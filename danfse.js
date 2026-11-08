import PDFDocument from 'pdfkit';

/**
 * DANFSE - Documento Auxiliar da NFS-e (leiaute oficial, modelo nacional).
 * A API oficial de DANFSE do ADN está indisponível (503), então o documento é
 * montado aqui seguindo o leiaute da NT 008, com todos os grupos do modelo:
 * identificação, prestador, tomador, serviço, tributação nacional, ISSQN,
 * tributação federal, valores totais, informações complementares e canhoto.
 */

const DIG = (v) => String(v || '').replace(/\D/g, '');

const docFmt = (v) => {
  const d = DIG(v);
  if (d.length === 14) return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  if (d.length === 11) return d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  return d || '-';
};

const moeda = (centavos) => {
  const v = Number(centavos || 0) / 100;
  const [i, d] = v.toFixed(2).split('.');
  return `R$ ${i.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${d}`;
};

const dataBR = (v) => {
  if (!v) return '-';
  const s = String(v);
  const dia = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (dia) return `${dia[3]}/${dia[2]}/${dia[1]}`;
  const mes = s.match(/^(\d{4})-(\d{2})$/);
  if (mes) return `${mes[2]}/${mes[1]}`;
  return s;
};

const horaBR = (v) => {
  if (!v) return '';
  const h = String(v).match(/T(\d{2}):(\d{2})/);
  return h ? `${h[1]}:${h[2]}` : '';
};

const chaveFmt = (c) => {
  const d = DIG(c);
  if (d.length !== 50) return d || '-';
  return d.replace(/(\d{4})(?=\d)/g, '$1 ');
};

const regimeTxt = (op) => {
  const v = String(op ?? '').trim();
  if (v === '1') return 'Simples Nacional - MEI';
  if (v === '2') return 'Simples Nacional - MEI';
  if (v === '3') return 'Simples Nacional - ME/EPP';
  return 'Regime Normal';
};

export function gerarDanfsePdf(dados) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 24, autoFirstPage: true });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const M = 24;
      const W = doc.page.width - M * 2;
      const AZUL = '#1e3a8a';
      const CINZA = '#6b7280';
      const BORDA = '#9ca3af';
      const PRETO = '#111827';

      let y = M;

      const caixa = (x, yy, w, h, fill) => {
        doc.save();
        if (fill) doc.rect(x, yy, w, h).fill(fill);
        doc.rect(x, yy, w, h).lineWidth(0.7).strokeColor(BORDA).stroke();
        doc.restore();
      };

      const rotulo = (txt, x, yy, w) =>
        doc.fillColor(CINZA).fontSize(5.6).font('Helvetica-Bold').text(txt, x + 3, yy + 3, { width: w - 6, lineBreak: false });

      const valor = (txt, x, yy, w, { size = 7.6, bold = false, align = 'left' } = {}) =>
        doc.fillColor(PRETO).fontSize(size).font(bold ? 'Helvetica-Bold' : 'Helvetica')
          .text(String(txt ?? '-'), x + 3, yy + 11, { width: w - 6, align, lineBreak: false, ellipsis: true });

      const campo = (rot, val, x, yy, w, h = 22, opts) => {
        caixa(x, yy, w, h);
        rotulo(rot, x, yy, w);
        valor(val, x, yy, w, opts);
      };

      const faixa = (titulo, yy) => {
        caixa(M, yy, W, 13, '#e8edf7');
        doc.fillColor(AZUL).fontSize(6.6).font('Helvetica-Bold').text(titulo, M + 4, yy + 3.5, { width: W - 8 });
        return yy + 13;
      };

      const p = dados.prestador || {};
      const t = dados.tomador || {};
      const s = dados.servico || {};
      const v = dados.valores || {};
      const numero = dados.numero ? String(Number(DIG(dados.numero)) || dados.numero) : '-';
      const serie = DIG(dados.serie) || '-';
      const competencia = dataBR(dados.competencia);
      const emissao = dataBR(dados.emitidaEm);
      const emissaoHora = horaBR(dados.emitidaEm);

      // ---------- Cabecalho ----------
      caixa(M, y, W, 40, AZUL);
      doc.fillColor('#ffffff').fontSize(13).font('Helvetica-Bold')
        .text('DANFSE', M + 6, y + 7, { width: 90 });
      doc.fontSize(8.5).font('Helvetica')
        .text('Documento Auxiliar da Nota Fiscal de Serviço eletrônica', M + 6, y + 22, { width: 220 });
      doc.fontSize(7).text('Modelo nacional - NFS-e', M + 6, y + 32, { width: 220 });
      doc.fontSize(6).font('Helvetica-Bold').text('Nº DA NFS-E', M + W - 300, y + 8, { width: 70 });
      doc.fontSize(11).font('Helvetica-Bold').text(numero, M + W - 300, y + 16, { width: 70 });
      doc.fontSize(6).font('Helvetica-Bold').text('SÉRIE', M + W - 220, y + 8, { width: 60 });
      doc.fontSize(11).font('Helvetica-Bold').text(serie, M + W - 220, y + 16, { width: 60 });
      doc.fontSize(6).font('Helvetica-Bold').text('COMPETÊNCIA', M + W - 150, y + 8, { width: 70 });
      doc.fontSize(9).font('Helvetica-Bold').text(competencia, M + W - 150, y + 17, { width: 70 });
      doc.fontSize(6).font('Helvetica-Bold').text('EMISSÃO', M + W - 78, y + 8, { width: 74 });
      doc.fontSize(9).font('Helvetica-Bold').text(`${emissao} ${emissaoHora}`.trim(), M + W - 78, y + 17, { width: 74 });
      y += 40;

      // Chave de acesso
      caixa(M, y, W, 22);
      rotulo('CHAVE DE ACESSO DA NFS-E', M, y, W);
      doc.fillColor(PRETO).fontSize(8.2).font('Helvetica-Bold')
        .text(chaveFmt(dados.chave), M + 3, y + 10, { width: W - 6, characterSpacing: 0.4 });
      y += 22;

      // Municipio / inscricao federal / regime
      const w1 = W * 0.42, w2 = W * 0.28, w3 = W - w1 - w2;
      campo('MUNICÍPIO / UF', dados.municipio || '-', M, y, w1);
      campo('INSCRIÇÃO FEDERAL DO EMITENTE', docFmt(p.cnpj), M + w1, y, w2);
      campo('REGIME DE TRIBUTAÇÃO', regimeTxt(p.op_simples_nacional), M + w1 + w2, y, w3);
      y += 22;

      // ---------- Prestador ----------
      y = faixa('PRESTADOR DE SERVIÇOS', y);
      const wp1 = W * 0.3, wp2 = W * 0.4, wp3 = W - wp1 - wp2;
      campo('INSCRIÇÃO FEDERAL', docFmt(p.cnpj), M, y, wp1);
      campo('RAZÃO SOCIAL', p.razao_social || '-', M + wp1, y, wp2);
      campo('INSCRIÇÃO MUNICIPAL', p.inscricao_municipal || '-', M + wp1 + wp2, y, wp3);
      y += 22;
      const we1 = W * 0.45, we2 = W * 0.35, we3 = W - we1 - we2;
      campo('ENDEREÇO', p.endereco || '-', M, y, we1);
      campo('MUNICÍPIO / UF', dados.municipio || '-', M + we1, y, we2);
      campo('E-MAIL', p.email || '-', M + we1 + we2, y, we3);
      y += 22;

      // ---------- Tomador ----------
      y = faixa('TOMADOR DE SERVIÇOS', y);
      campo('INSCRIÇÃO FEDERAL', docFmt(t.doc), M, y, wp1);
      campo('NOME / RAZÃO SOCIAL', t.nome || 'Consumidor final', M + wp1, y, wp2);
      campo('E-MAIL', t.email || '-', M + wp1 + wp2, y, wp3);
      y += 22;
      campo('ENDEREÇO', t.endereco || '-', M, y, W * 0.6);
      campo('MUNICÍPIO / UF', t.municipio || '-', M + W * 0.6, y, W * 0.4);
      y += 22;

      // ---------- Servico ----------
      y = faixa('SERVIÇO PRESTADO', y);
      const ws1 = W * 0.22, ws2 = W * 0.22, ws3 = W - ws1 - ws2;
      campo('CÓDIGO DE TRIBUTAÇÃO NACIONAL', s.codigo_trib_nacional || '-', M, y, ws1);
      campo('CÓDIGO DE TRIBUTAÇÃO MUNICIPAL', s.codigo_trib_municipal || '-', M + ws1, y, ws2);
      campo('LOCAL DA PRESTAÇÃO', dados.municipio || '-', M + ws1 + ws2, y, ws3);
      y += 22;
      const alturaDesc = 44;
      caixa(M, y, W, alturaDesc);
      rotulo('DESCRIÇÃO DO SERVIÇO', M, y, W);
      doc.fillColor(PRETO).fontSize(7.6).font('Helvetica')
        .text(s.descricao || '-', M + 3, y + 11, { width: W - 6, height: alturaDesc - 14, ellipsis: true });
      y += alturaDesc;

      // ---------- Tributacao ----------
      y = faixa('TRIBUTAÇÃO MUNICIPAL (ISSQN)', y);
      const wt1 = W * 0.25, wt2 = W * 0.25, wt3 = W * 0.25, wt4 = W - wt1 - wt2 - wt3;
      campo('TRIBUTAÇÃO DO ISSQN', 'Operação tributável', M, y, wt1, 22, { size: 7 });
      campo('RETENÇÃO DO ISSQN', 'Não retido', M + wt1, y, wt2, 22, { size: 7 });
      const aliq = Number(v.iss_aliquota || 0);
      campo('ALÍQUOTA', aliq > 0 ? `${aliq.toFixed(2)}%` : '-', M + wt1 + wt2, y, wt3);
      campo('VALOR DO ISSQN', moeda(v.iss_valor_centavos), M + wt1 + wt2 + wt3, y, wt4);
      y += 22;

      y = faixa('TRIBUTAÇÃO FEDERAL', y);
      const wf = W / 4;
      campo('IRRF', moeda(v.irrf_centavos), M, y, wf);
      campo('CONTRIBUIÇÃO PREVIDENCIÁRIA', moeda(v.cp_centavos), M + wf, y, wf);
      campo('CSLL', moeda(v.csll_centavos), M + wf * 2, y, wf);
      campo('OUTRAS RETENÇÕES', moeda(v.outras_retencoes_centavos), M + wf * 3, y, wf);
      y += 22;

      // ---------- Valores ----------
      y = faixa('VALORES TOTAIS', y);
      const wv = W / 3;
      campo('VALOR DO SERVIÇO', moeda(v.total_centavos), M, y, wv);
      campo('DESCONTO / DEDUÇÕES', moeda(v.desconto_centavos), M + wv, y, wv);
      caixa(M + wv * 2, y, wv, 22, '#e8edf7');
      rotulo('VALOR LÍQUIDO DA NFS-E', M + wv * 2, y, wv);
      doc.fillColor(PRETO).fontSize(9).font('Helvetica-Bold')
        .text(moeda(Number(v.total_centavos || 0) - Number(v.desconto_centavos || 0)), M + wv * 2 + 3, y + 10, { width: wv - 6, align: 'left' });
      y += 22;

      // ---------- Informacoes complementares ----------
      y = faixa('INFORMAÇÕES COMPLEMENTARES', y);
      const alturaInf = 46;
      caixa(M, y, W, alturaInf);
      doc.fillColor(PRETO).fontSize(6.8).font('Helvetica').text(
        'Documento gerado a partir da DPS autorizada pelo Sistema Nacional da NFS-e. ' +
          'A autenticidade pode ser conferida pela chave de acesso no portal nfse.gov.br. ' +
          (dados.observacoes ? String(dados.observacoes) : ''),
        M + 3, y + 4, { width: W - 6, height: alturaInf - 8, ellipsis: true },
      );
      y += alturaInf + 8;

      // ---------- Canhoto ----------
      if (y < doc.page.height - 110) {
        caixa(M, y, W, 12, '#f3f4f6');
        doc.fillColor(AZUL).fontSize(6.6).font('Helvetica-Bold')
          .text('RECIBO DO TOMADOR - NFS-e', M + 4, y + 3, { width: W - 8 });
        y += 12;
        caixa(M, y, W, 52);
        doc.fillColor(PRETO).fontSize(7).font('Helvetica')
          .text(
            `Recebi a NFS-e nº ${numero}, série ${serie}, no valor de ${moeda(v.total_centavos)}, ` +
              `emitida em ${emissao}. Chave de acesso: ${chaveFmt(dados.chave)}.`,
            M + 4, y + 5, { width: W - 8 },
          );
        doc.fillColor(CINZA).fontSize(6).text('ASSINATURA DO TOMADOR', M + 4, y + 36, { width: W * 0.5 });
        doc.moveTo(M + 4, y + 34).lineTo(M + W * 0.45, y + 34).strokeColor(BORDA).stroke();
      }

      // Rodape
      doc.fillColor(CINZA).fontSize(5.6).font('Helvetica').text(
        `Emitido por Cortevo Barber em ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`,
        M, doc.page.height - 40, { width: W, align: 'center' },
      );

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}
