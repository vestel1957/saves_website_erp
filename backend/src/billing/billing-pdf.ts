import PDFDocument from 'pdfkit';
import type { Response } from 'express';

const cop = (n: number) =>
  '$ ' + new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 }).format(Math.round(n || 0));
// Las fechas de día (invoiceDate/dueDate) viven en medianoche UTC exacta: se
// formatean en UTC para que el día no dependa de la zona del servidor (con el
// proceso al oeste de UTC, el 01/08 saldría impreso como 31/07). Los timestamps
// reales (pagos) no caen en medianoche exacta y siguen en hora del servidor.
const esSoloFecha = (f: Date) =>
  f.getUTCHours() === 0 && f.getUTCMinutes() === 0 && f.getUTCSeconds() === 0 && f.getUTCMilliseconds() === 0;
const fmt = (d: Date | string) => {
  const f = new Date(d);
  return f.toLocaleDateString('es-CO', esSoloFecha(f) ? { timeZone: 'UTC' } : undefined);
};

import * as B from '../common/pdf/brand';

type InvoiceDetail = {
  tid: number; kind: string | null; status: string | null;
  date: Date | string; dueDate: Date | string | null;
  period: string | null;
  subtotal: number; tax: number; discount: number; total: number; paid: number; balance: number;
  paymentMethod: string | null;
  /** Observación de la factura (y, si está anulada, el motivo de la anulación). */
  notes?: string | null;
  subscriber: { name: string; abonado: number; docType: string | null; docNumber: string | null; email: string | null; phone: string | null; branch: string | null } | null;
  items: { product: string | null; description: string | null; qty: number; price: number; taxRate: number; subtotal: number; taxTotal: number }[];
  payments: { date: Date | string; amount: number; method: string | null; status: string | null }[];
};

/** Factura de venta (impresión estándar Vestel). */
export function invoicePdf(res: Response, inv: InvoiceDetail) {
  const doc = B.newDoc(PDFDocument);
  doc.pipe(res);
  renderInvoice(doc, inv);
}

/**
 * Genera el mismo PDF pero como Buffer en memoria (para adjuntarlo por WhatsApp,
 * correo, etc.). Reutiliza exactamente el render de `invoicePdf`.
 */
export function invoicePdfBuffer(inv: InvoiceDetail): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = B.newDoc(PDFDocument);
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    renderInvoice(doc, inv);
  });
}

/** Dibuja el contenido de la factura sobre el documento (compartido por ambos exportadores). */
function renderInvoice(doc: PDFKit.PDFDocument, inv: InvoiceDetail) {
  B.docHeader(doc, `Factura N° ${inv.tid}`, {
    right: inv.kind ?? undefined,
    chip: inv.status ?? undefined,
  });

  const s = inv.subscriber;
  B.kvGrid(doc, [
    ['Cliente', s?.name ?? '—'],
    ['Fecha', fmt(inv.date)],
    ['Documento', `${s?.docType ?? ''} ${s?.docNumber ?? '—'}`.trim()],
    ['Vence', inv.dueDate ? fmt(inv.dueDate) : '—'],
    ['Abonado N°', String(s?.abonado ?? '—')],
    ['Sede', s?.branch ?? '—'],
    // El cliente llama preguntando "¿de qué mes es esta factura?": el periodo va
    // en la cabecera, no escondido en el renglón. En las fijas no hay periodo.
    ['Periodo', inv.period ?? 'Cargo puntual'],
    ...(s?.phone ? ([['Teléfono', s.phone]] as [string, string][]) : []),
  ]);

  B.section(doc, 'Detalle de la factura');
  const cols: B.Col[] = [
    { label: 'Descripción', x: 46, w: 275 },
    { label: 'Cant.', x: 330, w: 45, align: 'right' },
    { label: 'V. unit.', x: 380, w: 70, align: 'right' },
    { label: 'IVA', x: 455, w: 35, align: 'right' },
    { label: 'Total', x: 495, w: 55, align: 'right' },
  ];
  B.thead(doc, cols);
  inv.items.forEach((it, i) => {
    if (doc.y > 700) {
      B.newPage(doc);
      B.thead(doc, cols);
    }
    B.trow(doc, cols, [
      // Producto Y descripción: con solo la descripción, dos renglones distintos
      // salían idénticos ("Mensualidad julio 2026") en la factura del cliente.
      [it.product, it.description].filter(Boolean).join(' — ') || 'Ítem',
      String(it.qty),
      cop(it.price),
      it.taxRate ? `${it.taxRate}%` : '—',
      // Total de la línea desde `price` (base sin IVA en AMBAS convenciones) + su
      // IVA. No se usa `subtotal`: en los ítems importados del legacy ese campo
      // viene con el IVA YA incluido, y sumarle taxTotal lo cobraba dos veces —
      // los renglones no cuadraban contra el total del pie de la factura.
      cop(it.qty * it.price + it.taxTotal),
    ], i);
  });

  B.totals(doc, [
    ['Subtotal', cop(inv.subtotal)],
    ...(inv.discount ? ([['Descuento', `- ${cop(inv.discount)}`]] as [string, string][]) : []),
    ['IVA', cop(inv.tax)],
    ['Pagado', cop(inv.paid)],
    // El saldo va destacado, no el total: es el número por el que el cliente
    // llama a preguntar.
    ['Saldo', cop(inv.balance)],
  ]);

  // La observación es lo que explica la factura al que la recibe ("descuento 5 %",
  // "se corrigió el plan"): estaba en la BD y no salía impresa en ninguna parte.
  if (inv.notes) {
    B.section(doc, 'Observación');
    B.note(doc, inv.notes);
  }

  if (inv.payments?.length) {
    B.section(doc, 'Pagos aplicados');
    const pc: B.Col[] = [
      { label: 'Fecha', x: 46, w: 90 },
      { label: 'Medio', x: 150, w: 140 },
      { label: 'Estado', x: 300, w: 120 },
      { label: 'Valor', x: 440, w: 110, align: 'right' },
    ];
    B.thead(doc, pc);
    inv.payments.forEach((p, i) =>
      B.trow(doc, pc, [
        fmt(p.date), p.method ?? '—', p.status ?? '—',
        { t: cop(p.amount), color: B.OK, bold: true },
      ], i),
    );
  }

  B.finish(doc);
}
