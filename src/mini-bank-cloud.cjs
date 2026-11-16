'use strict';
const fs=require('node:fs'),path=require('node:path');
const USERS=['225223873933385@lid','215603096862749@lid'];
const GROUPS=['120363415524345679@g.us'];
function createRemoteBank({dataDir,logger=console}={}){
 const dir=dataDir||path.join(__dirname,'..','data'),cfgfile=path.join(dir,'cloud-config.json');
 const cfg=fs.existsSync(cfgfile)?JSON.parse(fs.readFileSync(cfgfile,'utf8')):{};
 const origin=process.env.MINIBANK_CLOUD_URL||cfg.url,secret=process.env.MINIBANK_BOT_SECRET||cfg.secret;
 if(!origin||new URL(origin).protocol!=='https:'||new URL(origin).origin!==origin||!secret||secret.length<32)throw Error('Konfigurasi Mini Bank cloud belum lengkap. Database lokal tidak dipakai sebagai fallback.');
 return {async handle(message,{senderId}={}){
  const body=(message.body||'').trim();if(!/^!mini\s+bank\s*$/i.test(body)&&!/^!(saving|transaksi|gaji|keluar|masuk|saldo|rekap|hapus|rekomendasi)(?:\s|$)/i.test(body))return false;
  const group=message.from?.endsWith('@g.us'),sender=senderId||(group?message.author:message.from);
  if(!USERS.includes(sender)||(group&&!GROUPS.includes(message.from))){await message.reply('🔒 Mini Bank hanya untuk dua anggota yang diizinkan.');return true;}
  let id;for(const candidate of [message.id,message.rawData?.id,message._data?.id]){id=typeof candidate==='string'?candidate:candidate?._serialized||candidate?.id;if(typeof id==='string'&&id.trim())break;}
  if(!id){await message.reply('⚠️ ID pesan tidak tersedia. Transaksi tidak dikirim agar tidak tercatat ganda.');return true;}
  try{const res=await fetch(origin+'/api/bot',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+secret,'User-Agent':'MiniBankWA/2.0'},body:JSON.stringify({body,senderId:sender,chatId:group?message.from:sender,messageId:id}),signal:AbortSignal.timeout(20000)});let data;try{data=await res.json();}catch{throw Error('API tidak mengembalikan JSON.');}if(!res.ok){if(res.status===400){await message.reply('⚠️ '+data.error);return true;}throw Error('Cloud HTTP '+res.status);}for(let i=0;i<data.reply.length;i+=3500)await message.reply(data.reply.slice(i,i+3500));}
  catch(e){logger.error('[MiniBank Cloud]',e.message);await message.reply('⚠️ Koneksi cloud atau balasan gagal. Cek riwayat di web sebelum mengirim transaksi baru. Database lokal tidak ditambah.');}
  return true;
 },close(){}};
}
module.exports={createRemoteBank};
