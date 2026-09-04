import PDFDocument from 'pdfkit';
import type { Response } from 'express';
import * as B from '../common/pdf/brand';

const cop = (n: number) =>
  '$ ' + new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 }).format(Math.round(n || 0));

const fmtDate = (d: Date | string) =>
  new Date(d).toLocaleDateString('es-CO', { year: 'numeric', month: 'long', day: 'numeric' });

const fmtShort = (d: Date | string) => new Date(d).toLocaleDateString('es-CO');

type Statement = {
  subscriber: { name: string; abonado: number; docType: string | null; docNumber: string | null; addressLine: string | null; branch: string | null };
  totalCharges: number; totalPayments: number; balance: number; pazysalvo: boolean;
  puedeEmitirPazYSalvo?: boolean; motivosPazYSalvo?: string[];
  movements: { date: string | Date; concept: string; debit: number; credit: number; balance: number }[];
};

const BRAND = B.NAVY;

/**
 * Quien firma el certificado de paz y salvo. Va impreso bajo la línea de firma:
 * antes salía sólo "Firma autorizada — VESTEL", y un certificado sin el nombre de
 * quien lo expide no le sirve a quien lo recibe (banco, arrendador, otro operador).
 *
 * Está aquí, en una sola constante, porque el mismo PDF lo emiten dos caminos —el
 * botón de la ficha del cliente y el chatbot por WhatsApp— y ambos pasan por
 * `pazYSalvoPdf`. Si mañana firma otra persona, se cambia este bloque y cambia en
 * los dos sitios. No se lee del usuario que pulsa el botón a propósito: quien
 * expide el certificado es siempre la misma persona, no la cajera de turno.
 */
const FIRMANTE = {
  nombre: 'Windy Sussan Muñoz Martinez',
  documento: 'C.C. 46.456.153',
  cargo: 'Firma autorizada — VESTEL',
};

const header = (doc: PDFKit.PDFDocument, title: string) => B.docHeader(doc, title);

function clientBlock(doc: PDFKit.PDFDocument, sub: Statement['subscriber']) {
  doc.fontSize(10).font('Helvetica').fillColor('#333');
  const line = (l: string, v: string) => {
    doc.font('Helvetica-Bold').text(l, { continued: true }).font('Helvetica').text(` ${v}`);
  };
  line('Cliente:', sub.name);
  line('Documento:', `${sub.docType ?? ''} ${sub.docNumber ?? '—'}`.trim());
  line('Abonado N°:', String(sub.abonado));
  if (sub.addressLine) line('Dirección:', sub.addressLine);
  if (sub.branch) line('Sede:', sub.branch);
  doc.moveDown(0.8);
}

/**
 * Certificado de paz y salvo.
 *
 * Sólo se llama cuando el certificado SE PUEDE expedir: quien decide es el
 * controlador (`SubscribersController.pazYSalvo`), que exige saldo en cero y equipo
 * devuelto. Aquí ya no hay versión "en negativo" — un PDF con membrete diciendo que
 * el cliente debe no es un certificado de nada, y era lo que salía antes cada vez que
 * alguien pulsaba el botón sin mirar el saldo.
 */
export function pazYSalvoPdf(res: Response, data: Statement) {
  const doc = B.newDoc(PDFDocument);
  doc.pipe(res);
  header(doc, 'Certificado de Paz y Salvo');
  clientBlock(doc, data.subscriber);

  doc.moveDown(0.5).fontSize(11).font('Helvetica').fillColor('#111');
  doc.text(
    `Por medio de la presente, VESTEL certifica que el cliente ${data.subscriber.name}, ` +
    `identificado con ${data.subscriber.docType ?? 'documento'} ${data.subscriber.docNumber ?? ''} ` +
    `(abonado N° ${data.subscriber.abonado}), se encuentra A PAZ Y SALVO por todo concepto ` +
    `con nuestra empresa a la fecha de expedición de este documento, y que ha hecho ` +
    `entrega de la totalidad de los equipos de nuestra propiedad que tenía a su cargo.`,
    { align: 'justify', lineGap: 3 },
  );

  doc.moveDown(1.5).fillColor('#333').fontSize(10);
  doc.text(`Expedido el ${fmtDate(new Date())}.`);
  doc.moveDown(3);
  doc.moveTo(40, doc.y).lineTo(240, doc.y).strokeColor('#999').stroke();
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#111')
    .text(FIRMANTE.nombre, 40, doc.y + 5, { width: 200 });
  doc.font('Helvetica').fontSize(9).fillColor('#666')
    .text(FIRMANTE.documento, 40, doc.y + 1, { width: 200 });
  doc.text(FIRMANTE.cargo, 40, doc.y + 1, { width: 200 });

  B.finish(doc);
}

/** Estado de cuenta detallado. */
export function statementPdf(res: Response, data: Statement) {
  const doc = B.newDoc(PDFDocument);
  doc.pipe(res);
  header(doc, 'Estado de Cuenta');
  clientBlock(doc, data.subscriber);

  // Resumen
  const boxY = doc.y;
  const box = (x: number, label: string, value: string, color: string) => {
    doc.roundedRect(x, boxY, 160, 42, 4).fillAndStroke('#f8fafc', '#e2e8f0');
    doc.fillColor('#64748b').fontSize(8).font('Helvetica').text(label, x + 10, boxY + 8);
    doc.fillColor(color).fontSize(14).font('Helvetica-Bold').text(value, x + 10, boxY + 20);
  };
  box(40, 'TOTAL FACTURADO', cop(data.totalCharges), '#111');
  box(210, 'TOTAL PAGADO', cop(data.totalPayments), '#15803d');
  box(380, 'SALDO ACTUAL', cop(data.balance), data.balance > 0 ? '#b91c1c' : '#15803d');
  doc.y = boxY + 60;
  doc.x = 40;

  // Tabla (más antiguo → reciente)
  const rows = [...data.movements].reverse();
  const cols = [
    { x: 40, w: 70, label: 'Fecha' },
    { x: 110, w: 200, label: 'Concepto' },
    { x: 310, w: 75, label: 'Cargo', align: 'right' as const },
    { x: 385, w: 75, label: 'Abono', align: 'right' as const },
    { x: 460, w: 95, label: 'Saldo', align: 'right' as const },
  ];
  const drawHead = () => {
    doc.rect(40, doc.y, 515, 18).fill(BRAND);
    doc.fillColor('#fff').fontSize(8.5).font('Helvetica-Bold');
    const y = doc.y + 5;
    cols.forEach((c) => doc.text(c.label, c.x + 4, y, { width: c.w - 8, align: c.align ?? 'left' }));
    doc.y += 18;
  };
  drawHead();
  doc.font('Helvetica').fontSize(8.5);
  rows.forEach((m, i) => {
    if (doc.y > 780) { doc.addPage(); drawHead(); doc.font('Helvetica').fontSize(8.5); }
    const y = doc.y + 4;
    if (i % 2) doc.rect(40, doc.y, 515, 16).fill('#f8fafc');
    doc.fillColor('#333');
    doc.text(fmtShort(m.date), cols[0].x + 4, y, { width: cols[0].w - 8 });
    doc.text(m.concept, cols[1].x + 4, y, { width: cols[1].w - 8 });
    doc.text(m.debit ? cop(m.debit) : '', cols[2].x + 4, y, { width: cols[2].w - 8, align: 'right' });
    doc.fillColor('#15803d').text(m.credit ? cop(m.credit) : '', cols[3].x + 4, y, { width: cols[3].w - 8, align: 'right' });
    doc.fillColor(m.balance > 0 ? '#b91c1c' : '#333').text(cop(m.balance), cols[4].x + 4, y, { width: cols[4].w - 8, align: 'right' });
    doc.y += 16;
  });

  doc.moveDown(1.5).fontSize(8).fillColor('#999').font('Helvetica')
    .text(`Generado el ${fmtDate(new Date())} · ${rows.length} movimiento(s).`, 40);

  B.finish(doc);
}
