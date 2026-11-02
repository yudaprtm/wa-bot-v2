"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const SHARED_USERS = ["225223873933385@lid", "215603096862749@lid"];
const SHARED_GROUPS = ["120363415524345679@g.us"];
const SAVING_PER_SALARY = 6_000_000n;
const DAY = 86400000;
class InputError extends Error {}

async function resolveSender(message, client) {
  // In groups, `from` identifies the chat; `author` identifies the person.
  const raw = message.from?.endsWith("@g.us") ? message.author : message.from;
  if (typeof raw !== "string") return null;
  if (raw.endsWith("@c.us") && typeof client?.getContactLidAndPhone === "function") {
    try {
      const records = await client.getContactLidAndPhone([raw]);
      const match = records?.find((r) => r.pn === raw && typeof r.lid === "string");
      if (match?.lid.endsWith("@lid")) return match.lid;
    } catch {
      // Failure to resolve a sender never grants group access.
    }
  }
  return raw;
}

function resolveMessageId(message) {
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
  return part("year") + "-" + part("month") + "-" + part("day");
}
function dateUTC(date) { return new Date(date + "T00:00:00Z"); }
function iso(date) { return date.toISOString().slice(0, 10); }
function addDays(date, days) {
  const value = dateUTC(date);
  value.setUTCDate(value.getUTCDate() + days);
  return iso(value);
}
function paydayInfo(today) {
  const date = dateUTC(today);
  const year = date.getUTCFullYear(), month = date.getUTCMonth(), day = date.getUTCDate();
  const next = new Date(Date.UTC(year, month + (day >= 25 ? 1 : 0), 25));
  const current = new Date(Date.UTC(year, month - (day < 25 ? 1 : 0), 25));
  return { next: iso(next), cycle: iso(current), days: Math.round((next - date) / DAY) };
}
function budget(balance, today) {
  const info = paydayInfo(today);
  const spendable = balance > 0n ? balance : 0n;
  const weeks = [];
  let offset = 0, distributed = 0n;
  while (offset < info.days) {
    const days = Math.min(7, info.days - offset);
    // Cumulative integer rounding allocates exactly the remaining balance.
    const cumulative = spendable * BigInt(offset + days) / BigInt(info.days);
    weeks.push({ start: addDays(today, offset), end: addDays(today, offset + days - 1), days,
      amount: cumulative - distributed });
    distributed = cumulative;
    offset += days;
  }
  return { ...info, daily: spendable / BigInt(info.days), weeks };
}
function money(value) { return "Rp" + new Intl.NumberFormat("id-ID").format(value); }
function parseAmount(raw) {
  if (!/^(?:\d+|\d{1,3}(?:\.\d{3})+)$/.test(raw)) {
    throw new InputError("Nominal harus rupiah bulat: 25000 atau 25.000. Jangan gunakan koma, minus, atau 25k.");
  }
  const amount = Number(raw.replace(/\./g, ""));
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 1_000_000_000_000) {
    throw new InputError("Nominal harus > 0, maksimal Rp1.000.000.000.000.");
  }
  return amount;
}
function inferCategory(kind, description) {
  const rules = kind === "in" ? [
    ["Gaji", /\b(gaji|payday|salary)\b/i], ["Bonus", /\b(bonus|thr)\b/i],
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
function parseEntry(input, direction) {
  const match = input.match(/^(\S+)\s+([\s\S]+)$/);
  if (!match) throw new InputError("Isi nominal dan keterangan. Contoh: !transaksi keluar 25000 makan siang");
  const amount = parseAmount(match[1]);
  let description = match[2].replace(/\s+/g, " ").trim();
  let category;
  if (description.includes("|")) {
    const chunks = description.split("|");
    if (chunks.length !== 2 || !chunks[0].trim() || !chunks[1].trim()) {
      throw new InputError("Kategori sendiri: !transaksi keluar 25000 transport | ojek");
    }
    category = chunks[0].trim();
    description = chunks[1].trim();
    if (category.length > 40) throw new InputError("Kategori maksimal 40 karakter.");
  }
  if (description.length > 250) throw new InputError("Keterangan maksimal 250 karakter.");
  return { amount, description, category: category || inferCategory(direction, description) };
}

const BANK_MENU = [
  "💰 *MINI BANK*", "",
  "!saving → Tabungan: masuk, keluar, saldo",
  "!transaksi → Saldo harian, masuk/keluar & anggaran",
  "!saldo → Lihat kedua saldo", "",
  "*SAAT GAJIAN*",
  "!gaji <total gaji>",
  "Otomatis: Rp6.000.000 ke Saving, sisanya ke Harian.",
  "Contoh: !gaji 10000000", "",
  "!hapus <ID> → Koreksi pencatatan",
  "🔒 Chat pribadi atau grup bersama yang ditentukan.",
].join("\n");

function createMiniBank({ dataDir = path.join(__dirname, "..", "data"), now = () => new Date(),
  logger = console, sharedUsers = SHARED_USERS, sharedGroups = SHARED_GROUPS } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "keuangan.db"));
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
  const prepare = (sql) => {
    const s = db.prepare(sql); s.setReadBigInts(true); return s;
  };
  const members = [...new Set(sharedUsers)].sort();
  const sharedWallet = members.length >= 2 ? "shared:" + members.join("+") : null;
  const isShared = (user) => !!sharedWallet && members.includes(user);
  function snapshot(prefix) {
    const dir = path.join(dataDir, "backups");
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, prefix + ".db");
    db.exec("VACUUM INTO '" + target.replace(/'/g, "''") + "'");
    return target;
  }
  const tableExists = (name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  const hadMeta = tableExists("mini_bank_meta");
  const resetKey = "saving-daily-reset-v1:" + (sharedWallet || "no-shared-wallet");
  const initialized = hadMeta && db.prepare("SELECT 1 FROM mini_bank_meta WHERE key=?").get(resetKey);
  const legacyExists = tableExists("transactions");
  // User authorized a one-time reset for the shared wallet. Keep a complete,
  // consistent backup before changing any old financial data.
  let resetBackup;
  try {
    if (!initialized && legacyExists && sharedWallet) {
      resetBackup = snapshot("keuangan-sebelum-saving-harian-" + randomUUID());
    }
    db.exec("BEGIN IMMEDIATE");
    db.exec(
      "CREATE TABLE IF NOT EXISTS mini_bank_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS mini_bank_ops (" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, actor TEXT NOT NULL," +
      "message_id TEXT NOT NULL, type TEXT NOT NULL, business_date TEXT NOT NULL," +
      "created_at TEXT NOT NULL, salary_cycle TEXT, deleted_at TEXT, UNIQUE(owner,message_id));" +
      "CREATE TABLE IF NOT EXISTS mini_bank_entries (" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT, op_id INTEGER NOT NULL REFERENCES mini_bank_ops(id)," +
      "wallet TEXT NOT NULL CHECK(wallet IN ('saving','harian'))," +
      "direction TEXT NOT NULL CHECK(direction IN ('in','out'))," +
      "amount INTEGER NOT NULL CHECK(amount >= 0 AND amount <= 1000000000000)," +
      "category TEXT NOT NULL, description TEXT NOT NULL);" +
      "CREATE INDEX IF NOT EXISTS idx_mb_owner_date ON mini_bank_ops(owner,business_date);" +
      "CREATE INDEX IF NOT EXISTS idx_mb_entries_op ON mini_bank_entries(op_id);" +
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_mb_salary_cycle ON mini_bank_ops(owner,salary_cycle)" +
      " WHERE type='gaji' AND deleted_at IS NULL;"
    );
    if (!initialized) {
      if (legacyExists && sharedWallet) {
        const erase = prepare("DELETE FROM transactions WHERE user_id=?");
        for (const id of [...members, sharedWallet]) erase.run(id);
      }
      db.prepare("INSERT INTO mini_bank_meta(key,value) VALUES(?,?)").run(resetKey, now().toISOString());
    }
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    db.close();
    throw new Error("Persiapan Saving/Harian dibatalkan: " + error.message);
  }
  if (resetBackup) logger.log?.("[MiniBank] Catatan lama dompet bersama dikosongkan satu kali. Backup: " + resetBackup);
  let backupDay;
  function dailyBackup() {
    const today = jakartaDate(now());
    if (backupDay === today) return;
    const filename = "keuangan-" + today;
    if (!fs.existsSync(path.join(dataDir, "backups", filename + ".db"))) snapshot(filename);
    backupDay = today;
  }
  const rowsFor = prepare(
    "SELECT e.*, o.id AS operation_id,o.business_date,o.type,o.actor FROM mini_bank_entries e " +
    "JOIN mini_bank_ops o ON o.id=e.op_id WHERE o.owner=? AND o.deleted_at IS NULL ORDER BY o.id DESC,e.id DESC"
  );
  const operationByMessage = prepare("SELECT * FROM mini_bank_ops WHERE owner=? AND message_id=?");
  const operationById = prepare("SELECT * FROM mini_bank_ops WHERE owner=? AND id=? AND deleted_at IS NULL");
  const salaryInCycle = prepare("SELECT * FROM mini_bank_ops WHERE owner=? AND type='gaji' AND salary_cycle=? AND deleted_at IS NULL");
  const insertOp = prepare(
    "INSERT INTO mini_bank_ops(owner,actor,message_id,type,business_date,created_at,salary_cycle) VALUES(?,?,?,?,?,?,?)"
  );
  const insertEntry = prepare(
    "INSERT INTO mini_bank_entries(op_id,wallet,direction,amount,category,description) VALUES(?,?,?,?,?,?)"
  );
  const rows = (owner, wallet) => rowsFor.all(owner).filter((r) => !wallet || r.wallet === wallet);
  const total = (items) => items.reduce((sum, row) => sum + (row.direction === "in" ? row.amount : -row.amount), 0n);
  const balance = (owner, wallet) => total(rows(owner, wallet));
  const title = (wallet) => wallet === "saving" ? "SAVING" : "TRANSAKSI HARIAN";

  function recommendation(owner) {
    const left = balance(owner, "harian");
    const plan = budget(left, jakartaDate(now()));
    return [
      "📅 *ANGGARAN TRANSAKSI HARIAN*", "",
      "Sisa saldo: " + money(left),
      "Gajian berikutnya: " + plan.next + " (tanggal 25)",
      "Dana perlu cukup sampai: " + addDays(plan.next, -1),
      "Sisa hari: " + plan.days + " (termasuk hari ini)", "",
      "Acuan per hari: " + money(plan.daily),
      "*Rencana dari hari ini*",
      ...plan.weeks.map((w, i) => (i + 1) + ". " + w.start + " s.d. " + w.end +
        " (" + w.days + " hari): " + money(w.amount)),
      "",
      left <= 0n ? "Saldo harian belum mencukupi. Anggaran belanja saat ini Rp0." :
        "Dihitung dari saldo harian saja. Saving tidak ikut dihitung.",
      "Diperbarui setiap kali diminta; uang tidak dipindahkan otomatis.",
      "Saat tanggal 25, perhitungan memakai tanggal 25 bulan berikutnya.",
    ].join("\n");
  }
  function walletMenu(owner, wallet) {
    if (wallet === "saving") return [
      "🏦 *SAVING*", "Saldo: *" + money(balance(owner, wallet)) + "*", "",
      "!saving masuk <nominal> <keterangan>",
      "!saving keluar <nominal> <keterangan>",
      "!saving saldo", "!saving riwayat",
      "!saving rekap hari", "!saving rekap bulan",
      "!saving rekap 2026-09", "",
      "Saat !gaji dicatat, Rp6.000.000 masuk ke Saving.",
    ].join("\n");
    return [
      "🛒 *TRANSAKSI HARIAN*", "Saldo: *" + money(balance(owner, wallet)) + "*", "",
      "!transaksi masuk <nominal> <keterangan>",
      "!transaksi keluar <nominal> <keterangan>",
      "!transaksi saldo", "!transaksi riwayat",
      "!transaksi rekap hari", "!transaksi rekap bulan",
      "!transaksi rekap 2026-09",
      "!transaksi rekomendasi", "",
      "Contoh: !transaksi keluar 25000 makan siang",
      "Singkatan: !keluar 25000 makan siang", "",
      "Dana dari sisa !gaji atau tambahan !transaksi masuk.",
      "Tambahan saldo Harian tidak mengurangi Saving.",
      "Kategori sendiri: !keluar 25000 transport | ojek",
    ].join("\n");
  }
  function history(owner, wallet) {
    const selected = rows(owner, wallet).slice(0, 10);
    return [
      "🧾 *RIWAYAT " + title(wallet) + "*", "",
      ...selected.map((r) => "ID " + r.operation_id + " | " + r.business_date + " | " +
        (r.direction === "in" ? "+" : "−") + money(r.amount) + "\n" +
        (r.type === "gaji" && wallet === "harian" ? "Alokasi sisa gaji" : r.description) + " (" + r.category + ")"),
      ...(selected.length ? ["", "Koreksi: !hapus <ID>. ID gaji membatalkan kedua alokasinya."] : ["Belum ada catatan."]),
    ].join("\n");
  }
  function summary(owner, wallet, period) {
    const today = jakartaDate(now());
    let start, end, label;
    if (period === "hari") { start = today; end = addDays(today, 1); label = today; }
    else {
      const month = period === "bulan" ? today.slice(0, 7) : period;
      if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)) {
        throw new InputError("Pilih rekap hari, bulan, atau YYYY-MM.");
      }
      start = month + "-01";
      const d = dateUTC(start); d.setUTCMonth(d.getUTCMonth() + 1); end = iso(d); label = month;
    }
    const selected = rows(owner, wallet).filter((r) => r.business_date >= start && r.business_date < end);
    const incoming = selected.filter((r) => r.direction === "in").reduce((s, r) => s + r.amount, 0n);
    const salaryAllocation = selected.filter((r) => r.direction === "in" && r.type === "gaji")
      .reduce((s, r) => s + r.amount, 0n);
    const outgoing = selected.filter((r) => r.direction === "out").reduce((s, r) => s + r.amount, 0n);
    const categories = new Map();
    for (const r of selected.filter((r) => r.direction === "out")) {
      categories.set(r.category, (categories.get(r.category) || 0n) + r.amount);
    }
    return [
      "📊 *REKAP " + title(wallet) + " — " + label + "*",
      "Catatan: " + selected.length, "",
      "Uang masuk: " + money(incoming),
      ...(wallet === "harian" ? ["Alokasi gaji: " + money(salaryAllocation),
        "Tambahan saldo: " + money(incoming - salaryAllocation)] : []),
      "Uang keluar: " + money(outgoing),
      "Selisih periode: " + money(incoming - outgoing),
      "Saldo sekarang (semua periode): " + money(balance(owner, wallet)), "",
      "*Pengeluaran per kategori*",
      ...[...categories].sort((a, b) => a[1] > b[1] ? -1 : a[1] < b[1] ? 1 : 0)
        .map(([category, amount]) => category + ": " + money(amount)),
      ...(categories.size ? [] : ["Belum ada pengeluaran."]),
    ].join("\n");
  }
  function saveOperation(owner, actor, messageId, type, entries, cycle) {
    if (!messageId) {
      messageId = "local:" + randomUUID();
      logger.warn?.("[MiniBank] ID WhatsApp tidak tersedia; pengiriman ulang pesan ini tidak dapat dideteksi.");
    }
    const old = operationByMessage.get(owner, messageId);
    if (old) return { duplicate: true, id: old.id, deleted: !!old.deleted_at };
    // Financial writes fail safely if a consistent backup cannot be made.
    dailyBackup();
    db.exec("BEGIN IMMEDIATE");
    try {
      const stamp = now();
      insertOp.run(owner, actor, messageId, type, jakartaDate(stamp), stamp.toISOString(), cycle || null);
      const op = operationByMessage.get(owner, messageId);
      for (const entry of entries) {
        insertEntry.run(op.id, entry.wallet, entry.direction, entry.amount, entry.category, entry.description);
      }
      db.exec("COMMIT");
      return { id: op.id };
    } catch (error) {
      db.exec("ROLLBACK"); throw error;
    }
  }
  const duplicateText = (result) => "ℹ️ Pesan sudah diproses sebagai ID " + result.id +
    (result.deleted ? " dan sudah dihapus." : ". Tidak dicatat ulang.");

  function execute(owner, actor, body, messageId) {
    const [commandRaw, ...rest] = body.trim().split(/\s+/);
    const command = commandRaw.toLowerCase(), args = rest.join(" ");
    if (command === "!mini") return BANK_MENU;
    if (command === "!saldo") {
      if (args) throw new InputError("Gunakan !saldo tanpa tambahan.");
      const saving = balance(owner, "saving"), daily = balance(owner, "harian");
      return ["💰 *SALDO MINI BANK*", "Saving: *" + money(saving) + "*",
        "Transaksi Harian: *" + money(daily) + "*", "Total tercatat: " + money(saving + daily),
        "", "Rekomendasi belanja hanya memakai saldo Transaksi Harian."].join("\n");
    }
    if (command === "!gaji") {
      if (!args) return "💵 Format: !gaji <total gaji>\nRp6.000.000 ke Saving; sisanya ke Harian.\nContoh: !gaji 10000000";
      const amount = BigInt(parseAmount(args));
      if (amount < SAVING_PER_SALARY) throw new InputError("Total gaji minimal Rp6.000.000 untuk pembagian Saving tetap Rp6.000.000.");
      const old = messageId && operationByMessage.get(owner, messageId);
      if (old) return duplicateText({ id: old.id, deleted: !!old.deleted_at });
      const cycle = paydayInfo(jakartaDate(now())).cycle;
      const existing = salaryInCycle.get(owner, cycle);
      if (existing) throw new InputError("Gaji siklus mulai " + cycle + " sudah dicatat (ID " + existing.id +
        "). Jika salah, !hapus " + existing.id + " lalu catat ulang gaji yang benar.");
      const result = saveOperation(owner, actor, messageId, "gaji", [
        { wallet: "saving", direction: "in", amount: SAVING_PER_SALARY, category: "Gaji", description: "Alokasi Saving dari gaji" },
        { wallet: "harian", direction: "in", amount: amount - SAVING_PER_SALARY, category: "Alokasi gaji", description: "Sisa gaji untuk belanja harian" },
      ], cycle);
      if (result.duplicate) return duplicateText(result);
      return ["✅ *GAJI TERCATAT* — ID " + result.id,
        "Total gaji: " + money(amount), "Ke Saving: " + money(SAVING_PER_SALARY),
        "Ke Harian: " + money(amount - SAVING_PER_SALARY), "",
        "Saldo Saving: " + money(balance(owner, "saving")),
        "Saldo Harian: " + money(balance(owner, "harian")), "", recommendation(owner)].join("\n");
    }
    if (command === "!hapus") {
      if (!/^[1-9]\d{0,14}$/.test(args)) throw new InputError("Format: !hapus <ID>. Lihat ID di riwayat.");
      const op = operationById.get(owner, BigInt(args));
      if (!op) return "Catatan tidak ditemukan pada dompet ini atau sudah dihapus.";
      dailyBackup();
      db.prepare("UPDATE mini_bank_ops SET deleted_at=? WHERE owner=? AND id=? AND deleted_at IS NULL")
        .run(now().toISOString(), owner, op.id);
      return "✅ Catatan ID " + op.id + " dihapus dari perhitungan." +
        (op.type === "gaji" ? "\nKedua alokasi gaji (Saving dan Harian) ikut dibatalkan." : "") +
        "\nCek !saldo. Jika saldo negatif, koreksi catatan pendanaannya.";
    }
    if (command === "!masuk") {
      return "Pilih tujuan pencatatan:\n!gaji <total gaji> → bagi Rp6 juta ke Saving, sisanya ke Harian.\n" +
        "!saving masuk <nominal> <keterangan> → tambah Saving.\n" +
        "!transaksi masuk <nominal> <keterangan> → tambah saldo Harian.";
    }
    let wallet, action, input;
    if (command === "!saving" || command === "!transaksi") {
      wallet = command === "!saving" ? "saving" : "harian";
      const [verb, ...remaining] = rest;
      action = (verb || "").toLowerCase(); input = remaining.join(" ");
    } else {
      wallet = "harian";
      action = ({ "!keluar": "keluar", "!rekap": "rekap", "!rekomendasi": "rekomendasi" })[command];
      input = args;
    }
    if (!action) return walletMenu(owner, wallet);
    if (action === "saldo") {
      if (input) throw new InputError("Perintah saldo tanpa tambahan.");
      return "💰 Saldo " + title(wallet) + ": *" + money(balance(owner, wallet)) + "*";
    }
    if (action === "riwayat") {
      if (input) throw new InputError("Perintah riwayat tanpa tambahan.");
      return history(owner, wallet);
    }
    if (action === "rekap") return summary(owner, wallet, input.toLowerCase());
    if (action === "rekomendasi" && wallet === "harian") {
      if (input) throw new InputError("Gunakan !transaksi rekomendasi.");
      return recommendation(owner);
    }
    if (action === "keluar" || action === "masuk") {
      const direction = action === "masuk" ? "in" : "out";
      const parsed = parseEntry(input, direction);
      const old = messageId && operationByMessage.get(owner, messageId);
      if (old) return duplicateText({ id: old.id, deleted: !!old.deleted_at });
      if (direction === "out" && BigInt(parsed.amount) > balance(owner, wallet)) {
        throw new InputError("Saldo " + title(wallet) + " tidak cukup. Tersedia " + money(balance(owner, wallet)) + ".");
      }
      const result = saveOperation(owner, actor, messageId, wallet + "_" + direction,
        [{ ...parsed, wallet, direction }]);
      if (result.duplicate) return duplicateText(result);
      const resultText = ["✅ " + title(wallet) + " — uang " + action + " tercatat",
        parsed.description + " — " + money(parsed.amount), "Kategori: " + parsed.category,
        "Tanggal: " + jakartaDate(now()) + " (WIB)", "ID: " + result.id,
        "Saldo: *" + money(balance(owner, wallet)) + "*"];
      if (wallet === "harian") {
        const plan = budget(balance(owner, wallet), jakartaDate(now()));
        resultText.push("", "Acuan harian: " + money(plan.daily),
          "Anggaran " + plan.weeks[0].days + " hari berikutnya: " + money(plan.weeks[0].amount),
          "Rincian: !transaksi rekomendasi");
      }
      return resultText.join("\n");
    }
    return walletMenu(owner, wallet);
  }
  async function handle(message, { senderId } = {}) {
    const body = (message.body || "").trim();
    const matches = /^!mini\s+bank\s*$/i.test(body) ||
      /^!(saving|transaksi|gaji|keluar|masuk|saldo|rekap|hapus|rekomendasi)(?:\s|$)/i.test(body);
    if (!matches) return false;
    const group = message.from?.endsWith("@g.us");
    const sender = senderId || (group ? message.author : message.from);
    if (!message.from || message.from.endsWith("@broadcast") ||
      (group && (!sharedGroups.includes(message.from) || !isShared(sender)))) {
      await message.reply("🔒 Mini Bank hanya lewat chat pribadi atau grup bersama dengan pengirim yang diizinkan."); return true;
    }
    try {
      const shared = isShared(sender);
      const platformId = resolveMessageId(message);
      const owner = shared ? sharedWallet : sender;
      const messageId = platformId ? sender + ":" + platformId : null;
      let reply = execute(owner, sender, body, messageId);
      if (shared) reply = "👥 *DOMPET BERSAMA*\n\n" + reply;
      for (let offset = 0; offset < reply.length; offset += 3500) await message.reply(reply.slice(offset, offset + 3500));
    } catch (error) {
      if (error instanceof InputError) await message.reply("⚠️ " + error.message);
      else {
        logger.error("[MiniBank] Operasi/balasan gagal:", error.message);
        await message.reply("⚠️ Operasi atau balasan gagal. Cek riwayat sebelum mencatat ulang, lalu periksa terminal.");
      }
    }
    return true;
  }
  return { handle, close: () => db.close() };
}
module.exports = { createMiniBank, BANK_MENU, jakartaDate, parseAmount, resolveMessageId,
  paydayInfo, budget, SHARED_USERS, SHARED_GROUPS, SAVING_PER_SALARY, resolveSender };
