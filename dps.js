/**
 * Gerador da DPS (Declaracao de Prestacao de Servicos) do padrao nacional
 * NFS-e v1.01 + assinatura XMLDSig enveloped (RSA-SHA256).
 *
 * Regra de ouro: o Emissor Nacional recebe XML assinado (POST /nfse),
 * NAO JSON. Este modulo existe para isso.
 */
import forge from 'node-forge';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { SignedXml } from 'xml-crypto';

const NS = 'http://www.sped.fazenda.gov.br/nfse';
const VERSAO = '1.01';

const esc = (v) =>
  String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const digits = (v) => String(v || '').replace(/\D/g, '');

function dec(v) {
  return Number(v || 0).toFixed(2);
}

function soData(v) {
  const s = String(v || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : new Date().toISOString().slice(0, 10);
}

function soDh(v) {
  if (v && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(-03:00|Z)$/.test(v)) return v;
  // Sefin recusa dhEmi no futuro (E0008): gera em horario de Brasilia, 1 min atras
  const t = new Date(Date.now() - 60 * 1000 - 3 * 3600 * 1000);
  const iso = t.toISOString().slice(0, 19);
  return `${iso}-03:00`;
}

/** Id da DPS: DPS + cLocEmi(7) + tpInsc(1) + inscricao(14) + serie(5) + numero(15) */
function idDps({ cLocEmi, tpInsc, inscricao, serie, numero }) {
  return (
    'DPS' +
    String(cLocEmi).padStart(7, '0') +
    String(tpInsc) +
    String(inscricao).padStart(14, '0') +
    String(serie).padStart(5, '0') +
    String(numero).padStart(15, '0')
  );
}

/**
 * Monta o XML da DPS (sem assinatura).
 * p = payload normalizado vindo do Cortevo.
 */
export function buildDpsXml(p) {
  const prest = p.prestador || {};
  const toma = p.tomador || {};
  const serv = p.servico || {};
  const val = p.valores || {};

  const cLocEmi = digits(p.municipio_ibge) || digits(prest.municipio_ibge);
  if (cLocEmi.length !== 7) throw Object.assign(new Error('municipio_ibge (7 digitos) obrigatorio'), { status: 400 });

  const prestDoc = digits(prest.cnpj);
  if (prestDoc.length !== 14) throw Object.assign(new Error('prestador exige CNPJ valido'), { status: 400 });

  const tomaDoc = digits(toma.doc);
  if (tomaDoc.length !== 11 && tomaDoc.length !== 14) {
    throw Object.assign(new Error('tomador exige CPF ou CNPJ valido'), { status: 400 });
  }

  const serie = String(p.serie || '1').padStart(5, '0').slice(-5);
  // TSNumDPS nao aceita zeros a esquerda (E1235): normaliza para inteiro
  const numeroLimpo = digits(p.numero).replace(/^0+/, '') || '1';
  const numero = String(Number(numeroLimpo));
  const id = idDps({ cLocEmi, tpInsc: 2, inscricao: prestDoc, serie, numero });

  const regime = String(prest.op_simples_nacional ?? '2').toUpperCase();
  const opSimpNac = ({ MEI: '2', SIMPLES: '3', 'SIMPLES NACIONAL': '3', SN: '3', ME: '3', EPP: '3', NAO: '1', 'NAO OPTANTE': '1', NORMAL: '1' })[regime] || String(prest.op_simples_nacional ?? '2');
  // MEI e Simples nao informam aliquota (E0600)
  const permiteAliquota = opSimpNac === '1';
  const regEspTrib = String(prest.regime_especial ?? '0'); // 0 = nenhum

  const partes = [];
  partes.push(`<tpAmb>${esc(p.tpAmb || '1')}</tpAmb>`);
  partes.push(`<dhEmi>${esc(soDh(p.dhEmi))}</dhEmi>`);
  partes.push(`<verAplic>${esc('Cortevo-1.0')}</verAplic>`);
  partes.push(`<serie>${esc(serie)}</serie>`);
  partes.push(`<nDPS>${esc(numero)}</nDPS>`);
  partes.push(`<dCompet>${esc(soData(p.competencia))}</dCompet>`);
  partes.push(`<tpEmit>${esc(String(p.tpEmit || '1'))}</tpEmit>`);
  // finalidade da NFS-e (RTC): 0 = NFS-e regular. Posicao exige vir logo apos tpEmit.
  partes.push(`<finNFSe>${esc(String(p.finNFSe || '0'))}</finNFSe>`);
  partes.push(`<cLocEmi>${esc(cLocEmi)}</cLocEmi>`);

  // prestador
  const pr = [`<CNPJ>${prestDoc}</CNPJ>`];
  if (prest.inscricao_municipal) pr.push(`<IM>${esc(digits(prest.inscricao_municipal))}</IM>`);
  // quando o proprio prestador emite (tpEmit=1), a Sefin recusa xNome/end (E0121/E0128)
  const emitenteProprio = String(p.tpEmit || '1') === '1';
  if (prest.razao_social && !emitenteProprio) pr.push(`<xNome>${esc(String(prest.razao_social).slice(0, 150))}</xNome>`);
  if (prest.endereco && prest.endereco.logradouro && !emitenteProprio) {
    const e = prest.endereco;
    const end = ['<end>'];
    if (e.cep && digits(e.cep).length === 8) {
      end.push(`<endNac><cMun>${esc(digits(e.municipio_ibge) || cLocEmi)}</cMun><CEP>${esc(digits(e.cep))}</CEP></endNac>`);
    }
    end.push(`<xLgr>${esc(String(e.logradouro).slice(0, 150))}</xLgr>`);
    end.push(`<nro>${esc(String(e.numero || 'S/N').slice(0, 10))}</nro>`);
    if (e.complemento) end.push(`<xCpl>${esc(String(e.complemento).slice(0, 60))}</xCpl>`);
    if (e.bairro) end.push(`<xBairro>${esc(String(e.bairro).slice(0, 60))}</xBairro>`);
    end.push('</end>');
    if (end.length > 2) pr.push(end.join(''));
  }
  if (prest.email) pr.push(`<email>${esc(String(prest.email).slice(0, 80))}</email>`);
  pr.push(`<regTrib><opSimpNac>${esc(opSimpNac)}</opSimpNac><regEspTrib>${esc(regEspTrib)}</regEspTrib></regTrib>`);
  partes.push(`<prest>${pr.join('')}</prest>`);

  // tomador (opcional no schema, mas util para a nota do cliente)
  if (tomaDoc) {
    const tm = [];
    tm.push(tomaDoc.length === 14 ? `<CNPJ>${tomaDoc}</CNPJ>` : `<CPF>${tomaDoc}</CPF>`);
    tm.push(`<xNome>${esc(String(toma.nome || 'Consumidor final').slice(0, 150))}</xNome>`);
    if (toma.email) tm.push(`<email>${esc(String(toma.email).slice(0, 80))}</email>`);
    partes.push(`<toma>${tm.join('')}</toma>`);
  }

  // servico
  const cTribNac = digits(serv.codigo_trib_nacional || '060101').padStart(6, '0');
  const sv = ['<locPrest>', `<cLocPrestacao>${esc(cLocEmi)}</cLocPrestacao>`, '</locPrest>'];
  sv.push('<cServ>');
  sv.push(`<cTribNac>${esc(cTribNac)}</cTribNac>`);
  if (serv.codigo_trib_municipal) sv.push(`<cTribMun>${esc(digits(serv.codigo_trib_municipal))}</cTribMun>`);
  sv.push(`<xDescServ>${esc(String(serv.descricao || 'Servico de barbearia').slice(0, 2000))}</xDescServ>`);
  sv.push('</cServ>');
  partes.push(`<serv>${sv.join('')}</serv>`);

  // valores
  const aliq = permiteAliquota ? Number(val.iss_aliquota || 0) : 0;
  const v = ['<vServPrest>', `<vServ>${dec(val.total_centavos)}</vServ>`, '</vServPrest>'];
  v.push('<trib><tribMun>');
  v.push('<tribISSQN>1</tribISSQN>');
  v.push('<tpRetISSQN>1</tpRetISSQN>');
  if (aliq > 0) v.push(`<pAliq>${aliq.toFixed(2)}</pAliq>`);
  v.push('</tribMun>');
  v.push('<totTrib><indTotTrib>0</indTotTrib></totTrib>');
  v.push('</trib>');
  partes.push(`<valores>${v.join('')}</valores>`);

  const infCanon = `<infDPS xmlns="${NS}" Id="${id}">` + partes.join('') + `</infDPS>`;
  const xml = `<DPS xmlns="${NS}" versao="${VERSAO}">` + infCanon + `</DPS>`;

  return { xml, infCanon, id, cLocEmi, serie, numero };
}

/** Cert + chave em PEM a partir do .pfx (A1) */
export function pemFromPfx(pfxBuffer, passphrase) {
  const p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(pfxBuffer.toString('binary')), passphrase || '');
  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || [];
  const keyBags =
    p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] ||
    p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] ||
    [];

  // certificado do titular = o que tem a chave correspondente; senao o primeiro
  const keyBag = keyBags[0];
  if (!keyBag || !keyBag.key) {
    throw Object.assign(new Error('nao foi possivel extrair a chave privada do .pfx'), { status: 422 });
  }
  let escolhido = certBags[0];
  for (const b of certBags) {
    if (b.cert && b.cert.publicKey && keyBag.key.n && b.cert.publicKey.n && b.cert.publicKey.n.equals(keyBag.key.n)) {
      escolhido = b;
      break;
    }
  }
  if (!escolhido || !escolhido.cert) {
    throw Object.assign(new Error('nao foi possivel extrair o certificado do .pfx'), { status: 422 });
  }
  return {
    privateKeyPem: forge.pki.privateKeyToPem(keyBag.key),
    certPem: forge.pki.certificateToPem(escolhido.cert),
  };
}

/**
 * Assina a DPS (XMLDSig enveloped, RSA-SHA256, C14N 1.0).
 * O C14N e calculado de forma deterministica: geramos o XML sem tags
 * auto-fechadas e com os namespaces declarados, entao a forma canonica do
 * infDPS e exatamente a string gerada (era isso que quebrava a assinatura).
 */
export function assinarDps(xmlOuInf, { privateKeyPem, certPem }) {
  const DSIG = 'http://www.w3.org/2000/09/xmldsig#';
  let infCanon = xmlOuInf;
  if (!/^<infDPS/.test(infCanon)) {
    const m = infCanon.match(/<infDPS[\s\S]*<\/infDPS>/);
    if (!m) throw new Error('infDPS nao encontrado para assinar');
    infCanon = m[0];
  }
  const id = (infCanon.match(/Id="([^"]+)"/) || [])[1];
  if (!id) throw new Error('atributo Id ausente no infDPS');

  const digest = crypto.createHash('sha256').update(infCanon, 'utf8').digest('base64');

  const signedInfo =
    `<SignedInfo xmlns="${DSIG}">` +
    `<CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"></CanonicalizationMethod>` +
    `<SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"></SignatureMethod>` +
    `<Reference URI="#${id}">` +
    `<Transforms>` +
    `<Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"></Transform>` +
    `<Transform Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"></Transform>` +
    `</Transforms>` +
    `<DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"></DigestMethod>` +
    `<DigestValue>${digest}</DigestValue>` +
    `</Reference>` +
    `</SignedInfo>`;

  const assinatura = crypto
    .createSign('RSA-SHA256')
    .update(signedInfo, 'utf8')
    .sign(privateKeyPem, 'base64');

  const bloco = String(certPem).match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/);
  if (!bloco) throw new Error('certificado PEM invalido');
  const certBody = bloco[0]
    .replace(/-----BEGIN CERTIFICATE-----/, '')
    .replace(/-----END CERTIFICATE-----/, '')
    .replace(/\s+/g, '');

  const signature =
    `<Signature xmlns="${DSIG}">` +
    signedInfo +
    `<SignatureValue>${assinatura}</SignatureValue>` +
    `<KeyInfo><X509Data><X509Certificate>${certBody}</X509Certificate></X509Data></KeyInfo>` +
    `</Signature>`;

  const final = `<DPS xmlns="${NS}" versao="${VERSAO}">` + infCanon + signature + `</DPS>`;
  return final;
}

/** Gera a DPS assinada e comprimida (gzip), pronta para POST /nfse */
export function gerarDpsAssinada(payload, src) {
  const { infCanon, id } = buildDpsXml(payload);
  const pems = pemFromPfx(src.pfx, src.passphrase);
  const assinada = assinarDps(infCanon, pems);
  // a Sefin exige declaracao de codificacao UTF-8 (E1229 sem ela)
  const comDecl = /^<\?xml/i.test(assinada)
    ? assinada
    : '<?xml version="1.0" encoding="UTF-8"?>' + assinada;
  return { xml: comDecl, id, gzip: zlib.gzipSync(Buffer.from(comDecl, 'utf8')) };
}
