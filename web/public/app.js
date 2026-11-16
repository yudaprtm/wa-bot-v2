"use strict";
const $ = (id) => document.getElementById(id);
const NS = "http://www.w3.org/2000/svg";
let session = null, data = null, currentView = "dashboard", refreshSequence = 0;
let historyItems = [], historyTotal = 0, historySequence = 0, busy = false, connected = true;
let kind = "out", wallet = "harian", lastPayload = "", requestKey = "", installEvent = null, toastTimer;
const money = (value) => "Rp " + new Intl.NumberFormat("id-ID").format(BigInt(value || 0));
const icon = (name) => {
  const svg = document.createElementNS(NS, "svg"); svg.setAttribute("class", "icon"); svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(NS, "use"); use.setAttribute("href", "#i-" + name); svg.append(use); return svg;
};
const node = (tag, className, text) => {
  const e = document.createElement(tag); if (className) e.className = className; if (text !== undefined) e.textContent = text; return e;
};
function today() {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const value = (type) => parts.find((p) => p.type === type).value;
  return value("year") + "-" + value("month") + "-" + value("day");
}
function dateLabel(value, options = { day: "numeric", month: "short" }) {
  return new Intl.DateTimeFormat("id-ID", { ...options, timeZone: "UTC" }).format(new Date(value + "T00:00:00Z"));
}
const monthLabel = (value) => dateLabel(value + "-01", { month: "long", year: "numeric" });
function text(id, value) { $(id).textContent = value; }
function toast(message, error = false) {
  clearTimeout(toastTimer); $("toast").classList.toggle("error", error);
  $("toast").querySelector("span").textContent = message; $("toast").hidden = false;
  toastTimer = setTimeout(() => { $("toast").hidden = true; }, 4500);
}
async function api(url, options = {}) {
  const headers = { ...options.headers };
  if (options.body) headers["Content-Type"] = "application/json";
  if (options.method && options.method !== "GET" && session) headers["X-CSRF-Token"] = session.csrf;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 16000);
  try {
    const response = await fetch(url, { ...options, headers, signal: controller.signal, credentials: "same-origin", cache: "no-store" });
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(result.error || "Permintaan belum berhasil."); error.status = response.status;
      if (response.status === 401 && session && !url.includes("/login")) showLogin("Sesi berakhir. Silakan masuk kembali.");
      throw error;
    }
    return result;
  } catch (error) {
    if (error.name === "AbortError" || error instanceof TypeError) {
      const e = new Error("Koneksi belum tersedia. Jika sedang menyimpan, coba kembali dengan formulir yang sama agar tidak tercatat dua kali.");
      e.network = true; throw e;
    }
    throw error;
  } finally { clearTimeout(timeout); }
}
function showLogin(message = "") {
  session = null; data = null; historyItems = [];
  $("boot").hidden = true; $("app").hidden = true; $("login-screen").hidden = false;
  $("pin").value = "";
  $("login-error").hidden = !message; text("login-error", message);
  if ($("entry-dialog").open) $("entry-dialog").close();
  $("entry-form").reset();
  for (const id of ["total-balance", "daily-balance", "saving-balance", "weekly-amount", "month-income", "month-expense"]) text(id, "Rp —");
  $("recent-list").replaceChildren(); $("history-list").replaceChildren();
}
function connection(ok) {
  connected = ok && navigator.onLine;
  $("offline-banner").hidden = connected;
  $("save-entry").disabled = busy || !connected;
  if (!connected) text("last-sync", "Belum tersambung · data belum diperbarui");
}
async function startSession(value) {
  session = value; text("user-name", value.name || value.username);
  text("user-avatar", (value.name || value.username || "P").slice(0, 1).toUpperCase());
  $("demo-badge").hidden = !value.demo;
  $("month").value = today().slice(0, 7);
  await refresh();
  if (!session) return;
  $("boot").hidden = true; $("login-screen").hidden = true; $("app").hidden = false;
  if (new URLSearchParams(location.search).get("action") === "expense" && data) {
    openEntry("out"); history.replaceState(null, "", "/");
  }
}
async function refresh({ quiet = false } = {}) {
  if (!session) return;
  const sequence = ++refreshSequence;
  const month = $("month").value || today().slice(0, 7);
  $("refresh").classList.add("refreshing");
  try {
    const result = await api("/api/dashboard?month=" + encodeURIComponent(month));
    if (sequence !== refreshSequence || !session) return;
    data = result; renderDashboard(); connection(true);
    $("error-banner").hidden = !result.legacyRecords;
    if (result.legacyRecords) text("error-banner", "Ada catatan dari versi ledger lama yang masih dipertahankan. Catatan legacy tersebut belum digabung ke saldo Saving/Harian.");
    text("last-sync", "Diperbarui " + new Intl.DateTimeFormat("id-ID", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jakarta" }).format(new Date(result.generatedAt)) + " WIB");
    if (currentView === "history") await loadHistory(true);
  } catch (error) {
    if (!session) return;
    connection(false);
    if (!quiet) toast(error.message, true);
  } finally { $("refresh").classList.remove("refreshing"); }
}
function renderDashboard() {
  $("total-balance").classList.remove("skeleton-text");
  text("total-balance", money(data.balances.total)); text("daily-balance", money(data.balances.harian));
  text("saving-balance", money(data.balances.saving)); text("month-income", money(data.monthTotals.income));
  text("month-expense", money(data.monthTotals.expense)); text("chart-period", monthLabel(data.month));
  text("today-label", dateLabel(data.today, { weekday: "long", day: "numeric", month: "long", year: "numeric" }).toUpperCase());
  const first = data.budget.weeks[0];
  text("weekly-amount", money(first.amount));
  text("week-caption", "Anggaran " + first.days + " hari berikutnya");
  text("daily-recommendation", money(data.budget.daily)); text("days-left", data.budget.days + " hari menuju gajian");
  text("next-payday", dateLabel(data.budget.next));
  const maxBalance = BigInt(data.balances.harian) > 0n;
  document.querySelector(".budget-track span").style.width = maxBalance ? Math.round(first.days / data.budget.days * 100) + "%" : "0%";
  text("budget-page-daily", money(data.budget.daily)); text("budget-page-balance", money(data.balances.harian));
  text("budget-page-payday", dateLabel(data.budget.next)); text("budget-page-days", data.budget.days + " hari");
  $("budget-warning").hidden = maxBalance;
  renderWeeks(); renderTrend(); renderCategories();
  renderTransactions($("recent-list"), data.recent, "Belum ada catatan di periode ini.", "Mulai dari satu pemasukan atau pengeluaran kecil.");
  text("form-daily-balance", money(data.balances.harian)); text("form-saving-balance", money(data.balances.saving));
}
function emptyState(title, subtitle, withButton = false) {
  const e = node("div", "empty"), holder = node("span", "mini-icon purple");
  holder.append(icon("wallet")); e.append(holder, node("strong", "", title), node("p", "", subtitle));
  if (withButton) {
    const button = node("button", "text-button", "Catat transaksi pertama");
    button.addEventListener("click", () => openEntry("out")); e.append(button);
  }
  return e;
}
function renderTransactions(target, items, emptyTitle, emptyText) {
  target.replaceChildren();
  if (!items.length) { target.append(emptyState(emptyTitle, emptyText, true)); return; }
  for (const r of items) {
    const row = node("div", "transaction-row");
    const incoming = r.direction === "in";
    const holder = node("span", "mini-icon " + (incoming ? "mint" : r.wallet === "saving" ? "purple" : "coral"));
    holder.append(icon(incoming ? "down" : r.wallet === "saving" ? "leaf" : "up"));
    const main = node("div", "transaction-main"), detail = node("p", "");
    detail.append(node("span", "", (r.wallet === "saving" ? "Saving" : "Harian") + " · " + r.category));
    detail.append(node("span", "source-tag", r.source === "web" ? "Web" : "WhatsApp"));
    main.append(node("strong", "", r.description), detail);
    const amount = node("div", "transaction-amount");
    amount.append(node("strong", incoming ? "income" : "", (incoming ? "+" : "−") + money(r.amount)));
    amount.append(node("small", "", dateLabel(r.date) + " · #" + r.operationId));
    row.append(holder, main, amount); target.append(row);
  }
}
function svgElement(tag, attrs, content) {
  const e = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) e.setAttribute(key, value);
  if (content !== undefined) e.textContent = content;
  return e;
}
function compact(value) {
  if (value >= 1000000000) return new Intl.NumberFormat("id-ID", {maximumFractionDigits: 1}).format(value / 1000000000) + " M";
  if (value >= 1000000) return new Intl.NumberFormat("id-ID", {maximumFractionDigits: 1}).format(value / 1000000) + " jt";
  if (value >= 1000) return new Intl.NumberFormat("id-ID", {maximumFractionDigits: 0}).format(value / 1000) + " rb";
  return String(Math.round(value));
}
function renderTrend() {
  const target = $("trend-chart"); target.replaceChildren();
  if (!data.monthTotals.count) {
    const e = emptyState("Ruang untuk cerita baru.", "Grafik akan muncul setelah ada pencatatan."); e.classList.add("chart-empty"); target.append(e); return;
  }
  const values = data.trend;
  const high = Math.max(100, ...values.flatMap((r) => [Number(r.income), Number(r.expense)]));
  const unit = 10 ** Math.floor(Math.log10(high)), max = Math.ceil(high / unit) * unit;
  const w = 600, h = 170, l = 44, r = 8, t = 10, bottom = 26;
  const x = (i) => l + i / Math.max(1, values.length - 1) * (w - l - r);
  const y = (v) => h - bottom - Number(v) / max * (h - bottom - t);
  const svg = svgElement("svg", {viewBox: "0 0 600 170", role: "img", "aria-label": "Arus keuangan harian " + monthLabel(data.month)});
  const title = svgElement("title", {}, "Pemasukan hijau, pengeluaran merah muda. Total masuk " + money(data.monthTotals.income) + ", keluar " + money(data.monthTotals.expense));
  svg.append(title);
  for (const ratio of [0, .5, 1]) {
    const yPos = y(max * ratio);
    svg.append(svgElement("line", {x1:l,y1:yPos,x2:w-r,y2:yPos,stroke:"#f0ecf6","stroke-dasharray":"4 5"}));
    svg.append(svgElement("text", {x:l-9,y:yPos+3,"text-anchor":"end"}, compact(max * ratio)));
  }
  for (const day of [1, 7, 14, 21, values.length]) {
    const pos = x(day - 1);
    svg.append(svgElement("text", {x:pos,y:h-3,"text-anchor":"middle"}, String(day).padStart(2, "0")));
  }
  const defs = svgElement("defs", {});
  for (const [name, color] of [["income","#3fba9b"],["expense","#e69b8c"]]) {
    const gradient = svgElement("linearGradient", {id: "gradient-" + name, x1:"0",y1:"0",x2:"0",y2:"1"});
    gradient.append(svgElement("stop", {offset:"0%","stop-color":color,"stop-opacity":".14"}),
      svgElement("stop", {offset:"100%","stop-color":color,"stop-opacity":"0"}));
    defs.append(gradient);
  }
  svg.append(defs);
  for (const [key, color] of [["income","#45b99d"],["expense","#e49a8f"]]) {
    const points = values.map((v,i) => x(i) + "," + y(v[key]));
    const path = "M" + points.join(" L");
    svg.append(svgElement("path", {d:path+" L"+x(values.length-1)+","+y(0)+" L"+x(0)+","+y(0)+" Z",fill:"url(#gradient-"+key+")"}));
    svg.append(svgElement("path", {d:path,fill:"none",stroke:color,"stroke-width":"2","stroke-linejoin":"round","stroke-linecap":"round"}));
    values.forEach((v,i) => {
      if (BigInt(v[key]) > 0n) {
        const dot = svgElement("circle", {cx:x(i),cy:y(v[key]),r:"2.6",fill:color,stroke:"white","stroke-width":"1"});
        dot.append(svgElement("title", {}, dateLabel(v.date) + " · " + (key === "income" ? "Masuk " : "Keluar ") + money(v[key]))); svg.append(dot);
      }
    });
  }
  target.append(svg);
}
function renderCategories() {
  const target = $("category-chart"); target.replaceChildren();
  if (!data.categories.length) { target.append(emptyState("Belum ada pengeluaran.", "Saat ada pengeluaran, pembagiannya akan terlihat di sini.")); return; }
  const colors = ["#9380e8","#8bcab4","#eab2a3","#a8bfe3","#cfb6e4","#edcf99"];
  const categories = data.categories.slice(0, 5).map((c) => ({...c}));
  if (data.categories.length > 5) categories.push({name:"Kategori lainnya",amount:String(data.categories.slice(5).reduce((s,c) => s + BigInt(c.amount), 0n))});
  const total = BigInt(data.monthTotals.expense);
  let angle = 0;
  const stops = categories.map((c,i) => {
    const start = angle; angle += Number(BigInt(c.amount) * 10000n / total) / 100;
    return colors[i] + " " + start + "% " + Math.min(100, angle) + "%";
  });
  const wrap = node("div", "donut-wrap"), donut = node("div", "donut");
  donut.style.background = "conic-gradient(" + stops.join(",") + ")";
  donut.setAttribute("role","img"); donut.setAttribute("aria-label","Pembagian pengeluaran berdasarkan kategori");
  const label = node("div", "donut-label"); label.append(node("small","","Kategori"),node("strong","",String(data.categories.length)));
  donut.append(label);
  const sum = node("div","donut-total"); sum.append(node("small","","Total pengeluaran"),node("strong","",money(total)));
  wrap.append(donut,sum); target.append(wrap);
  categories.forEach((c,i) => {
    const row = node("div","category-row"), dot = node("i","legend-dot"); dot.style.background = colors[i];
    const name = node("span","category-name",c.name); name.title = c.name;
    row.append(dot,name,node("strong","",money(c.amount))); target.append(row);
  });
}
function renderWeeks() {
  const target = $("weeks-list"); target.replaceChildren();
  data.budget.weeks.forEach((week,i) => {
    const row = node("div","week-row"), main = node("div","week-main");
    main.append(node("strong","",dateLabel(week.start)+" – "+dateLabel(week.end)),node("small","",week.days+" hari"+(i === 0 ? " · Mulai hari ini" : "")));
    row.append(node("span","week-number",String(i+1)),main,node("strong","",money(week.amount))); target.append(row);
  });
}
function setView(name) {
  if (!["dashboard","history","budget","more"].includes(name)) return;
  currentView = name;
  for (const view of document.querySelectorAll(".view")) view.hidden = view.id !== "view-" + name;
  for (const button of document.querySelectorAll("[data-view]")) button.classList.toggle("active",button.dataset.view === name);
  const titles = {
    dashboard: ["Ruang untuk hidup lebih tenang.","Lihat kabar keuanganmu, lalu lanjutkan harimu.","Ringkasan"],
    history: ["Setiap catatan punya cerita.","Pemasukan dan pengeluaranmu, tertata dalam satu tempat.","Riwayat"],
    budget: ["Hari ini cukup. Besok tetap tenang.","Langkah kecil untuk menjaga pengeluaran sampai gajian.","Anggaran"],
    more: ["Ruang ini milik kalian.","Bawa catatanmu, pasang aplikasi, dan atur aksesmu.","Lainnya"],
  };
  text("page-title",titles[name][0]); text("page-subtitle",titles[name][1]); text("breadcrumb-view",titles[name][2]);
  if (name === "history") loadHistory(true);
  window.scrollTo({top:0,behavior:"smooth"});
}
async function loadHistory(reset = true) {
  if (!session) return;
  const sequence = ++historySequence;
  const params = new URLSearchParams({month:$("month").value,wallet:$("history-wallet").value,
    direction:$("history-direction").value,search:$("search").value,
    offset:reset ? "0" : String(historyItems.length),limit:"25"});
  if (reset) text("history-count","Memuat catatan…");
  $("load-more").disabled = true;
  try {
    const result = await api("/api/history?"+params);
    if (sequence !== historySequence || !session) return;
    historyItems = reset ? result.items : [...historyItems,...result.items]; historyTotal = result.total;
    renderTransactions($("history-list"),historyItems,"Tidak ada catatan yang cocok.","Coba periode atau filter lain, atau buat catatan baru.");
    text("history-count",historyItems.length+" dari "+historyTotal+" catatan");
    $("load-more").hidden = historyItems.length >= historyTotal;
  } catch (error) {
    if (session) { text("history-count","Riwayat belum dapat dimuat"); toast(error.message,true); }
  } finally { $("load-more").disabled = false; }
}
function setKind(value) {
  kind = value; $("entry-error").hidden = true;
  for (const button of document.querySelectorAll("[data-kind]")) button.classList.toggle("selected",button.dataset.kind === value);
  text("entry-title",value === "salary" ? "Catat gaji" : value === "in" ? "Tambah pemasukan" : "Catat pengeluaran");
  text("amount-label",value === "salary" ? "Total gaji" : "Nominal");
  $("wallet-field").hidden = value === "salary"; $("description-fields").hidden = value === "salary";
  $("salary-preview").hidden = value !== "salary"; $("description").required = value !== "salary";
  text("amount-help",value === "salary" ? "Minimal Rp 6.000.000 untuk alokasi Saving." : "Rupiah bulat, tanpa koma.");
  salaryPreview();
}
function setWallet(value) {
  wallet = value;
  for (const button of document.querySelectorAll("[data-wallet]")) button.classList.toggle("selected",button.dataset.wallet === value);
}
function salaryPreview() {
  const digits = $("amount").value.replace(/\./g,"");
  const amount = /^\d+$/.test(digits) ? BigInt(digits) : 0n;
  text("salary-daily",money(amount > 6000000n ? amount-6000000n : 0n));
}
function openEntry(value) {
  if (!data) return toast("Tunggu sampai data tersambung.",true);
  if (!connected) return toast("Hubungkan kembali sebelum mencatat transaksi.",true);
  $("entry-form").reset(); $("amount").setCustomValidity(""); $("entry-error").hidden = true; requestKey = lastPayload = "";
  setKind(value); setWallet("harian");
  text("form-daily-balance",money(data.balances.harian)); text("form-saving-balance",money(data.balances.saving));
  $("entry-dialog").showModal();
  // Focus remains on the dialog heading on mobile so the full form is initially visible.
  if (window.innerWidth > 620) $("amount").focus();
}
function saveBusy(value) {
  busy = value; $("save-entry").disabled = value || !connected;
  for (const e of $("entry-form").querySelectorAll("input,select,button")) if (e.id !== "save-entry") e.disabled = value;
  $("save-entry").replaceChildren(value ? node("span","spinner") : icon("check"),
    node("span","",value ? "Menyimpan…" : "Simpan catatan"));
}
function closeEntry() { if (!busy) $("entry-dialog").close(); }
async function saveEntry(event) {
  event.preventDefault();
  if (busy || !connected) return;
  $("entry-error").hidden = true;
  const raw = $("amount").value;
  const valid = /^(?:\d+|\d{1,3}(?:\.\d{3})+)$/.test(raw);
  const amount = valid ? BigInt(raw.replace(/\./g,"")) : 0n;
  let error = "";
  if (!valid || amount <= 0n) error = "Isi nominal rupiah bulat yang lebih dari nol.";
  else if (amount > 1000000000000n) error = "Nominal maksimal Rp 1.000.000.000.000.";
  else if (kind === "salary" && amount < 6000000n) error = "Gaji minimal Rp 6.000.000 untuk pembagian Saving tetap.";
  else if (kind !== "salary" && !$("description").value.trim()) error = "Tambahkan keterangan singkat agar catatan mudah ditemukan.";
  else if (kind === "out" && amount > BigInt(data.balances[wallet])) error = "Saldo "+(wallet === "saving" ? "Saving" : "Harian")+" belum cukup.";
  if (error) { text("entry-error",error); $("entry-error").hidden = false; return; }
  const payload = kind === "salary" ? {kind:"salary",amount:String(amount)} :
    {kind:"entry",wallet,direction:kind,amount:String(amount),description:$("description").value.trim(),category:$("category").value};
  const fingerprint = JSON.stringify(payload);
  if (fingerprint !== lastPayload) { lastPayload = fingerprint; requestKey = crypto.randomUUID(); }
  saveBusy(true);
  try {
    const result = await api("/api/transactions",{method:"POST",headers:{"Idempotency-Key":requestKey},body:JSON.stringify(payload)});
    $("entry-dialog").close(); $("entry-form").reset(); requestKey = lastPayload = "";
    toast(result.message+" · #"+result.id);
    await refresh({quiet:true});
  } catch (err) {
    if (session) { text("entry-error",err.message); $("entry-error").hidden = false; }
    if (err.network) connection(false);
  } finally { saveBusy(false); }
}
function download() {
  if (!session || !connected) return toast("Hubungkan kembali sebelum mengunduh.",true);
  const a = document.createElement("a"); a.href = "/api/export?month="+encodeURIComponent($("month").value);
  a.download = ""; a.click();
}
$("login-form").addEventListener("submit",async (event) => {
  event.preventDefault(); $("login-submit").disabled = true; text("login-submit","Menyambungkan…"); $("login-error").hidden = true;
  try {
    await api("/api/login",{method:"POST",body:JSON.stringify({pin:$("pin").value,remember:$("remember").checked})});
    await startSession(await api("/api/session"));
  } catch (error) { text("login-error",error.message); $("login-error").hidden = false; }
  finally { $("login-submit").disabled = false; $("login-submit").replaceChildren(node("span","","Masuk"),icon("arrow")); }
});
$("pin-toggle").addEventListener("click",() => {
  const show = $("pin").type === "password"; $("pin").type = show ? "text" : "password";
  $("pin-toggle").setAttribute("aria-label",show ? "Sembunyikan PIN" : "Tampilkan PIN");
});
for (const button of document.querySelectorAll("[data-view]")) button.addEventListener("click",() => setView(button.dataset.view));
for (const button of document.querySelectorAll("[data-add]")) button.addEventListener("click",() => openEntry(button.dataset.add));
for (const button of document.querySelectorAll("[data-kind]")) button.addEventListener("click",() => setKind(button.dataset.kind));
for (const button of document.querySelectorAll("[data-wallet]")) button.addEventListener("click",() => setWallet(button.dataset.wallet));
for (const button of document.querySelectorAll("[data-wallet-history]")) button.addEventListener("click",() => {
  $("history-wallet").value = button.dataset.walletHistory; setView("history");
});
$("month").addEventListener("change",() => { if ($("month").value) refresh(); });
$("refresh").addEventListener("click",() => refresh());
$("refresh-more").addEventListener("click",() => refresh());
$("history-wallet").addEventListener("change",() => loadHistory(true));
$("history-direction").addEventListener("change",() => loadHistory(true));
let searchTimer;
$("search").addEventListener("input",() => { clearTimeout(searchTimer); searchTimer = setTimeout(() => loadHistory(true),300); });
$("load-more").addEventListener("click",() => loadHistory(false));
$("export-history").addEventListener("click",download); $("export-more").addEventListener("click",download);
$("close-entry").addEventListener("click",closeEntry);
$("entry-dialog").addEventListener("cancel",(event) => { if (busy) event.preventDefault(); });
$("entry-form").addEventListener("submit",saveEntry);
$("amount").addEventListener("input",() => {
  const raw = $("amount").value.replace(/\./g,"");
  if (/^\d*$/.test(raw)) {
    $("amount").value = raw ? new Intl.NumberFormat("id-ID").format(BigInt(raw)) : "";
    $("amount").setCustomValidity("");
  } else $("amount").setCustomValidity("Gunakan angka positif, tanpa koma atau tanda minus.");
  salaryPreview();
});
$("logout").addEventListener("click",async () => {
  try { await api("/api/logout",{method:"POST",body:"{}"}); showLogin(); toast("Kamu sudah keluar."); }
  catch(error) { toast(error.message,true); }
});
window.addEventListener("offline",() => connection(false));
window.addEventListener("online",() => refresh({quiet:true}));
document.addEventListener("visibilitychange",() => { if (!document.hidden && session) refresh({quiet:true}); });
setInterval(() => { if (!document.hidden && session && !busy) refresh({quiet:true}); },15000);
window.addEventListener("beforeinstallprompt",(event) => {
  event.preventDefault(); installEvent = event; $("install-button").hidden = false;
});
$("install-button").addEventListener("click",async () => {
  if (!installEvent) return;
  await installEvent.prompt(); const choice = await installEvent.userChoice;
  if (choice.outcome === "accepted") toast("Mini Bank ditambahkan ke layar utama.");
  installEvent = null; $("install-button").hidden = true;
});
window.addEventListener("appinstalled",() => { $("install-button").hidden = true; });
if ("serviceWorker" in navigator && window.isSecureContext) {
  navigator.serviceWorker.register("/sw.js").catch(() => {
    text("install-hint","Aplikasi tetap bisa dipakai. Pemasangan ke layar utama belum tersedia; coba muat ulang lewat HTTPS.");
  });
}
(async () => {
  try {
    const value = await api("/api/session");
    if (value.demo && new URLSearchParams(location.search).has("login-preview")) showLogin();
    else await startSession(value);
  }
  catch(error) { showLogin(error.status === 401 ? "" : error.message); }
})();

