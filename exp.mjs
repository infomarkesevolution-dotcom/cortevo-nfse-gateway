import fs from 'fs'; import zlib from 'zlib'; import https from 'https'; import axios from 'axios';
import { buildDpsXml, assinarDps } from './dps.js';
const C='/app/conversations/69b9afd7ca3719553a3c96cd/efi/certs/';
const key=fs.readFileSync(C+'cnpj_a1.key','utf8'), crt=fs.readFileSync(C+'cnpj_a1.crt','utf8');
const payload={tpAmb:'2',municipio_ibge:'3167202',serie:'00001',numero:'1',competencia:'2026-11-07',
  prestador:{cnpj:'62978287000186',inscricao_municipal:'108982',op_simples_nacional:'2'},
  tomador:{doc:'12345678909',nome:'Cliente Teste'},
  servico:{codigo_trib_nacional:'060101',descricao:'Servico de barbearia'},
  valores:{total_centavos:5500,iss_aliquota:'2.00'}};
let {xml,id}=buildDpsXml(payload);
if (process.env.VARIANTE==='sem_loc') xml=xml.replace(/<cLocEmi>[^<]*<\/cLocEmi>/,'');
if (process.env.VARIANTE==='v100') xml=xml.replace(/versao="1\.01"/,'versao="1.00"');
if (process.env.VARIANTE==='min') xml=xml.replace(/<cLocEmi>[\s\S]*<\/infDPS>/,'</infDPS>');
const assinada='<?xml version="1.0" encoding="UTF-8"?>'+assinarDps(xml,{privateKeyPem:key,certPem:crt});
fs.writeFileSync('/tmp/exp.xml',assinada);
const gz=zlib.gzipSync(Buffer.from(assinada,'utf8'));
const agent=new https.Agent({cert:crt,key:key});
const base=process.env.BASE||'https://sefin.producaorestrita.nfse.gov.br/SefinNacional';
const r=await axios({method:'POST',url:base+'/nfse',data:{dpsXmlGZipB64:gz.toString('base64')},httpsAgent:agent,timeout:60000,validateStatus:()=>true,responseType:'text',headers:{'Content-Type':'application/json'}});
console.log('HTTP',r.status); console.log(String(r.data).slice(0,900));
