import fs from 'fs'; import zlib from 'zlib'; import https from 'https'; import axios from 'axios';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { SignedXml } from 'xml-crypto';
import { buildDpsXml } from './dps.js';
const C='/app/conversations/69b9afd7ca3719553a3c96cd/efi/certs/';
const key=fs.readFileSync(C+'cnpj_a1.key','utf8'), crt=fs.readFileSync(C+'cnpj_a1.crt','utf8');
const agent=new https.Agent({cert:crt,key});
const base='https://sefin.producaorestrita.nfse.gov.br/SefinNacional';
const payload={tpAmb:'2',municipio_ibge:'3167202',serie:'00001',numero:'1',competencia:'2026-11-07',
 residencia:1,
 prestador:{cnpj:'62978287000186',inscricao_municipal:'108982',op_simples_nacional:'2'},
 tomador:{doc:'12345678909',nome:'Cliente Teste'},
 servico:{codigo_trib_nacional:'060101',descricao:'Servico de barbearia'},
 valores:{total_centavos:5500,iss_aliquota:'2.00'}};
const {xml,id}=buildDpsXml(payload);
function sign(sigAlg,digAlg,c14n){
  const doc=new DOMParser().parseFromString(xml,'text/xml');
  const sig=new SignedXml({privateKey:key,publicCert:crt,signatureAlgorithm:sigAlg,canonicalizationAlgorithm:c14n||'http://www.w3.org/TR/2001/REC-xml-c14n-20010315'});
  sig.addReference({xpath:"/*[local-name()='DPS']/*[local-name()='infDPS']",digestAlgorithm:digAlg,transforms:['http://www.w3.org/2000/09/xmldsig#enveloped-signature',c14n||'http://www.w3.org/TR/2001/REC-xml-c14n-20010315']});
  sig.computeSignature(new XMLSerializer().serializeToString(doc),{location:{reference:"/*[local-name()='DPS']",action:'append'}});
  return sig.getSignedXml();
}
const SHA1S='http://www.w3.org/2000/09/xmldsig#rsa-sha1', SHA1D='http://www.w3.org/2000/09/xmldsig#sha1';
const SHA256S='http://www.w3.org/2001/04/xmldsig-more#rsa-sha256', SHA256D='http://www.w3.org/2001/04/xmlenc#sha256';
const variantes={'sha1+sha1':[SHA1S,SHA1D],'sha256+sha256':[SHA256S,SHA256D],'sha256+sha1':[SHA256S,SHA1D]};
for(const [nome,[sa,da]] of Object.entries(variantes)){
  const x='<?xml version="1.0" encoding="UTF-8"?>'+sign(sa,da);
  const gz=zlib.gzipSync(Buffer.from(x,'utf8'));
  try{
    const r=await axios({method:'POST',url:base+'/nfse',data:{dpsXmlGZipB64:gz.toString('base64')},httpsAgent:agent,timeout:60000,validateStatus:()=>true,responseType:'text',headers:{'Content-Type':'application/json'}});
    let msg=''; try{const j=JSON.parse(r.data); msg=(j.erros||[]).map(e=>e.Codigo+'|'+(e.Descricao||'')+' '+(e.Complemento||'')).join(' ; ')||('chave:'+(j.nfse&&j.nfse.chaveAcesso));}catch(_){msg=String(r.data).slice(0,200);}
    console.log(nome,'->',r.status,msg.slice(0,220));
  }catch(e){console.log(nome,'-> ERRO',e.message);}
}
