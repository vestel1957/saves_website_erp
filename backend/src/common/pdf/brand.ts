/**
 * Kit de marca para los PDF operativos (recibo, factura, orden, contrato, cierre).
 *
 * Existe para que los cinco documentos dejen de repetir cada uno su propio
 * `brandHeader` con "VESTEL" escrito a mano: aquí están la paleta, el membrete con
 * logo, el pie con numeración y los ladrillos de tabla que todos comparten.
 *
 * La paleta sale del PNG del logo (navy #001858 → azul #0868a8 → plata), no de un
 * azul cualquiera: es el mismo azul de los manuales de uso.
 */
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

// --- Paleta ---------------------------------------------------------------
export const NAVY = '#0b2059';
export const NAVY_2 = '#132f74';
export const BRAND = '#0a5ca8';
export const BRAND_2 = '#1592d0';
export const BRAND_SOFT = '#e8f2fa';
export const BRAND_LINE = '#c3dcf0';
export const SILVER = '#aab8c6';
export const INK = '#0d1526';
export const INK_2 = '#3d4a60';
export const INK_3 = '#6b7a90';
export const LINE = '#dde5ee';
export const ZEBRA = '#f4f7fb';
export const OK = '#067647';
export const BAD = '#b42318';

/** Márgenes y anchos útiles de la hoja A4 que usan todos los documentos. */
export const M = 40;
export const RIGHT = 555;
export const WIDTH = RIGHT - M; // 515
export const FOOT_Y = 800;

export const EMPRESA = {
  nombre: 'VESGA TELEVISION S.A.S',
  marca: 'VESTEL',
  bajada: 'Servicios de Internet y Televisión',
  nit: 'NIT 813.001.768-1',
};

// El logo vive en el frontend; se lee una sola vez y se cachea. Si no aparece
// (despliegue solo-backend), el membrete cae al texto y el PDF sale igual.
let logoCache: Buffer | null | undefined;
function logo(): Buffer | null {
  if (logoCache !== undefined) return logoCache;
  const rutas = [
    process.env.BRAND_LOGO_PATH,
    resolve(process.cwd(), '..', 'frontend', 'public', 'logo-vestel.png'),
    resolve(process.cwd(), 'assets', 'logo-vestel.png'),
    join('/home/dev/saves', 'frontend', 'public', 'logo-vestel.png'),
  ].filter(Boolean) as string[];
  for (const r of rutas) {
    try {
      if (existsSync(r)) return (logoCache = readFileSync(r));
    } catch {
      /* ruta ilegible: se prueba la siguiente */
    }
  }
  return (logoCache = null);
}

/** El mismo logo cacheado, para los documentos que arman su propio membrete (rollo 80 mm). */
export const logoBuffer = (): Buffer | null => logo();

/** Datos de la empresa que el legacy leía de `app_system` (hook Myapp::appset). */
export const CONTACTO = {
  direccion: 'Dig 34 n 31B - 87',
  ciudad: 'Yopal',
  nitCorto: '813001768-1',
  telefono: '300 9135141',
  email: 'atencionalusuario@vestel.com.co',
  web: 'www.vestel.com.co',
  convenioBancolombia: '93477',
};

/**
 * Crea el documento con la numeración de páginas ya habilitada.
 *
 * `bufferPages` es lo que permite escribir "Página 2 de 7": sin él pdfkit no puede
 * volver atrás a estampar el total. Hay que cerrar SIEMPRE con `finish()`.
 */
export function newDoc(PDFDocument: any) {
  return new PDFDocument({ size: 'A4', margin: M, bufferPages: true });
}

/**
 * Membrete: cinta de color, logo, datos de la empresa y título del documento.
 *
 * `right` es el rótulo pequeño de la esquina (tipo de documento, estado); `chip`
 * pinta ese rótulo como pastilla azul en vez de texto suelto.
 */
export function docHeader(
  doc: PDFKit.PDFDocument,
  title: string,
  opts: { right?: string; chip?: string } = {},
) {
  // Cinta superior con el degradado del logo.
  const g = doc.linearGradient(0, 0, 595, 0);
  g.stop(0, NAVY).stop(0.55, BRAND).stop(1, BRAND_2);
  doc.rect(0, 0, 595, 6).fill(g);

  const img = logo();
  if (img) {
    // 200 px de ancho original: a 118 pt queda nítido en impresión.
    doc.image(img, M, 26, { width: 118 });
    doc.fillColor(INK_3).fontSize(7.5).font('Helvetica')
      .text(`${EMPRESA.nombre} · ${EMPRESA.nit}`, M, 62, { width: 300 });
  } else {
    doc.fillColor(NAVY).fontSize(20).font('Helvetica-Bold').text(EMPRESA.marca, M, 30);
    doc.fillColor(INK_3).fontSize(8.5).font('Helvetica').text(EMPRESA.bajada, M, 54);
    doc.fillColor(INK_3).fontSize(7.5).text(`${EMPRESA.nombre} · ${EMPRESA.nit}`, M, 66);
  }

  if (opts.right) {
    doc.fillColor(INK_3).fontSize(9).font('Helvetica')
      .text(opts.right, 340, 30, { width: 215, align: 'right' });
  }
  if (opts.chip) {
    const w = doc.font('Helvetica-Bold').fontSize(8).widthOfString(opts.chip) + 14;
    doc.roundedRect(RIGHT - w, opts.right ? 46 : 30, w, 15, 7.5).fill(BRAND_SOFT);
    doc.fillColor(NAVY).fontSize(8).font('Helvetica-Bold')
      .text(opts.chip, RIGHT - w, (opts.right ? 46 : 30) + 4, { width: w, align: 'center' });
  }

  doc.moveTo(M, 84).lineTo(RIGHT, 84).lineWidth(0.75).strokeColor(BRAND_LINE).stroke();
  doc.fillColor(NAVY).fontSize(16).font('Helvetica-Bold').text(title, M, 94, { width: WIDTH });
  doc.moveTo(M, doc.y + 4).lineTo(M + 46, doc.y + 4).lineWidth(2.5).strokeColor(BRAND_2).stroke();
  doc.lineWidth(1);
  doc.x = M;
  doc.y = doc.y + 16;
}

/** Título de bloque: cuadrito azul + texto en versalitas y una línea fina. */
export function section(doc: PDFKit.PDFDocument, title: string) {
  if (doc.y > 730) newPage(doc);
  doc.moveDown(0.3);
  const y = doc.y;
  doc.rect(M, y + 2, 3, 9).fill(BRAND_2);
  doc.fillColor(NAVY).fontSize(10).font('Helvetica-Bold')
    .text(title.toUpperCase(), M + 8, y, { width: WIDTH - 8, characterSpacing: 0.5 });
  doc.moveTo(M, doc.y + 2).lineTo(RIGHT, doc.y + 2).lineWidth(0.5).strokeColor(LINE).stroke();
  doc.x = M;
  doc.y = doc.y + 8;
}

/** Etiqueta + valor en una línea (los datos de cabecera de cada documento). */
export function kv(doc: PDFKit.PDFDocument, label: string, value: string) {
  const y = doc.y;
  doc.fontSize(9.5).font('Helvetica').fillColor(INK_3).text(label, M, y, { width: 110 });
  doc.font('Helvetica-Bold').fillColor(INK).text(value, M + 115, y, { width: WIDTH - 115 });
  doc.x = M;
  doc.y = Math.max(y + 14, doc.y);
}

/** Los mismos datos en dos columnas, para cabeceras con muchos campos. */
export function kvGrid(doc: PDFKit.PDFDocument, pares: [string, string][]) {
  const colW = WIDTH / 2;
  let y = doc.y;
  pares.forEach(([l, v], i) => {
    const x = M + (i % 2) * colW;
    if (i % 2 === 0 && i > 0) y += 15;
    doc.fontSize(9).font('Helvetica').fillColor(INK_3).text(l, x, y, { width: 78 });
    doc.font('Helvetica-Bold').fillColor(INK).text(v, x + 80, y, { width: colW - 88, ellipsis: true });
  });
  doc.x = M;
  doc.y = y + 20;
}

/**
 * Fila de TARJETAS con las cifras de cabecera.
 *
 * Sustituye a `kvGrid` cuando lo que se muestra son indicadores y no campos de un
 * formulario. La diferencia no es estética: en una rejilla "etiqueta: valor" el
 * número compite con su etiqueta por el mismo renglón, así que una etiqueta un poco
 * larga ("Re-visita del equipo") se parte en dos líneas y pisa la siguiente — hubo
 * que ir acortando textos a mano para que cupieran. En una tarjeta cada cosa tiene
 * su renglón: la etiqueta arriba, pequeña y en gris, y el valor abajo, grande. El
 * texto puede crecer sin romper nada y el número se lee de un vistazo, que es para
 * lo que está.
 *
 * Tres por fila, y las que sobren bajan solas.
 */
export function stats(doc: PDFKit.PDFDocument, tiles: [string, string][]) {
  if (!tiles.length) return;
  const POR_FILA = 3, GAP = 8, ALTO = 42;
  const w = (WIDTH - GAP * (POR_FILA - 1)) / POR_FILA;
  const filas = Math.ceil(tiles.length / POR_FILA);
  if (doc.y + filas * (ALTO + GAP) > 760) newPage(doc);
  const y0 = doc.y;

  tiles.forEach(([label, value], i) => {
    const x = M + (i % POR_FILA) * (w + GAP);
    const y = y0 + Math.floor(i / POR_FILA) * (ALTO + GAP);
    doc.roundedRect(x, y, w, ALTO, 4).fill('#f7fafd');
    // Filete de color a la izquierda: da jerarquía sin meter una caja de color
    // entera, que competiría con las tablas.
    doc.rect(x, y + 6, 2.5, ALTO - 12).fill(BRAND_2);
    doc.fillColor(INK_3).fontSize(7.5).font('Helvetica')
      .text(label.toUpperCase(), x + 10, y + 8, { width: w - 16, characterSpacing: 0.3, ellipsis: true, lineBreak: false });
    doc.fillColor(NAVY).fontSize(14).font('Helvetica-Bold')
      .text(value, x + 10, y + 20, { width: w - 16, ellipsis: true, lineBreak: false });
  });

  doc.x = M;
  doc.y = y0 + filas * (ALTO + GAP) + 2;
}

/**
 * Medidor de proporción para una celda de tabla.
 *
 * Una columna de números ordenada dice cuál es el mayor, pero no CUÁNTO mayor: hay
 * que restar de cabeza fila por fila. Una barra fina al lado lo resuelve sin leer
 * un solo dígito. Es una sola tonalidad (más oscuro = más), no una paleta: aquí no
 * hay identidades que distinguir, solo magnitudes que comparar.
 *
 * `v` es la fracción 0..1 sobre el mayor de la tabla. Se le deja siempre un mínimo
 * visible: una barra de ancho cero se lee como "sin dato", y un 1 sobre 5.000 no es
 * cero.
 */
export function meter(doc: PDFKit.PDFDocument, x: number, y: number, w: number, v: number) {
  const H = 5, r = H / 2;
  const frac = Math.max(0, Math.min(1, Number(v) || 0));
  doc.roundedRect(x, y, w, H, r).fill(BRAND_SOFT);
  const ancho = frac > 0 ? Math.max(H, w * frac) : 0;
  if (ancho > 0) doc.roundedRect(x, y, ancho, H, r).fill(BRAND);
}

export type Col = { label: string; x: number; w: number; align?: 'left' | 'right' };

/** Encabezado de tabla en navy. Devuelve las columnas para reusarlas por fila. */
export function thead(doc: PDFKit.PDFDocument, cols: Col[]) {
  const y = doc.y;
  doc.rect(M, y, WIDTH, 18).fill(NAVY);
  doc.fillColor('#fff').fontSize(8.5).font('Helvetica-Bold');
  for (const c of cols) {
    doc.text(c.label.toUpperCase(), c.x, y + 5, { width: c.w, align: c.align ?? 'left' });
  }
  doc.x = M;
  doc.y = y + 18;
  return cols;
}

/** Fila de tabla con cebra. `h` permite filas más altas si el texto envuelve. */
export function trow(
  doc: PDFKit.PDFDocument,
  cols: Col[],
  celdas: (string | { t: string; color?: string; bold?: boolean })[],
  i: number,
  h = 16,
) {
  const y = doc.y;
  if (i % 2 === 1) doc.rect(M, y, WIDTH, h).fill(ZEBRA);
  cols.forEach((c, k) => {
    const cel = celdas[k] ?? '';
    const o = typeof cel === 'string' ? { t: cel } : cel;
    doc.font(o.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9)
      .fillColor(o.color ?? INK_2)
      .text(o.t, c.x, y + 4, { width: c.w, align: c.align ?? 'left', ellipsis: true, lineBreak: false });
  });
  doc.x = M;
  doc.y = y + h;
  doc.moveTo(M, doc.y).lineTo(RIGHT, doc.y).lineWidth(0.5).strokeColor(LINE).stroke();
}

/**
 * Recuadro de totales alineado a la derecha. La última línea va destacada:
 * es el número que la gente busca primero al recibir el documento.
 */
export function totals(doc: PDFKit.PDFDocument, filas: [string, string][], destacado = true) {
  const x = 320, w = RIGHT - x;
  const alto = filas.length * 16 + 8;
  const y = doc.y + 6;
  doc.roundedRect(x, y, w, alto, 3).fill(BRAND_SOFT);
  filas.forEach(([l, v], i) => {
    const ultimo = destacado && i === filas.length - 1;
    const fy = y + 6 + i * 16;
    if (ultimo) doc.roundedRect(x, fy - 3, w, 19, 3).fill(NAVY);
    doc.font(ultimo ? 'Helvetica-Bold' : 'Helvetica').fontSize(ultimo ? 11 : 9.5)
      .fillColor(ultimo ? '#fff' : INK_2)
      .text(l, x + 10, fy + (ultimo ? 1 : 0), { width: w / 2 - 10 });
    doc.fillColor(ultimo ? '#fff' : NAVY).font('Helvetica-Bold')
      .text(v, x + w / 2, fy + (ultimo ? 1 : 0), { width: w / 2 - 10, align: 'right' });
  });
  doc.x = M;
  doc.y = y + alto + 8;
}

/** Cuadro de firmas: reparte en columnas iguales el ancho útil. */
export function signatures(
  doc: PDFKit.PDFDocument,
  firmas: { rotulo: string; nombre?: string | null; nota?: string | null }[],
) {
  if (doc.y > 690) newPage(doc);
  const y = Math.max(doc.y + 24, 0);
  const colW = WIDTH / firmas.length;
  firmas.forEach((f, i) => {
    const x = M + i * colW;
    doc.moveTo(x, y).lineTo(x + colW - 24, y).lineWidth(0.75).strokeColor(SILVER).stroke();
    if (f.nombre) {
      doc.fillColor(INK).fontSize(9).font('Helvetica-Bold')
        .text(f.nombre, x, y + 5, { width: colW - 24, ellipsis: true });
    }
    doc.fillColor(INK_3).fontSize(8).font('Helvetica')
      .text(f.rotulo, x, y + (f.nombre ? 18 : 5), { width: colW - 24 });
    if (f.nota) {
      doc.fillColor(SILVER).fontSize(7.5).text(f.nota, x, y + (f.nombre ? 29 : 16), { width: colW - 24 });
    }
  });
  doc.y = y + 44;
}

/** Nota al pie del cuerpo (aclaraciones legales o de cálculo). */
export function note(doc: PDFKit.PDFDocument, texto: string) {
  doc.fillColor(INK_3).fontSize(7.5).font('Helvetica')
    .text(texto, M, doc.y + 2, { width: WIDTH, align: 'justify' });
  doc.x = M;
  doc.moveDown(0.5);
}

/** Salto de página que deja el cursor bajo el membrete corrido. */
export function newPage(doc: PDFKit.PDFDocument) {
  doc.addPage();
  doc.x = M;
  doc.y = 60;
}

/**
 * Cierra el documento estampando el pie en TODAS las páginas.
 *
 * Va al final a propósito: hasta que no está todo el contenido no se sabe cuántas
 * páginas hay, y "Página 1 de 1" en un cierre de caja de seis hojas engaña.
 */
export function finish(doc: PDFKit.PDFDocument, pie?: string) {
  const r = doc.bufferedPageRange();
  for (let i = 0; i < r.count; i++) {
    doc.switchToPage(r.start + i);
    // Sin margen inferior mientras se dibuja el pie: escribir por debajo del
    // margen haría que pdfkit añadiera otra página y el bucle no terminaría.
    const m = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.moveTo(M, FOOT_Y).lineTo(RIGHT, FOOT_Y).lineWidth(0.5).strokeColor(LINE).stroke();
    doc.fillColor(INK_3).fontSize(7.5).font('Helvetica')
      .text(pie ?? `${EMPRESA.nombre} · ${EMPRESA.nit} · Generado por SAVES`, M, FOOT_Y + 5,
        { width: 350, lineBreak: false });
    doc.fillColor(BRAND).font('Helvetica-Bold')
      .text(`Página ${i + 1} de ${r.count}`, 355, FOOT_Y + 5, { width: 200, align: 'right', lineBreak: false });
    doc.page.margins.bottom = m;
  }
  doc.end();
}
