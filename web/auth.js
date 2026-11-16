"use strict";
const fs = require("node:fs");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const WEB_ACTOR = "web-shared";
const SHARED_ACCOUNT = Object.freeze({ name: "Dompet bersama", actor: WEB_ACTOR });
const isValidPin = (pin) => typeof pin === "string" && /^[0-9]{6}$/.test(pin);
function pinHash(pin, salt = crypto.randomBytes(16).toString("hex")) {
  if (!isValidPin(pin)) throw new Error("PIN harus tepat 6 digit angka.");
  return { salt, hash: crypto.scryptSync("mini-bank-pin:" + pin, salt, 64).toString("hex") };
}
function verifyPin(pin, record) {
  if (!record || !isValidPin(pin)) return false;
  const actual = Buffer.from(pinHash(pin, record.salt).hash, "hex");
  const expected = Buffer.from(record.hash, "hex");
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
const digest = (token) => crypto.createHash("sha256").update(token).digest("hex");
function createAuth({ filename, pinRecord, now = () => Date.now() }) {
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;" +
    "CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, username TEXT NOT NULL, csrf TEXT NOT NULL, expires INTEGER NOT NULL);" +
    "CREATE TABLE IF NOT EXISTS attempts(key TEXT PRIMARY KEY, failures INTEGER NOT NULL, until INTEGER NOT NULL);");
  // Keep the existing auth schema, but bind sessions to this PIN revision.
  // Username/password sessions are never accepted by the PIN login.
  const credentialId = "shared-pin:" + digest(pinRecord.salt + ":" + pinRecord.hash);
  function attempt(pin, ip, remember) {
    const key = "pin:shared";
    db.exec("BEGIN IMMEDIATE");
    try {
      const record = db.prepare("SELECT * FROM attempts WHERE key=?").get(key);
      if (record && record.until > now() && record.failures >= 5) {
        db.exec("COMMIT"); return { blocked: true };
      }
      if (!verifyPin(pin, pinRecord)) {
        const failures = record && record.until > now() ? record.failures + 1 : 1;
        db.prepare("INSERT INTO attempts VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET failures=excluded.failures,until=excluded.until")
          .run(key, failures, record && record.until > now() ? record.until : now() + 15 * 60000);
        db.exec("COMMIT"); return null;
      }
      db.prepare("DELETE FROM attempts WHERE key=?").run(key);
      const token = crypto.randomBytes(32).toString("base64url");
      const csrf = crypto.randomBytes(32).toString("base64url");
      const maxAge = remember ? 7 * 86400 : 12 * 3600;
      db.prepare("DELETE FROM sessions WHERE expires<?").run(now());
      db.prepare("INSERT INTO sessions VALUES(?,?,?,?)").run(digest(token), credentialId, csrf, now() + maxAge * 1000);
      db.exec("COMMIT");
      return { token, maxAge, user: SHARED_ACCOUNT, csrf };
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  function session(token) {
    if (!token || !/^[a-zA-Z0-9_-]{43}$/.test(token)) return null;
    const row = db.prepare("SELECT * FROM sessions WHERE token_hash=? AND username=? AND expires>?")
      .get(digest(token), credentialId, now());
    return row ? { user: SHARED_ACCOUNT, csrf: row.csrf } : null;
  }
  return { attempt, session,
    logout(token) { if (token) db.prepare("DELETE FROM sessions WHERE token_hash=?").run(digest(token)); },
    close: () => db.close() };
}
function loadPin(filename) {
  if (!fs.existsSync(filename)) throw new Error("PIN bersama belum dibuat. Jalankan node web/setup.js terlebih dahulu.");
  const record = JSON.parse(fs.readFileSync(filename, "utf8"));
  if (record.version !== 1 || !/^[a-f0-9]{32}$/.test(record.salt) || !/^[a-f0-9]{128}$/.test(record.hash))
    throw new Error("Konfigurasi PIN tidak valid. Jalankan node web/setup.js --reset-pin.");
  return record;
}
module.exports = { pinHash, verifyPin, isValidPin, createAuth, loadPin, SHARED_ACCOUNT, WEB_ACTOR };

