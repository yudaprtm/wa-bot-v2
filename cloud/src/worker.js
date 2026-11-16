import {schema} from './schema.js';
import {createMiniBank,SHARED_USERS,SHARED_GROUPS,InputError} from './ledger.js';
const enc=new TextEncoder();
const json=(value,status=200,extra={})=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...extra}});
const hex=bytes=>Array.from(new Uint8Array(bytes),n=>n.toString(16).padStart(2,'0')).join('');
const random=()=>hex(crypto.getRandomValues(new Uint8Array(32)));
const sha=async value=>hex(await crypto.subtle.digest('SHA-256',enc.encode(value)));
async function signed(secret,value){const key=await crypto.subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);return hex(await crypto.subtle.sign('HMAC',key,enc.encode(value)));}
const equal=(a,b)=>{if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);return d===0;};
async function body(req,max=8192){if(!req.headers.get('content-type')?.startsWith('application/json'))throw new InputError('Gunakan JSON.'); const reader=req.body?.getReader();if(!reader)throw new InputError('Input kosong.');let total=0,parts=[];while(true){const {value,done}=await reader.read();if(done)break;total+=value.byteLength;if(total>max){await reader.cancel();throw new InputError('Input terlalu panjang.');}parts.push(value);}const raw=new Uint8Array(total);let offset=0;for(const p of parts){raw.set(p,offset);offset+=p.length;}try{const v=JSON.parse(new TextDecoder().decode(raw));if(!v||typeof v!=='object'||Array.isArray(v))throw 0;return v;}catch{throw new InputError('JSON tidak valid.');}}
function csv(rows){const cell=v=>'"'+(/^[\s]*[=+@\-\t\r]/.test(String(v))?"'":'')+String(v??'').replaceAll('"','""')+'"';return '\uFEFF'+[['ID','Tanggal','Dompet','Jenis','Nominal','Kategori','Keterangan','Sumber'],...rows.map(r=>[r.operationId,r.date,r.wallet,r.direction,r.amount,r.category,r.description,r.source])].map(r=>r.map(cell).join(',')).join('\r\n');}
const cookie=(token,age)=>`mb_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${age}`;
export default {async fetch(req,env){let response;try{response=await route(req,env);}catch(e){if(e instanceof InputError)response=json({error:e.message},400);else{console.error('MiniBank request failed',e?.name);response=json({error:'Layanan belum dapat memproses permintaan. Coba lagi dengan formulir yang sama; ID permintaan mencegah catatan ganda.'},503);}}const out=new Response(response.body,response);out.headers.set('X-Content-Type-Options','nosniff');out.headers.set('Referrer-Policy','no-referrer');out.headers.set('X-Frame-Options','DENY');out.headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");return out;}};
async function route(req,env){
 const url=new URL(req.url),p=url.pathname,method=req.method;
 if(!p.startsWith('/api/'))return env.ASSETS.fetch(req);
 if(url.protocol!=='https:' && !['localhost','127.0.0.1'].includes(url.hostname))return json({error:'HTTPS wajib.'},403);
 if(!env.DB||!env.PIN_HASH||!env.AUTH_SECRET||!env.BOT_SECRET||env.AUTH_SECRET.length<32||env.BOT_SECRET.length<32)return json({error:'Konfigurasi hosting belum lengkap.'},503);
 const db=env.DB,bank=createMiniBank(db),bearer=req.headers.get('authorization')||'';
 const authorized=equal(bearer,'Bearer '+env.BOT_SECRET);
 if(p==='/api/admin/install'&&method==='POST'){if(!authorized)return json({error:'Akses ditolak.'},401);await db.batch(schema.map(sql=>db.prepare(sql)));return json({ok:true});}
 if(p==='/api/admin/import'&&method==='POST'){
  if(!authorized)return json({error:'Akses ditolak.'},401);
  return importData(await body(req,2_000_000),db);
 }
 if(p==='/api/admin/status'&&method==='GET'){
  if(!authorized)return json({error:'Akses ditolak.'},401);
  const state=await db.prepare("SELECT value FROM cloud_state WHERE key='ready'").first();
  const result=await db.batch([
   db.prepare('SELECT key,value FROM mini_bank_meta ORDER BY key'),
   db.prepare('SELECT id,owner,actor,message_id,type,business_date,created_at,salary_cycle,deleted_at FROM mini_bank_ops ORDER BY id'),
   db.prepare('SELECT id,op_id,wallet,direction,amount,category,description FROM mini_bank_entries ORDER BY id'),
   db.prepare("SELECT row_json FROM cloud_archive WHERE table_name='transactions' ORDER BY rowid")
  ]);
  const source={version:1,meta:result[0].results,ops:result[1].results,entries:result[2].results,legacy:result[3].results.map(r=>JSON.parse(r.row_json))};
  return json({digest:state?.value,ops:source.ops.length,entries:source.entries.length,sourceHash:await sha(JSON.stringify(source))});
 }
 const ready=await db.prepare("SELECT value FROM cloud_state WHERE key='ready'").first();
 if(!ready)return json({error:'Migrasi data belum selesai. Pencatatan belum diaktifkan.'},503);
 if(p==='/api/bot'&&method==='POST'){
  if(!authorized)return json({error:'Akses ditolak.'},401);
  const input=await body(req);if(!SHARED_USERS.includes(input.senderId)||!(SHARED_USERS.includes(input.chatId)||SHARED_GROUPS.includes(input.chatId)))return json({error:'Pengirim tidak diizinkan.'},403);
  if(typeof input.body!=='string'||input.body.length>2000||!/^!(?:mini\s+bank\s*$|saving\b|transaksi\b|gaji\b|keluar\b|masuk\b|saldo\b|rekap\b|hapus\b|rekomendasi\b)/i.test(input.body))throw new InputError('Perintah tidak dikenal.');
  if(typeof input.messageId!=='string'||!input.messageId||input.messageId.length>500)throw new InputError('ID pesan wajib tersedia.');
  const owner='shared:'+ [...SHARED_USERS].sort().join('+');
  const reply=await bank.execute(owner,input.senderId,input.body,input.senderId+':'+input.messageId);
  return json({reply:'👥 *DOMPET BERSAMA*\n\n'+reply});
 }
 if(!['GET','HEAD'].includes(method)&&req.headers.get('origin')!==url.origin)return json({error:'Origin tidak diizinkan.'},403);
 const revision=await sha(env.PIN_HASH+env.AUTH_SECRET);
 if(p==='/api/login'&&method==='POST'){
  const input=await body(req),now=Date.now();
  // Reserve a globally shared attempt atomically, before verifying the PIN.
  const attempt=await db.prepare("UPDATE cloud_attempts SET failures=CASE WHEN until<=? THEN 1 ELSE failures+1 END,until=CASE WHEN until<=? THEN ? ELSE until END WHERE key='pin' AND (until<=? OR failures<5) RETURNING failures,until").bind(now,now,now+900000,now).first();
  if(!attempt)return json({error:'Terlalu banyak percobaan. Tunggu 15 menit.'},429);
  const valid=/^\d{6}$/.test(String(input.pin||''))&&equal(await signed(env.AUTH_SECRET,'mini-bank-pin:'+input.pin),env.PIN_HASH);
  if(!valid)return json({error:'PIN tidak sesuai. Gunakan 6 digit angka.'},401);
  const token=random(),csrf=random(),age=input.remember===false?43200:604800;
  await db.batch([db.prepare("UPDATE cloud_attempts SET failures=0,until=0 WHERE key='pin'"),db.prepare('DELETE FROM cloud_sessions WHERE expires<? OR revision<>?').bind(now,revision),db.prepare('INSERT INTO cloud_sessions VALUES(?,?,?,?)').bind(await sha(token),csrf,now+age*1000,revision)]);
  return json({ok:true},200,{'Set-Cookie':cookie(token,age)});
 }
 const token=(req.headers.get('cookie')||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('mb_session='))?.slice(11);
 const session=token&&await db.prepare('SELECT * FROM cloud_sessions WHERE token_hash=? AND expires>? AND revision=?').bind(await sha(token),Date.now(),revision).first();
 if(!session)return json({error:'Silakan masuk dengan PIN bersama.'},401);
 if(!['GET','HEAD'].includes(method)&&!equal(req.headers.get('x-csrf-token'),session.csrf))return json({error:'Sesi formulir tidak valid. Muat ulang halaman.'},403);
 if(p==='/api/session'&&method==='GET')return json({name:'Dompet bersama',authMode:'shared-pin',csrf:session.csrf,demo:false,refreshSeconds:60});
 if(p==='/api/logout'&&method==='POST'){await db.prepare('DELETE FROM cloud_sessions WHERE token_hash=?').bind(await sha(token)).run();return json({ok:true},200,{'Set-Cookie':cookie('',0)});}
 if(p==='/api/dashboard'&&method==='GET')return json(await bank.webSnapshot('web-shared',url.searchParams.get('month')));
 if(p==='/api/history'&&method==='GET')return json(await bank.webHistory('web-shared',Object.fromEntries(url.searchParams)));
 if(p==='/api/transactions'&&method==='POST'){const value=await bank.webAppend('web-shared',await body(req),req.headers.get('idempotency-key'));return json(value,value.duplicate?200:201);}
 if(p==='/api/export'&&method==='GET')return new Response(csv(await bank.webExport('web-shared',url.searchParams.get('month'))),{headers:{'Content-Type':'text/csv; charset=utf-8','Cache-Control':'no-store','Content-Disposition':'attachment; filename="mini-bank.csv"'}});
 return json({error:'Layanan tidak ditemukan.'},404);
}
async function importData(data,db){
 if(!Array.isArray(data.ops)||!Array.isArray(data.entries)||!Array.isArray(data.meta)||data.version!==1||data.ops.length>600||data.entries.length>2000)throw new InputError('Format migrasi tidak didukung. Maksimal 600 operasi / 2000 rincian; database lebih besar perlu migrasi bertahap.');
 const digest=await sha(JSON.stringify(data));const old=await db.prepare("SELECT value FROM cloud_state WHERE key='ready'").first();
 if(old)return old.value===digest?json({ok:true,duplicate:true,digest}):json({error:'Database cloud sudah diaktifkan. Impor diblokir agar data tidak tertimpa.'},409);
 const existing=await db.prepare('SELECT COUNT(*) AS n FROM mini_bank_ops').first();if(existing.n)return json({error:'Database tujuan harus kosong.'},409);
 const stmts=[];
 const cols={meta:['key','value'],ops:['id','owner','actor','message_id','type','business_date','created_at','salary_cycle','deleted_at'],entries:['id','op_id','wallet','direction','amount','category','description']};
 for(const table of ['meta','ops','entries'])for(const row of data[table]){const keys=cols[table];stmts.push(db.prepare(`INSERT INTO mini_bank_${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).bind(...keys.map(k=>row[k]??null)));}
 for(const row of data.legacy||[])stmts.push(db.prepare('INSERT INTO cloud_archive VALUES(?,?)').bind('transactions',JSON.stringify(row)));
 stmts.push(db.prepare("INSERT INTO cloud_state VALUES('ready',?)").bind(digest));
 // A failed statement rolls the entire D1 batch back. Retrying the same import is safe.
 await db.batch(stmts);
 return json({ok:true,ops:data.ops.length,entries:data.entries.length,digest});
}
