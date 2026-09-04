/**
 * Recibo de caja en ROLLO de 80 mm — el papelito que sale por la impresora térmica
 * cuando la cajera recibe un pago.
 *
 * Es una RÉPLICA del recibo del legacy, no una reinterpretación: allá
 * `Invoices::printinvoice()` renderiza `invoices/{header,view}-print-ltr.php` con un
 * mPDF de `format => [80, 250]` y márgenes 5/5, y esto reproduce ese papel bloque a
 * bloque —membrete, recuadro del cliente, tabla de conceptos con cabecera gris, las
 * facturas que sigue debiendo en negrita cursiva dentro de la misma tabla, el cuadro
 * de resumen con bordes, estado, quién atendió, condiciones, medios de pago y el pie
 * `1/1 #tid`—, con casi las mismas medidas (68 mm útiles, cuerpo de 12 pt) y los
 * mismos textos. El cliente ya conoce este papel; que cambie de forma al cambiar de
 * sistema es una pregunta en la ventanilla que no hace falta.
 *
 * Tres diferencias deliberadas, todas de papel y no de contenido:
 *  · El ALTO no es fijo. En el legacy salían siempre 250 mm, así que un recibo de un
 *    renglón escupía 20 cm en blanco. Aquí se mide el contenido y la página se crea
 *    con el alto justo, que es como trabaja una térmica (papel continuo + corte).
 *  · El membrete no lleva logo. Tampoco lo lleva el legacy.
 *  · El ANCHO es el que la impresora marca (72 mm), no el del rollo (80). Ver la
 *    nota de `ANCHO_MM`: con 80 se iba la columna de valores fuera del papel.
 *
 * Si hay que tocar algo aquí, la referencia está en
 * `/home/dev/saves-vestel-src/application/views/invoices/view-print-ltr.php`.
 */
import PDFDocument from 'pdfkit';
import type { Response } from 'express';

const MM = 72 / 25.4;

/**
 * Medidas del papel, ajustables sin tocar código.
 *
 * La página mide el ancho que la impresora IMPRIME, no el que mide el rollo. No son
 * el mismo número: en un rollo de 80 mm la térmica marca solo unos 72 mm (576 puntos
 * a 203 ppp), y los 8 mm restantes son el margen mecánico del cabezal. Con una página
 * de 80 mm pasa una de dos, según lo que decida el driver: o recorta los últimos
 * milímetros —y se va la columna de valores, que es el borde derecho— o encoge todo
 * para que quepa y el recibo sale pequeño y desplazado. Con la página a 72 mm el
 * papel ya mide lo que la impresora marca y no hay nada que recortar ni que escalar.
 *
 * El margen baja a 2 mm para compensar: quedan 68 mm de contenido contra los 70 mm
 * del legacy, así que el recibo se ve igual de ancho que el de siempre.
 *
 * `RECIBO_ANCHO_MM` y `RECIBO_MARGEN_MM` mueven esto sin tocar código, que es lo que
 * hay que hacer si una sede pone una térmica distinta —una de 58 mm imprime unos 48—.
 * Todo lo demás se recalcula solo a partir de `CONT`.
 */
const mm = (env: string, porDefecto: number) => {
  const v = Number(process.env[env]);
  return Number.isFinite(v) && v > 0 ? v : porDefecto;
};
const ANCHO_MM = mm('RECIBO_ANCHO_MM', 72);
const MARGEN_MM = mm('RECIBO_MARGEN_MM', 2);

const ANCHO = ANCHO_MM * MM;
const PAD = MARGEN_MM * MM;
const CONT = ANCHO - PAD * 2; // 192,8 pt con los valores por defecto (68 mm)
/** Papel que se deja al final para que la cuchilla no se coma la última línea. */
const COLA = 8 * MM;

/** Cuerpo del recibo: `.invoice-box { font-size: 12pt }`. */
const BASE = 12;
/** Membrete: `.myw { font-size: 14pt }` y el `<h2>` del nombre de la empresa. */
const MEMBRETE = 14;
const TITULO = 21;

const GRIS_CABECERA = '#515151';
const BORDE = '#DDDDDD';
const BORDE_CLIENTE = '#CCCCCC';
const TINTA = '#000000';

/** `amountExchange()` del legacy con la configuración de Vestel: `$ 84.000`. */
const cop = (n: number) =>
  '$ ' + new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 }).format(Math.round(n || 0));

// `date` del recibo es una columna `date` (medianoche UTC): formatearla en horario
// de Colombia la correría al día anterior. La hora sí sale de `createdAt`, que es un
// instante real. Ver la nota de fechas en `sql-crudo-fechas`.
const fechaSolo = (d: Date | string) =>
  new Date(d).toLocaleDateString('es-CO', {
    timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric',
  });
/** `date("g:i a")` de PHP: "4:41 pm" — sin puntos y en minúscula, como el legacy. */
const horaSolo = (d: Date | string) =>
  new Date(d)
    .toLocaleTimeString('en-US', {
      timeZone: 'America/Bogota', hour: 'numeric', minute: '2-digit', hour12: true,
    })
    .toLowerCase()
    .replace(/\s/g, ' ');

/** Como el `date("d/m/Y").' '.date("g:i a")` de la cabecera del legacy. */
const fechaHora = (d: Date | string, hora?: Date | string | null) =>
  fechaSolo(d) + (hora ? ` ${horaSolo(hora)}` : '');

type Doc = PDFKit.PDFDocument;

type Opts = {
  size?: number;
  bold?: boolean;
  italic?: boolean;
  align?: 'left' | 'center' | 'right' | 'justify';
  color?: string;
  /** Aire debajo del elemento, en puntos. */
  gap?: number;
  /**
   * Separación entre líneas RESPECTO de la que pdfkit calcularía. El legacy aprieta
   * los renglones de la tabla con `line-height: 9pt` sobre un cuerpo de 12 pt, y sin
   * esto un concepto de dos líneas sale con el doble de aire que en el papel viejo.
   */
  lineGap?: number;
};

const fuente = (o: { bold?: boolean; italic?: boolean }) =>
  o.bold && o.italic ? 'Helvetica-BoldOblique'
  : o.bold ? 'Helvetica-Bold'
  : o.italic ? 'Helvetica-Oblique'
  : 'Helvetica';

/**
 * Proporción de la tabla que se lleva la columna de valores.
 *
 * El mínimo es el 32% del legacy (su `<td>` de totales), pero es un mínimo y no una
 * medida fija: con 68 mm de contenido eso deja 55 pt de celda útil, y ahí `$ 84.000`
 * cabe pero `$ 1.234.500` no —se parte en dos renglones—. Las facturas acumuladas del
 * legacy pasan del millón a menudo, así que la columna se ensancha hasta el 46% si el
 * número más largo del recibo lo pide. Del 46% no pasa: al otro lado va el concepto,
 * que también necesita sitio.
 */
const ANCHO_DER_MIN = 0.32;
const ANCHO_DER_MAX = 0.46;
/** Aire a cada lado dentro de la celda: el `padX` de `filaTabla` y el `pad` de la cabecera. */
const PAD_CELDA = 6;

/**
 * Cuánto tiene que medir la columna de valores para que NINGUNO se parta.
 *
 * Se mide con la negrita cursiva porque es la fuente más ancha de la tabla (las
 * facturas pendientes van así) y el ancho de la columna es uno solo para todas las
 * filas: si cada una eligiera el suyo, los bordes no cuadrarían en vertical.
 */
function anchoValores(valores: string[]): number {
  const m = new PDFDocument({ size: [ANCHO, 100], margin: 0 }) as unknown as Doc;
  const ancho = valores.reduce(
    (max, t) => Math.max(max, m.font('Helvetica-BoldOblique').fontSize(BASE).widthOfString(t)),
    0,
  );
  (m as any).end();
  const necesario = (ancho + PAD_CELDA * 2 + 1) / CONT;
  return Math.min(ANCHO_DER_MAX, Math.max(ANCHO_DER_MIN, necesario));
}

/** Un bloque del rollo: sabe cuánto ocupa y cómo se pinta a una altura dada. */
type El = { alto: (m: Doc) => number; pinta: (doc: Doc, y: number) => void };

/** Un trozo de párrafo: el legacy mete negritas en medio del texto de medios de pago. */
type Trozo = { t: string; bold?: boolean };

/** Celda de una tabla del recibo. */
type Celda = { t: string; bold?: boolean; italic?: boolean; align?: 'left' | 'center' | 'right' };

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
    const size = o.size ?? BASE;
    const align = o.align ?? 'left';
    const gap = o.gap ?? 0;
    const lineGap = o.lineGap ?? 0;
    this.els.push({
      alto: (m) => m.font(f).fontSize(size).heightOfString(t, { width: CONT, align, lineGap }) + gap,
      pinta: (doc, y) => {
        doc.font(f).fontSize(size).fillColor(o.color ?? TINTA)
          .text(t, PAD, y, { width: CONT, align, lineGap });
      },
    });
    return this;
  }

  /**
   * Párrafo con negritas dentro (el bloque de medios de pago del legacy).
   *
   * Se pinta encadenando trozos con `continued`, que es lo único que respeta el flujo
   * del texto. Para MEDIRLO se junta todo y se mide con la redonda sobre un ancho un
   * 4% más estrecho: las negritas ocupan algo más, y quedarse corto partiría el papel
   * a mitad del párrafo — sobrar unos milímetros no le hace daño a nadie.
   */
  parrafo(trozos: Trozo[], o: Opts = {}) {
    const size = o.size ?? BASE;
    const align = o.align ?? 'left';
    const gap = o.gap ?? 0;
    // Con `continued`, pdfkit se traga el espacio inicial de cada trozo y las palabras
    // se pegan ("...usuario Nº 19150y en contraseña..."). Se pasa ese espacio al final
    // del trozo anterior, que sí lo respeta.
    const partes = trozos.map((x) => ({ ...x }));
    for (let i = 1; i < partes.length; i++) {
      const m = /^\s+/.exec(partes[i].t);
      if (!m) continue;
      partes[i].t = partes[i].t.slice(m[0].length);
      partes[i - 1].t += m[0];
    }
    const plano = partes.map((x) => x.t).join('');
    this.els.push({
      alto: (m) => m.font('Helvetica').fontSize(size).heightOfString(plano, { width: CONT * 0.96, align }) + gap,
      pinta: (doc, y) => {
        doc.fillColor(o.color ?? TINTA).fontSize(size);
        partes.forEach((trozo, i) => {
          doc.font(trozo.bold ? 'Helvetica-Bold' : 'Helvetica');
          const opciones = { width: CONT, align, continued: i < partes.length - 1 };
          if (i === 0) doc.text(trozo.t, PAD, y, opciones);
          else doc.text(trozo.t, opciones);
        });
      },
    });
    return this;
  }

  /** El recuadro de datos del cliente (`table.party`, borde gris de 1 pt). */
  recuadro(lineas: Trozo[]) {
    const size = BASE;
    const padX = 4, padTop = 6, padBottom = 5;
    const ancho = CONT - padX * 2;
    const altoTexto = (m: Doc) =>
      lineas.reduce((s, l) => s + m.font(fuente({ bold: l.bold })).fontSize(size).heightOfString(l.t, { width: ancho }), 0);
    this.els.push({
      alto: (m) => altoTexto(m) + padTop + padBottom + 2,
      pinta: (doc, y) => {
        const h = altoTexto(doc) + padTop + padBottom;
        doc.rect(PAD, y, CONT, h).lineWidth(1).strokeColor(BORDE_CLIENTE).stroke();
        let cursor = y + padTop;
        for (const l of lineas) {
          const f = fuente({ bold: l.bold });
          doc.font(f).fontSize(size).fillColor(TINTA).text(l.t, PAD + padX, cursor, { width: ancho });
          cursor += doc.font(f).fontSize(size).heightOfString(l.t, { width: ancho });
        }
      },
    });
    return this;
  }

  /** Cabecera de la tabla de conceptos: fondo `#515151` y texto blanco (`tr.heading`). */
  cabeceraTabla(izq: string, der: string, anchoDer = ANCHO_DER_MIN) {
    const size = BASE;
    const pad = 6;
    const dw = CONT * anchoDer;
    const iw = CONT - dw;
    const altoCelda = (m: Doc) =>
      Math.max(
        m.font('Helvetica').fontSize(size).heightOfString(izq, { width: iw - pad * 2 }),
        m.font('Helvetica').fontSize(size).heightOfString(der, { width: dw - pad * 2, align: 'center' }),
      ) + pad * 2;
    this.els.push({
      alto: (m) => altoCelda(m),
      pinta: (doc, y) => {
        const h = altoCelda(doc);
        doc.rect(PAD, y, CONT, h).fill(GRIS_CABECERA);
        doc.font('Helvetica').fontSize(size).fillColor('#FFFFFF')
          .text(izq, PAD + pad, y + pad, { width: iw - pad * 2 });
        doc.font('Helvetica').fontSize(size).fillColor('#FFFFFF')
          .text(der, PAD + iw, y + pad, { width: dw - pad * 2, align: 'center' });
      },
    });
    return this;
  }

  /**
   * Fila de tabla con bordes (`tr.item td { border: 1px solid #ddd }`).
   *
   * `lineGap` negativo reproduce el `line-height: 9pt` del legacy, que es lo que hace
   * que un concepto de dos líneas salga pegado y no con doble espacio.
   */
  filaTabla(izq: Celda, der: Celda, o: { anchoDer?: number; lineGap?: number; padY?: [number, number] } = {}) {
    const size = BASE;
    const padX = 4;
    const [padTop, padBottom] = o.padY ?? [6, 5];
    const lineGap = o.lineGap ?? 0;
    const dw = CONT * (o.anchoDer ?? ANCHO_DER_MIN);
    const iw = CONT - dw;
    const fi = fuente(izq), fd = fuente(der);
    const altoCelda = (m: Doc) =>
      Math.max(
        m.font(fi).fontSize(size).heightOfString(izq.t, { width: iw - padX * 2, lineGap }),
        m.font(fd).fontSize(size).heightOfString(der.t, { width: dw - padX * 2, lineGap }),
      ) + padTop + padBottom;
    this.els.push({
      alto: (m) => altoCelda(m),
      pinta: (doc, y) => {
        const h = altoCelda(doc);
        doc.lineWidth(1).strokeColor(BORDE);
        doc.rect(PAD, y, iw, h).stroke();
        doc.rect(PAD + iw, y, dw, h).stroke();
        doc.font(fi).fontSize(size).fillColor(TINTA)
          .text(izq.t, PAD + padX, y + padTop, { width: iw - padX * 2, align: izq.align ?? 'left', lineGap });
        doc.font(fd).fontSize(size).fillColor(TINTA)
          .text(der.t, PAD + iw + padX, y + padTop, { width: dw - padX * 2, align: der.align ?? 'center', lineGap });
      },
    });
    return this;
  }

  /** Regla horizontal fina (el `<hr>` que va antes de las condiciones). */
  regla() {
    this.els.push({
      alto: () => 8,
      pinta: (doc, y) => {
        doc.moveTo(PAD, y + 4).lineTo(PAD + CONT, y + 4).lineWidth(0.5).strokeColor(BORDE_CLIENTE).stroke();
      },
    });
    return this;
  }

  espacio(h: number) {
    this.els.push({ alto: () => h, pinta: () => {} });
    return this;
  }

  /** Mide todo contra un documento de descarte y devuelve el alto de papel. */
  altoTotal(): number {
    const m = new PDFDocument({ size: [ANCHO, 2000], margin: 0 }) as unknown as Doc;
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
  /** Título de la condición de pago (`billing_terms.title` del legacy). */
  terms: string | null;
};

/** `$lang['Paid'|'Due'|'Partial']` del español del legacy. */
const ESTADO: Record<string, string> = {
  PAID: 'Cancelado', PARTIAL: 'Abonado', DUE: 'Pendiente', CANCELED: 'Anulada',
};

/** Datos de la empresa: los mismos de `app_system` que imprime el legacy. */
const EMPRESA = {
  nombre: 'VESTEL S.A.S',
  direccion: 'Dig 34 n 31B - 87',
  nit: '813001768-1',
  web: 'www.vestel.com.co',
  convenio: '93477',
  pbx: '300 9135141',
};

/** Nombre propio como lo escribe el legacy (`ucwords`), no en mayúsculas sostenidas. */
const capitalizar = (s: string) =>
  s.toLowerCase()
    // `\b` de JS no entiende letras con tilde ni la Ñ: con él, "castañeda" salía
    // "CastaÑEda" porque veía frontera de palabra alrededor de la ñ.
    .replace(/(^|[\s'-])(\p{L})/gu, (_, sep, letra) => sep + letra.toUpperCase())
    .replace(/\s+/g, ' ')
    .trim();

/** Recibo de caja en rollo de 80 mm (impresión térmica). */
export function reciboRolloPdf(res: Response, d: ReciboRolloData) {
  const r = arma(d);
  const doc = new PDFDocument({ size: [ANCHO, r.altoTotal()], margin: 0 }) as unknown as Doc;
  sinReescalar(doc);
  doc.pipe(res);
  r.pinta(doc);
  (doc as any).end();
}

/**
 * Le dice al visor que NO toque el tamaño al imprimir.
 *
 * El recibo sale por una impresora POS, donde el milímetro es el milímetro: si el
 * visor "ajusta al área imprimible" —lo hace solo, sin avisar— el papel sale con la
 * letra encogida y descentrada. `PrintScaling /None` y `PickTrayByPDFSize` son la
 * forma estándar de pedir escala 1:1 y que el papel se elija por el tamaño del
 * documento. No todos los visores lo respetan (Chrome tiene su propio selector de
 * escala), pero los que sí, dejan de estropear el recibo sin que nadie toque nada.
 */
function sinReescalar(doc: Doc) {
  const d = doc as any;
  // Igual que hace pdfkit con `displayTitle`: una referencia creada con `ref()` y
  // SIN cerrarla aquí — su `end()` la cierra él al terminar el documento. Cerrarla a
  // mano (o poner un diccionario suelto, que no tiene `end`) rompe el PDF entero.
  d._root.data.ViewerPreferences = d.ref({
    PrintScaling: 'None', PickTrayByPDFSize: true, Duplex: 'Simplex',
  });
}

function arma(d: ReciboRolloData): Rollo {
  const r = new Rollo();
  const s = d.subscriber;
  const codigo = s?.codigo ?? s?.abonado ?? null;
  // El pie del legacy estampa el número de FACTURA, no el del recibo.
  const tid = d.items.find((i) => i.tid)?.tid ?? null;

  // --- Membrete (header-print-ltr.php) ---------------------------------------
  r.texto(EMPRESA.nombre, { size: TITULO, bold: true, align: 'center', gap: 4 });
  const CABECERA = { size: MEMBRETE, align: 'center' as const, lineGap: -2 };
  r.texto(EMPRESA.direccion, CABECERA);
  r.texto(`Nit: ${EMPRESA.nit}`, CABECERA);
  if (d.branch) r.texto(`Sede: ${d.branch}`, CABECERA);
  r.texto(fechaHora(d.date, d.createdAt), CABECERA);
  r.espacio(10);

  // --- Recuadro del cliente (table.party) ------------------------------------
  const lineas: Trozo[] = [{ t: capitalizar(s?.name || '—'), bold: true }];
  if (s?.docNumber) lineas.push({ t: `${s.docType || 'CC'}: ${s.docNumber}` });
  if (s?.email) lineas.push({ t: `Email : ${s.email}` });
  if (s?.abonado != null) lineas.push({ t: `Abonado : ${s.abonado}` });
  r.recuadro(lineas);
  r.espacio(10);

  // --- Tabla de conceptos ----------------------------------------------------
  // El legacy aprieta estos renglones con `line-height: 9pt` sobre cuerpo de 12 pt.
  const APRETADO = -4.5;
  // Un solo ancho de columna para la tabla de conceptos Y el resumen: son dos tablas
  // distintas pero salen una debajo de otra y los bordes tienen que cuadrar.
  const anchoDer = anchoValores([
    ...d.items.map((i) => cop(i.amount)),
    ...d.pending.map((p) => cop(p.amount)),
    cop(d.total), cop(d.discount), cop(d.paid), cop(d.balance),
  ]);
  r.cabeceraTabla('Descripción', 'Total parcial', anchoDer);
  if (d.items.length) {
    for (const it of d.items) {
      r.filaTabla({ t: it.concept }, { t: cop(it.amount) }, { anchoDer, lineGap: APRETADO });
    }
  } else {
    r.filaTabla({ t: 'Sin movimientos en el recibo' }, { t: cop(0) }, { anchoDer, lineGap: APRETADO });
  }
  // Lo que sigue debiendo va en la MISMA tabla, en negrita cursiva: es como lo lee la
  // cajera cuando el cliente pregunta "¿y entonces qué me falta?".
  for (const p of d.pending) {
    r.filaTabla(
      { t: p.concept, bold: true, italic: true },
      { t: cop(p.amount), bold: true, italic: true },
      { anchoDer, lineGap: APRETADO },
    );
  }
  r.espacio(10);

  // --- Resumen (table.subtotal, con bordes) ----------------------------------
  const RESUMEN: [number, number] = [6, 6];
  const resumen = { anchoDer, padY: RESUMEN };
  r.filaTabla({ t: 'Resumen:', bold: true }, { t: '' }, resumen);
  r.filaTabla({ t: 'Cantidad Total:' }, { t: cop(d.total) }, resumen);
  if (d.discount > 0) {
    r.filaTabla({ t: 'Descuento total:' }, { t: cop(d.discount) }, resumen);
  }
  r.filaTabla({ t: 'Monto de pago' }, { t: cop(d.paid) }, resumen);
  r.filaTabla({ t: 'Saldo adeudado:' }, { t: cop(d.balance), bold: true }, resumen);
  r.espacio(10);

  // --- Estado y quién atendió ------------------------------------------------
  if (d.status) r.texto(`Estado: ${ESTADO[d.status] ?? d.status}`, { size: BASE, bold: true });
  if (d.cashier) {
    r.texto(`(${d.cashier})`, { size: 10, align: 'center' });
    if (d.cashierRole) r.texto(d.cashierRole, { size: 10, align: 'center' });
  }

  // --- Condiciones -----------------------------------------------------------
  r.regla();
  if (d.terms) r.texto(`Condiciones: ${d.terms}`, { size: 9, bold: true });
  r.espacio(6);

  // --- Medios de pago (texto literal del legacy para Vestel) -----------------
  r.parrafo([
    { t: 'Realice su pago a través de nuestra pagina ' },
    { t: EMPRESA.web, bold: true },
    { t: ', en el menu ' },
    { t: 'EN LINEA', bold: true },
    { t: ', con su codigo de usuario Nº ' },
    { t: String(codigo ?? '—'), bold: true },
    { t: ' y en contraseña su numero de documento. A través de un corresponsal ' },
    { t: 'BANCOLOMBIA', bold: true },
    { t: ' al número  de convenio ' },
    { t: EMPRESA.convenio, bold: true },
    { t: ' con referencia codigo de usuario Nº ' },
    { t: String(codigo ?? '—'), bold: true },
  ], { align: 'justify', gap: 8 });

  r.texto(`LINEA PBX: ${EMPRESA.pbx}`, { size: BASE, bold: true, align: 'center' });

  // --- Pie (`{PAGENO}/{nbpg} #tid` del mPDF) ---------------------------------
  r.espacio(10);
  // El pie del legacy es gris (#5C5C5C), pero una térmica sólo tiene negro: los
  // grises los simula con trama y el resultado es un renglón sucio y medio ilegible.
  r.texto(`1/1 #${tid ?? d.number}`, { size: 8, italic: true, align: 'right' });

  return r;
}
