import fs from 'fs'; import zlib from 'zlib'; import https from 'https'; import axios from 'axios';
import { buildDpsXml, assinarDps } from './dps.js';
const C='/app/conversations/69b9afd7ca3719553a3c96cd/efi/certs/';
const key=fs.readFileSync(C+'cnpj_a1.key','utf8'), crt=fs.readFileSync(C+'cnpj_a1.crt','utf8');
const agent=new https.Agent({cert:crt,key:key});
const base='https://sefin.producaorestrita.nfse.gov.br/SefinNacional';
const payload={tpAmb:'2',municipio_ibge:'3167202',serie:'00001',numero:'1',competencia:'2026-11-07',
  prestador:{cnpj:'62978287000186',inscricao_municipal:'108982',op_simples_nacional:'2'},
  tomador:{doc:'12345678909',nome:'Cliente Teste'},
  servico:{codigo_trib_nacional:'060101',descricao:'Servico de barbearia'},
  valores:{total_centavos:5500,iss_aliquota:'2.00'}};
const {xml,id}=buildDpsXml(payload);
const assinada='<?xml version="1.0" encoding="UTF-8"?>'+assinarDps(xml,{privateKeyPem:key,certPem:crt});
const interno=assinada.replace(/^<\?xml[^>]*\?>/,'').replace(/<ds:Signature[\s\S]*<\/ds:Signature>/,'');
const kids=[...interno.matchAll(/<(tpAmb|dhEmi|verAplic|serie|nDPS|dCompet|tpEmit|cLocEmi)>[^<]*<\/\1>|<prest>[\s\S]*?<\/prest>|<toma>[\s\S]*?<\/toma>|<serv>[\s\S]*?<\/serv>|<valores>[\s\S]*?<\/valores>/g)].map(m=>m[0]);
console.log('filhos detectados:', kids.length);
for (let k=1;k<=kids.length;k++){
  const corpo=kids.slice(0,k).join('');
  const x='<?xml version="1.0" encoding="UTF-8"?><DPS xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infDPS Id="'+id+'">'+corpo+'</infDPS></DPS>';
  const gz=zlib.gzipSync(Buffer.from(x,'utf8'));
  const r=await axios({method:'POST',url:base+'/nfse',data:{dpsXmlGZipB64:gz.toString('base64')},httpsAgent:agent,timeout:60000,validateStatus:()=>true,responseType:'text',headers:{'Content-Type':'application/json'}});
  let msg=''; try{const j=JSON.parse(r.data); msg=(j.erros||[]).map(e=>e.Codigo+'|'+(e.Complemento||e.Descricao)).join(' ; ');}catch(_){msg=String(r.data).slice(0,150);}
  console.log(k, kids[k-1].slice(0,14).replace(/<|>/g,''), '->', r.status, msg.slice(0,220));
}
