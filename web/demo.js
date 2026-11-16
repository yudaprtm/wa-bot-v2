"use strict";
// Preview uses only synthetic data in a temporary directory, NEVER the bot's data/.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { createMiniBank, SHARED_USERS, jakartaDate } = require("../src/mini-bank");
const { pinHash } = require("./auth");
const { createApp } = require("./server");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mini-bank-demo-"));
let instant = new Date();
const current = jakartaDate(instant);
const bank = createMiniBank({ dataDir: dir, now: () => instant });
const salaryDate = new Date(current + "T08:00:00Z");
salaryDate.setUTCMonth(salaryDate.getUTCMonth() - (salaryDate.getUTCDate() < 25 ? 1 : 0)); salaryDate.setUTCDate(25);
instant = salaryDate;
bank.webAppend(SHARED_USERS[0], {kind:"salary",amount:"10800000"},crypto.randomUUID());
const expenses = [
  [1,"Belanja kebutuhan rumah","Belanja",425000], [2,"Kopi & sarapan","Makan & minum",68000],
  [3,"Internet bulanan","Tagihan",325000], [4,"Makan siang bersama","Makan & minum",95000],
  [5,"Bensin & parkir","Transport",175000], [6,"Belanja mingguan","Belanja",280000],
  [7,"Kopi sore","Makan & minum",42000], [8,"Vitamin dan obat","Kesehatan",120000],
  [9,"Kereta ke kantor","Transport",28000], [10,"Makan siang","Makan & minum",45000],
  [11,"Belanja perlengkapan","Belanja",180000], [12,"Nonton akhir pekan","Hiburan",130000],
  [13,"Jajan sore","Makan & minum",35000], [14,"Makan malam","Makan & minum",85000],
  [15,"Ojek ke kantor","Transport",22000], [16,"Kopi & roti pagi","Makan & minum",38000],
];
const month = current.slice(0,7), day = Number(current.slice(-2));
for (const [d,description,category,amount] of expenses.filter((r) => r[0] <= day)) {
  instant = new Date(month + "-" + String(d).padStart(2,"0") + "T02:00:00Z");
  bank.webAppend(SHARED_USERS[d % 2],{kind:"entry",wallet:"harian",direction:"out",amount:String(amount),category,description},crypto.randomUUID());
}
instant = new Date(month + "-" + String(Math.min(10,day)).padStart(2,"0") + "T03:00:00Z");
bank.webAppend(SHARED_USERS[0],{kind:"entry",wallet:"saving",direction:"in",amount:"650000",description:"Bonus proyek",category:"Bonus"},crypto.randomUUID());
bank.webAppend(SHARED_USERS[1],{kind:"entry",wallet:"harian",direction:"in",amount:"400000",description:"Pengembalian dana",category:"Lainnya"},crypto.randomUUID());
// Some fixture entries were notionally entered from WA: change only the synthetic database.
const { DatabaseSync } = require("node:sqlite");
const fixture = new DatabaseSync(path.join(dir,"keuangan.db"));
fixture.exec("UPDATE mini_bank_ops SET message_id='demo-wa-' || id WHERE id % 3 <> 0"); fixture.close();
instant = new Date();
const pinRecord = { version: 1, ...pinHash(String(crypto.randomInt(0,1000000)).padStart(6,"0")) };
const app = createApp({dataDir:dir,bank,pinRecord,demo:true});
const portArg = process.argv.indexOf("--port");
const port = Number(portArg >= 0 ? process.argv[portArg + 1] : process.env.PORT || 3030);
app.server.listen(port,"0.0.0.0",() => console.log("Mini Bank DEMO (data contoh): http://localhost:" + port));
for (const signal of ["SIGINT","SIGTERM"]) process.once(signal,async () => {
  await app.close(); bank.close(); fs.rmSync(dir,{recursive:true,force:true}); process.exit(0);
});
