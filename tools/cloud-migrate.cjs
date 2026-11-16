'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {backupExisting}=require('../web/backup');
const {createInterface}=require('node:readline/promises');
const ROOT=path.join(__dirname,'..'),DIR=path.join(ROOT,'data');
function exportData(filename){
 if(!fs.existsSync(filename))throw Error('Database bot tidak ditemukan. Jalankan dari folder bot lama.');
 const db=new DatabaseSync(filename,{readOnly:true});
 try{db.exec('BEGIN');const table=n=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(n);for(const n of ['mini_bank_ops','mini_bank_entries','mini_bank_meta'])if(!table(n))throw Error('Schema Saving/Harian tidak ditemukan. Data tidak diubah.');const data={version:1,meta:db.prepare('SELECT * FROM mini_bank_meta ORDER BY key').all(),ops:db.prepare('SELECT id,owner,actor,message_id,type,business_date,created_at,salary_cycle,deleted_at FROM mini_bank_ops ORDER BY id').all(),entries:db.prepare('SELECT id,op_id,wallet,direction,amount,category,description FROM mini_bank_entries ORDER BY id').all(),legacy:table('transactions')?db.prepare('SELECT * FROM transactions').all():[]};for(const rows of [data.ops,data.entries])for(const row of rows)for(const v of Object.values(row))if(typeof v==='number'&&!Number.isSafeInteger(v))throw Error('Angka di database melebihi presisi yang aman. Perlu migrasi khusus.');return data;}finally{db.close();}
}
async function migrate({url,secret,dir=DIR,fetcher=fetch}){
 if(new URL(url).protocol!=='https:'||new URL(url).origin!==url||secret.length<32)throw Error('URL harus origin HTTPS dan BOT_SECRET harus benar.');
 const source=path.join(dir,'keuangan.db'),target=path.join(dir,'backups','before-cloud-'+Date.now()+'.db');
 await backupExisting(source,target);const data=exportData(source),digest=crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
 if(data.ops.length>600||data.entries.length>2000)throw Error('Database lebih besar dari batas migrasi otomatis. Backup aman; perlu migrasi bertahap.');
 const headers={'Content-Type':'application/json','Authorization':'Bearer '+secret,'User-Agent':'MiniBankWA/2.0'};
 const setup=await fetcher(url+'/api/admin/install',{method:'POST',headers,signal:AbortSignal.timeout(30000)});if(!setup.ok)throw Error('Persiapan database cloud gagal. Periksa binding DB dan Secrets.');
 // Block accidental local financial writes as soon as cloud import begins.
 fs.writeFileSync(path.join(dir,'cloud-cutover.json'),JSON.stringify({url,pending:true,backup:target,startedAt:new Date().toISOString()},null,2),{mode:0o600});
 const res=await fetcher(url+'/api/admin/import',{method:'POST',headers,body:JSON.stringify(data),signal:AbortSignal.timeout(120000)});const result=await res.json();if(!res.ok||result.digest!==digest)throw Error(result.error||'Verifikasi impor gagal. Bot jangan dijalankan sampai diverifikasi.');
 const check=await fetcher(url+'/api/admin/status',{headers,signal:AbortSignal.timeout(20000)});const status=await check.json();if(!check.ok||status.digest!==digest||status.ops!==data.ops.length||status.entries!==data.entries.length)throw Error('Jumlah catatan cloud belum sesuai. Jangan jalankan bot.');
 // Verify all copied rows, not only counts, through a server-side manifest hash.
 if(status.sourceHash!==digest)throw Error('Fingerprint migrasi belum sesuai.');
 if(crypto.createHash('sha256').update(JSON.stringify(exportData(source))).digest('hex')!==digest)throw Error('Database lokal berubah selama migrasi. Hentikan semua penulis dan rekonsiliasi sebelum melanjutkan.');
 const marker=path.join(dir,'cloud-cutover.json'),config=path.join(dir,'cloud-config.json');
 fs.writeFileSync(marker,JSON.stringify({url,digest,backup:target,migratedAt:new Date().toISOString()},null,2),{mode:0o600});
 fs.writeFileSync(config+'.tmp',JSON.stringify({url,secret},null,2),{mode:0o600});fs.renameSync(config+'.tmp',config);
 return {operations:data.ops.length,entries:data.entries.length,backup:target,url};
}
if(require.main===module)(async()=>{console.log('Hentikan bot dan UI lokal (Ctrl+C) sebelum migrasi. Jangan catat transaksi selama proses.');const rl=createInterface({input:process.stdin,output:process.stdout});try{const url=(await rl.question('URL HTTPS hosting (tanpa / akhir): ')).trim(),secret=(await rl.question('BOT_SECRET dari Cloudflare (jangan bagikan): ')).trim();const result=await migrate({url,secret});console.log('Migrasi terverifikasi:',result.operations,'operasi,',result.entries,'rincian.\nBackup:',result.backup,'\nBot kini memakai cloud. Jalankan npm start; buka',result.url,'di HP.');}finally{rl.close();}})().catch(e=>{console.error('Migrasi belum selesai:',e.message);process.exitCode=1;});
module.exports={exportData,migrate};
