/**
 * Cortevo NFS-e Gateway
 * ------------------------------------------------------------------
 * Ponte mTLS entre o Cortevo Barber (Base44) e a NFS-e Nacional
 * (Emissor Nacional / SefinNacional, padrao nacional do nfse.gov.br).
 *
 * Por que existe: o runtime de funcoes do Base44 nao consegue abrir
 * conexao TLS com certificado de cliente (A1). Este servico guarda o
 * .pfx de cada barbearia e assina a requisicao.
 *
 * Autenticacao: header x-api-key (GATEWAY_API_KEY).
 * Certificado por tenant: cert_ref (id da shop no Base44).
 * ------------------------------------------------------------------
 */
import express from 'express';
import zlib from 'node:zlib';
import axios from 'axios';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import forge from 'node-forge';
import { gerarDpsAssinada } from './dps.js';
import { gerarDanfsePdf } from './danfse.js';

const PORT = process.env.PORT || 8080;
const API_KEY = process.env.GATEWAY_API_KEY || '';
const AMBIENTE = (process.env.NFSE_AMBIENTE || 'restrita').toLowerCase(); // restrita | producao
const CERT_DIR = process.env.CERT_DIR || path.resolve('./certs');

// Bases oficiais do padrao nacional
const BASES = {
  producao: 'https://sefin.nfse.gov.br/SefinNacional',
  restrita: 'https://sefin.producaorestrita.nfse.gov.br/SefinNacional',
};
const BASE_URL = process.env.NFSE_BASE_URL || BASES[AMBIENTE] || BASES.restrita;
const TP_AMB = AMBIENTE === 'producao' ? '1' : '2';

// DANFSE (PDF oficial) vem do ADN, nao da Sefin
const ADN_BASES = {
  producao: 'https://adn.nfse.gov.br',
  restrita: 'https://adn.producaorestrita.nfse.gov.br',
};
const ADN_BASE = process.env.NFSE_ADN_BASE || ADN_BASES[AMBIENTE] || ADN_BASES.restrita;

if (!API_KEY) {
  console.warn('[aviso] GATEWAY_API_KEY nao definida: o gateway vai recusar todas as chamadas.');
}
fs.mkdirSync(CERT_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: '12mb' }));

/* ----------------------------- utilidades ----------------------------- */

const certPath = (ref) => path.join(CERT_DIR, `${String(ref).replace(/[^a-zA-Z0-9_-]/g, '')}.pfx`);
const pwdPath = (ref) => path.join(CERT_DIR, `${String(ref).replace(/[^a-zA-Z0-9_-]/g, '')}.pwd`);

function requireApiKey(req, res, next) {
  const key = req.header('x-api-key') || '';
  if (!API_KEY || key !== API_KEY) {
    return res.status(401).json({ ok: false, error: 'api key invalida' });
  }
  next();
}

function certSource(input) {
  const d = input || {};
  if (d.pfx_base64) {
    const buf = Buffer.from(String(d.pfx_base64), 'base64');
    if (buf.length < 1000) {
      const err = new Error('pfx_base64 invalido');
      err.status = 400;
      throw err;
    }
    return { pfx: buf, passphrase: String(d.senha || ''), ref: d.cert_ref || 'inline' };
  }
  const ref = d.cert_ref;
  if (!ref) {
    const err = new Error('cert_ref ou pfx_base64 obrigatorio');
    err.status = 400;
    throw err;
  }
  const file = certPath(ref);
  if (!fs.existsSync(file)) {
    const err = new Error('certificado nao configurado para este tenant');
    err.status = 422;
    throw err;
  }
  const passphrase = fs.existsSync(pwdPath(ref)) ? fs.readFileSync(pwdPath(ref), 'utf8').trim() : '';
  return { pfx: fs.readFileSync(file), passphrase, ref };
}

function agentForSource(src) {
  return new https.Agent({ pfx: src.pfx, passphrase: src.passphrase, keepAlive: true });
}

function readCertInfo(buffer, senha) {
  const p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(buffer.toString('binary')), senha);
  let validade = null;
  let titular = null;
  let cnpj = null;
  const bags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || [];
  for (const bag of bags) {
    const cert = bag.cert;
    if (!cert) continue;
    if (!validade || cert.validity.notAfter > validade) validade = cert.validity.notAfter;

    for (const attr of cert.subject.attributes || []) {
      const isCN = attr.shortName === 'CN' || attr.name === 'commonName' || attr.type === '2.5.4.3';
      if (isCN && attr.value) titular = String(attr.value);
    }

    // ICP-Brasil: o CNPJ do titular vem em otherName (OID 2.16.76.1.3.3).
    // Tentamos o SAN estruturado e, se nao vier, caimos para o CN.
    try {
      const san = cert.getExtension('subjectAltName');
      const raw = JSON.stringify(san || {});
      const hit = raw.match(/(\d{14})/);
      if (hit) cnpj = hit[1];
    } catch (_) { /* ignora */ }

    if (!cnpj) {
      try {
        const alt = cert.getExtension('1.3.6.1.5.5.7.1.1') || cert.getExtension('subjectAltName');
        const raw = JSON.stringify(alt || {});
        const hit = raw.match(/(\d{14})/);
        if (hit) cnpj = hit[1];
      } catch (_) { /* ignora */ }
    }

    if (!cnpj && titular) {
      const digits = String(titular).replace(/\D/g, '');
      if (digits.length >= 14) cnpj = digits.slice(-14);
    }
  }
  return {
    titular,
    cnpj,
    validade: validade ? validade.toISOString().slice(0, 10) : null,
    fingerprint: forge.md.sha256.create().update(buffer.toString('binary')).digest().toHex().slice(0, 40),
  };
}

function centavos(v) {
  return Number(v || 0) / 100;
}

/**
 * Monta o infDPS (padrao nacional v1.00) a partir do payload normalizado
 * enviado pelo Cortevo. Campos opcionais sao omitidos quando vazios.
 */
function buildInfDPS(p) {
  const prest = p.prestador || {};
  const toma = p.tomador || {};
  const serv = p.servico || {};
  const val = p.valores || {};
  const now = new Date();
  const dhEmi = p.dhEmi || now.toISOString().slice(0, 19) + '-03:00';
  const competencia = p.competencia || now.toISOString().slice(0, 10);

  const documento = (doc) => {
    const digits = String(doc || '').replace(/\D/g, '');
    if (digits.length === 14) return { CNPJ: digits };
    if (digits.length === 11) return { CPF: digits };
    return null;
  };

  const tomadorDoc = documento(toma.doc);
  if (!tomadorDoc) {
    const err = new Error('tomador exige CPF ou CNPJ valido');
    err.status = 400;
    throw err;
  }
  const prestadorDoc = documento(prest.cnpj);
  if (!prestadorDoc || !prestadorDoc.CNPJ) {
    const err = new Error('prestador exige CNPJ valido');
    err.status = 400;
    throw err;
  }

  const infDPS = {
    tpAmb: TP_AMB,
    dhEmi,
    verAplic: 'Cortevo-1.0',
    serie: String(p.serie || '1'),
    nDPS: String(p.numero || '1'),
    dCompet: competencia,
    tpEmit: '1', // prestador
    cLocEmi: String(p.municipio_ibge || ''),
    prestador: {
      ...prestadorDoc,
      IM: prest.inscricao_municipal || undefined,
      xNome: prest.razao_social || undefined,
      end: prest.endereco || undefined,
      contato: prest.email ? { email: prest.email } : undefined,
    },
    tomador: {
      ...tomadorDoc,
      xNome: toma.nome || 'Consumidor final',
      email: toma.email || undefined,
      end: toma.endereco || undefined,
    },
    serv: {
      locPrest: { cLocPrestacao: String(p.municipio_ibge || '') },
      cServ: {
        cTribNac: serv.codigo_trib_nacional || '060101',
        cTribMun: serv.codigo_trib_municipal || undefined,
        xDescServ: serv.descricao || 'Servico de barbearia',
        cNBS: serv.codigo_nbs || undefined,
      },
    },
    valores: {
      vServPrest: { vServ: centavos(val.total_centavos) },
      trib: {
        tribMun: {
          tribISSQN: val.iss_retido ? '2' : '1',
          cPaisResult: '1058',
          pAliq: Number(val.iss_aliquota || 0),
          tpRetISSQN: val.iss_retido ? '1' : '2',
        },
        totTrib: {
          indTotTrib: '0',
        },
      },
    },
  };

  // remove chaves indefinidas para nao quebrar o schema
  const clean = (obj) => {
    if (Array.isArray(obj)) return obj.map(clean);
    if (obj && typeof obj === 'object') {
      return Object.fromEntries(
        Object.entries(obj)
          .filter(([, v]) => v !== undefined && v !== null && v !== '')
          .map(([k, v]) => [k, clean(v)]),
      );
    }
    return obj;
  };

  return clean(infDPS);
}


// Busca os parametros do municipio (aliquota, cTribNac, exigencia de IM).
// Usado para nao depender do contador: o proprio municipio informa a aliquota.
async function fetchParametros(src, municipio) {
  const out = await callSefin({
    src,
    method: 'GET',
    url: `/parametros_municipais/${encodeURIComponent(municipio)}`,
  });
  return out;
}

function extractAliquota(parametros) {
  try {
    const raw = JSON.stringify(parametros || {});
    const m = raw.match(/"pAliq"\s*:\s*"?([0-9]+(?:\.[0-9]+)?)"?/);
    return m ? Number(m[1]) : null;
  } catch (_) {
    return null;
  }
}

// XML autorizado + DANFSE (PDF) de uma nota
async function fetchArquivos(src, chave) {
  const agent = agentForSource(src);
  const xmlRes = await axios({
    method: 'GET',
    url: `${BASE_URL}/nfse/${encodeURIComponent(chave)}`,
    httpsAgent: agent,
    timeout: 45000,
    validateStatus: () => true,
    responseType: 'text',
    headers: { Accept: 'application/xml, text/xml, */*' },
  });

  let pdfBase64 = null;
  let pdfErro = null;
  try {
    const pdfRes = await axios({
      method: 'GET',
      url: `${ADN_BASE}/danfse/${encodeURIComponent(chave)}`,
      httpsAgent: agent,
      timeout: 45000,
      validateStatus: () => true,
      responseType: 'arraybuffer',
      headers: { Accept: 'application/pdf' },
    });
    if (pdfRes.status === 200 && pdfRes.data) {
      pdfBase64 = Buffer.from(pdfRes.data).toString('base64');
    } else {
      pdfErro = `DANFSE respondeu ${pdfRes.status}`;
    }
  } catch (e) {
    pdfErro = e.message;
  }

  return {
    xml: typeof xmlRes.data === 'string' ? xmlRes.data : null,
    xml_http: xmlRes.status,
    pdf_base64: pdfBase64,
    pdf_erro: pdfErro,
  };
}

async function callSefin({ src, method, url, data }) {
  const agent = agentForSource(src);
  const response = await axios({
    method,
    url: `${BASE_URL}${url}`,
    data,
    httpsAgent: agent,
    timeout: 45000,
    validateStatus: () => true,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
  });
  return { status: response.status, body: response.data };
}

/* ------------------------------- rotas ------------------------------- */

const ULTIMAS = [];
app.get('/debug/ultimas', requireApiKey, (_req, res) => {
  res.json({ ok: true, total: ULTIMAS.length, itens: ULTIMAS.slice(-5) });
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    servico: 'cortevo-nfse-gateway',
    ambiente: AMBIENTE,
    base: BASE_URL,
    tenants: fs.readdirSync(CERT_DIR).filter((f) => f.endsWith('.pfx')).length,
    stateless: process.env.GATEWAY_STATELESS === '1',
    build: 'dps-ok-v1.01-20261109',
  });
});

// Cadastro / substituicao do certificado A1 de uma barbearia
app.post('/certificado', requireApiKey, (req, res) => {
  try {
    const { cert_ref, pfx_base64, senha } = req.body || {};
    if (!cert_ref || !pfx_base64) {
      return res.status(400).json({ ok: false, error: 'cert_ref e pfx_base64 obrigatorios' });
    }
    const buffer = Buffer.from(pfx_base64, 'base64');
    if (buffer.length < 1000) {
      return res.status(400).json({ ok: false, error: 'arquivo .pfx invalido' });
    }
    const info = readCertInfo(buffer, senha || '');
    if (!info.validade) {
      return res.status(422).json({ ok: false, error: 'nao foi possivel ler o certificado (senha incorreta?)' });
    }
    const vencido = new Date(info.validade) < new Date();
    fs.writeFileSync(certPath(cert_ref), buffer, { mode: 0o600 });
    fs.writeFileSync(pwdPath(cert_ref), String(senha || ''), { mode: 0o600 });
    return res.json({
      ok: true,
      cert_ref,
      titular: info.titular,
      cnpj: info.cnpj,
      validade: info.validade,
      fingerprint: info.fingerprint,
      status: vencido ? 'invalido' : 'valido',
    });
  } catch (e) {
    return res.status(422).json({ ok: false, error: `falha ao ler certificado: ${e.message}` });
  }
});

app.delete('/certificado/:ref', requireApiKey, (req, res) => {
  const ref = req.params.ref;
  for (const f of [certPath(ref), pwdPath(ref)]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  res.json({ ok: true, removido: ref });
});

// Emissao da NFS-e: POST /nfse com JSON { dpsXmlGZipB64 } (XML assinado, gzip, base64).
app.post('/nfse/emitir', requireApiKey, async (req, res) => {
  try {
    const src = certSource(req.body);

    let aliquota_origem = 'payload';
    if (!req.body?.valores?.iss_aliquota) {
      try {
        const par = await fetchParametros(src, req.body?.municipio_ibge);
        const aliq = extractAliquota(par.body);
        if (par.status === 200 && aliq) {
          req.body.valores = { ...(req.body.valores || {}), iss_aliquota: aliq };
          aliquota_origem = 'municipio';
        }
      } catch (_) { /* segue sem aliquota */ }
    }

    if (!req.body.tpAmb) req.body.tpAmb = TP_AMB;

    // Alguns municipios nao aceitam IM (E0120) e MEI/Simples nao aceita
    // aliquota (E0600). Tentamos variantes antes de devolver erro.
    const variantes = [req.body];
    if (req.body?.prestador?.inscricao_municipal) {
      const semIm = { ...req.body, prestador: { ...req.body.prestador, inscricao_municipal: null } };
      variantes.push(semIm);
    }
    const val = req.body?.valores || {};
    if (val.iss_aliquota) {
      variantes.push({ ...(variantes[variantes.length - 1]), valores: { ...val, iss_aliquota: 0 } });
    }

    let out = null;
    let dps = null;
    for (const corpo of variantes) {
      dps = gerarDpsAssinada(corpo, src);
      out = await postDps(src, dps.gzip);
      const bruto = typeof out.body === 'string' ? out.body : JSON.stringify(out.body || '');
      try {
        ULTIMAS.push({
          quando: new Date().toISOString(),
          dps_id: dps.id,
          http: out.status,
          payload: corpo,
          xml: dps.xml,
          resposta: bruto.slice(0, 3000),
        });
        while (ULTIMAS.length > 20) ULTIMAS.shift();
      } catch (_) { /* ignora */ }
      const autorizou = out.status === 200 || out.status === 201;
      if (autorizou) break;

      // E1235 reclamando do finNFSe: o leiaute diverge entre ambientes
      if (/finNFSe/i.test(bruto) && !corpo.__alternouFin) {
        variantes.push({ ...corpo, finNFSe: (corpo.finNFSe === null ? '0' : null), __alternouFin: true });
      }
      // E0014 = serie/numero ja usados: o app nao controla bem o contador,
      // entao seguimos para o proximo numero livre (nunca duplica nota).
      if (/E0014/.test(bruto) && (corpo.__tentativasNumero || 0) < 10) {
        const prox = String(Number(String(corpo.numero || '0').replace(/\D/g, '') || 0) + 1);
        variantes.push({ ...corpo, numero: prox, __tentativasNumero: (corpo.__tentativasNumero || 0) + 1 });
      }
      const erroDeRegra = /E0120|E0600/.test(bruto);
      if (!erroDeRegra && !/finNFSe/i.test(bruto) && !/E0014/.test(bruto)) break;
    }

    const autorizada = out.status === 200 || out.status === 201;
    const txt = typeof out.body === 'string' ? out.body : JSON.stringify(out.body || {});

    let chave = null;
    let erro = null;
    let xmlOficial = null;
    try {
      const j = JSON.parse(txt);
      if (j.nfseXmlGZipB64) {
        try {
          xmlOficial = zlib.gunzipSync(Buffer.from(j.nfseXmlGZipB64, 'base64')).toString('utf8');
        } catch (_) { xmlOficial = null; }
      }
      chave = (j.nfse && (j.nfse.chaveAcesso || j.nfse.chave)) || j.chaveAcesso || j.chave || null;
      const lista = j.erros || j.erro || [];
      const e = Array.isArray(lista) ? (lista[0] || {}) : lista;
      if (!autorizada && e && Object.keys(e).length) {
        erro = [e.Codigo || e.codigo, e.Descricao || e.descricao || e.mensagem].filter(Boolean).join(': ');
      }
      if (!erro && !autorizada && (j.codigo || j.descricao)) erro = [j.codigo, j.descricao].filter(Boolean).join(': ');
      if (!erro && !autorizada && j.mensagem) erro = String(j.mensagem);
    } catch (_) { /* resposta nao-JSON */ }

    if (!chave) {
      const mChave = txt.match(/<chaveAcesso>([^<]+)<\/chaveAcesso>/i) || txt.match(/<chNFSe>([^<]+)<\/chNFSe>/i);
      if (mChave) chave = mChave[1];
    }
    if (!autorizada && !erro) {
      const c = txt.match(/<codigo>([^<]+)<\/codigo>/i);
      const d = txt.match(/<descricao>([^<]+)<\/descricao>/i) || txt.match(/<mensagem>([^<]+)<\/mensagem>/i);
      erro = [c && c[1], d && d[1]].filter(Boolean).join(': ') || txt.slice(0, 500) || ('HTTP ' + out.status);
    }

    let arquivos = null;
    if (autorizada && chave && !xmlOficial) {
      try { arquivos = await fetchArquivos(src, chave); }
      catch (e) { arquivos = { xml: null, pdf_base64: null, pdf_erro: e.message }; }
    }

    // DANFSE: a API oficial esta suspensa, entao geramos o documento aqui
    let pdfLocal = null;
    if (autorizada && chave) {
      try {
        const ehCpf = String(req.body?.tomador?.doc || '').replace(/\D/g, '').length === 11;
        const pdf = await gerarDanfsePdf({
          chave,
          numero: String(dps.numero || req.body?.numero || ''),
          serie: String(dps.serie || req.body?.serie || ''),
          competencia: req.body?.competencia,
          emitidaEm: new Date().toISOString(),
          prestador: {
            cnpj: req.body?.prestador?.cnpj,
            razao_social: req.body?.prestador?.razao_social,
            inscricao_municipal: req.body?.prestador?.inscricao_municipal,
            municipio: req.body?.prestador?.endereco?.municipio || req.body?.municipio_nome,
            uf: req.body?.prestador?.endereco?.uf || req.body?.uf,
          },
          tomador: {
            nome: req.body?.tomador?.nome,
            doc: req.body?.tomador?.doc,
            email: req.body?.tomador?.email,
          },
          servico: {
            descricao: req.body?.servico?.descricao,
            codigo_trib_nacional: req.body?.servico?.codigo_trib_nacional,
          },
          valores: {
            total_centavos: req.body?.valores?.total_centavos,
            iss_valor_centavos: req.body?.valores?.iss_valor_centavos,
          },
        });
        pdfLocal = pdf.toString('base64');
        void ehCpf;
      } catch (e) {
        console.error('falha ao gerar DANFSE local:', e.message);
      }
    }

    return res.status(autorizada ? 200 : (out.status && out.status >= 400 ? out.status : 422)).json({
      ok: autorizada,
      dps_id: dps.id,
      chave,
      numero: chave ? String(Number(String(dps.numero || '0')) || dps.numero) : null,
      serie: dps.serie || null,
      emitida_em: autorizada ? new Date().toISOString() : null,
      xml: xmlOficial || (arquivos && arquivos.xml) || txt || null,
      pdf_base64: pdfLocal || (arquivos ? arquivos.pdf_base64 : null),
      pdf_erro: pdfLocal ? null : (arquivos ? arquivos.pdf_erro : null),
      erro,
      mensagem: erro,
      aliquota_origem,
      http: out.status,
    });
  } catch (e) {
    return res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

async function postDps(src, gzipBuffer) {
  const agent = agentForSource(src);
  const r = await axios({
    method: 'POST',
    url: `${BASE_URL}/nfse`,
    data: { dpsXmlGZipB64: gzipBuffer.toString('base64') },
    httpsAgent: agent,
    timeout: 60000,
    validateStatus: () => true,
    responseType: 'text',
    transformRequest: [(d) => JSON.stringify(d)],
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
  });
  return { status: r.status, body: r.data };
}

// Consulta da DPS (usa idDps = municipio + serie + numero, como no padrao)
app.get('/dps/:id', requireApiKey, async (req, res) => {
  try {
    const src = certSource(req.query);
    const out = await callSefin({ src, method: 'GET', url: `/dps/${encodeURIComponent(req.params.id)}` });
    return res.status(out.status).json({ ok: out.status === 200, http: out.status, resposta: out.body });
  } catch (e) {
    return res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

// Cancelamento
app.post('/nfse/cancelar', requireApiKey, async (req, res) => {
  try {
    const { chave, motivo } = req.body || {};
    const src = certSource(req.body);
    if (!chave || !motivo) {
      return res.status(400).json({ ok: false, error: 'chave e motivo obrigatorios' });
    }
    const data = { evento: { cMotivo: '9', xMotivo: String(motivo).slice(0, 255) } };
    const out = await callSefin({
      src,
      method: 'POST',
      url: `/nfse/${encodeURIComponent(chave)}/cancelamento`,
      data,
    });
    return res.status(out.status).json({ ok: out.status === 200, http: out.status, resposta: out.body });
  } catch (e) {
    return res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

// XML + DANFSE (PDF) de uma nota ja autorizada
const arquivosHandler = async (req, res) => {
  try {
    const chave = (req.body && req.body.chave) || req.query.chave;
    const src = certSource({ ...(req.query || {}), ...(req.body || {}) });
    if (!chave) return res.status(400).json({ ok: false, error: 'chave obrigatoria' });
    const out = await fetchArquivos(src, chave);
    const xmlOk = out.xml_http === 200 && typeof out.xml === 'string' && !out.xml.includes('<!DOCTYPE html');
    if (!xmlOk) {
      return res.status(422).json({
        ok: false,
        erro: 'a Sefin nao devolveu o XML da nota (verifique se a chave existe e se o certificado e o do emitente)',
        xml_http: out.xml_http,
        pdf_base64: out.pdf_base64,
        pdf_erro: out.pdf_erro,
      });
    }
    return res.json({ ok: true, ...out });
  } catch (e) {
    return res.status(e.status || 500).json({ ok: false, error: e.message });
  }
};
app.get('/nfse/arquivos', requireApiKey, arquivosHandler);
app.post('/nfse/arquivos', requireApiKey, arquivosHandler);

// Parametros do municipio (aliquota, codigos de tributo, exigencia de IM)
app.get('/parametros/:municipio', requireApiKey, async (req, res) => {
  try {
    const src = certSource(req.query);
    const out = await callSefin({
      src,
      method: 'GET',
      url: `/parametros_municipais/${encodeURIComponent(req.params.municipio)}`,
    });
    return res.status(out.status).json({ ok: out.status === 200, http: out.status, resposta: out.body });
  } catch (e) {
    return res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

app.use((err, _req, res, _next) => {
  res.status(err.status || 500).json({ ok: false, error: err.message });
});

app.listen(PORT, () => {
  console.log(`cortevo-nfse-gateway em ${PORT} | ambiente ${AMBIENTE} | ${BASE_URL}`);
});
