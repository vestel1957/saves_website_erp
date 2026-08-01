/**
 * Recibo de caja en ROLLO de 80 mm — el papelito que sale por la impresora térmica
 * cuando la cajera recibe un pago.
 *
 * Es el port del recibo del legacy: allá `Invoices::printinvoice()` cargaba
 * `invoices/view-print-ltr.php` con `Pdf_invoice::load()`, que es un mPDF con
 * `format => [80, 250]` (80 mm de ancho) — o sea, nunca fue media carta ni A4: es
 * rollo. Aquí se respeta el ancho y el orden de bloques del legacy (membrete,
 * cliente, meses pagados con `CTA:tid`, meses que quedan debiendo, resumen, estado,
 * quién atendió, términos y medios de pago).
 *
 * Diferencia deliberada con el legacy: el ALTO no es fijo. Allá los 250 mm salían
 * siempre, así que un recibo de una sola factura escupía 20 cm de papel en blanco.
 * Aquí se mide el contenido primero y la página se crea con el alto justo — que es
 * como trabaja una térmica (papel continuo + corte).
 */
import PDFDocument from 'pdfkit';
import type { Response } from 'express';
import * as B from './brand';

const MM = 72 / 25.4;
/** Ancho del rollo (80 mm) y márgenes laterales, en puntos. */
const ANCHO = 80 * MM;
const PAD = 4 * MM;
const CONT = ANCHO - PAD * 2; // ~204 pt de contenido
/** Papel que se deja al final para que la cuchilla no se coma la última línea. */
const COLA = 8 * MM;

const cop = (n: number) =>
  '$ ' + new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 }).format(Math.round(n || 0));

// `date` del recibo es una columna `date` (medianoche UTC): formatearla en horario
// de Colombia la correría al día anterior. La hora sí sale de `createdAt`, que es un
// instante real. Ver la nota de fechas en `sql-crudo-fechas`.
const fechaSolo = (d: Date | string) =>
  new Date(d).toLocaleDateString('es-CO', { timeZone: 'UTC' });
const horaSolo = (d: Date | string) =>
  new Date(d).toLocaleTimeString('es-CO', {
    timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hour12: true,
  });

type Doc = PDFKit.PDFDocument;
type Opts = {
  size?: number;
  bold?: boolean;
  italic?: boolean;
  align?: 'left' | 'center' | 'right';
  color?: string;
  /** Aire debajo del elemento, en puntos. */
  gap?: number;
};

const fuente = (o: Opts) =>
  o.bold && o.italic ? 'Helvetica-BoldOblique'
  : o.bold ? 'Helvetica-Bold'
  : o.italic ? 'Helvetica-Oblique'
  : 'Helvetica';

/** Un bloque del rollo: sabe cuánto ocupa y cómo se pinta a una altura dada. */
type El = { alto: (m: Doc) => number; pinta: (doc: Doc, y: number) => void };

/**
 * Constructor del rollo: acumula bloques y al final calcula el alto total.
 *
 * Existe porque en pdfkit el tamaño de la página se fija al crearla: para saber
 * cuánto papel pedir hay que medir el contenido ANTES de abrir el documento. Por eso
 * cada bloque separa `alto()` (medir, contra un documento de descarte) de `pinta()`.
 */
class Rollo {
  private els: El[] = [];

  texto(t: string, o: Opts = {}) {
    const f = fuente(o);
    const size = o.size ?? 8;
    const align = o.align ?? 'left';
    const gap = o.gap ?? 1.5;
    this.els.push({
      alto: (m) => m.font(f).fontSize(size).heightOfString(t, { width: CONT, align }) + gap,
      pinta: (doc, y) => {
        doc.font(f).fontSize(size).fillColor(o.color ?? B.INK)
          .text(t, PAD, y, { width: CONT, align });
      },
    });
    return this;
  }

  /** Renglón etiqueta ↔ valor: el valor manda a la derecha y la etiqueta envuelve. */
  fila(izq: string, der: string, o: Opts = {}) {
    const f = fuente(o);
    const size = o.size ?? 8;
    const gap = o.gap ?? 1.5;
    // El ancho del valor se calcula sobre el texto: los importes en pesos varían
    // mucho ("$ 0" vs "$ 1.250.000") y una columna fija dejaría la descripción
    // partida en tres renglones sin necesidad.
    const anchos = (m: Doc) => {
      const dw = Math.min(Math.max(m.font(f).fontSize(size).widthOfString(der) + 2, 34), CONT * 0.55);
      return { dw, iw: CONT - dw - 5 };
    };
    this.els.push({
      alto: (m) => {
        const { dw, iw } = anchos(m);
        return Math.max(
          m.font(f).fontSize(size).heightOfString(izq, { width: iw }),
          m.font(f).fontSize(size).heightOfString(der, { width: dw }),
        ) + gap;
      },
      pinta: (doc, y) => {
        const { dw, iw } = anchos(doc);
        doc.font(f).fontSize(size).fillColor(o.color ?? B.INK).text(izq, PAD, y, { width: iw });
        doc.font(f).fontSize(size).fillColor(o.color ?? B.INK)
          .text(der, PAD + CONT - dw, y, { width: dw, align: 'right' });
      },
    });
    return this;
  }

  /** Banda oscura de encabezado de tabla (el `tr.heading` del legacy). */
  banda(izq: string, der: string) {
    const size = 7.5;
    const h = 12;
    this.els.push({
      alto: () => h + 2.5,
      pinta: (doc, y) => {
        doc.rect(PAD, y, CONT, h).fill(B.NAVY);
        doc.font('Helvetica-Bold').fontSize(size).fillColor('#FFFFFF')
          .text(izq, PAD + 3, y + 3, { width: CONT / 2 });
        doc.font('Helvetica-Bold').fontSize(size).fillColor('#FFFFFF')
          .text(der, PAD + CONT / 2, y + 3, { width: CONT / 2 - 3, align: 'right' });
      },
    });
    return this;
  }

  regla(punteada = true) {
    this.els.push({
      alto: () => 6,
      pinta: (doc, y) => {
        if (punteada) doc.dash(1.6, { space: 1.6 });
        doc.moveTo(PAD, y + 3).lineTo(PAD + CONT, y + 3)
          .lineWidth(0.6).strokeColor(punteada ? B.SILVER : B.NAVY).stroke();
        doc.undash();
      },
    });
    return this;
  }

  espacio(h: number) {
    this.els.push({ alto: () => h, pinta: () => {} });
    return this;
  }

  imagen(buf: Buffer, ancho: number) {
    const h = ancho * 0.3; // el logo es apaisado (200x60 aprox.)
    this.els.push({
      alto: () => h + 3,
      pinta: (doc, y) => {
        try {
          doc.image(buf, PAD + (CONT - ancho) / 2, y, { width: ancho });
        } catch {
          /* logo ilegible: el recibo sale igual, solo con el texto */
        }
      },
    });
    return this;
  }

  /** Mide todo contra un documento de descarte y devuelve el alto de papel. */
  altoTotal(): number {
    const m = new PDFDocument({ size: [ANCHO, 1000], margin: 0 }) as unknown as Doc;
    const total = this.els.reduce((s, e) => s + e.alto(m), 0);
    (m as any).end();
    return PAD + total + COLA;
  }

  pinta(doc: Doc) {
    let y = PAD;
    for (const e of this.els) {
      e.pinta(doc, y);
      y += e.alto(doc);
    }
  }
}

export type ReciboRolloData = {
  number: string;
  date: Date | string;
  /** Instante real del recaudo: de aquí sale la hora del membrete. */
  createdAt?: Date | string | null;
  /** Sede de la factura (el `refer` del legacy). */
  branch: string | null;
  /** Quién imprime: en el legacy era `aauth->get_user()->username` + su rol. */
  cashier: string | null;
  cashierRole: string | null;
  method: string | null;
  subscriber: {
    name: string;
    abonado: number | null;
    docType: string | null;
    docNumber: string | null;
    email: string | null;
    /** `customers.id` del legacy: es el "código de usuario" del convenio de pago. */
    codigo: number | null;
  } | null;
  /** Lo que se abonó con este recibo (mes + CTA:tid, como el legacy). */
  items: { tid: number | null; concept: string; amount: number }[];
  /** Lo que le sigue quedando debiendo (el legacy las imprime en negrita cursiva). */
  pending: { tid: number | null; concept: string; amount: number }[];
  total: number;
  paid: number;
  discount: number;
  balance: number;
  status: string | null;
  terms: string | null;
};

const ESTADO: Record<string, string> = {
  PAID: 'Pagada', PARTIAL: 'Abono parcial', DUE: 'Pendiente', CANCELED: 'Anulada',
};

// Los métodos viajan en inglés desde el legacy (`transactions.method`). En el papel
// del cliente van en español: debe coincidir con `PAY_METHODS` del frontend.
const METODO: Record<string, string> = {
  Cash: 'Efectivo',
  Bank: 'Consignación / Transferencia',
  Cheque: 'Cheque',
  Balance: 'Saldo a favor',
};

/** Recibo de caja en rollo de 80 mm (impresión térmica). */
export function reciboRolloPdf(res: Response, d: ReciboRolloData) {
  const r = arma(d);
  const doc = new PDFDocument({ size: [ANCHO, r.altoTotal()], margin: 0 }) as unknown as Doc;
  doc.pipe(res);
  r.pinta(doc);
  (doc as any).end();
}

function arma(d: ReciboRolloData): Rollo {
  const r = new Rollo();

  // --- Membrete (legacy header-print-ltr.php) ---------------------------------
  const logo = B.logoBuffer();
  if (logo) r.imagen(logo, 42 * MM);
  else r.texto(B.EMPRESA.marca, { size: 13, bold: true, align: 'center', color: B.NAVY });
  r.texto(B.EMPRESA.nombre, { size: 8.5, bold: true, align: 'center', color: B.NAVY });
  r.texto(`${B.CONTACTO.direccion} · ${B.CONTACTO.ciudad}`, { size: 7, align: 'center', color: B.INK_2 });
  r.texto(`Nit: ${B.CONTACTO.nitCorto}`, { size: 7, align: 'center', color: B.INK_2 });
  if (d.branch) r.texto(`Sede: ${d.branch}`, { size: 7, align: 'center', color: B.INK_2 });
  r.texto(
    fechaSolo(d.date) + (d.createdAt ? ` ${horaSolo(d.createdAt)}` : ''),
    { size: 7, align: 'center', color: B.INK_2, gap: 3 },
  );

  r.regla(false);
  r.texto(`RECIBO DE CAJA N° ${d.number}`, { size: 9, bold: true, align: 'center', color: B.NAVY });
  if (d.method) {
    r.texto(`Forma de pago: ${METODO[d.method] ?? d.method}`, { size: 7, align: 'center', color: B.INK_2 });
  }
  r.regla();

  // --- Cliente (el recuadro `party` del legacy) -------------------------------
  const s = d.subscriber;
  r.texto(s?.name?.toUpperCase() || '—', { size: 8.5, bold: true });
  if (s?.docNumber) r.texto(`${s.docType || 'Documento'}: ${s.docNumber}`, { size: 7.5, color: B.INK_2 });
  if (s?.email) r.texto(`Email: ${s.email}`, { size: 7.5, color: B.INK_2 });
  if (s?.abonado != null) r.texto(`Abonado: ${s.abonado}`, { size: 7.5, color: B.INK_2 });
  r.espacio(3);

  // --- Detalle: lo pagado (legacy imprime "mes CTA:tid") ----------------------
  r.banda('DESCRIPCIÓN', 'VALOR');
  if (d.items.length) {
    d.items.forEach((it) => r.fila(it.concept, cop(it.amount), { size: 8 }));
  } else {
    r.texto('Sin movimientos en el recibo', { size: 7.5, italic: true, color: B.INK_3 });
  }

  // --- Lo que sigue debiendo (legacy: negrita + cursiva) ----------------------
  if (d.pending.length) {
    r.espacio(2);
    r.texto('PENDIENTE POR PAGAR', { size: 7, bold: true, color: B.BAD });
    d.pending.forEach((p) =>
      r.fila(p.concept, cop(p.amount), { size: 8, bold: true, italic: true, color: B.BAD }),
    );
  }

  r.espacio(2);
  r.regla();

  // --- Resumen (el bloque `subtotal` del legacy) ------------------------------
  r.texto('RESUMEN', { size: 7.5, bold: true, color: B.NAVY });
  r.fila('Cantidad total', cop(d.total), { size: 8 });
  if (d.discount > 0) r.fila('Descuento', `- ${cop(d.discount)}`, { size: 8 });
  r.fila('Valor pagado', cop(d.paid), { size: 9, bold: true, color: B.OK });
  r.fila('Saldo pendiente', cop(d.balance), {
    size: 9, bold: true, color: d.balance > 0 ? B.BAD : B.OK,
  });
  r.regla();

  // --- Estado y quién atendió (legacy: `(usuario)` + rol, centrados) ----------
  if (d.status) {
    r.texto(`Estado: ${ESTADO[d.status] ?? d.status}`, { size: 8, bold: true, align: 'center' });
  }
  if (d.cashier) {
    r.texto(`Atendido por: ${d.cashier}`, { size: 7.5, align: 'center', color: B.INK_2 });
    if (d.cashierRole) r.texto(d.cashierRole, { size: 7, align: 'center', color: B.INK_3 });
  }

  // --- Términos y medios de pago (texto textual del legacy para Vestel) -------
  if (d.terms) {
    r.espacio(2);
    r.texto(d.terms, { size: 6.5, align: 'center', color: B.INK_3 });
  }
  r.regla();
  const codigo = s?.codigo ?? s?.abonado ?? null;
  r.texto(
    `Realice su pago en ${B.CONTACTO.web}, menú EN LINEA, con su código de usuario N° ${codigo ?? '—'} ` +
    `y como contraseña su número de documento. También en corresponsal BANCOLOMBIA, ` +
    `convenio N° ${B.CONTACTO.convenioBancolombia}, referencia código de usuario N° ${codigo ?? '—'}.`,
    { size: 6.5, align: 'center', color: B.INK_2 },
  );
  r.espacio(2);
  r.texto(`LINEA PBX: ${B.CONTACTO.telefono}`, { size: 8, bold: true, align: 'center', color: B.NAVY });
  r.texto('Conserve este recibo como soporte de su pago', {
    size: 6.5, align: 'center', color: B.INK_3,
  });

  return r;
}
