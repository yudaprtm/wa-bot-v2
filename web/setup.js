"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { pinHash, isValidPin } = require("./auth");
const { askHiddenPin } = require("./prompt");
const root = path.join(__dirname, "..");
const dataDir = process.env.MINIBANK_DATA_DIR ? path.resolve(process.env.MINIBANK_DATA_DIR) : path.join(root, "data");
function inspectDatabase() {
  const file = path.join(dataDir, "keuangan.db");
  if (!fs.existsSync(file)) throw new Error("Database bot tidak ditemukan di " + file + ". Salin paket UI ke folder bot yang sudah berisi data/keuangan.db.");
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    for (const table of ["mini_bank_ops", "mini_bank_entries"]) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
        throw new Error("Schema database bukan versi Saving/Harian. Data tidak diubah; perlu ditinjau terlebih dahulu.");
    }
    const count = db.prepare("SELECT COUNT(*) AS n FROM mini_bank_ops").get().n;
    console.log("Database bot ditemukan. " + count + " pencatatan tetap dipertahankan.");
  } finally { db.close(); }
}
function saveSharedPin(directory, pin) {
  if (!isValidPin(pin)) throw new Error("PIN harus tepat 6 digit angka.");
  const record = { version: 1, ...pinHash(pin), updatedAt: new Date().toISOString() };
  const filename = path.join(directory, "web-pin.json");
  const temporary = path.join(directory, ".web-pin-" + crypto.randomUUID() + ".tmp");
  try {
    fs.writeFileSync(temporary, JSON.stringify(record, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, filename);
  } catch (error) {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    throw error;
  }
  const authFile = path.join(directory, "web-auth.db");
  if (fs.existsSync(authFile)) {
    const db = new DatabaseSync(authFile);
    try {
      for (const name of ["sessions", "attempts"]) {
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)) db.exec("DELETE FROM " + name);
      }
    } finally { db.close(); }
  }
  return record;
}
async function main() {
  inspectDatabase();
  const settingsFile = path.join(dataDir, "web-settings.json");
  const originIndex = process.argv.indexOf("--origin");
  if (originIndex >= 0) {
    const origin = process.argv[originIndex + 1] || "";
    if (origin && (new URL(origin).protocol !== "https:" || new URL(origin).origin !== origin))
      throw new Error("Gunakan URL HTTPS tanpa garis miring akhir, contoh https://nama-pc.tailnet.ts.net");
    fs.writeFileSync(settingsFile, JSON.stringify({ publicOrigin: origin }, null, 2), { mode: 0o600 });
    console.log("Alamat akses diperbarui. Restart UI. Data transaksi dan PIN tidak berubah.");
    return;
  }
  const pinFile = path.join(dataDir, "web-pin.json");
  if (fs.existsSync(pinFile) && !process.argv.includes("--reset-pin") && !process.argv.includes("--reset-users")) {
    console.log("PIN bersama sudah tersedia. Klik START-UI.bat untuk menjalankan UI.\nUntuk mengganti PIN: node web/setup.js --reset-pin");
    return;
  }
  console.log("\nBuat SATU PIN bersama untuk dipakai kalian berdua. Tidak perlu username.\nAturan: tepat 6 digit angka. Input ditampilkan sebagai tanda *.");
  let pin, confirm;
  do {
    pin = await askHiddenPin("PIN bersama (6 digit): ");
    confirm = await askHiddenPin("Ulangi PIN bersama: ");
    if (!isValidPin(pin) || pin !== confirm) console.log("PIN harus 6 digit dan konfirmasinya sama. Coba lagi.\n");
  } while (!isValidPin(pin) || pin !== confirm);
  saveSharedPin(dataDir, pin);
  pin = confirm = null;
  if (!fs.existsSync(settingsFile)) fs.writeFileSync(settingsFile, JSON.stringify({ publicOrigin: "" }, null, 2), { mode: 0o600 });
  console.log("\nPIN bersama berhasil dibuat. Kalian berdua memakai PIN yang sama.\nKlik START-UI.bat, lalu buka http://localhost:3030.\nData keuangan, akun bot WA, dan pengaturan HTTPS tetap dipertahankan.");
}
if (require.main === module) main().catch((error) => { console.error("Setup dihentikan: " + error.message); process.exitCode = 1; });
module.exports = { saveSharedPin };
