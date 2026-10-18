"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const SHARED_USERS = ["225223873933385@lid", "215603096862749@lid"];

const BANK_MENU = [
  "💰 *MINI BANK*", "",
  "*CATAT TRANSAKSI*",
  "!keluar <nominal> <keterangan>",
  "!masuk <nominal> <keterangan>", "",
  "*CEK KEUANGAN*",
  "!saldo → Saldo tercatat",
  "!transaksi → 10 transaksi terakhir",
  "!rekap hari → Ringkasan hari ini",
  "!rekap bulan → Ringkasan bulan ini",
  "!rekap 2026-09 → Ringkasan bulan tertentu", "",
  "*KOREKSI*",
  "!hapus <ID> → Hapus transaksi yang salah", "",
  "*CONTOH*",
  "!keluar 25000 makan siang",
  "!masuk 8000000 gaji", "",
  "Nominal: 25000 atau 25.000 (rupiah bulat).",
  "Kategori otomatis; kategori sendiri: transport | ojek",
  "Saldo dihitung dari seluruh transaksi tercatat.",
  "🔒 Hanya lewat chat pribadi. Tanggal memakai WIB.",
].join("\n");

class InputError extends Error {}
function resolveMessageId(message) {
  // Different WhatsApp Web versions expose either a serialized string,
  // a MessageId object, or only the raw stanza ID.
  for (const candidate of [message.id, message.rawData?.id, message._data?.id]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
    if (candidate && typeof candidate === "object") {
      if (typeof candidate._serialized === "string" && candidate._serialized.trim()) return candidate._serialized;
      if (typeof candidate.id === "string" && candidate.id.trim()) return candidate.id;
    }
  }
  return null;
}
function jakartaDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const part = (type) => parts.find((p) => p.type === type).value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
function money(value) {
  return `Rp${new Intl.NumberFormat("id-ID").format(value)}`;
}
function parseAmount(raw) {
  if (!/^(?:\d+|\d{1,3}(?:\.\d{3})+)$/.test(raw)) {
    throw new InputError("Nominal harus rupiah bulat, contoh 25000 atau 25.000. Jangan gunakan koma, minus, atau singkatan 25k.");
  }
  const amount = Number(raw.replace(/\./g, ""));
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 1_000_000_000_000) {
    throw new InputError("Nominal harus lebih dari 0 dan maksimal Rp1.000.000.000.000 per transaksi.");
  }
  return amount;
}
function inferCategory(kind, description) {
  const rules = kind === "masuk" ? [
    ["Gaji", /\b(gaji|payday|salary)\b/i],
    ["Bonus", /\b(bonus|thr)\b/i],
    ["Usaha", /\b(jual|jualan|usaha|freelance)\b/i],
  ] : [
    ["Makan & minum", /\b(makan|minum|kopi|sarapan|warteg|restoran|jajan)\b/i],
    ["Transport", /\b(transport|ojek|gojek|grab|bensin|parkir|tol|kereta|taksi|bus)\b/i],
    ["Tagihan", /\b(tagihan|listrik|air|internet|wifi|pulsa|sewa|kos|cicilan)\b/i],
    ["Belanja", /\b(belanja|baju|sepatu|sembako|supermarket)\b/i],
    ["Kesehatan", /\b(obat|dokter|rumah sakit|vitamin)\b/i],
    ["Hiburan", /\b(nonton|bioskop|game|liburan|netflix)\b/i],
  ];
  return rules.find(([, pattern]) => pattern.test(description))?.[0] || "Lainnya";
}
function parseEntry(kind, input) {
  const match = input.match(/^(\S+)\s+([\s\S]+)$/);
  if (!match) throw new InputError(`Format: !${kind} <nominal> <keterangan>\nContoh: !${kind} 25000 makan siang`);
  const amount = parseAmount(match[1]);
  let description = match[2].replace(/\s+/g, " ").trim();
  let category;
  if (description.includes("|")) {
    const chunks = description.split("|");
    if (chunks.length !== 2 || !chunks[0].trim() || !chunks[1].trim()) {
      throw new InputError("Kategori sendiri: !keluar 25000 transport | ojek");
    }
    category = chunks[0].trim();
    description = chunks[1].trim();
    if (category.length > 40) throw new InputError("Kategori maksimal 40 karakter.");
  }
  if (description.length > 250) throw new InputError("Keterangan maksimal 250 karakter.");
  return { kind, amount, description, category: category || inferCategory(kind, description) };
}

function createMiniBank({ dataDir = path.join(__dirname, "..", "data"), now = () => new Date(), logger = console, sharedUsers = SHARED_USERS } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "keuangan.db"));
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('masuk', 'keluar')),
      amount INTEGER NOT NULL CHECK(amount > 0 AND amount <= 1000000000000),
      category TEXT NOT NULL,
      description TEXT NOT NULL,
      business_date TEXT NOT NULL,
      created_at TEXT NOT NULL,
      deleted_at TEXT,
      UNIQUE(user_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_transactions_user_date
      ON transactions(user_id, business_date, deleted_at);
  `);
  const prepare = (sql) => {
    const statement = db.prepare(sql);
    statement.setReadBigInts(true);
    return statement;
  };
  const byMessage = prepare("SELECT * FROM transactions WHERE user_id = ? AND message_id = ?");
  const byId = prepare("SELECT * FROM transactions WHERE user_id = ? AND id = ? AND deleted_at IS NULL");
  const insert = prepare(`INSERT INTO transactions
    (user_id, message_id, kind, amount, category, description, business_date, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const remove = prepare("UPDATE transactions SET deleted_at = ? WHERE user_id = ? AND id = ? AND deleted_at IS NULL");
  const recent = prepare("SELECT * FROM transactions WHERE user_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 10");
  const periodRows = prepare(`SELECT * FROM transactions WHERE user_id = ? AND deleted_at IS NULL
    AND business_date >= ? AND business_date < ? ORDER BY id DESC`);
  const allRows = prepare("SELECT * FROM transactions WHERE user_id = ? AND deleted_at IS NULL");
  let backupDay;
  function backup() {
    const day = jakartaDate(now());
    if (backupDay === day) return;
    const dir = path.join(dataDir, "backups");
    fs.mkdirSync(dir, { recursive: true });
    const destination = path.join(dir, `keuangan-${day}.db`);
    // SQLite creates a consistent snapshot, including WAL, before the first mutation of the day.
    if (!fs.existsSync(destination)) {
      db.exec(`VACUUM INTO '${destination.replace(/'/g, "''")}'`);
    }
    backupDay = day;
  }
  function tryBackup() {
    try { backup(); }
    catch (error) { logger.error("[MiniBank] Backup harian gagal:", error.message); }
  }
  const members = [...new Set(sharedUsers)].sort();
  const sharedWallet = members.length >= 2 ? `shared:${members.join("+")}` : null;
  const isShared = (user) => sharedWallet && members.includes(user);
  // Move existing individual ledgers once, preserving transaction IDs and deleted rows.
  // Prefix transport IDs with the sender to keep cross-user duplicates independent.
  const hasOldRows = prepare("SELECT 1 FROM transactions WHERE user_id = ? LIMIT 1");
  if (sharedWallet && members.some((user) => hasOldRows.get(user))) {
    try {
      const backupDir = path.join(dataDir, "backups");
      fs.mkdirSync(backupDir, { recursive: true });
      const filename = path.join(backupDir, `keuangan-sebelum-dompet-bersama-${randomUUID()}.db`);
      // A separate pre-migration backup is required even if today's regular backup exists.
      db.exec(`VACUUM INTO '${filename.replace(/'/g, "''")}'`);
      db.exec("BEGIN IMMEDIATE");
      const merge = prepare("UPDATE transactions SET user_id = ?, message_id = ? || message_id WHERE user_id = ?");
      for (const user of members) merge.run(sharedWallet, `${user}:`, user);
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      db.close();
      throw new Error(`Penggabungan dompet dibatalkan. Database tidak diubah: ${error.message}`);
    }
  }
  const totals = (rows) => rows.reduce((sum, row) => {
    sum[row.kind] += row.amount;
    return sum;
  }, { masuk: 0n, keluar: 0n });
  function totalsText(rows) {
    const t = totals(rows);
    return [`Pemasukan: ${money(t.masuk)}`, `Pengeluaran: ${money(t.keluar)}`, `Selisih: ${money(t.masuk - t.keluar)}`];
  }
  function summary(user, period) {
    const today = jakartaDate(now());
    let start, end, label;
    if (period === "hari") {
      start = today;
      const d = new Date(`${today}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + 1);
      end = d.toISOString().slice(0, 10);
      label = today;
    } else {
      const month = period === "bulan" ? today.slice(0, 7) : period;
      if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)) {
        throw new InputError("Gunakan !rekap hari, !rekap bulan, atau !rekap YYYY-MM (contoh !rekap 2026-09).");
      }
      start = `${month}-01`;
      const d = new Date(`${start}T00:00:00Z`);
      d.setUTCMonth(d.getUTCMonth() + 1);
      end = d.toISOString().slice(0, 10);
      label = month;
    }
    const rows = periodRows.all(user, start, end);
    const categories = new Map();
    for (const row of rows.filter((r) => r.kind === "keluar")) {
      categories.set(row.category, (categories.get(row.category) || 0n) + row.amount);
    }
    const sorted = [...categories].sort((a, b) => a[1] > b[1] ? -1 : a[1] < b[1] ? 1 : 0);
    return [
      `📊 *REKAP ${label} (WIB)*`, `Transaksi: ${rows.length}`, "", ...totalsText(rows), "",
      "*Pengeluaran per kategori*",
      ...sorted.map(([category, amount]) => `${category}: ${money(amount)}`),
      ...(sorted.length ? [] : ["Belum ada pengeluaran."]),
      "", "Selisih adalah pemasukan dikurangi pengeluaran pada periode ini.",
      "Saldo seluruh periode: !saldo",
    ].join("\n");
  }
  function execute(user, body, messageId) {
    const match = body.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
    if (!match) return null;
    const command = match[1].toLowerCase();
    const args = (match[2] || "").trim();
    if (command === "!mini" && /^bank$/i.test(args)) return BANK_MENU;
    if (!["!keluar", "!masuk", "!saldo", "!transaksi", "!rekap", "!hapus"].includes(command)) return null;
    if (command === "!masuk" || command === "!keluar") {
      const entry = parseEntry(command.slice(1), args);
      if (!messageId) {
        // A missing transport ID must not block a legitimate financial entry.
        // Do not hash text/time: two identical purchases may happen in one second.
        messageId = `local:${randomUUID()}`;
        logger.warn("[MiniBank] ID WhatsApp tidak tersedia; memakai ID lokal. Deteksi pengiriman ulang tidak tersedia untuk pesan ini.");
      }
      // All DB work is synchronous: save completes before any WhatsApp reply awaits.
      const existing = byMessage.get(user, messageId);
      if (existing) return `ℹ️ Pesan ini sudah dicatat sebagai ID ${existing.id}.${existing.deleted_at ? " Transaksinya sudah dihapus." : " Tidak dicatat ulang."}`;
      tryBackup();
      const timestamp = now();
      insert.run(user, messageId, entry.kind, entry.amount, entry.category, entry.description, jakartaDate(timestamp), timestamp.toISOString());
      const row = byMessage.get(user, messageId);
      return [
        `✅ ${entry.kind === "masuk" ? "Pemasukan" : "Pengeluaran"} tercatat`,
        `${entry.description} — ${money(entry.amount)}`,
        `Kategori: ${entry.category}`, `Tanggal: ${row.business_date} (WIB)`, `ID: ${row.id}`,
      ].join("\n");
    }
    if (command === "!saldo") {
      if (args) throw new InputError("Gunakan !saldo tanpa tambahan.");
      const t = totals(allRows.all(user));
      return ["💰 *SALDO TERCATAT*", `Pemasukan: ${money(t.masuk)}`, `Pengeluaran: ${money(t.keluar)}`,
        `Saldo: *${money(t.masuk - t.keluar)}*`, "", "Dihitung dari seluruh transaksi yang belum dihapus; bukan saldo rekening bank."].join("\n");
    }
    if (command === "!transaksi") {
      if (args) throw new InputError("Gunakan !transaksi tanpa tambahan.");
      const rows = recent.all(user);
      return ["🧾 *10 TRANSAKSI TERAKHIR*", "", ...rows.map((r) =>
        `ID ${r.id} | ${r.business_date} | ${r.kind === "masuk" ? "+" : "−"}${money(r.amount)}\n${r.description} (${r.category})`),
        ...(rows.length ? ["", "Koreksi: !hapus <ID>"] : ["Belum ada transaksi. Mulai dengan !masuk atau !keluar."]),
      ].join("\n");
    }
    if (command === "!rekap") return summary(user, args.toLowerCase());
    if (!/^[1-9]\d{0,14}$/.test(args)) throw new InputError("Format: !hapus <ID>\nLihat ID melalui !transaksi.");
    const id = BigInt(args);
    const row = byId.get(user, id);
    if (!row) return "Transaksi tidak ditemukan pada catatanmu atau sudah dihapus.";
    tryBackup();
    remove.run(now().toISOString(), user, id);
    return `✅ Transaksi ID ${row.id} dihapus dari perhitungan.\n${row.description} — ${money(row.amount)}`;
  }
  async function handle(message) {
    const body = (message.body || "").trim();
    const isBank = /^!mini\s+bank\s*$/i.test(body) || /^!(keluar|masuk|saldo|transaksi|rekap|hapus)(?:\s|$)/i.test(body);
    if (!isBank) return false;
    if (!message.from || message.from.endsWith("@g.us") || message.from.endsWith("@broadcast") || message.author) {
      await message.reply("🔒 Mini Bank hanya bisa digunakan lewat chat pribadi ke bot.");
      return true;
    }
    try {
      const shared = isShared(message.from);
      const platformId = resolveMessageId(message);
      const messageId = shared && platformId ? `${message.from}:${platformId}` : platformId;
      const user = shared ? sharedWallet : message.from;
      let reply = execute(user, body, messageId);
      if (shared && reply) reply = `👥 *DOMPET BERSAMA*\n\n${reply}`;
      if (reply) {
        for (let offset = 0; offset < reply.length; offset += 3500) {
          await message.reply(reply.slice(offset, offset + 3500));
        }
      }
    } catch (error) {
      if (error instanceof InputError) await message.reply(`⚠️ ${error.message}`);
      else {
        logger.error("[MiniBank] Operasi/balasan gagal:", error.message);
        await message.reply("⚠️ Operasi atau balasan Mini Bank gagal. Cek !transaksi sebelum mencatat ulang agar tidak dobel, lalu periksa terminal.");
      }
    }
    return true;
  }
  return { handle, close: () => db.close() };
}

module.exports = { createMiniBank, BANK_MENU, jakartaDate, parseAmount, resolveMessageId, SHARED_USERS };
