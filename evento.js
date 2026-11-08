import crypto from 'node:crypto';

const NS = 'http://www.sped.fazenda.gov.br/nfse';
const DSIG = 'http://www.w3.org/2000/09/xmldsig#';

const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const soDigitos = (v) => String(v || '').replace(/\D/g, '');

/** dhEvento em horario de Brasilia, 1 minuto atras (evita "evento no futuro") */
function dhEvento() {
  const t = new Date(Date.now() - 60 * 1000 - 3 * 3600 * 1000);
  return `${t.toISOString().slice(0, 19)}-03:00`;
}

/**
 * Monta e assina o pedido de registro do evento de cancelamento (e101101)
 * conforme o leiaute nacional: Id = "PRE" + chave(50) + tpEvento(6).
 */
export function montarEventoCancelamento({ chave, motivo, codigoMotivo, tpAmb, cnpjAutor, certPem, privateKeyPem }) {
  const ch = soDigitos(chave);
  if (ch.length !== 50) throw Object.assign(new Error('chave de acesso invalida'), { status: 400 });

  const texto = String(motivo || '').trim();
  if (texto.length < 15) {
    throw Object.assign(new Error('o motivo do cancelamento precisa ter ao menos 15 caracteres'), { status: 400 });
  }

  const cnpj = soDigitos(cnpjAutor);
  if (cnpj.length !== 14) throw Object.assign(new Error('CNPJ do autor do evento invalido'), { status: 400 });

  const tpEvento = '101101';
  const id = `PRE${ch}${tpEvento}`;

  const infPedReg =
    `<infPedReg xmlns="${NS}" Id="${id}">` +
    `<tpAmb>${esc(String(tpAmb || '1'))}</tpAmb>` +
    `<verAplic>Cortevo-1.0</verAplic>` +
    `<dhEvento>${dhEvento()}</dhEvento>` +
    `<CNPJAutor>${cnpj}</CNPJAutor>` +
    `<chNFSe>${ch}</chNFSe>` +
    `<e101101>` +
    `<xDesc>Cancelamento de NFS-e</xDesc>` +
    `<cMotivo>${esc(String(codigoMotivo || '9'))}</cMotivo>` +
    `<xMotivo>${esc(texto.slice(0, 255))}</xMotivo>` +
    `</e101101>` +
    `</infPedReg>`;

  const digest = crypto.createHash('sha256').update(infPedReg, 'utf8').digest('base64');

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

  const assinatura = crypto.createSign('RSA-SHA256').update(signedInfo, 'utf8').sign(privateKeyPem, 'base64');

  const blocoCert = String(certPem || '').match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/);
  if (!blocoCert) throw new Error('certificado PEM invalido');
  const certBody = blocoCert[0].replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');

  const signature =
    `<Signature xmlns="${DSIG}">` +
    signedInfo +
    `<SignatureValue>${assinatura}</SignatureValue>` +
    `<KeyInfo><X509Data><X509Certificate>${certBody}</X509Certificate></X509Data></KeyInfo>` +
    `</Signature>`;

  const xml = `<?xml version="1.0" encoding="UTF-8"?>` + `<pedRegEvento xmlns="${NS}" versao="1.01">` + infPedReg + signature + `</pedRegEvento>`;

  return { xml, id, tpEvento, chave: ch };
}
