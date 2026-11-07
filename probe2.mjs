import fs from 'fs'; import zlib from 'zlib'; import https from 'https'; import axios from 'axios';
const C='/app/conversations/69b9afd7ca3719553a3c96cd/efi/certs/';
const key=fs.readFileSync(C+'cnpj_a1.key','utf8'), crt=fs.readFileSync(C+'cnpj_a1.crt','utf8');
const agent=new https.Agent({cert:crt,key:key});
const base='https://sefin.producaorestrita.nfse.gov.br/SefinNacional';
const id='DPS316720226297828700018600001000000000000001';
const IDENT='<tpAmb>2</tpAmb><dhEmi>2026-11-07T19:00:00-03:00</dhEmi><verAplic>Cortevo-1.0</verAplic><serie>00001</serie><nDPS>1</nDPS><dCompet>2026-11-07</dCompet><tpEmit>1</tpEmit>';
const variantes = {
  A_fin:'<infDPS Id="'+id+'">'+IDENT+'<finNFSe>1</finNFSe></infDPS>',
  B_fin_mais:'<infDPS Id="'+id+'">'+IDENT+'<finNFSe>1</finNFSe><prest><CNPJ>62978287000186</CNPJ></prest></infDPS>',
};
for (const [nome, corpo] of Object.entries(variantes)) {
  const x='<?xml version="1.0" encoding="UTF-8"?><DPS xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01">'+corpo+'</DPS>';
  const gz=zlib.gzipSync(Buffer.from(x,'utf8'));
  const r=await axios({method:'POST',url:base+'/nfse',data:{dpsXmlGZipB64:gz.toString('base64')},httpsAgent:agent,timeout:60000,validateStatus:()=>true,responseType:'text',headers:{'Content-Type':'application/json'}});
  let msg=''; try{const j=JSON.parse(r.data); msg=(j.erros||[]).map(e=>e.Codigo+'|'+(e.Complemento||e.Descricao)).join(' ; ');}catch(_){msg=String(r.data).slice(0,200);}
  console.log(nome, r.status, msg.slice(0,300));
}
