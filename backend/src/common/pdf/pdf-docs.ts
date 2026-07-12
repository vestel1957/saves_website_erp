import PDFDocument from 'pdfkit';
import type { Response } from 'express';

const cop = (n: number) =>
  '$ ' + new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 }).format(Math.round(n || 0));
const fmt = (d: Date | string | null) => (d ? new Date(d).toLocaleDateString('es-CO') : '—');
const BRAND = '#1e3a8a';
const GRAY = '#666';

function brandHeader(doc: PDFKit.PDFDocument, title: string) {
  doc.fillColor(BRAND).fontSize(20).font('Helvetica-Bold').text('VESTEL', 40, 40);
  doc.fillColor(GRAY).fontSize(9).font('Helvetica').text('Servicios de Internet y Televisión', 40, 64);
  doc.fillColor(GRAY).fontSize(8).text('VESGA TELEVISION S.A.S · NIT 813.001.768-1', 40, 76);
  doc.moveTo(40, 96).lineTo(555, 96).strokeColor('#ddd').stroke();
  doc.fillColor('#111').fontSize(15).font('Helvetica-Bold').text(title, 40, 108);
  doc.y = 134;
}

function kv(doc: PDFKit.PDFDocument, l: string, v: string) {
  doc.fontSize(10).fillColor('#333');
  doc.font('Helvetica-Bold').text(l, { continued: true }).font('Helvetica').text(` ${v}`);
}

// ---------------------------------------------------------------------------
export type CashCloseData = {
  cashAccountName: string;
  date: Date | string;
  userName: string;
  base: number; sales: number; expenses: number; deposited: number; surplus: number;
};

/** Comprobante de cierre de caja (arqueo). */
export function cashClosePdf(res: Response, d: CashCloseData) {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  doc.pipe(res);
  brandHeader(doc, 'Cierre de caja');

  kv(doc, 'Caja:', d.cashAccountName);
  kv(doc, 'Fecha:', fmt(d.date));
  kv(doc, 'Responsable:', d.userName || '—');
  doc.moveDown(1);

  const rows: [string, number, boolean?][] = [
    ['Base inicial', d.base],
    ['(+) Ventas / recaudo', d.sales],
    ['(−) Egresos', d.expenses],
    ['(−) Consignado', d.deposited],
    ['(=) Excedente en caja', d.surplus, true],
  ];
  const x0 = 40, x1 = 380, w = 175;
  for (const [label, val, bold] of rows) {
    const y = doc.y;
    if (bold) { doc.rect(x0, y - 3, 515, 22).fill('#f1f5ff'); doc.fillColor('#111'); }
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 12 : 11).fillColor(bold ? BRAND : '#333');
    doc.text(label, x0 + 6, y + 2);
    doc.text(cop(val), x1, y + 2, { width: w, align: 'right' });
    doc.y = y + 24;
    doc.moveTo(x0, doc.y - 3).lineTo(555, doc.y - 3).strokeColor('#eee').stroke();
  }

  doc.moveDown(4);
  doc.fontSize(9).fillColor(GRAY);
  doc.text('_______________________________', 40, doc.y);
  doc.text('Firma responsable de caja', 40, doc.y + 4);
  doc.end();
}

// ---------------------------------------------------------------------------
export type ReceiptData = {
  number: string;
  date: Date | string;
  cashier: string | null;
  method: string | null;
  subscriber: { name: string; abonado: number | null; docNumber: string | null } | null;
  items: { tid: number | null; concept: string; amount: number }[];
  total: number;
};

/** Recibo de caja (comprobante de pago). */
export function receiptPdf(res: Response, d: ReceiptData) {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  doc.pipe(res);
  brandHeader(doc, `Recibo de caja N° ${d.number}`);

  const s = d.subscriber;
  kv(doc, 'Recibimos de:', s?.name ?? '—');
  if (s?.docNumber) kv(doc, 'Documento:', s.docNumber);
  if (s?.abonado != null) kv(doc, 'Abonado N°:', String(s.abonado));
  kv(doc, 'Fecha:', fmt(d.date));
  kv(doc, 'Forma de pago:', d.method ?? '—');
  if (d.cashier) kv(doc, 'Cajero:', d.cashier);
  doc.moveDown(1);

  // Detalle por factura abonada
  const rowY = doc.y;
  doc.rect(40, rowY - 2, 515, 18).fill(BRAND);
  doc.fillColor('#fff').fontSize(9).font('Helvetica-Bold');
  doc.text('Concepto', 46, rowY + 3);
  doc.text('Factura', 360, rowY + 3, { width: 80, align: 'right' });
  doc.text('Valor', 450, rowY + 3, { width: 100, align: 'right' });
  doc.y = rowY + 22;

  doc.font('Helvetica').fontSize(10).fillColor('#222');
  for (const it of d.items) {
    const y = doc.y;
    doc.text(it.concept, 46, y, { width: 300 });
    doc.text(it.tid ? `#${it.tid}` : '—', 360, y, { width: 80, align: 'right' });
    doc.text(cop(it.amount), 450, y, { width: 100, align: 'right' });
    doc.y = y + 18;
    doc.moveTo(40, doc.y - 3).lineTo(555, doc.y - 3).strokeColor('#eee').stroke();
  }

  doc.moveDown(0.6);
  doc.font('Helvetica-Bold').fontSize(13).fillColor(BRAND);
  doc.text('Total recibido:', 300, doc.y, { width: 150, align: 'right', continued: true })
     .text(`  ${cop(d.total)}`, { align: 'right' });

  doc.moveDown(4);
  doc.fontSize(9).fillColor(GRAY);
  doc.text('_______________________________', 40, doc.y);
  doc.text('Firma / sello de caja', 40, doc.y + 4);
  doc.end();
}

// ---------------------------------------------------------------------------
export type ContractData = {
  name: string; docType: string | null; docNumber: string | null;
  abonado: number; addressLine: string | null; branch: string | null;
  phone: string | null; email: string | null;
  plan: string | null; profile: string | null; service: string | null;
  contractDate: Date | string | null;
};

// ---------------------------------------------------------------------------
export type ServiceOrderData = {
  code: string;
  type: string;
  subject: string;
  status: string;
  priority: string | null;
  created: Date | string | null;
  finalDate: Date | string | null;
  technician: string | null;
  problem: string | null;
  section: string | null;
  subscriber: {
    name: string; doc: string | null; abonado: number | null; phone: string | null;
    address: string | null; barrio: string | null; branch: string | null;
    services: string | null; debt: number;
  } | null;
  equipment: { mac: string | null; installType: string | null; port: number | null; vlan: number | null; nat: number | null; serial: string | null }[];
  materials: { name: string; qty: number; price: number; total: number }[];
  threads: { message: string | null; date: Date | string; hasPhoto: boolean }[];
  signature: { name: string; cc: string | null; rel: string | null } | null;
};

/** Orden / acta de servicio técnico (reemplaza el legacy pdfticket / view-ticket). */
export function serviceOrderPdf(res: Response, d: ServiceOrderData) {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  doc.pipe(res);
  brandHeader(doc, `Orden de servicio N° ${d.code}`);

  // Cabecera de la orden
  kv(doc, 'Detalle:', d.type);
  if (d.subject) kv(doc, 'Asunto:', d.subject);
  kv(doc, 'Estado:', d.status);
  if (d.priority) kv(doc, 'Prioridad:', d.priority);
  kv(doc, 'Creada:', fmt(d.created));
  if (d.finalDate) kv(doc, 'Finalizada:', fmt(d.finalDate));
  kv(doc, 'Técnico:', d.technician || '—');
  doc.moveDown(0.8);

  // Datos del cliente
  const s = d.subscriber;
  if (s) {
    sectionTitle(doc, 'Cliente');
    kv(doc, 'Nombre:', s.name);
    if (s.doc) kv(doc, 'Documento:', s.doc);
    if (s.abonado != null) kv(doc, 'Abonado N°:', String(s.abonado));
    if (s.phone) kv(doc, 'Celular:', s.phone);
    if (s.address) kv(doc, 'Dirección:', [s.address, s.barrio].filter(Boolean).join(', '));
    if (s.branch) kv(doc, 'Sede:', s.branch);
    if (s.services) kv(doc, 'Servicios:', s.services);
    kv(doc, 'Deuda actual:', cop(s.debt));
    doc.moveDown(0.8);
  }

  // Problema / observaciones
  if (d.problem || d.section) {
    sectionTitle(doc, 'Descripción');
    doc.fontSize(10).fillColor('#333').font('Helvetica');
    if (d.problem) doc.text(d.problem, { align: 'justify' });
    if (d.section) { doc.moveDown(0.2); doc.fillColor(GRAY).fontSize(9).text(d.section, { align: 'justify' }); }
    doc.moveDown(0.8);
  }

  // Equipo asignado
  if (d.equipment.length) {
    sectionTitle(doc, 'Equipo asignado');
    doc.fontSize(9.5).fillColor('#333').font('Helvetica');
    for (const e of d.equipment) {
      const parts = [
        e.mac ? `MAC ${e.mac}` : null, e.installType, e.serial ? `S/N ${e.serial}` : null,
        e.port != null ? `Puerto ${e.port}` : null, e.vlan != null ? `VLAN ${e.vlan}` : null, e.nat != null ? `NAT ${e.nat}` : null,
      ].filter(Boolean).join(' · ');
      doc.text(`• ${parts || '—'}`);
    }
    doc.moveDown(0.8);
  }

  // Material consumido
  if (d.materials.length) {
    sectionTitle(doc, 'Material utilizado');
    const rowY = doc.y;
    doc.rect(40, rowY - 2, 515, 18).fill(BRAND);
    doc.fillColor('#fff').fontSize(9).font('Helvetica-Bold');
    doc.text('Material', 46, rowY + 3);
    doc.text('Cant.', 360, rowY + 3, { width: 50, align: 'right' });
    doc.text('V. unit.', 415, rowY + 3, { width: 60, align: 'right' });
    doc.text('Total', 480, rowY + 3, { width: 70, align: 'right' });
    doc.y = rowY + 22;
    doc.font('Helvetica').fontSize(9.5).fillColor('#222');
    let tot = 0;
    for (const m of d.materials) {
      const y = doc.y; tot += m.total;
      doc.text(m.name, 46, y, { width: 300 });
      doc.text(String(m.qty), 360, y, { width: 50, align: 'right' });
      doc.text(cop(m.price), 415, y, { width: 60, align: 'right' });
      doc.text(cop(m.total), 480, y, { width: 70, align: 'right' });
      doc.y = y + 16;
      doc.moveTo(40, doc.y - 3).lineTo(555, doc.y - 3).strokeColor('#eee').stroke();
    }
    doc.font('Helvetica-Bold').fontSize(10).fillColor(BRAND);
    doc.text('Total material:', 340, doc.y + 2, { width: 130, align: 'right', continued: true }).text(`  ${cop(tot)}`, { align: 'right' });
    doc.moveDown(1);
  }

  // Seguimiento
  if (d.threads.length) {
    sectionTitle(doc, 'Seguimiento');
    doc.fontSize(9).fillColor('#333').font('Helvetica');
    for (const h of d.threads) {
      if (!h.message && !h.hasPhoto) continue;
      const label = `${fmt(h.date)}${h.hasPhoto ? ' · 📷 foto' : ''}`;
      doc.font('Helvetica-Bold').fillColor(GRAY).text(label);
      if (h.message) doc.font('Helvetica').fillColor('#333').text(h.message, { align: 'justify' });
      doc.moveDown(0.3);
    }
    doc.moveDown(0.5);
  }

  // Firma de recibido
  doc.moveDown(2);
  const y = doc.y > 680 ? (doc.addPage(), 120) : doc.y;
  doc.fontSize(9).fillColor(GRAY);
  doc.text('_______________________________', 40, y);
  if (d.signature) {
    doc.fillColor('#333').fontSize(9).text(`${d.signature.name}${d.signature.cc ? ` · CC ${d.signature.cc}` : ''}`, 40, y + 4);
    if (d.signature.rel) doc.fillColor(GRAY).text(`Parentesco: ${d.signature.rel}`, 40, y + 16);
  }
  doc.fillColor(GRAY).text('Firma de quien recibe', 40, y + (d.signature ? 30 : 4));
  doc.text('_______________________________', 320, y);
  doc.text(`Técnico: ${d.technician || ''}`, 320, y + 4);
  doc.end();
}

function sectionTitle(doc: PDFKit.PDFDocument, title: string) {
  doc.moveDown(0.2);
  doc.fillColor(BRAND).fontSize(11).font('Helvetica-Bold').text(title.toUpperCase());
  doc.moveTo(40, doc.y + 1).lineTo(555, doc.y + 1).strokeColor('#ccd').stroke();
  doc.moveDown(0.4);
}

/** Contrato de prestación de servicios (plantilla estándar Vestel). */
export function contractPdf(res: Response, d: ContractData) {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  doc.pipe(res);
  brandHeader(doc, 'Contrato de prestación de servicios');

  kv(doc, 'Suscriptor:', d.name);
  kv(doc, 'Identificación:', `${d.docType ?? ''} ${d.docNumber ?? '—'}`.trim());
  kv(doc, 'Abonado N°:', String(d.abonado));
  if (d.addressLine) kv(doc, 'Dirección:', d.addressLine);
  if (d.branch) kv(doc, 'Sede:', d.branch);
  if (d.phone) kv(doc, 'Teléfono:', d.phone);
  if (d.email) kv(doc, 'Correo:', d.email);
  kv(doc, 'Plan / servicio:', [d.plan, d.profile].filter(Boolean).join(' · ') || d.service || '—');
  kv(doc, 'Fecha de contrato:', fmt(d.contractDate));
  doc.moveDown(1);

  doc.fontSize(9.5).fillColor('#333').font('Helvetica');
  const cláusulas = [
    'PRIMERA — OBJETO: VESGA TELEVISION S.A.S (VESTEL) prestará al suscriptor el servicio de acceso a Internet y/o televisión conforme al plan contratado.',
    'SEGUNDA — VALOR Y PAGO: el suscriptor pagará mensualmente el valor del plan dentro de las fechas establecidas en la factura. La mora autoriza la suspensión del servicio.',
    'TERCERA — EQUIPOS: los equipos entregados en comodato son propiedad de VESTEL y deben devolverse al terminar el contrato en buen estado.',
    'CUARTA — SUSPENSIÓN Y RECONEXIÓN: el incumplimiento en el pago faculta a VESTEL para suspender el servicio; la reconexión podrá generar un cargo.',
    'QUINTA — VIGENCIA: el presente contrato rige a partir de la fecha de instalación y se renueva automáticamente por periodos mensuales.',
  ];
  for (const c of cláusulas) {
    doc.text(c, { align: 'justify' });
    doc.moveDown(0.5);
  }

  doc.moveDown(3);
  const y = doc.y;
  doc.fontSize(9).fillColor(GRAY);
  doc.text('_______________________________', 40, y);
  doc.text('El suscriptor', 40, y + 4);
  doc.text('_______________________________', 320, y);
  doc.text('Por VESTEL', 320, y + 4);
  doc.end();
}
