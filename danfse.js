import PDFDocument from 'pdfkit';

const moeda = (centavos) => {
  const v = Number(centavos || 0) / 100;
  const [inteiro, decimal] = v.toFixed(2).split('.');
  const comMilhar = inteiro.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `R$ ${comMilhar},${decimal}`;
};

const soDigitos = (v) => String(v || '').replace(/\D/g, '');

function formataDoc(doc) {
  const d = soDigitos(doc);
  if (d.length === 14) return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  if (d.length === 11) return d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  return d;
}

function formataChave(chave) {
  const c = soDigitos(chave);
  if (c.length !== 50) return c;
  return c.replace(/(\d{4})(?=\d)/g, '$1 ');
}

function formataData(iso) {
  if (!iso) return '';
  const s = String(iso);
  const dia = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (dia) return `${dia[3]}/${dia[2]}/${dia[1]}`;
  const mes = s.match(/^(\d{4})-(\d{2})$/);
  if (mes) return `${mes[2]}/${mes[1]}`;
  return s;
}

/**
 * DANFSe simplificada. A API oficial do DANFSE está suspensa desde 03/08/2026,
 * então o documento é gerado a partir dos dados da própria DPS autorizada.
 */
export function gerarDanfsePdf({ chave, numero, serie, competencia, emitidaEm, prestador, tomador, servico, valores }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 40 });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const largura = doc.page.width - 80;
      const cinza = '#555555';
      const preto = '#111111';

      // Cabecalho
      doc.rect(40, 40, largura, 54).fill('#0f172a');
      doc.fillColor('#ffffff').fontSize(14).font('Helvetica-Bold')
        .text('DANFSE - Documento Auxiliar da NFS-e', 52, 52, { width: largura - 24 });
      doc.fontSize(9).font('Helvetica')
        .text('Cortevo Barber - Nota Fiscal de Servico eletronica (padrao nacional)', 52, 72, { width: largura - 24 });

      // Chave de acesso
      doc.fillColor(preto).fontSize(9).font('Helvetica-Bold').text('CHAVE DE ACESSO', 40, 110);
      doc.font('Helvetica').fontSize(9).text(formataChave(chave) || 'processando...', 40, 122, { width: largura });

      // Bloco numero / serie / competencia
      let y = 148;
      const linha = (rotulo, valor, x, w) => {
        doc.fillColor(cinza).fontSize(7).font('Helvetica-Bold').text(rotulo, x, y, { width: w });
        doc.fillColor(preto).fontSize(10).font('Helvetica').text(valor || '-', x, y + 10, { width: w });
      };
      linha('NUMERO DA NFS-E', numero ? String(numero) : '-', 40, 130);
      linha('SERIE', serie || '-', 180, 80);
      linha('COMPETENCIA', formataData(competencia) || '-', 270, 130);
      linha('DATA DE EMISSAO', formataData(emitidaEm), 410, 145);

      y += 44;
      doc.moveTo(40, y).lineTo(40 + largura, y).strokeColor('#dddddd').stroke();

      // Prestador
      y += 14;
      doc.fillColor(cinza).fontSize(8).font('Helvetica-Bold').text('PRESTADOR DE SERVICOS', 40, y);
      y += 14;
      doc.fillColor(preto).fontSize(11).font('Helvetica-Bold').text(prestador?.razao_social || '-', 40, y, { width: largura });
      y += 15;
      doc.fontSize(9).font('Helvetica')
        .text(
          [
            prestador?.cnpj ? `CNPJ ${formataDoc(prestador.cnpj)}` : null,
            prestador?.inscricao_municipal ? `IM ${prestador.inscricao_municipal}` : null,
            prestador?.municipio ? `${prestador.municipio}${prestador.uf ? ' - ' + prestador.uf : ''}` : null,
          ].filter(Boolean).join('   |   ') || '-',
          40, y, { width: largura },
        );

      y += 34;
      doc.moveTo(40, y).lineTo(40 + largura, y).strokeColor('#dddddd').stroke();

      // Tomador
      y += 14;
      doc.fillColor(cinza).fontSize(8).font('Helvetica-Bold').text('TOMADOR DE SERVICOS', 40, y);
      y += 14;
      doc.fillColor(preto).fontSize(11).font('Helvetica-Bold').text(tomador?.nome || 'Consumidor final', 40, y, { width: largura });
      y += 15;
      doc.fontSize(9).font('Helvetica').text(
        [tomador?.doc ? `CPF/CNPJ ${formataDoc(tomador.doc)}` : null, tomador?.email || null].filter(Boolean).join('   |   ') || '-',
        40, y, { width: largura },
      );

      y += 34;
      doc.moveTo(40, y).lineTo(40 + largura, y).strokeColor('#dddddd').stroke();

      // Servico
      y += 14;
      doc.fillColor(cinza).fontSize(8).font('Helvetica-Bold').text('DISCRIMINACAO DOS SERVICOS', 40, y);
      y += 14;
      doc.fillColor(preto).fontSize(10).font('Helvetica').text(servico?.descricao || '-', 40, y, { width: largura });
      y = doc.y + 8;
      doc.fontSize(9).fillColor(cinza).text(
        `Codigo de tributacao nacional: ${servico?.codigo_trib_nacional || '-'}`,
        40, y, { width: largura },
      );
      y = doc.y + 18;

      // Valores
      const valorServico = Number(valores?.total_centavos || 0);
      const iss = Number(valores?.iss_valor_centavos || 0);
      doc.rect(40, y, largura, 26).fill('#f1f5f9');
      doc.fillColor(preto).fontSize(9).font('Helvetica-Bold').text('VALOR DO SERVICO', 52, y + 8);
      doc.font('Helvetica-Bold').text(moeda(valorServico), 40, y + 8, { width: largura - 12, align: 'right' });
      y += 26;
      doc.rect(40, y, largura, 24).fill('#0f172a');
      doc.fillColor('#ffffff').fontSize(10).font('Helvetica-Bold').text('VALOR TOTAL DA NOTA', 52, y + 7);
      doc.text(moeda(valorServico), 40, y + 7, { width: largura - 12, align: 'right' });
      void iss;

      y += 44;
      doc.fillColor(cinza).fontSize(8).font('Helvetica').text(
        'Documento gerado eletronicamente a partir da DPS autorizada pelo Sistema Nacional da NFS-e. ' +
          'A autenticidade pode ser conferida pela chave de acesso no portal nfse.gov.br.',
        40, y, { width: largura, align: 'justify' },
      );

      doc.fontSize(7).fillColor('#888888').text(
        `Emitido por Cortevo Barber em ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`,
        40, doc.page.height - 60, { width: largura, align: 'center' },
      );

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}
