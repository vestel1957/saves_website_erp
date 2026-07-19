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
const fmtLargo = (d: Date | string | null) =>
  d ? new Date(d).toLocaleDateString('es-CO', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' }) : '—';

type Bucket = { cantidad: number; monto: number };

/** Los bloques de resumen del informe legacy (ver `treasury/cierre-informe.ts`). */
export type CashCloseInforme = {
  cobranza: { excento: Bucket; base: Bucket; iva: Bucket; total: Bucket };
  porBanco: { nombre: string; cantidad: number; monto: number }[];
  cajaVirtual: { nombre: string; cantidad: number; monto: number };
  formaPago: { saldoAnterior: Bucket; efectivo: Bucket; transferencia: Bucket; wompi: Bucket };
  servicios: {
    planes: { clave: string; megas: number; cantidad: number; monto: number }[];
    television: Bucket;
    mensualidades: Bucket;
    reconexiones: Bucket;
    afiliaciones: { producto: string; cantidad: number; monto: number }[];
    ventas: Bucket;
    materiales: Bucket;
    otros: Bucket;
    total: Bucket;
  };
  tipoServicio: { Internet: Bucket; Television: Bucket };
  meses: Record<'actual' | 'anterior' | 'anteriores', { cantidad: number; monto: number; Internet: Bucket; Television: Bucket }>;
  anulaciones: {
    anuladoDeCierre: Bucket; anuladoDeOtrosCierres: Bucket;
    cobranzaEfectiva: { monto: number }; cobradoNeto: number;
  };
  egresos: { ordenes: Bucket; traslados: Bucket; transacciones: Bucket; total: Bucket };
};

export type CashCloseData = {
  informe: CashCloseInforme;
  cashAccountName: string;
  date: Date | string;
  userName: string;
  proximoDiaHabil: Date | string;
  arrastre: number;
  ventas: number;
  egresos: number;
  transferencias: number;
  noEfectivo: number;
  excedente: number;
  descuadrado: boolean;
  efectivoHoy: number;
  porCategoria: { category: string; type: string; n: number; total: number }[];
  movimientos: {
    date: Date | string; note: string | null; payer: string; category: string;
    method: string | null; type: string; amount: number; firma: number;
  }[];
};

/**
 * Comprobante de cierre de caja — réplica del legacy.
 *
 * No lleva base ni consignado: allá la base es cero y el cierre barre el efectivo entero
 * del cajón, que se arrastra al próximo día hábil (ver `treasury/cierre-legacy.ts`).
 */
export function cashClosePdf(res: Response, d: CashCloseData) {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  doc.pipe(res);
  brandHeader(doc, 'Cierre de caja');

  kv(doc, 'Caja:', d.cashAccountName);
  kv(doc, 'Fecha:', fmtLargo(d.date));
  kv(doc, 'Cajero:', d.userName || '—');
  kv(doc, 'Arrastra a:', `${fmtLargo(d.proximoDiaHabil)} (próximo día hábil)`);
  doc.moveDown(0.8);

  if (d.descuadrado) {
    const y = doc.y;
    doc.rect(40, y, 515, 30).fill('#fff4e5');
    doc.fillColor('#8a5300').fontSize(9).font('Helvetica-Bold')
      .text('Este cierre ya no cuadra con el libro.', 46, y + 6);
    doc.font('Helvetica').text(
      `Se barrieron ${cop(d.excedente)}, pero con los movimientos vigentes hoy el cajón daría ${cop(d.efectivoHoy)}.`,
      46, y + 17, { width: 500 },
    );
    doc.y = y + 38;
  }

  sectionTitle(doc, 'Arqueo del cajón');
  const rows: [string, number, boolean?][] = [
    ['Arrastre que entró del cierre anterior', d.arrastre],
    ['(+) Recaudo en efectivo del día', d.ventas],
    ['(-) Egresos en efectivo', d.egresos],
    ...(d.transferencias !== 0 ? ([['(±) Traslados entre cajas', d.transferencias]] as [string, number][]) : []),
    ['(=) Excedente barrido', d.excedente, true],
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
  doc.font('Helvetica').fontSize(8).fillColor(GRAY).text(
    'La base es cero: al cerrar se lleva el efectivo entero del cajón.' +
      (d.noEfectivo > 0 ? ` El recaudo por banco/tarjeta (${cop(d.noEfectivo)}) no está en el cajón y no se barre.` : ''),
    40, doc.y + 4, { width: 515 },
  );
  doc.moveDown(1.2);

  // ── Los bloques de resumen del informe legacy ──────────────────────────────
  const inf = d.informe;
  const tabla = (titulo: string, filas: [string, number | string, number][], total?: [string, number | string, number]) => {
    if (doc.y > 690) { doc.addPage(); doc.y = 50; }
    sectionTitle(doc, titulo);
    let y = doc.y;
    doc.font('Helvetica-Bold').fontSize(8).fillColor(GRAY);
    doc.text('DESCRIPCIÓN', 46, y); doc.text('CANT', 330, y, { width: 60, align: 'right' });
    doc.text('MONTO', 420, y, { width: 130, align: 'right' });
    doc.y = y + 12;
    for (const [label, cant, monto] of filas) {
      if (doc.y > 770) { doc.addPage(); doc.y = 50; }
      y = doc.y;
      doc.font('Helvetica').fontSize(9).fillColor('#333');
      doc.text(label, 46, y, { width: 280, ellipsis: true });
      doc.text(String(cant), 330, y, { width: 60, align: 'right' });
      doc.text(cop(monto), 420, y, { width: 130, align: 'right' });
      doc.y = y + 13;
    }
    if (total) {
      y = doc.y;
      doc.rect(40, y - 2, 515, 17).fill('#f1f5ff');
      doc.font('Helvetica-Bold').fontSize(9).fillColor(BRAND);
      doc.text(total[0], 46, y + 2, { width: 280 });
      doc.text(String(total[1]), 330, y + 2, { width: 60, align: 'right' });
      doc.text(cop(total[2]), 420, y + 2, { width: 130, align: 'right' });
      doc.y = y + 22;
    }
    doc.moveDown(0.5);
  };

  tabla('Resumen Cobranza', [
    ['Excento', inf.cobranza.excento.cantidad, inf.cobranza.excento.monto],
    ['Base', inf.cobranza.base.cantidad, inf.cobranza.base.monto],
    ['iva', '', inf.cobranza.iva.monto],
  ], ['TOTAL COBRANZA', inf.cobranza.total.cantidad, inf.cobranza.total.monto]);

  tabla('Resumen por Banco',
    inf.porBanco.map((b) => [b.nombre, b.cantidad, b.monto] as [string, number, number]),
    ['TOTAL COBRANZA', inf.porBanco.reduce((s, b) => s + b.cantidad, 0), inf.porBanco.reduce((s, b) => s + b.monto, 0)],
  );

  tabla('Resumen por Forma de pago', [
    ['Saldo Anterior', inf.formaPago.saldoAnterior.cantidad, inf.formaPago.saldoAnterior.monto],
    ['Efectivo', inf.formaPago.efectivo.cantidad, inf.formaPago.efectivo.monto],
    ['Transferencia', inf.formaPago.transferencia.cantidad, inf.formaPago.transferencia.monto],
    ['WOMPI', inf.formaPago.wompi.cantidad, inf.formaPago.wompi.monto],
  ], ['TOTAL FORMA PAGO',
    inf.formaPago.saldoAnterior.cantidad + inf.formaPago.efectivo.cantidad + inf.formaPago.transferencia.cantidad + inf.formaPago.wompi.cantidad,
    inf.formaPago.saldoAnterior.monto + inf.formaPago.efectivo.monto + inf.formaPago.transferencia.monto + inf.formaPago.wompi.monto,
  ]);

  tabla('Resumen por Servicios', [
    ...inf.servicios.planes.map((p) => [`Internet ${p.megas}MG`, p.cantidad, p.monto] as [string, number, number]),
    ...(inf.servicios.television.cantidad ? ([['Television', inf.servicios.television.cantidad, inf.servicios.television.monto]] as [string, number, number][]) : []),
    ...inf.servicios.afiliaciones.map((a) => [a.producto, a.cantidad, a.monto] as [string, number, number]),
    ['Total Ventas', inf.servicios.ventas.cantidad, inf.servicios.ventas.monto],
    ['Total Reconexiones', inf.servicios.reconexiones.cantidad, inf.servicios.reconexiones.monto],
    ['Total Materiales', inf.servicios.materiales.cantidad, inf.servicios.materiales.monto],
    ['Total Otros', inf.servicios.otros.cantidad, inf.servicios.otros.monto],
  ], ['TOTAL', inf.servicios.total.cantidad, inf.servicios.total.monto]);

  tabla('Resumen por tipo de servicio', [
    ['Internet', inf.tipoServicio.Internet.cantidad, inf.tipoServicio.Internet.monto],
    ['Television', inf.tipoServicio.Television.cantidad, inf.tipoServicio.Television.monto],
  ], ['TOTAL TIPO DE SERVICIOS',
    inf.tipoServicio.Internet.cantidad + inf.tipoServicio.Television.cantidad,
    inf.tipoServicio.Internet.monto + inf.tipoServicio.Television.monto,
  ]);

  const mesLabel = (base: Date | string, delta: number) => {
    const dd = new Date(base);
    const x = new Date(Date.UTC(dd.getUTCFullYear(), dd.getUTCMonth() + delta, 1));
    return x.toLocaleDateString('es-CO', { month: 'long', year: 'numeric' });
  };
  tabla('Resumen de cargos cobrados por meses', [
    [mesLabel(d.date, 0), inf.meses.actual.cantidad, inf.meses.actual.monto],
    [mesLabel(d.date, -1), inf.meses.anterior.cantidad, inf.meses.anterior.monto],
    ['Meses anteriores', inf.meses.anteriores.cantidad, inf.meses.anteriores.monto],
  ], ['TOTAL COBRANZA POR MESES',
    inf.meses.actual.cantidad + inf.meses.anterior.cantidad + inf.meses.anteriores.cantidad,
    inf.meses.actual.monto + inf.meses.anterior.monto + inf.meses.anteriores.monto,
  ]);

  tabla('Resumen Anulaciones', [
    ['Anulado de cierre', inf.anulaciones.anuladoDeCierre.cantidad, inf.anulaciones.anuladoDeCierre.monto],
    ['Anulado de otros cierres', inf.anulaciones.anuladoDeOtrosCierres.cantidad, inf.anulaciones.anuladoDeOtrosCierres.monto],
    ['Cobranza efectiva', '', inf.anulaciones.cobranzaEfectiva.monto],
  ], ['COBRADO - ANULADO DE OTRAS FECHAS', '', inf.anulaciones.cobradoNeto]);

  tabla('Resumen Egresos', [
    ['Pago Orden de Compra', inf.egresos.ordenes.cantidad, inf.egresos.ordenes.monto],
    ...(inf.egresos.traslados.cantidad ? ([['Transferencias', inf.egresos.traslados.cantidad, inf.egresos.traslados.monto]] as [string, number, number][]) : []),
    ...(inf.egresos.transacciones.cantidad ? ([['Transacciones', inf.egresos.transacciones.cantidad, inf.egresos.transacciones.monto]] as [string, number, number][]) : []),
  ], ['TOTAL EGRESOS', inf.egresos.total.cantidad, inf.egresos.total.monto]);

  if (d.porCategoria.length) {
    if (doc.y > 690) { doc.addPage(); doc.y = 50; }
    sectionTitle(doc, 'De dónde salió');
    for (const c of d.porCategoria) {
      const y = doc.y;
      doc.font('Helvetica').fontSize(9).fillColor('#333');
      doc.text(`${c.type === 'INCOME' ? '(+)' : c.type === 'EXPENSE' ? '(-)' : '(±)'} ${c.category}  (${c.n})`, 46, y);
      doc.text(cop(c.total), x1, y, { width: w, align: 'right' });
      doc.y = y + 14;
    }
    doc.moveDown(0.8);
  }

  if (d.movimientos.length) {
    sectionTitle(doc, `Movimientos del día (${d.movimientos.length})`);
    const cols = [46, 190, 330, 420, 480];
    doc.font('Helvetica-Bold').fontSize(8).fillColor(GRAY);
    let y = doc.y;
    doc.text('Quién', cols[0], y); doc.text('Concepto', cols[1], y);
    doc.text('Medio', cols[2], y); doc.text('Valor', cols[3], y, { width: 70, align: 'right' });
    doc.text('Saldo', cols[4], y, { width: 70, align: 'right' });
    doc.y = y + 12;

    let saldo = 0;
    for (const m of d.movimientos) {
      if (doc.y > 760) { doc.addPage(); doc.y = 50; }
      saldo += m.firma;
      y = doc.y;
      doc.font('Helvetica').fontSize(8).fillColor('#333');
      doc.text((m.payer || '—').slice(0, 32), cols[0], y, { width: 140, ellipsis: true });
      doc.text((m.note || m.category || '—').slice(0, 34), cols[1], y, { width: 135, ellipsis: true });
      doc.text(m.method || '—', cols[2], y, { width: 85, ellipsis: true });
      doc.fillColor(m.type === 'EXPENSE' ? '#b42318' : '#067647');
      doc.text(`${m.type === 'EXPENSE' ? '-' : '+'}${cop(m.amount)}`, cols[3], y, { width: 70, align: 'right' });
      doc.fillColor('#333').text(cop(saldo), cols[4], y, { width: 70, align: 'right' });
      doc.y = y + 12;
    }
  }

  doc.moveDown(3);
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
  // La x va explícita: si no, el título arranca donde lo dejó el último `text()` (por
  // ejemplo una celda alineada a la derecha) y sale corrido y partido en dos líneas.
  doc.fillColor(BRAND).fontSize(11).font('Helvetica-Bold')
    .text(title.toUpperCase(), 40, doc.y, { width: 515 });
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
