"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { createMiniBank, InputError } = require("../src/mini-bank");
const { createAuth, loadPin, SHARED_ACCOUNT } = require("./auth");

const ROOT = path.join(__dirname, "..");
const PUBLIC = path.join(__dirname, "public");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml", ".png": "image/png" };
function csvCell(value) {
  let text = String(value ?? "");
  if (/^[\s]*[=+@\-\t\r]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}
function exportCsv(rows) {
  return "\uFEFF" + [["ID", "Tanggal", "Dompet", "Jenis", "Nominal", "Kategori", "Keterangan", "Sumber"],
    ...rows.map((r) => [r.operationId, r.date, r.wallet === "saving" ? "Saving" : "Harian",
      r.direction === "in" ? "Masuk" : "Keluar", r.amount, r.category, r.description, r.source])]
    .map((r) => r.map(csvCell).join(",")).join("\r\n");
}
function cookieToken(req) {
  return (req.headers.cookie || "").split(";").map((p) => p.trim()).find((p) => p.startsWith("mb_session="))?.slice(11);
}
async function bodyJson(req) {
  if (!String(req.headers["content-type"] || "").startsWith("application/json")) {
    const e = new Error("Gunakan JSON."); e.status = 415; throw e;
  }
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > 8192) { const e = new Error("Input terlalu panjang."); e.status = 413; throw e; }
  }
  try { const value = JSON.parse(body); if (!value || typeof value !== "object" || Array.isArray(value)) throw 0; return value; }
  catch { const e = new Error("Input tidak valid."); e.status = 400; throw e; }
}
function createApp({ dataDir = path.join(ROOT, "data"), bank, pinRecord, publicOrigin = "", demo = false,
  now, logger = console } = {}) {
  if (publicOrigin && (new URL(publicOrigin).protocol !== "https:" || new URL(publicOrigin).origin !== publicOrigin))
    throw new Error("PUBLIC_ORIGIN harus berupa origin HTTPS tanpa path/garis miring akhir.");
  const ledger = bank || createMiniBank({ dataDir, requireExisting: true, ...(now ? { now } : {}) });
  const credential = pinRecord || loadPin(path.join(dataDir, "web-pin.json"));
  const auth = createAuth({ filename: path.join(dataDir, "web-auth.db"), pinRecord: credential });
  const demoUser = SHARED_ACCOUNT;
  const demoCsrf = crypto.randomBytes(32).toString("base64url");
  const loginTraffic = new Map();
  const send = (res, code, value) => {
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(value));
  };
  const server = http.createServer(async (req, res) => {
    const requestId = crypto.randomUUID().slice(0, 8);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors " + (demo ? "'self'" : "'none'") + "; base-uri 'none'; form-action 'self'");
    try {
      const host = req.headers.host || "";
      const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
      const localOrigin = "http://" + host;
      const origin = publicOrigin || localOrigin;
      const isLocalHost = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host);
      const approvedHost = isLocalHost || (publicOrigin && host === new URL(publicOrigin).host);
      if (!demo && (!loopback || !approvedHost)) return send(res, 403, { error: "Akses hanya melalui localhost atau proxy HTTPS yang ditentukan." });
      const url = new URL(req.url, "http://localhost");
      if (demo && url.pathname === "/preview-mobile" && req.method === "GET") {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        return res.end('<!doctype html><html lang="id"><meta charset="utf-8"><title>Mini Bank · Preview mobile</title><meta name="viewport" content="width=device-width, initial-scale=1"><body style="margin:0;min-height:100vh;background:#edeef4;display:grid;place-content:center;font:12px system-ui;color:#7a6d8c"><p style="text-align:center;letter-spacing:1px">MINI BANK · 390 × 844 · DATA CONTOH</p><iframe title="Mini Bank layar HP" src="/" width="390" height="844" style="border:8px solid white;border-radius:28px;box-shadow:0 15px 70px #29203915;background:#f7f8fc"></iframe></body></html>');
      }
      const mutating = !["GET", "HEAD"].includes(req.method);
      if (mutating && req.headers.origin !== origin && !demo) return send(res, 403, { error: "Origin permintaan tidak diizinkan." });
      if (req.method === "OPTIONS") return send(res, 405, { error: "Metode tidak tersedia." });
      if (!url.pathname.startsWith("/api/")) {
        if (!["GET", "HEAD"].includes(req.method)) return send(res, 405, { error: "Metode tidak tersedia." });
        const routes = new Map(["/", "/index.html", "/app-pin.js", "/ui.css", "/manifest.webmanifest", "/sw.js",
          "/assets/icon.svg", "/assets/icon-192.png", "/assets/icon-512.png", "/assets/apple-touch-icon.png"].map((p) => [p, p === "/" ? "index.html" : p.slice(1)]));
        const file = routes.get(url.pathname);
        if (!file) return send(res, 404, { error: "Halaman tidak ditemukan." });
        const filename = path.join(PUBLIC, file === "app-pin.js" ? "app.js" : file);
        if (file === "sw.js") res.setHeader("Service-Worker-Allowed", "/");
        res.setHeader("Content-Type", MIME[path.extname(filename)] || "application/octet-stream");
        if (req.method === "HEAD") return res.end();
        return fs.createReadStream(filename).on("error", () => { if (!res.headersSent) res.statusCode = 404; res.end(); }).pipe(res);
      }
      const token = cookieToken(req);
      const session = demo ? { user: demoUser, csrf: demoCsrf } : auth.session(token);
      if (url.pathname === "/api/session" && req.method === "GET") {
        if (!session) return send(res, 401, { error: "Silakan masuk." });
        return send(res, 200, { name: session.user.name, authMode: "shared-pin",
          csrf: session.csrf, demo, refreshSeconds: 15 });
      }
      if (url.pathname === "/api/login" && req.method === "POST") {
        const input = await bodyJson(req);
        const ip = req.socket.remoteAddress;
        const stamp = Date.now();
        const counter = loginTraffic.get(ip);
        if (counter && counter.until > stamp && counter.count >= 20) return send(res, 429, { error: "Terlalu banyak percobaan. Tunggu 15 menit." });
        loginTraffic.set(ip, { until: counter && counter.until > stamp ? counter.until : stamp + 900000,
          count: counter && counter.until > stamp ? counter.count + 1 : 1 });
        const result = auth.attempt(input.pin, ip, input.remember !== false);
        if (result?.blocked) return send(res, 429, { error: "Terlalu banyak percobaan. Tunggu 15 menit." });
        if (!result) return send(res, 401, { error: "PIN tidak sesuai. Gunakan PIN bersama yang terdiri dari 6 digit angka." });
        loginTraffic.delete(ip);
        res.setHeader("Set-Cookie", "mb_session=" + result.token + "; HttpOnly; SameSite=Strict; Path=/; Max-Age=" + result.maxAge + (publicOrigin ? "; Secure" : ""));
        return send(res, 200, { ok: true });
      }
      if (!session) return send(res, 401, { error: "Sesi berakhir. Silakan masuk kembali." });
      if (mutating && req.headers["x-csrf-token"] !== session.csrf) return send(res, 403, { error: "Sesi formulir tidak valid. Muat ulang halaman." });
      const actor = session.user.actor;
      if (url.pathname === "/api/logout" && req.method === "POST") {
        auth.logout(token); res.setHeader("Set-Cookie", "mb_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" + (publicOrigin ? "; Secure" : ""));
        return send(res, 200, { ok: true });
      }
      if (url.pathname === "/api/dashboard" && req.method === "GET") return send(res, 200, ledger.webSnapshot(actor, url.searchParams.get("month")));
      if (url.pathname === "/api/history" && req.method === "GET") return send(res, 200, ledger.webHistory(actor, Object.fromEntries(url.searchParams)));
      if (url.pathname === "/api/transactions" && req.method === "POST") {
        const input = await bodyJson(req);
        const value = ledger.webAppend(actor, input, req.headers["idempotency-key"]);
        return send(res, value.duplicate ? 200 : 201, value);
      }
      if (url.pathname === "/api/export" && req.method === "GET") {
        const month = url.searchParams.get("month");
        const rows = ledger.webExport(actor, month);
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", 'attachment; filename="mini-bank-' + (month || "bulan-ini") + '.csv"');
        return res.end(exportCsv(rows));
      }
      return send(res, 404, { error: "Layanan tidak ditemukan." });
    } catch (error) {
      if (error instanceof InputError) return send(res, 400, { error: error.message });
      if (error.status) return send(res, error.status, { error: error.message });
      logger.error("[MiniBank Web] " + requestId + ": " + error.message);
      if (!res.headersSent) send(res, 500, { error: "Penyimpanan belum dapat dipastikan. Coba lagi dengan formulir yang sama; ID permintaan mencegah catatan ganda.", reference: requestId });
      else res.end();
    }
  });
  server.headersTimeout = 15000; server.requestTimeout = 15000;
  return { server, ledger, close: async () => { await new Promise((resolve) => server.close(resolve)); auth.close(); if (!bank) ledger.close(); } };
}
if (require.main === module) {
  try {
    if (fs.existsSync(path.join(ROOT, ".env"))) process.loadEnvFile(path.join(ROOT, ".env"));
    const settingsFile = path.join(ROOT, "data", "web-settings.json");
    const settings = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile)) : {};
    const publicOrigin = process.env.MINIBANK_PUBLIC_ORIGIN || settings.publicOrigin || "";
    const dataDir = process.env.MINIBANK_DATA_DIR ? path.resolve(process.env.MINIBANK_DATA_DIR) : path.join(ROOT, "data");
    const port = Number(process.env.MINIBANK_WEB_PORT || 3030);
    const app = createApp({ dataDir, publicOrigin });
    app.server.listen(port, "127.0.0.1", () => console.log("Mini Bank UI: " + (publicOrigin || "http://localhost:" + port) + "\nDatabase: " + path.join(dataDir, "keuangan.db")));
    app.server.on("error", (e) => { console.error("UI gagal berjalan: " + e.message); process.exitCode = 1; });
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => app.close().then(() => process.exit(0)));
  } catch (error) { console.error("UI belum dapat dijalankan: " + error.message); process.exitCode = 1; }
}
module.exports = { createApp, exportCsv };
