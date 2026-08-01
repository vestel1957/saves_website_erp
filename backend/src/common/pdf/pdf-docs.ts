import PDFDocument from 'pdfkit';
import type { Response } from 'express';
import * as B from './brand';

const cop = (n: number) =>
  '$ ' + new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 }).format(Math.round(n || 0));
const fmt = (d: Date | string | null) => (d ? new Date(d).toLocaleDateString('es-CO') : '—');
// Alias hacia el kit de marca: el resto del archivo ya hablaba en estos términos.
const BRAND = B.NAVY;
const GRAY = B.INK_3;

const brandHeader = (doc: PDFKit.PDFDocument, title: string, opts?: { right?: string; chip?: string }) =>
  B.docHeader(doc, title, opts ?? {});

const kv = (doc: PDFKit.PDFDocument, l: string, v: string) => B.kv(doc, l.replace(/:$/, ''), v);

// ---------------------------------------------------------------------------
const fmtLargo = (d: Date | string | null) =>
  d ? new Date(d).toLocaleDateString('es-CO', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' }) : '—';
const fmtHoraCorta = (d: Date | string | null) =>
  d ? new Date(d).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', hour12: false }) : '—';

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
 * Comprobante de cierre de caja — réplica del legacy en las CIFRAS, no en la forma.
 *
 * No lleva base ni consignado: allá la base es cero y el cierre barre el efectivo entero
 * del cajón, que se arrastra al próximo día hábil (ver `treasury/cierre-legacy.ts`).
 *
 * Estructura del documento:
 *
 *   Hoja 1 · el resumen que se firma — el arqueo del cajón, las cifras del día, cómo
 *            entró la plata y de dónde salió. Es la hoja que se archiva y se entrega.
 *   Anexo A · los bloques del legacy, tabla por tabla, para conciliar contra el sistema
 *            viejo cifra por cifra.
 *   Anexo B · los movimientos, agrupados por concepto y con subtotal.
 *
 * Antes era todo un mismo chorro: arqueo, ocho tablas y cuatrocientas filas de
 * movimientos seguidas, sin una hoja que se pudiera firmar sin llevarse el resto detrás.
 */
export function cashClosePdf(res: Response, d: CashCloseData) {
  const doc = B.newDoc(PDFDocument);
  doc.pipe(res);
  const inf = d.informe;

  /* ─────────────────── Hoja 1: el resumen que se firma ─────────────────── */
  brandHeader(doc, 'Cierre de caja', {
    right: 'Comprobante de caja',
    chip: d.descuadrado ? 'DESCUADRADO' : 'CERRADA',
  });

  B.kvGrid(doc, [
    ['Caja', d.cashAccountName],
    ['Fecha', fmtLargo(d.date)],
    ['Cajero', d.userName || '—'],
    ['Arrastra a', `${fmtLargo(d.proximoDiaHabil)} (próx. día hábil)`],
  ]);

  if (d.descuadrado) {
    const y = doc.y;
    doc.rect(B.M, y, B.WIDTH, 30).fill('#fff4e5');
    doc.fillColor('#8a5300').fontSize(9).font('Helvetica-Bold')
      .text('Este cierre ya no cuadra con el libro.', B.M + 6, y + 6);
    doc.font('Helvetica').text(
      `Se barrieron ${cop(d.excedente)}, pero con los movimientos vigentes hoy el cajón daría ${cop(d.efectivoHoy)}.`,
      B.M + 6, y + 17, { width: B.WIDTH - 12 },
    );
    doc.y = y + 38;
  }

  // La cinta de cuadre: de dónde sale el excedente, paso a paso y en una sola línea.
  sectionTitle(doc, 'Cómo se compone el cajón');
  cinta(doc, [
    { op: '', k: 'Arrastre anterior', v: d.arrastre },
    { op: '+', k: 'Recaudo efectivo', v: d.ventas },
    { op: '-', k: 'Egresos efectivo', v: d.egresos },
    { op: d.transferencias < 0 ? '-' : '+', k: 'Traslados', v: Math.abs(d.transferencias) },
    { op: '=', k: 'En el cajón', v: d.excedente, res: true },
  ]);
  // Sin el recaudo que no es efectivo: este bloque es el arqueo del CAJÓN y esa plata
  // nunca pasa por él, así que nombrarla aquí sólo invitaba a sumarla.
  doc.font('Helvetica').fontSize(8).fillColor(GRAY).text(
    'La base es cero: al cerrar se lleva el efectivo entero del cajón.',
    B.M, doc.y + 4, { width: B.WIDTH },
  );
  doc.moveDown(0.8);

  sectionTitle(doc, 'El día en cifras');
  B.stats(doc, [
    ['Cobrado del día', cop(inf.cobranza.total.monto)],
    ['Efectivo en el cajón', cop(d.excedente)],
    ['Egresos del día', cop(inf.egresos.total.monto)],
  ]);

  sectionTitle(doc, 'Cómo entró la plata');
  const fpFilas: [string, number, number][] = [
    ['Saldo anterior', inf.formaPago.saldoAnterior.cantidad, inf.formaPago.saldoAnterior.monto],
    ['Efectivo', inf.formaPago.efectivo.cantidad, inf.formaPago.efectivo.monto],
    ['Transferencia', inf.formaPago.transferencia.cantidad, inf.formaPago.transferencia.monto],
    ['WOMPI', inf.formaPago.wompi.cantidad, inf.formaPago.wompi.monto],
  ];
  tablaRica(doc, fpFilas, 'Total forma de pago');

  if (d.porCategoria.length) {
    sectionTitle(doc, 'De dónde entró y de dónde salió');
    // Sin barra de composición: aquí conviven entradas y salidas, y una barra apilada
    // que mezcla las dos direcciones pintaría una proporción que no significa nada.
    tablaRica(
      doc,
      d.porCategoria.map((c) => [
        `${c.type === 'INCOME' ? '(+)' : c.type === 'EXPENSE' ? '(-)' : '(±)'} ${c.category || 'Traslado entre cajas'}`,
        c.n,
        c.total,
      ] as [string, number, number]),
      'Neto del día',
      [
        d.porCategoria.reduce((s, c) => s + c.n, 0),
        d.porCategoria.reduce((s, c) => s + (c.type === 'INCOME' ? c.total : -c.total), 0),
      ],
      { composicion: false },
    );
  }

  B.signatures(doc, [
    { rotulo: 'Firma responsable de caja', nombre: d.userName || null },
    { rotulo: 'Recibe tesorería' },
  ]);

  /* ─────────────────── Anexo A: los bloques del legacy ─────────────────── */
  B.newPage(doc);
  anexo(doc, 'Anexo A · Informe del legacy',
    'Los mismos bloques del sistema viejo, en su mismo orden, para conciliar cifra por cifra.');

  sectionTitle(doc, 'Resumen Cobranza');
  tablaRica(doc, [
    ['Excento', inf.cobranza.excento.cantidad, inf.cobranza.excento.monto],
    ['Base', inf.cobranza.base.cantidad, inf.cobranza.base.monto],
    ['iva', '', inf.cobranza.iva.monto],
  ], 'Total cobranza', [inf.cobranza.total.cantidad, inf.cobranza.total.monto]);

  sectionTitle(doc, 'Resumen por Banco');
  tablaRica(doc, inf.porBanco.map((b) => [b.nombre, b.cantidad, b.monto] as [string, number, number]),
    'Total banco', [inf.porBanco.reduce((s, b) => s + b.cantidad, 0), inf.porBanco.reduce((s, b) => s + b.monto, 0)],
  );

  sectionTitle(doc, 'Resumen por Forma de pago');
  tablaRica(doc, fpFilas, 'Total forma de pago', [
    inf.formaPago.saldoAnterior.cantidad + inf.formaPago.efectivo.cantidad + inf.formaPago.transferencia.cantidad + inf.formaPago.wompi.cantidad,
    inf.formaPago.saldoAnterior.monto + inf.formaPago.efectivo.monto + inf.formaPago.transferencia.monto + inf.formaPago.wompi.monto,
  ]);

  sectionTitle(doc, 'Resumen por Servicios');
  tablaRica(doc, [
    ...inf.servicios.planes.map((p) => [`Internet ${p.megas}MG`, p.cantidad, p.monto] as [string, number, number]),
    ...(inf.servicios.television.cantidad ? ([['Television', inf.servicios.television.cantidad, inf.servicios.television.monto]] as [string, number, number][]) : []),
    ...inf.servicios.afiliaciones.map((a) => [a.producto, a.cantidad, a.monto] as [string, number, number]),
    ['Total Ventas', inf.servicios.ventas.cantidad, inf.servicios.ventas.monto],
    ['Total Reconexiones', inf.servicios.reconexiones.cantidad, inf.servicios.reconexiones.monto],
    ['Total Materiales', inf.servicios.materiales.cantidad, inf.servicios.materiales.monto],
    ['Total Otros', inf.servicios.otros.cantidad, inf.servicios.otros.monto],
  ], 'Total servicios', [inf.servicios.total.cantidad, inf.servicios.total.monto]);

  sectionTitle(doc, 'Resumen por tipo de servicio');
  tablaRica(doc, [
    ['Internet', inf.tipoServicio.Internet.cantidad, inf.tipoServicio.Internet.monto],
    ['Television', inf.tipoServicio.Television.cantidad, inf.tipoServicio.Television.monto],
  ], 'Total tipo de servicio', [
    inf.tipoServicio.Internet.cantidad + inf.tipoServicio.Television.cantidad,
    inf.tipoServicio.Internet.monto + inf.tipoServicio.Television.monto,
  ]);

  const mesLabel = (base: Date | string, delta: number) => {
    const dd = new Date(base);
    const x = new Date(Date.UTC(dd.getUTCFullYear(), dd.getUTCMonth() + delta, 1));
    return x.toLocaleDateString('es-CO', { month: 'long', year: 'numeric' });
  };
  sectionTitle(doc, 'Resumen de cargos cobrados por meses');
  tablaRica(doc, [
    [mesLabel(d.date, 0), inf.meses.actual.cantidad, inf.meses.actual.monto],
    [mesLabel(d.date, -1), inf.meses.anterior.cantidad, inf.meses.anterior.monto],
    ['Meses anteriores', inf.meses.anteriores.cantidad, inf.meses.anteriores.monto],
  ], 'Total cobranza por meses', [
    inf.meses.actual.cantidad + inf.meses.anterior.cantidad + inf.meses.anteriores.cantidad,
    inf.meses.actual.monto + inf.meses.anterior.monto + inf.meses.anteriores.monto,
  ]);

  sectionTitle(doc, 'Resumen Anulaciones');
  tablaRica(doc, [
    ['Anulado de cierre', inf.anulaciones.anuladoDeCierre.cantidad, inf.anulaciones.anuladoDeCierre.monto],
    ['Anulado de otros cierres', inf.anulaciones.anuladoDeOtrosCierres.cantidad, inf.anulaciones.anuladoDeOtrosCierres.monto],
    ['Cobranza efectiva', '', inf.anulaciones.cobranzaEfectiva.monto],
  ], 'Cobrado - anulado de otras fechas', ['', inf.anulaciones.cobradoNeto], { composicion: false });

  sectionTitle(doc, 'Resumen Egresos');
  tablaRica(doc, [
    ['Pago Orden de Compra', inf.egresos.ordenes.cantidad, inf.egresos.ordenes.monto],
    ...(inf.egresos.traslados.cantidad ? ([['Transferencias', inf.egresos.traslados.cantidad, inf.egresos.traslados.monto]] as [string, number, number][]) : []),
    ...(inf.egresos.transacciones.cantidad ? ([['Transacciones', inf.egresos.transacciones.cantidad, inf.egresos.transacciones.monto]] as [string, number, number][]) : []),
  ], 'Total egresos', [inf.egresos.total.cantidad, inf.egresos.total.monto]);

  /* ─────────────────── Anexo B: los movimientos ─────────────────── */
  if (d.movimientos.length) {
    B.newPage(doc);
    anexo(doc, `Anexo B · Movimientos del día (${d.movimientos.length})`,
      'Agrupados por concepto, con subtotal — el mismo corte que los filtros de la pantalla.');

    // Mismo agrupamiento que los pills de la pantalla, para que el papel y la pantalla
    // cuenten la misma historia. Dentro de cada grupo se respeta el orden cronológico.
    const grupos = new Map<string, typeof d.movimientos>();
    for (const m of d.movimientos) {
      const k = `${m.type}|${m.category ?? '—'}`;
      const g = grupos.get(k) ?? [];
      g.push(m);
      grupos.set(k, g);
    }

    // Sin columna de saldo acumulado: al agrupar por concepto las filas dejan de ir en
    // orden cronológico, y un saldo que va y viene según el grupo no es un saldo. Lo que
    // sí dice algo es el subtotal de cada grupo, que va en su título.
    const cols: B.Col[] = [
      { label: 'Hora', x: B.M + 6, w: 42 },
      { label: 'Quién', x: 90, w: 165 },
      { label: 'Concepto / nota', x: 258, w: 140 },
      { label: 'Medio', x: 400, w: 75 },
      { label: 'Valor', x: 475, w: 75, align: 'right' },
    ];

    for (const [k, filas] of grupos) {
      const [tipo, categoria] = k.split('|');
      const signo = tipo === 'INCOME' ? '(+)' : tipo === 'EXPENSE' ? '(-)' : '(±)';
      const subtotal = filas.reduce((s, m) => s + m.amount, 0);

      if (doc.y > 700) B.newPage(doc);
      sectionTitle(doc, `${signo} ${categoria} · ${filas.length} · ${cop(subtotal)}`);
      B.thead(doc, cols);

      filas.forEach((m, i) => {
        if (doc.y > 745) { B.newPage(doc); B.thead(doc, cols); }
        B.trow(doc, cols, [
          { t: fmtHoraCorta(m.date), color: GRAY },
          m.payer || '—',
          m.note || m.category || '—',
          m.method || '—',
          { t: `${tipo === 'INCOME' ? '+' : '-'}${cop(m.amount)}`, color: tipo === 'INCOME' ? B.OK : B.BAD, bold: true },
        ], i, 15);
      });
      doc.moveDown(0.4);
    }
  }

  B.finish(doc);
}

/** Cinta horizontal de pasos: el arqueo leído de izquierda a derecha, sin restar de cabeza. */
function cinta(
  doc: PDFKit.PDFDocument,
  pasos: { op: string; k: string; v: number; res?: boolean }[],
) {
  const GAP = 4;
  const w = (B.WIDTH - GAP * (pasos.length - 1)) / pasos.length;
  const ALTO = 44;
  if (doc.y + ALTO > 740) B.newPage(doc);
  const y = doc.y;

  pasos.forEach((p, i) => {
    const x = B.M + i * (w + GAP);
    doc.roundedRect(x, y, w, ALTO, 4).fill(p.res ? B.BRAND_SOFT : '#f7fafd');
    if (p.op) {
      doc.fillColor(p.res ? BRAND : B.INK_3).fontSize(9).font('Helvetica-Bold')
        .text(p.op, x + 6, y + 5, { width: 10, lineBreak: false });
    }
    doc.fillColor(B.INK_3).fontSize(7).font('Helvetica')
      .text(p.k.toUpperCase(), x + (p.op ? 16 : 6), y + 6, { width: w - (p.op ? 22 : 12), characterSpacing: 0.3, ellipsis: true, lineBreak: false });
    doc.fillColor(p.res ? BRAND : B.INK).fontSize(p.res ? 13 : 11).font('Helvetica-Bold')
      .text(cop(p.v), x + 6, y + 22, { width: w - 12, ellipsis: true, lineBreak: false });
  });

  doc.x = B.M;
  doc.y = y + ALTO + 6;
}

/**
 * Los bloques del legacy intercalan sus propios subtotales entre los conceptos ("Total
 * Ventas", "Total Reconexiones"…). No son un concepto más: son la suma de otros de la
 * misma tabla, así que si entran en la composición y en los porcentajes, la plata se
 * cuenta dos veces y la barra miente. Se listan, pero fuera del reparto.
 */
const esSubtotal = (label: string) => /^total\s/i.test(label.trim());

/** Rampa de un solo tono: no hay identidades que distinguir, sólo magnitudes. */
const RAMPA = [1, 0.82, 0.66, 0.52, 0.4, 0.3, 0.22];

/**
 * La composición del bloque en una sola barra apilada, con su leyenda — la misma pieza
 * que la pantalla. Responde "¿qué pesa aquí?" antes de bajar a la tabla. Seis tajadas y
 * el resto agrupado: con quince, la barra deja de decir nada.
 */
function barraComposicion(doc: PDFKit.PDFDocument, filas: [string, number | string, number][], total: number) {
  const positivas = filas.filter((f) => f[2] > 0 && !esSubtotal(f[0])).sort((a, b) => b[2] - a[2]);
  if (positivas.length < 2 || total <= 0) return;

  const cola = positivas.slice(6);
  const segmentos: [string, number][] = [
    ...positivas.slice(0, 6).map((f) => [f[0], f[2]] as [string, number]),
    ...(cola.length ? ([[`Otros ${cola.length}`, cola.reduce((s, f) => s + f[2], 0)]] as [string, number][]) : []),
  ];

  const H = 6;
  let y = doc.y + 2;
  let x = B.M;
  doc.roundedRect(B.M, y, B.WIDTH, H, H / 2).fill(B.BRAND_SOFT);
  segmentos.forEach(([, monto], i) => {
    const w = (monto / total) * B.WIDTH;
    if (w <= 0) return;
    doc.fillOpacity(RAMPA[i] ?? 0.18).rect(x, y, Math.max(w - 1, 0.8), H).fill(B.BRAND_2);
    x += w;
  });
  doc.fillOpacity(1);

  // Leyenda en línea: cada entrada ocupa lo que mide y salta de renglón cuando no cabe.
  // En dos columnas fijas, un nombre corto dejaba un hueco de media hoja hasta su cifra.
  y += H + 5;
  let lx = B.M;
  let ly = y;
  segmentos.forEach(([label, monto], i) => {
    const pct = `${((monto / total) * 100).toFixed(1)}%`;
    doc.font('Helvetica').fontSize(8);
    const wLabel = doc.widthOfString(label);
    doc.font('Helvetica-Bold');
    const wPct = doc.widthOfString(pct);
    const ancho = 7 + wLabel + 4 + wPct + 14;
    if (lx + ancho > B.RIGHT) { lx = B.M; ly += 11; }

    doc.fillOpacity(RAMPA[i] ?? 0.18).rect(lx, ly + 1.5, 5, 5).fill(B.BRAND_2);
    doc.fillOpacity(1);
    doc.font('Helvetica').fontSize(8).fillColor(B.INK_2).text(label, lx + 7, ly, { lineBreak: false });
    doc.font('Helvetica-Bold').fillColor(B.INK).text(pct, lx + 7 + wLabel + 4, ly, { lineBreak: false });
    lx += ancho;
  });

  doc.x = B.M;
  doc.y = ly + 14;
}

/**
 * La tabla de un bloque, con el mismo tratamiento que la pantalla: barra de composición
 * arriba, la fila ENTERA teñida en proporción a lo que pesa, el monto grande y una
 * columna de peso.
 *
 * El tinte se mide contra el TOTAL, igual que en pantalla: lo pintado y lo escrito tienen
 * que ser el mismo número o el documento deja de merecer confianza.
 *
 * `total` es el total que IMPRIME EL LEGACY, que no siempre es la suma de las filas (el
 * bloque de cobranza suma unidades distintas a propósito). Se respeta tal cual y sólo se
 * rotula "100%" cuando de verdad cuadra con la suma.
 */
function tablaRica(
  doc: PDFKit.PDFDocument,
  filas: [string, number | string, number][],
  totalLabel: string,
  total?: [number | string, number],
  opts?: { composicion?: boolean },
) {
  const suma = filas.reduce((s, f) => s + f[2], 0);
  const totalMonto = total ? total[1] : suma;
  const totalCant = total ? total[0] : filas.reduce((s, f) => s + (typeof f[1] === 'number' ? f[1] : 0), 0);

  if (opts?.composicion !== false) barraComposicion(doc, filas, suma);

  const cols: B.Col[] = [
    { label: 'Concepto', x: B.M + 8, w: 250 },
    { label: 'Cant', x: 300, w: 55, align: 'right' },
    { label: 'Monto', x: 360, w: 115, align: 'right' },
    { label: 'Peso', x: 480, w: 68, align: 'right' },
  ];
  if (doc.y > 700) B.newPage(doc);
  B.thead(doc, cols);

  const ALTO = 18;
  filas.forEach(([label, cant, monto]) => {
    if (doc.y > 745) { B.newPage(doc); B.thead(doc, cols); }
    const y = doc.y;
    const sub = esSubtotal(label);
    const parte = sub || !suma ? 0 : monto / suma;

    // La fila teñida hasta donde llega su peso, y nada después.
    const ancho = Math.max(0, Math.min(1, parte)) * B.WIDTH;
    if (ancho > 0.5) doc.rect(B.M, y, ancho, ALTO).fill(B.BRAND_SOFT);

    doc.font(sub ? 'Helvetica-Oblique' : 'Helvetica').fontSize(9.5).fillColor(sub ? GRAY : B.INK_2)
      .text(label, cols[0].x, y + 5, { width: cols[0].w, ellipsis: true, lineBreak: false });
    doc.fontSize(8.5).fillColor(GRAY)
      .text(cant === '' || cant == null ? '—' : `x ${cant}`, cols[1].x, y + 5.5, { width: cols[1].w, align: 'right', lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(sub ? 9.5 : 11).fillColor(sub ? B.INK_2 : B.INK)
      .text(cop(monto), cols[2].x, y + (sub ? 5 : 4), { width: cols[2].w, align: 'right', lineBreak: false });
    doc.font('Helvetica').fontSize(8.5).fillColor(GRAY)
      .text(sub || !suma ? '—' : `${(parte * 100).toFixed(1)}%`, cols[3].x, y + 5.5, { width: cols[3].w, align: 'right', lineBreak: false });

    doc.x = B.M;
    doc.y = y + ALTO;
    doc.moveTo(B.M, doc.y).lineTo(B.RIGHT, doc.y).lineWidth(0.5).strokeColor(B.LINE).stroke();
  });

  if (doc.y > 750) B.newPage(doc);
  const y = doc.y;
  doc.rect(B.M, y, B.WIDTH, 22).fill(B.BRAND_SOFT);
  doc.rect(B.M, y, B.WIDTH, 1.5).fill(B.BRAND_2);
  doc.font('Helvetica-Bold').fontSize(9).fillColor(BRAND)
    .text(totalLabel.toUpperCase(), cols[0].x, y + 7, { width: cols[0].w, characterSpacing: 0.4, lineBreak: false });
  doc.fontSize(8.5)
    .text(totalCant === '' || totalCant == null ? '' : `x ${totalCant}`, cols[1].x, y + 7.5, { width: cols[1].w, align: 'right', lineBreak: false });
  doc.fontSize(12)
    .text(cop(totalMonto), cols[2].x, y + 5, { width: cols[2].w, align: 'right', lineBreak: false });
  doc.fontSize(8.5)
    .text(Math.abs(totalMonto - suma) < 1 && suma !== 0 ? '100%' : '—', cols[3].x, y + 7.5, { width: cols[3].w, align: 'right', lineBreak: false });
  doc.x = B.M;
  doc.y = y + 28;
}

/** Portadilla de anexo: separa el documento firmable del material de conciliación. */
function anexo(doc: PDFKit.PDFDocument, titulo: string, bajada: string) {
  doc.fillColor(BRAND).fontSize(14).font('Helvetica-Bold').text(titulo, B.M, doc.y, { width: B.WIDTH });
  doc.fillColor(GRAY).fontSize(8.5).font('Helvetica').text(bajada, B.M, doc.y + 2, { width: B.WIDTH });
  doc.moveTo(B.M, doc.y + 6).lineTo(B.RIGHT, doc.y + 6).lineWidth(0.75).strokeColor(B.BRAND_LINE).stroke();
  doc.x = B.M;
  doc.y = doc.y + 16;
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
  const doc = B.newDoc(PDFDocument);
  doc.pipe(res);
  brandHeader(doc, `Recibo de caja N° ${d.number}`, {
    right: 'Comprobante de pago',
    chip: d.method ?? undefined,
  });

  const s = d.subscriber;
  B.kvGrid(doc, [
    ['Recibimos de', s?.name ?? '—'],
    ['Fecha', fmt(d.date)],
    ['Documento', s?.docNumber ?? '—'],
    ['Forma de pago', d.method ?? '—'],
    ['Abonado N°', s?.abonado != null ? String(s.abonado) : '—'],
    ['Cajero', d.cashier ?? '—'],
  ]);

  B.section(doc, 'Detalle del pago');
  const cols: B.Col[] = [
    { label: 'Concepto', x: 46, w: 300 },
    { label: 'Factura', x: 360, w: 80, align: 'right' },
    { label: 'Valor', x: 450, w: 100, align: 'right' },
  ];
  B.thead(doc, cols);
  d.items.forEach((it, i) =>
    B.trow(doc, cols, [it.concept, it.tid ? `#${it.tid}` : '—', cop(it.amount)], i),
  );

  B.totals(doc, [['Total recibido', cop(d.total)]]);
  B.note(doc, 'Este recibo hace constar el pago de las facturas relacionadas. Consérvelo como soporte.');
  B.signatures(doc, [
    { rotulo: 'Firma / sello de caja', nombre: d.cashier ?? undefined },
    { rotulo: 'Recibí conforme', nota: 'Nombre y cédula' },
  ]);
  B.finish(doc);
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
  const doc = B.newDoc(PDFDocument);
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
    B.section(doc, 'Material utilizado');
    const cols: B.Col[] = [
      { label: 'Material', x: 46, w: 300 },
      { label: 'Cant.', x: 360, w: 50, align: 'right' },
      { label: 'V. unit.', x: 415, w: 60, align: 'right' },
      { label: 'Total', x: 480, w: 70, align: 'right' },
    ];
    B.thead(doc, cols);
    let tot = 0;
    d.materials.forEach((m, i) => {
      tot += m.total;
      B.trow(doc, cols, [m.name, String(m.qty), cop(m.price), cop(m.total)], i);
    });
    B.totals(doc, [['Total material', cop(tot)]]);
  }

  // Seguimiento
  if (d.threads.length) {
    sectionTitle(doc, 'Seguimiento');
    doc.fontSize(9).fillColor('#333').font('Helvetica');
    for (const h of d.threads) {
      if (!h.message && !h.hasPhoto) continue;
      // Sin emoji: las fuentes base de pdfkit (Helvetica) no traen pictogramas y
      // el 📷 salía impreso como "Ø=Ü+" en la orden que firma el cliente.
      const label = `${fmt(h.date)}${h.hasPhoto ? ' · con foto' : ''}`;
      doc.font('Helvetica-Bold').fillColor(GRAY).text(label);
      if (h.message) doc.font('Helvetica').fillColor('#333').text(h.message, { align: 'justify' });
      doc.moveDown(0.3);
    }
    doc.moveDown(0.5);
  }

  // Firma de recibido: el nombre y la cédula de quien firma son la prueba de que
  // el técnico estuvo en la vivienda.
  B.signatures(doc, [
    {
      rotulo: 'Firma de quien recibe',
      nombre: d.signature ? `${d.signature.name}${d.signature.cc ? ` · CC ${d.signature.cc}` : ''}` : undefined,
      nota: d.signature?.rel ? `Parentesco: ${d.signature.rel}` : undefined,
    },
    { rotulo: 'Técnico', nombre: d.technician },
  ]);
  B.finish(doc);
}

// ---------------------------------------------------------------------------
// Orden de compra imprimible (legacy printinvoice: solicitante + autorizadores).

export type PurchaseOrderPdfData = {
  tid: number;
  kind: string;
  status: string;
  date: Date | string | null;
  dueDate: Date | string | null;
  branchRef: string | null;
  categoryRef?: string | null;
  notes: string | null;
  supplier: { name: string; nit: string | null; phone: string | null } | null;
  items: { product: string; qty: number; price: number; taxRate: number; subtotal: number; taxTotal: number }[];
  noteLines: { type: string; description: string | null; amount: number }[];
  subtotal: number; tax: number; total: number; paid: number; balance: number;
  createdByName: string | null;
  firstBy: string | null;
  secondBy: string | null;
};

/** Orden de compra/servicio con cuadro de firmas (solicitante y autorizadores). */
export function purchaseOrderPdf(res: Response, d: PurchaseOrderPdfData) {
  const doc = B.newDoc(PDFDocument);
  doc.pipe(res);
  brandHeader(doc, `Orden de ${d.kind === 'servicio' ? 'servicio' : 'compra'} N° ${d.tid}`, {
    right: d.branchRef ?? undefined,
    chip: d.status,
  });

  B.kvGrid(doc, [
    ['Fecha', fmt(d.date)],
    ['Vence', d.dueDate ? fmt(d.dueDate) : '—'],
    ['Categoría', d.categoryRef ?? '—'],
    ['Elaboró', d.createdByName ?? '—'],
  ]);

  if (d.supplier) {
    B.section(doc, 'Proveedor');
    B.kv(doc, 'Nombre', d.supplier.name);
    if (d.supplier.nit) B.kv(doc, 'NIT', d.supplier.nit);
    if (d.supplier.phone) B.kv(doc, 'Teléfono', d.supplier.phone);
  }

  B.section(doc, 'Ítems');
  const cols: B.Col[] = [
    { label: 'Descripción', x: 46, w: 275 },
    { label: 'Cant.', x: 330, w: 45, align: 'right' },
    { label: 'V. unit.', x: 380, w: 70, align: 'right' },
    { label: 'IVA', x: 455, w: 35, align: 'right' },
    { label: 'Total', x: 495, w: 55, align: 'right' },
  ];
  B.thead(doc, cols);
  d.items.forEach((it, i) => {
    if (doc.y > 700) {
      B.newPage(doc);
      B.thead(doc, cols);
    }
    B.trow(doc, cols, [
      it.product, String(it.qty), cop(it.price),
      it.taxRate ? `${it.taxRate}%` : '—', cop(it.subtotal + it.taxTotal),
    ], i);
  });
  d.noteLines.forEach((n, i) =>
    B.trow(doc, cols, [
      { t: `${n.type}${n.description ? ` — ${n.description}` : ''}`, color: B.INK_3 },
      '', '', '', { t: cop(n.amount), color: B.INK_3 },
    ], d.items.length + i),
  );

  B.totals(doc, [
    ['Subtotal', cop(d.subtotal)],
    ['IVA', cop(d.tax)],
    ...(d.paid > 0
      ? ([['Total', cop(d.total)], ['Pagado', cop(d.paid)], ['Saldo', cop(d.balance)]] as [string, string][])
      : ([['Total', cop(d.total)]] as [string, string][])),
  ]);

  if (d.notes) {
    B.section(doc, 'Observaciones');
    doc.fontSize(9.5).fillColor(B.INK_2).font('Helvetica')
      .text(d.notes, B.M, doc.y, { width: B.WIDTH, align: 'justify' });
    doc.x = B.M;
  }

  // Cuadro de firmas: solicitante + autorizadores (como el impreso del legacy).
  doc.moveDown(2);
  B.signatures(doc, [
    { rotulo: 'Elaboró', nombre: d.createdByName },
    { rotulo: 'Autorizó', nombre: d.firstBy },
    { rotulo: 'Autorizó (2ª firma)', nombre: d.secondBy },
  ]);
  B.finish(doc);
}

// El kit ya fija la x explícita del título: sin eso el rótulo arrancaba donde lo
// dejó el último `text()` (p. ej. una celda alineada a la derecha) y salía partido.
const sectionTitle = (doc: PDFKit.PDFDocument, title: string) => B.section(doc, title);

/** Contrato de prestación de servicios (plantilla estándar Vestel). */
export function contractPdf(res: Response, d: ContractData) {
  const doc = B.newDoc(PDFDocument);
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

  B.signatures(doc, [
    { rotulo: 'El suscriptor', nombre: d.name, nota: d.docNumber ? `${d.docType ?? 'CC'} ${d.docNumber}` : undefined },
    { rotulo: 'Por VESTEL', nota: 'VESGA TELEVISION S.A.S' },
  ]);
  B.finish(doc);
}

// ---------------------------------------------------------------------------

/**
 * Acta de traspaso: el papel de que ALGO cambió de manos.
 *
 * Sirve para las dos cosas que se mueven entre bodegas —material y equipos—,
 * porque el documento es el mismo: quién lo entrega, quién lo recibe, qué va
 * dentro y las dos firmas. Lo que cambia es la columna de la cantidad (material)
 * o del serial (equipos), y eso lo resuelve `items`.
 *
 * La firma de quien recibe sale VACÍA mientras no haya firmado: el acta se emite
 * y se manda antes de que él la firme, así que el PDF tiene que poder mostrar el
 * renglón en blanco sin mentir. Cuando firma, el `nota` de su bloque dice a qué
 * WhatsApp salió el código —que es la prueba de que estuvo—.
 */
export type ActaPdfData = {
  /** 'Acta de traspaso de material' | 'Acta de transferencia de equipos' */
  titulo: string;
  /** Consecutivo o id corto que la identifica. */
  numero: string;
  date: Date | string;
  status: string;
  from: string;
  to: string;
  fromBranch?: string | null;
  toBranch?: string | null;
  observations?: string | null;
  /** Cada línea: descripción + un dato a la derecha (cantidad o serial/MAC). */
  items: { descripcion: string; detalle?: string | null; cantidad?: string | null }[];
  /** Rótulo de la columna derecha ('Cantidad' o 'Serial / MAC'). */
  columnaDerecha: string;
  entrega: { nombre?: string | null; fecha?: Date | string | null; nota?: string | null };
  recibe: { nombre?: string | null; fecha?: Date | string | null; nota?: string | null };
};

const fmtHora = (d: Date | string | null | undefined) =>
  d ? new Date(d).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' }) : null;

export function actaPdf(res: Response, d: ActaPdfData) {
  const doc = B.newDoc(PDFDocument);
  doc.pipe(res);
  brandHeader(doc, `${d.titulo} N° ${d.numero}`, { chip: d.status });

  B.kvGrid(doc, [
    ['Fecha', fmt(d.date)],
    ['Origen', d.fromBranch ? `${d.from} (${d.fromBranch})` : d.from],
    ['Destino', d.toBranch ? `${d.to} (${d.toBranch})` : d.to],
    ['Ítems', String(d.items.length)],
  ]);

  B.section(doc, 'Detalle');
  const cols: B.Col[] = [
    { label: 'Descripción', x: 46, w: 300 },
    { label: 'Detalle', x: 355, w: 110 },
    { label: d.columnaDerecha, x: 470, w: 80, align: 'right' },
  ];
  B.thead(doc, cols);
  d.items.forEach((it, i) => {
    if (doc.y > 660) {
      B.newPage(doc);
      B.thead(doc, cols);
    }
    B.trow(doc, cols, [it.descripcion, it.detalle ?? '—', it.cantidad ?? ''], i);
  });

  if (d.observations) {
    B.section(doc, 'Observaciones');
    doc.fontSize(9.5).fillColor(B.INK_2).font('Helvetica')
      .text(d.observations, B.M, doc.y, { width: B.WIDTH, align: 'justify' });
    doc.x = B.M;
  }

  doc.moveDown(2);
  B.signatures(doc, [
    {
      rotulo: 'Entrega',
      nombre: d.entrega.nombre,
      nota: [fmtHora(d.entrega.fecha), d.entrega.nota].filter(Boolean).join(' · ') || undefined,
    },
    {
      rotulo: 'Recibe',
      nombre: d.recibe.nombre,
      nota: d.recibe.nombre
        ? [fmtHora(d.recibe.fecha), d.recibe.nota].filter(Boolean).join(' · ') || undefined
        : 'Pendiente de firma',
    },
  ]);
  B.note(
    doc,
    'La firma de quien recibe se hace en el sistema con un código de un solo uso enviado a su WhatsApp; ' +
    'el número al que salió queda registrado bajo su nombre.',
  );
  B.finish(doc);
}
