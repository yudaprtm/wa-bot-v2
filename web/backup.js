"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync, backup } = require("node:sqlite");
async function backupExisting(source, target) {
  if (!fs.existsSync(source)) throw new Error("Database bot tidak ditemukan: " + source);
  if (fs.existsSync(target)) throw new Error("File tujuan sudah ada; backup tidak akan ditimpa.");
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    for (const table of ["mini_bank_ops", "mini_bank_entries"]) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
        throw new Error("Database bukan schema Saving/Harian. Instalasi dibatalkan tanpa perubahan data.");
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    await backup(db, target);
    return { operations: db.prepare("SELECT COUNT(*) AS n FROM mini_bank_ops").get().n };
  } finally { db.close(); }
}
if (require.main === module) {
  const [source, target] = process.argv.slice(2);
  if (!source || !target) { console.error("Gunakan: node web/backup.js <database-bot> <file-backup-baru>"); process.exitCode = 1; }
  else backupExisting(source, target).then((result) => console.log("Backup berhasil. " + result.operations + " pencatatan dipertahankan."))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { backupExisting };
