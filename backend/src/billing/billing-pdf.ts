import PDFDocument from 'pdfkit';
import type { Response } from 'express';

const cop = (n: number) =>
  '$ ' + new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 }).format(Math.round(n || 0));
const fmt = (d: Date | string) => new Date(d).toLocaleDateString('es-CO');

const BRAND = '#1e3a8a';
const GRAY = '#666';

type InvoiceDetail = {
  tid: number; kind: string | null; status: string | null;
  date: Date | string; dueDate: Date | string | null;
  subtotal: number; tax: number; discount: number; total: number; paid: number; balance: number;
  paymentMethod: string | null;
  subscriber: { name: string; abonado: number; docType: string | null; docNumber: string | null; email: string | null; phone: string | null; branch: string | null } | null;
  items: { product: string | null; description: string | null; qty: number; price: number; taxRate: number; subtotal: number; taxTotal: number }[];
  payments: { date: Date | string; amount: number; method: string | null; status: string | null }[];
};

function brandHeader(doc: PDFKit.PDFDocument, title: string, right?: string) {
  doc.fillColor(BRAND).fontSize(20).font('Helvetica-Bold').text('VESTEL', 40, 40);
  doc.fillColor(GRAY).fontSize(9).font('Helvetica').text('Servicios de Internet y Televisión', 40, 64);
  doc.fillColor(GRAY).fontSize(8).text('VESGA TELEVISION S.A.S · NIT 813.001.768-1', 40, 76);
  if (right) {
    doc.fillColor('#111').fontSize(13).font('Helvetica-Bold').text(right, 340, 44, { width: 215, align: 'right' });
  }
  doc.moveTo(40, 96).lineTo(555, 96).strokeColor('#ddd').stroke();
  doc.fillColor('#111').fontSize(15).font('Helvetica-Bold').text(title, 40, 108);
  doc.y = 132;
}

/** Factura de venta (impresión estándar Vestel). */
export function invoicePdf(res: Response, inv: InvoiceDetail) {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  doc.pipe(res);
  renderInvoice(doc, inv);
}

/**
 * Genera el mismo PDF pero como Buffer en memoria (para adjuntarlo por WhatsApp,
 * correo, etc.). Reutiliza exactamente el render de `invoicePdf`.
 */
export function invoicePdfBuffer(inv: InvoiceDetail): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    renderInvoice(doc, inv);
  });
}

/** Dibuja el contenido de la factura sobre el documento (compartido por ambos exportadores). */
function renderInvoice(doc: PDFKit.PDFDocument, inv: InvoiceDetail) {
  brandHeader(doc, `Factura N° ${inv.tid}`, `${inv.kind ?? ''}`);

  // Cliente + meta en dos columnas
  const topY = doc.y;
  const s = inv.subscriber;
  doc.fontSize(10).fillColor('#333');
  const line = (l: string, v: string) => {
    doc.font('Helvetica-Bold').text(l, { continued: true }).font('Helvetica').text(` ${v}`);
  };
  line('Cliente:', s?.name ?? '—');
  line('Documento:', `${s?.docType ?? ''} ${s?.docNumber ?? '—'}`.trim());
  line('Abonado N°:', String(s?.abonado ?? '—'));
  if (s?.branch) line('Sede:', s.branch);
  if (s?.phone) line('Teléfono:', s.phone);

  doc.fontSize(10).fillColor('#333');
  doc.font('Helvetica').text(`Fecha: ${fmt(inv.date)}`, 360, topY, { width: 195, align: 'right' });
  if (inv.dueDate) doc.text(`Vence: ${fmt(inv.dueDate)}`, 360, doc.y, { width: 195, align: 'right' });
  doc.text(`Estado: ${inv.status ?? '—'}`, 360, doc.y, { width: 195, align: 'right' });

  doc.y = Math.max(doc.y, topY + 70);
  doc.moveDown(0.6);

  // Tabla de ítems
  const cols = { desc: 40, qty: 330, price: 380, tax: 445, total: 500 };
  const rowY = doc.y;
  doc.rect(40, rowY - 2, 515, 18).fill(BRAND);
  doc.fillColor('#fff').fontSize(9).font('Helvetica-Bold');
  doc.text('Descripción', cols.desc + 4, rowY + 3);
  doc.text('Cant', cols.qty, rowY + 3, { width: 40, align: 'right' });
  doc.text('Precio', cols.price, rowY + 3, { width: 55, align: 'right' });
  doc.text('IVA%', cols.tax, rowY + 3, { width: 45, align: 'right' });
  doc.text('Total', cols.total, rowY + 3, { width: 51, align: 'right' });
  doc.y = rowY + 22;

  doc.font('Helvetica').fontSize(9).fillColor('#222');
  for (const it of inv.items) {
    const y = doc.y;
    const label = it.description || it.product || 'Ítem';
    doc.text(label, cols.desc + 4, y, { width: 280 });
    const lineH = Math.max(doc.y - y, 12);
    doc.text(String(it.qty), cols.qty, y, { width: 40, align: 'right' });
    doc.text(cop(it.price), cols.price, y, { width: 55, align: 'right' });
    doc.text(String(it.taxRate), cols.tax, y, { width: 45, align: 'right' });
    doc.text(cop(it.subtotal + it.taxTotal), cols.total, y, { width: 51, align: 'right' });
    doc.y = y + lineH + 4;
    doc.moveTo(40, doc.y - 2).lineTo(555, doc.y - 2).strokeColor('#eee').stroke();
  }

  // Totales
  doc.moveDown(0.5);
  const totY = doc.y;
  const totLine = (l: string, v: string, bold = false) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 10).fillColor(bold ? '#111' : '#444');
    doc.text(l, 360, doc.y, { width: 120, align: 'right', continued: true }).text(`  ${v}`, { align: 'right' });
  };
  totLine('Subtotal:', cop(inv.subtotal));
  if (inv.discount) totLine('Descuento:', `- ${cop(inv.discount)}`);
  totLine('IVA:', cop(inv.tax));
  totLine('Total:', cop(inv.total), true);
  totLine('Pagado:', cop(inv.paid));
  totLine('Saldo:', cop(inv.balance), true);
  void totY;

  // Pagos aplicados
  if (inv.payments?.length) {
    doc.moveDown(1);
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#111').text('Pagos aplicados', 40);
    doc.font('Helvetica').fontSize(9).fillColor('#444');
    for (const p of inv.payments) {
      doc.text(`${fmt(p.date)} · ${p.method ?? '—'} · ${p.status ?? ''} — ${cop(p.amount)}`, 40);
    }
  }

  doc.fontSize(8).fillColor(GRAY).text('Documento generado por el sistema Vestel.', 40, 790, { width: 515, align: 'center' });
  doc.end();
}
