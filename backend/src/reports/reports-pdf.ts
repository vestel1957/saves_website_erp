import PDFDocument from 'pdfkit';
import type { Response } from 'express';
import * as B from '../common/pdf/brand';

/**
 * Los reportes de gerencia, en PDF.
 *
 * Un reporte no es un documento como la factura o el contrato: no tiene un formato
 * pactado con nadie, cambia de forma cada vez que alguien añade una columna y son
 * nueve cosas distintas (recaudo, cartera, técnicos, cortes…). Dibujar uno por
 * reporte garantizaba que a los tres meses la mitad estuvieran desincronizados con
 * su tablero.
 *
 * Por eso aquí hay UN renderizador (`reportPdf`) que solo sabe de KPIs, tablas y
 * notas, y una función por reporte que TRADUCE lo que devuelve el servicio a esa
 * forma. Cuando un reporte cambia, se toca su traductor —diez líneas— y no el
 * dibujo. El membrete, la paginación y el pie salen del mismo kit de marca que el
 * resto de los PDF del ERP, así que un reporte impreso se ve como todo lo demás.
 */

const cop = (n: number | null | undefined) =>
  '$ ' + new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 }).format(Math.round(Number(n) || 0));
const int = (n: number | null | undefined) =>
  new Intl.NumberFormat('es-CO').format(Math.round(Number(n) || 0));
/** Porcentaje que distingue "0%" de "no se puede calcular". */
const pct = (n: number | null | undefined) => (n == null ? '—' : `${n}%`);
/**
 * ⚠️ ESTE SERVIDOR NO ESTÁ EN COLOMBIA (hoy, Europe/Berlin +02:00). Nada de fechas
 * puede formatearse con la zona por defecto o sale corrido un día.
 *
 * Y no vale una sola zona para todo, porque aquí conviven dos cosas distintas:
 *
 *  · Los LÍMITES DE PERIODO se construyen en UTC (`new Date(\`${to}T23:59:59.999Z\`)`,
 *    ver performance.service). Formatearlos en Berlín empujaba el 23:59:59Z al día
 *    siguiente: se pedía "hasta el 29 de julio" y el PDF titulaba "30 de jul". En
 *    Bogotá pasaría lo simétrico con el 00:00:00Z del inicio (saldría 31 de dic).
 *    Se muestran en UTC, que es como se calcularon.
 *
 *  · Las FECHAS DE UN HECHO (una anulación, un evento de bitácora) son instantes
 *    reales y se leen en la hora de quien los vivió: Colombia.
 */
const TZ_CO = 'America/Bogota';

/** Fecha de un hecho (anulación, evento, orden): hora de Colombia. */
const dia = (d: Date | string | null | undefined) =>
  d ? new Date(d).toLocaleDateString('es-CO', { timeZone: TZ_CO, day: '2-digit', month: 'short', year: 'numeric' }) : '—';

/** Límite de un periodo pedido: se calculó en UTC y se muestra en UTC. */
const diaRango = (d: Date | string | null | undefined) =>
  d ? new Date(d).toLocaleDateString('es-CO', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' }) : '—';

/**
 * Fecha para DENTRO de una tabla: dd/mm/aaaa, en hora de Colombia.
 *
 * La larga ("02 de ene de 2026") no cabe en una columna de fecha y se recorta a
 * "02 de ene d…", que además de feo pierde el año — justo el dato que se busca al
 * repasar un listado. La larga se queda para los rótulos de periodo, donde sí hay
 * sitio y se lee mejor.
 */
const diaCorto = (d: Date | string | null | undefined) => {
  if (!d) return '—';
  const x = new Date(d);
  if (Number.isNaN(x.getTime())) return '—';
  // en-CA da YYYY-MM-DD ya en la zona pedida; se le da la vuelta a dd/mm/aaaa.
  const [y, m, dd] = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ_CO, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(x).split('-');
  return `${dd}/${m}/${y}`;
};

/**
 * Recorta un texto al ancho de su columna.
 *
 * `B.trow` ya pide `ellipsis`, pero pdfkit lo ignora en algunos casos y parte el
 * nombre en dos líneas: la segunda se dibuja encima de la fila siguiente y la tabla
 * queda ilegible (nombres largos de técnico y razones sociales de empresa, que aquí
 * abundan). Se corta en la fuente, que es lo único que no falla. El límite es en
 * caracteres porque a 9 pt una Helvetica ronda los 4,5 pt por carácter.
 */
const corto = (s: unknown, max: number): string => {
  const t = String(s ?? '—').trim() || '—';
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

/** Columna declarada por PESO, no por posición: el renderizador reparte el ancho. */
export type ColSpec = { label: string; peso: number; align?: 'left' | 'right' };
/**
 * Una celda. `bar` (0..1) la convierte en un MEDIDOR en vez de texto: se usa en las
 * columnas de distribución, donde comparar magnitudes es justo lo que se viene a
 * hacer y una columna de cifras a secas obliga a restar de cabeza.
 */
export type Celda = string | { t?: string; color?: string; bold?: boolean; bar?: number };

export type ReporteTabla = {
  titulo: string;
  cols: ColSpec[];
  filas: Celda[][];
  /** Qué decir cuando no hay ni una fila. */
  vacio?: string;
};

export type ReporteData = {
  titulo: string;
  /** Rótulo del periodo medido. Va bajo el título y en la esquina del membrete. */
  periodo?: string;
  /** Cifras de cabecera: lo que se mira antes que las tablas. */
  resumen?: [string, string][];
  tablas: ReporteTabla[];
  /** Advertencias de lectura (qué NO mide el reporte, sesgos, muestras cortas). */
  notas?: string[];
  /** Quién lo pidió: un reporte suelto en un chat sin autor no se puede rastrear. */
  generadoPor?: string;
};

/** Reparte el ancho útil entre las columnas según su peso. */
function repartir(cols: ColSpec[]): B.Col[] {
  const total = cols.reduce((s, c) => s + c.peso, 0) || 1;
  let x = B.M;
  return cols.map((c) => {
    const w = (c.peso / total) * B.WIDTH;
    const col = { label: c.label, x, w: w - 6, align: c.align };
    x += w;
    return col;
  });
}

/**
 * Recorta la celda al ancho REAL de su columna, midiéndola con la misma fuente con
 * la que se va a dibujar.
 *
 * Es la red de seguridad de `corto`: contar caracteres falla justo donde más duele
 * —un nombre en MAYÚSCULAS ocupa bastante más que uno en minúsculas con la misma
 * cantidad de letras—, y una celda que no cabe no se recorta sino que se parte en
 * dos líneas, y la segunda se dibuja encima de la fila siguiente.
 */
function ajustar(doc: PDFKit.PDFDocument, texto: string, ancho: number, bold?: boolean): string {
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
  if (doc.widthOfString(texto) <= ancho) return texto;
  let s = texto;
  while (s.length > 1 && doc.widthOfString(`${s}…`) > ancho) s = s.slice(0, -1);
  return `${s.trimEnd()}…`;
}

/** Fila a fila, saltando de página y repitiendo el encabezado cuando toca. */
function tabla(doc: PDFKit.PDFDocument, t: ReporteTabla) {
  B.section(doc, t.titulo);
  if (!t.filas.length) {
    B.note(doc, t.vacio ?? 'Sin datos en el periodo.');
    return;
  }
  const cols = repartir(t.cols);
  B.thead(doc, cols);
  t.filas.forEach((fila, i) => {
    // El pie se estampa en FOOT_Y (800): pasar de ~745 mete la última fila debajo.
    if (doc.y > 745) {
      B.newPage(doc);
      B.thead(doc, cols);
    }
    const objetos = fila.map((cel) => (typeof cel === 'string' ? { t: cel } : cel));
    // El texto de la fila se dibuja primero; las celdas-medidor van vacías de texto
    // y se pintan encima, ya sabiendo dónde quedó la fila.
    const y = doc.y;
    B.trow(doc, cols, objetos.map((o, k) => ({
      ...o, t: o.bar != null ? '' : ajustar(doc, o.t ?? '', cols[k]?.w ?? B.WIDTH, o.bold),
    })), i);
    objetos.forEach((o, k) => {
      if (o.bar == null || !cols[k]) return;
      B.meter(doc, cols[k].x, y + 5.5, cols[k].w, o.bar);
    });
  });
  doc.moveDown(0.4);
}

/**
 * Tabla de distribución: etiqueta, medidor y cifra.
 *
 * Casi todos los bloques de estos reportes tienen esta forma ("por tipo", "por
 * estado", "por módulo", "por caja"…). Tenerla en un solo sitio evita que cada uno
 * elija sus propios anchos y que la mitad se queden sin medidor con el tiempo. El
 * medidor se calcula contra el MAYOR de la tabla, no contra el total: lo que se
 * compara aquí es unas filas con otras.
 */
function distribucion(
  titulo: string,
  etiqueta: string,
  unidad: string,
  /** [rótulo, valor que dibuja el medidor, dato secundario opcional]. */
  filas: [string, number, string?][],
  fmt: (n: number) => string = int,
  vacio?: string,
  /** Encabezado de la columna secundaria (si alguna fila la trae). */
  extra?: string,
): ReporteTabla {
  const max = filas.reduce((m, [, v]) => Math.max(m, Number(v) || 0), 0);
  // La columna secundaria solo aparece si de verdad hay dato: unificar el formato
  // de estas tablas no puede costar información que antes se veía (el recuento de
  // movimientos por caja, por ejemplo).
  const hayExtra = filas.some((f) => f[2] != null);
  const cols: ColSpec[] = hayExtra
    ? [
      { label: etiqueta, peso: 38 },
      { label: extra ?? '', peso: 12, align: 'right' },
      { label: '', peso: 26 },
      { label: corto(unidad, 14), peso: 24, align: 'right' },
    ]
    : [
      { label: etiqueta, peso: 46 },
      { label: '', peso: 30 },
      { label: corto(unidad, 14), peso: 24, align: 'right' },
    ];

  return {
    titulo,
    cols,
    filas: filas.map(([l, v, x]) => [
      corto(l, 60),
      ...(hayExtra ? [x ?? '—'] : []),
      { bar: max > 0 ? (Number(v) || 0) / max : 0 },
      { t: fmt(Number(v) || 0), bold: true },
    ]),
    vacio,
  };
}

/**
 * Dibuja el reporte. Los generadores del ERP escriben sobre el `Response` como
 * stream, nunca tocan cabeceras: por eso `pdfToBuffer` puede reutilizarlos tal cual
 * para adjuntarlos a un chat.
 */
export function reportPdf(res: Response, d: ReporteData) {
  const doc = B.newDoc(PDFDocument);
  doc.pipe(res);
  B.docHeader(doc, d.titulo, { right: d.periodo, chip: 'Reporte' });

  if (d.generadoPor) {
    doc.fillColor(B.INK_3).fontSize(8).font('Helvetica')
      .text(`Generado el ${dia(new Date())} para ${d.generadoPor}`, B.M, doc.y, { width: B.WIDTH });
    doc.x = B.M;
    doc.moveDown(0.6);
  }

  // Las cifras van en tarjetas, no en una rejilla etiqueta:valor — ver `B.stats`.
  if (d.resumen?.length) {
    B.section(doc, 'En cifras');
    B.stats(doc, d.resumen);
  }

  for (const t of d.tablas) tabla(doc, t);

  if (d.notas?.length) {
    B.section(doc, 'Cómo leer esto');
    // Las advertencias van dentro de un recuadro con fondo: sueltas al final, en
    // gris y a 7,5 pt, se leen como letra pequeña legal y nadie las mira — y aquí
    // es donde se dice qué NO mide cada reporte, que es lo que evita malentendidos.
    const alto = d.notas.reduce((h, n) => {
      doc.fontSize(7.5).font('Helvetica');
      return h + doc.heightOfString(`• ${n}`, { width: B.WIDTH - 24, align: 'justify' }) + 4;
    }, 12);
    if (doc.y + alto > 780) B.newPage(doc);
    const y0 = doc.y;
    doc.roundedRect(B.M, y0, B.WIDTH, alto, 4).fill('#f7fafd');
    doc.y = y0 + 6;
    for (const n of d.notas) {
      doc.fillColor(B.INK_3).fontSize(7.5).font('Helvetica')
        .text(`• ${n}`, B.M + 12, doc.y, { width: B.WIDTH - 24, align: 'justify' });
      doc.y += 4;
    }
    doc.x = B.M;
    doc.y = y0 + alto + 6;
  }

  B.finish(doc);
}

// ---------------------------------------------------------------------------
// Traductores: salida del servicio → forma del reporte. Uno por reporte.
// ---------------------------------------------------------------------------

/** Rótulo de periodo a partir de las fechas que se le pasaron al servicio. */
export function periodoLabel(desde?: string, hasta?: string): string {
  if (!desde && !hasta) return 'Histórico completo';
  if (desde && hasta) return `${diaRango(desde)} — ${diaRango(hasta)}`;
  return desde ? `Desde ${diaRango(desde)}` : `Hasta ${diaRango(hasta!)}`;
}

/**
 * Rendimiento de los técnicos de campo.
 *
 * Ordena por re-visita (peor primero) y NO por volumen, igual que el tablero: el
 * PDF no puede contar una historia distinta a la pantalla. Quien no tiene muestra
 * suficiente va al final y marcado — sus porcentajes no son interpretables y
 * mezclarlos con el resto es justo como se arruina una conversación de desempeño.
 */
export function tecnicosReporte(d: any): ReporteData {
  const eq = d.equipo;
  const orden = [...(d.tecnicos ?? [])].sort((a: any, b: any) => {
    if (a.muestraSuficiente !== b.muestraSuficiente) return a.muestraSuficiente ? -1 : 1;
    return (b.revisitaPct ?? -1) - (a.revisitaPct ?? -1);
  });

  return {
    titulo: 'Rendimiento de técnicos',
    periodo: `${diaRango(d.desde)} — ${diaRango(d.hasta)}`,
    resumen: eq
      ? [
        ['Técnicos', int(eq.tecnicos)],
        ['Con muestra', `${int(eq.conMuestra)} de ${int(eq.tecnicos)}`],
        ['Órdenes cerradas', int(eq.cerradas)],
        // Las etiquetas del bloque de cifras van CORTAS a propósito: la rejilla les
        // da 78 pt y una más larga se parte en dos líneas encima de la siguiente.
        ['Re-visita equipo', pct(eq.revisitaPct)],
        ['Mediana re-visita', pct(eq.medianaRevisita)],
        ['Mediana ciclo', eq.medianaCiclo == null ? '—' : `${eq.medianaCiclo} h`],
        ['Abiertas', int(eq.abiertas)],
        ['Vencidas', int(eq.vencidas)],
      ]
      : undefined,
    tablas: [{
      titulo: 'Por técnico',
      cols: [
        { label: 'Técnico', peso: 26 },
        { label: 'Asig.', peso: 8, align: 'right' },
        { label: 'Cerr.', peso: 8, align: 'right' },
        { label: 'Abiert.', peso: 9, align: 'right' },
        { label: 'Venc.', peso: 8, align: 'right' },
        { label: 'Re-visita', peso: 11, align: 'right' },
        { label: 'Ciclo', peso: 10, align: 'right' },
        { label: 'Evidencia', peso: 11, align: 'right' },
      ],
      filas: orden.map((t: any) => {
        // El nombre se recorta ANTES de pegarle los sufijos, y reservándoles su
        // sitio: si lo recortara el renderizador, lo primero en caerse sería el "*"
        // —que es justo la marca de "no saques conclusiones de este porcentaje"— y
        // no el apellido, que es lo que sí sobra.
        const sufijo = `${t.muestraSuficiente ? '' : ' *'}${t.activo ? '' : ' (inactivo)'}`;
        return [
        { t: `${corto(t.nombre, 30 - sufijo.length)}${sufijo}` },
        int(t.asignadas),
        int(t.cerradas),
        int(t.abiertas),
        { t: int(t.vencidas), color: t.vencidas > 0 ? B.BAD : undefined },
        {
          t: pct(t.revisitaPct),
          // Solo se colorea a quien tiene muestra: pintar de rojo un 33% que
          // salió de tres órdenes es señalar a alguien con ruido estadístico.
          color: !t.muestraSuficiente || t.revisitaPct == null || eq?.medianaRevisita == null
            ? undefined
            : t.revisitaPct > eq.medianaRevisita ? B.BAD : B.OK,
        },
        t.cicloHoras == null ? '—' : `${t.cicloHoras} h`,
        pct(t.evidenciaPct),
        ];
      }),
      vacio: 'Nadie tuvo órdenes de campo asignadas en el periodo.',
    }],
    notas: [
      'Solo cuenta el TRABAJO DE CAMPO. Los cortes y reconexiones automáticas (la mayor parte de las órdenes) quedan fuera a propósito: si entraran, esto sería un ranking de quién ejecuta más cortes desde un escritorio.',
      `La métrica que manda es la RE-VISITA: el % de órdenes cerradas en las que el mismo cliente volvió a quejarse dentro de ${eq?.ventanaRevisitaDias ?? 15} días. El volumen es contexto, no calificación.`,
      `Un "*" marca a quien cerró menos de ${eq?.muestraMinima ?? 5} órdenes: sus porcentajes no son interpretables y no entran en la mediana del equipo.`,
      `"Vencidas" son órdenes que siguen abiertas pasados ${eq?.diasVencimiento ?? 7} días. No es un SLA pactado: es el umbral a partir del cual vale la pena preguntar.`,
      `${int(d.sinAtribuir ?? 0)} orden(es) de campo del periodo no tienen técnico asignado: este reporte no puede evaluarlas.`,
      'Nada de esto califica a una persona. Son hechos y la mediana del equipo para poder leerlos; la conversación la tiene un jefe, no un tablero.',
    ],
  };
}

/** Recaudo del periodo, por caja y por método de pago. */
export function recaudoReporte(d: any, periodo: string): ReporteData {
  return {
    titulo: d.sede ? `Recaudo · ${d.sede}` : 'Recaudo',
    periodo,
    resumen: [['Total recaudado', cop(d.total)], ['Movimientos', int(d.count)]],
    tablas: [
      distribucion('Por caja', 'Caja', 'Total', (d.porCaja ?? []).map((r: any) => [r.caja, r.total, int(r.count)]), cop, undefined, 'Movim.'),
      distribucion('Por método de pago', 'Método', 'Total', (d.porMetodo ?? []).map((r: any) => [r.metodo, r.total, int(r.count)]), cop, undefined, 'Movim.'),
    ],
    notas: ['Solo ingresos VIGENTES: lo anulado no suma.',
      ...(d.notaSede ? [`${d.notaSede}${d.sinSede ? ` En este periodo, ${int(d.sinSede)} ingreso(s) sin abonado quedaron fuera.` : ''}`] : [])],
  };
}

/** Cartera: quién debe más. */
export function deudoresReporte(d: any): ReporteData {
  const items = d.items ?? [];
  const mayor = items.reduce((m: number, r: any) => Math.max(m, Number(r.balance) || 0), 0);
  return {
    titulo: d.sede ? `Mayores deudores · ${d.sede}` : 'Mayores deudores',
    periodo: 'Cartera vigente',
    resumen: [
      ['Deudores listados', int(items.length)],
      ['Deuda listada', cop(items.reduce((s: number, r: any) => s + (Number(r.balance) || 0), 0))],
    ],
    tablas: [{
      titulo: 'Top 30 por saldo',
      cols: [
        { label: '#', peso: 5, align: 'right' },
        { label: 'Abonado', peso: 11, align: 'right' },
        { label: 'Cliente', peso: 37 },
        { label: 'Facturas', peso: 11, align: 'right' },
        { label: '', peso: 16 },
        { label: 'Saldo', peso: 20, align: 'right' },
      ],
      // El medidor es lo que hace visible que el primero debe el triple que el
      // décimo: en una columna de cifras ordenada eso hay que restarlo de cabeza.
      filas: items.map((r: any, i: number) => [
        String(i + 1), int(r.abonado), corto(r.name, 40), int(r.facturas),
        { bar: mayor > 0 ? (Number(r.balance) || 0) / mayor : 0 },
        { t: cop(r.balance), bold: true },
      ]),
      vacio: 'No hay facturas pendientes.',
    }],
    notas: ['Suma el saldo de las facturas en estado DUE y PARTIAL. No incluye acuerdos de pago ni intereses.',
      ...(d.sede ? [`Solo abonados de la sede ${d.sede}.`] : [])],
  };
}

/** Base de clientes por estado y por sede. */
export function serviciosReporte(d: any): ReporteData {
  const estados = Object.entries(d.estados ?? {}) as [string, number][];
  return {
    titulo: 'Estadísticas de servicios',
    periodo: 'Foto de hoy',
    resumen: estados.map(([e, n]) => [e, int(n)] as [string, string]),
    tablas: [{
      titulo: 'Por sede',
      cols: [
        { label: 'Sede', peso: 40 },
        { label: 'Total', peso: 15, align: 'right' },
        { label: 'Activos', peso: 15, align: 'right' },
        { label: 'Cortados', peso: 15, align: 'right' },
        { label: 'Cartera', peso: 15, align: 'right' },
      ],
      filas: (d.porSede ?? []).map((r: any) => [
        corto(r.sede, 42), { t: int(r.total), bold: true }, int(r.activos), int(r.cortados), int(r.cartera),
      ]),
    }],
  };
}

/** Cortes, activaciones y bajas del periodo. */
export function cortesReporte(d: any, periodo: string): ReporteData {
  return {
    titulo: d.sede ? `Cortes y activaciones · ${d.sede}` : 'Cortes y activaciones',
    periodo,
    resumen: [
      ['Cortes', int(d.cortes)],
      ['Activaciones', int(d.activaciones)],
      ['Suspensiones', int(d.suspensiones)],
      ['Retiros', int(d.retiros)],
    ],
    tablas: [
      distribucion('Detalle por estado', 'Estado', 'Cambios', (d.detalle ?? []).map((r: any) => [r.estado, r.count])),
    ],
    notas: ['Sale del historial de estados del abonado: cuenta CAMBIOS, no personas. Un mismo cliente cortado y reconectado dos veces aparece cuatro veces.',
      ...(d.notaSede ? [d.notaSede] : [])],
  };
}

/** Órdenes de servicio del periodo: tipo, estado y quién las tiene. */
export function ordenesReporte(d: any, periodo: string): ReporteData {
  // `total` viene del servicio; el respaldo es por si algún llamador antiguo no lo trae.
  const total = d.total ?? (d.porEstado ?? []).reduce((s: number, r: any) => s + r.count, 0);
  return {
    // La sede va en el TÍTULO, no escondida en una nota: es lo primero que hay que
    // poder comprobar al recibir el archivo, sobre todo si se pidió de viva voz.
    titulo: d.sede ? `Órdenes de servicio · ${d.sede}` : 'Órdenes de servicio',
    periodo,
    resumen: [
      ['Órdenes', int(total)],
      ['Tipos distintos', int((d.porTipo ?? []).length)],
      ...(d.sede ? ([['Sede', String(d.sede)]] as [string, string][]) : []),
    ],
    tablas: [
      distribucion('Por estado', 'Estado', 'Órdenes', (d.porEstado ?? []).map((r: any) => [r.estado, r.count])),
      distribucion('Por tipo', 'Tipo', 'Órdenes', (d.porTipo ?? []).map((r: any) => [r.tipo, r.count])),
      distribucion('Por técnico asignado', 'Técnico', 'Órdenes', (d.porTecnico ?? []).map((r: any) => [r.tecnico, r.count]),
        int, 'Ninguna orden del periodo tiene técnico asignado.'),
    ],
    notas: [
      'Cuenta TODAS las órdenes, incluidos los cortes y reconexiones automáticas. Es volumen de trabajo, no rendimiento: para eso está el reporte de rendimiento de técnicos.',
      'El agrupado por técnico usa el texto del campo "asignado", así que un mismo técnico escrito de dos formas sale dos veces.',
      d.sede
        ? `La sede sale del ABONADO de cada orden, no de la orden. ${d.sinAbonado ? `${int(d.sinAbonado)} orden(es) del periodo no tienen abonado y por tanto no tienen sede: no están contadas aquí.` : 'Todas las órdenes del periodo tienen abonado, así que no falta ninguna por ese motivo.'}`
        : 'Sin filtro de sede: son las órdenes de TODAS las sedes.',
    ],
  };
}

/** Facturación por sede. */
export function ventasSedeReporte(d: any, periodo: string): ReporteData {
  const items = d.items ?? [];
  return {
    titulo: 'Ventas por sede',
    periodo,
    resumen: [
      ['Total facturado', cop(items.reduce((s: number, r: any) => s + (Number(r.total) || 0), 0))],
      ['Facturas', int(items.reduce((s: number, r: any) => s + (Number(r.facturas) || 0), 0))],
    ],
    tablas: [
      distribucion('Por sede', 'Sede', 'Facturado', items.map((r: any) => [r.sede, r.total, int(r.facturas)]), cop, undefined, 'Facturas'),
    ],
    notas: ['Es lo FACTURADO, no lo recaudado: incluye facturas que siguen sin pagar.'],
  };
}

/** Ingresos contra egresos, mes a mes. */
export function ingresosEgresosReporte(d: any): ReporteData {
  const items = d.items ?? [];
  const ing = items.reduce((s: number, r: any) => s + (Number(r.income) || 0), 0);
  const egr = items.reduce((s: number, r: any) => s + (Number(r.expense) || 0), 0);
  return {
    titulo: 'Ingresos y egresos',
    periodo: 'Últimos 12 meses con datos',
    resumen: [['Ingresos', cop(ing)], ['Egresos', cop(egr)], ['Balance', cop(ing - egr)]],
    tablas: [{
      titulo: 'Mes a mes',
      cols: [
        { label: 'Mes', peso: 25 },
        { label: 'Ingresos', peso: 25, align: 'right' },
        { label: 'Egresos', peso: 25, align: 'right' },
        { label: 'Balance', peso: 25, align: 'right' },
      ],
      filas: items.map((r: any) => [
        r.month, cop(r.income), cop(r.expense),
        { t: cop(r.balance), bold: true, color: r.balance < 0 ? B.BAD : B.OK },
      ]),
    }],
    notas: ['Solo movimientos de tesorería VIGENTES.'],
  };
}

/** Altas y retiros de clientes. */
export function movimientosReporte(d: any, periodo: string): ReporteData {
  return {
    titulo: d.sede ? `Movimiento de clientes · ${d.sede}` : 'Movimiento de clientes',
    periodo,
    resumen: [
      ['Altas', int(d.altas)],
      ['Retiros', int(d.retiros)],
      ['Neto', int(d.neto)],
    ],
    tablas: [{
      titulo: 'Resumen',
      cols: [{ label: 'Concepto', peso: 70 }, { label: 'Clientes', peso: 30, align: 'right' }],
      filas: [
        ['Altas del periodo', { t: int(d.altas), bold: true }],
        ['Retiros del periodo', { t: int(d.retiros), bold: true }],
        ['Neto', { t: int(d.neto), bold: true, color: Number(d.neto) < 0 ? B.BAD : B.OK }],
      ],
    }],
    notas: ['Las altas se cuentan por fecha de ingreso del abonado; los retiros, por el historial de estados.',
      ...(d.notaSede ? [d.notaSede] : [])],
  };
}

/** El tablero de dirección completo, en una hoja. */
export function resumenNegocioReporte(d: any): ReporteData {
  return {
    titulo: 'Resumen del negocio',
    periodo: 'Foto de hoy',
    resumen: [
      ['Abonados', int(d.clientes?.total)],
      ['Activos', int(d.clientes?.activos)],
      ['Cartera', cop(d.cartera?.total)],
      ['Fact. pendientes', int(d.cartera?.facturas)],
      ['Ingresos', cop(d.tesoreria?.ingresos)],
      ['Egresos', cop(d.tesoreria?.egresos)],
      ['Órdenes pend.', int(d.soporte?.pendientes)],
      ['Inventario', cop(d.inventario?.valor)],
    ],
    tablas: [
      distribucion('Edad de la cartera', 'Tramo', 'Saldo', [
        ['Corriente (hasta 30 días)', d.cartera?.aging?.corriente ?? 0],
        ['31 a 60 días', d.cartera?.aging?.d31_60 ?? 0],
        ['61 a 90 días', d.cartera?.aging?.d61_90 ?? 0],
        ['Más de 90 días', d.cartera?.aging?.d90 ?? 0],
      ], cop),
      distribucion('Ventas por sede', 'Sede', 'Facturado',
        (d.ventasPorSede ?? []).map((r: any) => [r.sede, r.total, int(r.abonados)]), cop, undefined, 'Abonados'),
      distribucion('Mayores deudores', 'Cliente', 'Saldo',
        (d.topDeudores ?? []).map((r: any) => [r.name, r.balance]), cop),
      distribucion('Órdenes por tipo', 'Tipo', 'Órdenes',
        (d.ordenesPorTipo ?? []).map((r: any) => [r.type, r.count])),
    ],
    notas: ['Las cifras de tesorería y facturación son acumuladas históricas, no del mes.'],
  };
}

/** Resumen de facturación: qué se emitió, qué se pagó y qué quedó debiendo. */
export function facturacionReporte(d: any, periodo: string): ReporteData {
  return {
    titulo: 'Resumen de facturación',
    periodo: d.periodo ?? periodo,
    resumen: [
      ['Facturas', int(d.total)],
      ['Facturado', cop(d.facturadoTotal)],
      ['Pagadas', int(d.pagadas)],
      ['Pendientes', int(d.pendientes)],
      ['Parciales', int(d.parciales)],
      ['Cartera', cop(d.carteraTotal)],
    ],
    tablas: [{
      titulo: 'Por estado',
      cols: [{ label: 'Estado', peso: 70 }, { label: 'Facturas', peso: 30, align: 'right' }],
      filas: Object.entries(d.status ?? {}).map(([estado, n]) => [corto(estado, 70), { t: int(n as number), bold: true }]),
    }],
    notas: [
      'Las facturas emitidas se cuentan en el periodo pedido; la CARTERA es histórica completa (el saldo que sigue debiéndose venga de donde venga), así que no cuadra contra lo facturado del periodo. Es a propósito.',
    ],
  };
}

/**
 * Reporte de IVA para la declaración.
 *
 * Se listan como mucho 150 documentos: el detalle completo puede ser de miles de
 * filas y un PDF de 80 páginas por WhatsApp no lo abre nadie. Los TOTALES y el
 * resumen por tarifa sí salen del universo entero, que es lo que se declara; el
 * listado es de apoyo y se avisa cuando está recortado.
 */
export function ivaReporte(d: any, periodo: string): ReporteData {
  const items = d.items ?? [];
  const TOPE = 150;
  const t = d.totales ?? {};
  return {
    titulo: `Reporte de IVA · ${d.tipo === 'compras' ? 'Compras' : 'Ventas'}${d.sede ? ` · ${d.sede}` : ''}`,
    periodo,
    resumen: [
      ['Documentos', int(t.documentos)],
      ['Base gravable', cop(t.baseGravable)],
      ['Base exenta', cop(t.baseExenta)],
      ['IVA', cop(t.iva)],
      ['Ajustes (NC/ND)', cop(t.ajustes)],
      ['Retención', cop(t.retencion)],
      ['Total', cop(t.total)],
    ],
    tablas: [
      {
        titulo: 'Por tarifa',
        cols: [
          { label: 'Tarifa', peso: 20, align: 'right' },
          { label: 'Documentos', peso: 20, align: 'right' },
          { label: 'Base', peso: 30, align: 'right' },
          { label: 'IVA', peso: 30, align: 'right' },
        ],
        filas: (d.porTarifa ?? []).map((r: any) => [
          `${r.tarifa}%`, int(r.documentos), cop(r.base), { t: cop(r.iva), bold: true },
        ]),
      },
      {
        titulo: `Detalle por documento${items.length > TOPE ? ` (primeros ${TOPE} de ${int(items.length)})` : ''}`,
        cols: [
          { label: 'N°', peso: 9, align: 'right' },
          { label: 'Fecha', peso: 13 },
          { label: 'Tercero', peso: 32 },
          { label: 'Base grav.', peso: 16, align: 'right' },
          { label: 'Exenta', peso: 14, align: 'right' },
          { label: 'IVA', peso: 16, align: 'right' },
        ],
        filas: items.slice(0, TOPE).map((r: any) => [
          int(r.numero), diaCorto(r.fecha), corto(r.tercero, 40), cop(r.baseGravable), cop(r.baseExenta),
          { t: cop(r.iva), bold: true },
        ]),
      },
    ],
    notas: [
      'Excluye los documentos ANULADOS y aísla las notas crédito/débito en "Ajustes", para que no contaminen la base gravable.',
      ...(d.sedeIgnorada
        ? ['OJO: se pidió filtrar por sede, pero este reporte es de COMPRAS y una compra es a un proveedor, que no pertenece a ninguna sede. Lo que ves NO está filtrado por sede.']
        : []),
      items.length > TOPE
        ? `El listado muestra solo los primeros ${TOPE} documentos, pero los totales y el resumen por tarifa cubren los ${int(items.length)} del periodo. Para el detalle completo, expórtalo desde el ERP.`
        : 'El listado cubre todos los documentos del periodo.',
    ],
  };
}

/** Recaudo por funcionario: cuánto entró por manos de cada quien. */
export function recaudoFuncionarioReporte(d: any): ReporteData {
  return {
    titulo: 'Recaudo por funcionario',
    periodo: `${diaRango(d.desde)} — ${diaRango(d.hasta)}`,
    resumen: [
      ['Total recaudado', cop(d.total)],
      ['Movimientos', int(d.movimientos)],
      ['Funcionarios', int((d.funcionarios ?? []).length)],
    ],
    tablas: [
      {
        titulo: 'Por funcionario',
        cols: [
          { label: 'Funcionario', peso: 34 },
          { label: 'Movim.', peso: 13, align: 'right' },
          { label: 'Promedio', peso: 17, align: 'right' },
          { label: 'Total', peso: 22, align: 'right' },
          { label: 'Partic.', peso: 14, align: 'right' },
        ],
        filas: (d.funcionarios ?? []).map((f: any) => [
          corto(`${f.nombre}${f.activo === false ? ' (inactivo)' : ''}`, 34),
          int(f.movimientos), cop(f.promedio), { t: cop(f.total), bold: true }, `${f.participacion}%`,
        ]),
        vacio: 'Ningún ingreso del periodo tiene funcionario identificado.',
      },
      {
        titulo: 'Por método de pago',
        cols: [{ label: 'Método', peso: 55 }, { label: 'Movim.', peso: 15, align: 'right' }, { label: 'Total', peso: 30, align: 'right' }],
        filas: (d.porMetodo ?? []).map((r: any) => [corto(r.metodo, 60), int(r.movimientos), { t: cop(r.total), bold: true }]),
      },
      {
        titulo: 'Por caja',
        cols: [{ label: 'Caja', peso: 55 }, { label: 'Movim.', peso: 15, align: 'right' }, { label: 'Total', peso: 30, align: 'right' }],
        filas: (d.porCaja ?? []).map((r: any) => [corto(r.caja, 60), int(r.movimientos), { t: cop(r.total), bold: true }]),
      },
    ],
    notas: [
      'Solo ingresos VIGENTES con emisor identificado: una transacción anulada no se le abona a nadie.',
      'Un "Emisor N" sin nombre es plata que sí se recaudó pero cuyo usuario no cruza contra la ficha de personal. Se muestra en vez de esconderse: ocultarla descuadraría el total.',
      'Esto mide por dónde ENTRÓ la plata, no el desempeño de nadie: quien atiende la caja principal siempre saldrá arriba.',
    ],
  };
}

/**
 * Anulaciones. El número que importa no es cuántas, sino el hueco entre el cobro
 * y su anulación: anular algo del mismo día es operación normal.
 */
export function anulacionesReporte(d: any): ReporteData {
  const casos = d.casos ?? [];
  const TOPE = 120;
  return {
    titulo: d.sede ? `Anulaciones (control) · ${d.sede}` : 'Anulaciones (control)',
    periodo: `${diaRango(d.desde)} — ${diaRango(d.hasta)}`,
    resumen: [
      ['Anulaciones', int(d.total)],
      ['Monto anulado', cop(d.monto)],
      ['Tasa', `${d.tasaPct}% de ${int(d.movimientosPeriodo)}`],
      ['Tardías (+7 días)', `${int(d.tardias?.total)} · ${cop(d.tardias?.monto)}`],
    ],
    tablas: [
      {
        titulo: 'Por funcionario',
        cols: [
          { label: 'Funcionario', peso: 42 },
          { label: 'Anulac.', peso: 14, align: 'right' },
          { label: 'Monto', peso: 26, align: 'right' },
          { label: 'Peor demora', peso: 18, align: 'right' },
        ],
        filas: (d.porQuien ?? []).map((r: any) => [
          corto(r.quien, 42), int(r.n), { t: cop(r.monto), bold: true },
          { t: `${int(r.maxDias)} d`, color: r.maxDias > 7 ? B.BAD : undefined },
        ]),
        vacio: 'No hubo anulaciones en el periodo.',
      },
      {
        titulo: `Casos${casos.length > TOPE ? ` (primeros ${TOPE} de ${int(casos.length)})` : ''}`,
        // El MOTIVO se lleva la cuarta parte del ancho: es el dato por el que se
        // pide este reporte. Recortado a "Eliminado…" no sirve para nada, y los
        // nombres de funcionario y cliente sí toleran ir más justos.
        cols: [
          { label: 'Anulada', peso: 12 },
          { label: 'Quién', peso: 16 },
          { label: 'Cliente / pagador', peso: 21 },
          { label: 'Monto', peso: 15, align: 'right' },
          { label: 'Días', peso: 7, align: 'right' },
          { label: 'Motivo', peso: 29 },
        ],
        filas: casos.slice(0, TOPE).map((c: any) => [
          diaCorto(c.fecha), corto(c.quien, 20), corto(c.cliente?.nombre ?? c.pagador ?? '—', 26),
          { t: cop(c.monto), bold: true },
          { t: c.diasDespues == null ? '—' : int(c.diasDespues), color: (c.diasDespues ?? 0) > 7 ? B.BAD : undefined },
          corto(c.motivo ?? '—', 36),
        ]),
      },
    ],
    notas: [
      'La fecha es la de la ANULACIÓN, no la del movimiento original. "Días" es el hueco entre uno y otro: anular algo del mismo día es corrección normal; anular un recibo de hace tres meses no.',
      'Se marcan en rojo los que pasan de 7 días, que son los que ameritan mirarse de a uno.',
      'El listado trae como mucho las 500 anulaciones más recientes del periodo; si hay más, los agregados también salen de esas 500.',
      ...(d.notaSede ? [d.notaSede] : []),
    ],
  };
}

/** Actividad en el sistema, desde la bitácora de auditoría. */
export function actividadReporte(d: any): ReporteData {
  const eventos = d.eventos ?? [];
  const TOPE = 120;
  return {
    titulo: 'Actividad en el sistema',
    periodo: `${diaRango(d.desde)} — ${diaRango(d.hasta)}`,
    resumen: [
      ['Eventos', int(d.total)],
      ['Usuarios', int((d.porUsuario ?? []).length)],
      ['Módulos', int((d.porModulo ?? []).length)],
    ],
    tablas: [
      distribucion('Por usuario', 'Usuario', 'Eventos', (d.porUsuario ?? []).map((r: any) => [r.nombre, r.eventos]),
        int, 'No hay actividad registrada en el periodo.'),
      distribucion('Por módulo', 'Módulo', 'Eventos', (d.porModulo ?? []).map((r: any) => [r.modulo, r.eventos])),
      distribucion('Operaciones más frecuentes', 'Operación', 'Eventos', (d.porOperacion ?? []).map((r: any) => [r.operacion, r.eventos])),
      {
        titulo: `Últimos eventos${eventos.length > TOPE ? ` (${TOPE} de ${int(eventos.length)})` : ''}`,
        cols: [
          { label: 'Fecha', peso: 14 },
          { label: 'Usuario', peso: 26 },
          { label: 'Módulo', peso: 18 },
          { label: 'Operación', peso: 30 },
          { label: 'IP', peso: 12 },
        ],
        filas: eventos.slice(0, TOPE).map((e: any) => [
          diaCorto(e.fecha), corto(e.usuario, 30), corto(e.modulo, 22), corto(e.operacion, 36), corto(e.ip ?? '—', 15),
        ]),
      },
    ],
    notas: [
      'ADVERTENCIA: la bitácora solo registra unas pocas entidades, así que esto NO es todo lo que hizo el equipo. Sirve para rastrear cambios sobre lo que sí se audita, NUNCA para medir productividad ni comparar personas.',
      '"Sistema (automático)" son eventos sin usuario (cron, webhooks). Se etiquetan en vez de omitirse para que los totales cuadren.',
      d.truncado
        ? 'OJO: se alcanzó el tope de lectura de la bitácora, así que hay eventos del periodo que NO están contados. Pide un rango más corto.'
        : 'El periodo cabe entero en la bitácora: no falta ningún evento por tope.',
    ],
  };
}

/**
 * Detalle de UN técnico: el desglose por tipo de trabajo y las órdenes que sí
 * trajeron queja. Es la parte accionable — un porcentaje no se puede revisar, una
 * orden sí.
 */
export function tecnicoDetalleReporte(d: any, nombre: string): ReporteData {
  const r = d.resumen;
  const casos = d.casos ?? [];
  return {
    titulo: `Detalle de técnico · ${nombre}`,
    periodo: `${diaRango(d.desde)} — ${diaRango(d.hasta)}`,
    resumen: r
      ? [
        ['Asignadas', int(r.asignadas)],
        ['Cerradas', int(r.cerradas)],
        ['Re-visita', pct(r.revisitaPct)],
        ['Mediana equipo', pct(d.equipo?.medianaRevisita)],
        ['Abiertas', int(r.abiertas)],
        ['Vencidas', int(r.vencidas)],
        ['Con evidencia', pct(r.evidenciaPct)],
        ['Con firma', pct(r.firmaPct)],
      ]
      : undefined,
    tablas: [
      {
        titulo: 'Por tipo de trabajo',
        cols: [
          { label: 'Tipo', peso: 50 },
          { label: 'Cerradas', peso: 20, align: 'right' },
          { label: 'Re-visitas', peso: 15, align: 'right' },
          { label: '%', peso: 15, align: 'right' },
        ],
        filas: (d.porTipo ?? []).map((t: any) => [
          corto(t.tipo, 55), int(t.cerradas), int(t.revisitas), { t: pct(t.revisitaPct), bold: true },
        ]),
        vacio: 'No cerró órdenes de campo en el periodo.',
      },
      {
        titulo: 'Órdenes que trajeron queja',
        cols: [
          { label: 'Orden', peso: 11, align: 'right' },
          { label: 'Fecha', peso: 14 },
          { label: 'Tipo', peso: 23 },
          { label: 'Cliente', peso: 30 },
          { label: 'Volvió por', peso: 22 },
        ],
        filas: casos.map((c: any) => [
          c.code == null ? '—' : int(c.code), diaCorto(c.fecha), corto(c.tipo, 26),
          corto(c.cliente ?? (c.abonado ? `Abonado ${c.abonado}` : '—'), 34), corto(c.queja, 26),
        ]),
        vacio: 'Ninguna de sus órdenes cerradas trajo una queja del mismo cliente. Es la mejor noticia posible de este reporte.',
      },
    ],
    notas: [
      'El desglose por tipo es lo que convierte un porcentaje en algo accionable: casi siempre el problema no es el técnico entero, sino UN tipo de trabajo suyo.',
      'Cada orden listada es revisable de a una. Ese es el punto: se mira el caso, no la nota.',
      r && !r.muestraSuficiente
        ? 'OJO: cerró muy pocas órdenes en el periodo, así que sus porcentajes NO son interpretables. No saques conclusiones de aquí.'
        : 'Los casos son de órdenes de campo cerradas dentro del periodo pedido.',
    ],
  };
}

/**
 * Tendencia de un indicador, con su comparación contra el periodo anterior.
 *
 * Es el único reporte que puede salir VACÍO por un motivo legítimo —que no haya
 * histórico de esa métrica todavía— y por eso el hueco se explica en el propio
 * documento en vez de entregar una hoja con una tabla en blanco.
 */
export function tendenciaReporte(d: any, periodo: string): ReporteData {
  const serie: any[] = d.serie ?? [];
  const c = d.comparacion ?? {};
  const dinero = !!c.esDinero;
  const fmt = (v: number | null | undefined) => (v == null ? '—' : dinero ? cop(v) : int(v));
  const esEstado = d.noSumable === true;
  const valorPeriodo = esEstado ? serie.at(-1)?.valor ?? null : serie.reduce((s2: number, p: any) => s2 + p.valor, 0);

  return {
    titulo: `Tendencia · ${d.etiqueta ?? d.metrica}`,
    periodo,
    resumen: [
      [esEstado ? 'Último periodo' : 'Total del periodo', fmt(valorPeriodo)],
      ['Periodo anterior', fmt(c.a?.valor)],
      ['Variación', c.variacionPct == null ? '—' : `${c.variacionPct > 0 ? '+' : ''}${c.variacionPct}%`],
      ['Periodos con datos', int(serie.length)],
    ],
    tablas: [
      distribucion('Evolución', 'Periodo', d.etiqueta ?? 'Valor',
        serie.map((p: any) => [p.fecha.endsWith('-01') ? p.fecha.slice(0, 7) : p.fecha, p.valor]),
        dinero ? cop : int,
        'No hay histórico de este indicador en el periodo elegido.'),
      {
        titulo: 'Desde cuándo hay datos',
        cols: [
          { label: 'Indicador', peso: 42 },
          { label: 'Desde', peso: 16 },
          { label: 'Hasta', peso: 16 },
          { label: 'Origen', peso: 26 },
        ],
        filas: (d.cobertura ?? []).map((r: any) => [
          corto(r.etiqueta, 46), r.desde, r.hasta,
          { t: r.reconstruible ? 'Reconstruido' : 'Foto diaria', color: r.reconstruible ? B.OK : undefined },
        ]),
      },
    ],
    notas: [
      c.aviso ?? 'La comparación es contra el periodo inmediatamente anterior de la misma duración.',
      'Los indicadores marcados "Reconstruido" salen de documentos con fecha propia y auditable (facturas, movimientos de caja, altas, órdenes): su pasado es fiable.',
      'Los marcados "Foto diaria" solo existen desde que se empezó a medir. Su pasado NO se puede reconstruir porque el historial de estados del ERP no registró todos los cambios, y una reconstrucción daría una cifra con aspecto de exacta y un 12% de desvío.',
    ],
  };
}

// ── Reportes propios de un ISP ──────────────────────────────────────────────

/** De lo que se factura, cuánto entra. Ver `IspReportsService.indiceRecaudo`. */
export function indiceRecaudoReporte(d: any, periodo: string): ReporteData {
  const t = d.totales ?? {};
  return {
    titulo: d.sede ? `Índice de recaudo · ${d.sede}` : 'Índice de recaudo',
    periodo,
    resumen: [
      ['Facturado', cop(t.facturado)],
      ['Recaudado', cop(t.recaudado)],
      ['Índice', pct(t.indice)],
      ['Diferencia', cop(t.diferencia)],
    ],
    tablas: [{
      titulo: 'Mes a mes',
      cols: [
        { label: 'Mes', peso: 16 },
        { label: 'Facturado', peso: 24, align: 'right' },
        { label: 'Recaudado', peso: 24, align: 'right' },
        { label: 'Diferencia', peso: 22, align: 'right' },
        { label: 'Índice', peso: 14, align: 'right' },
      ],
      filas: (d.items ?? []).map((r: any) => [
        r.mes, cop(r.facturado), cop(r.recaudado),
        { t: cop(r.diferencia), color: r.diferencia < 0 ? B.BAD : B.OK },
        { t: pct(r.indice), bold: true },
      ]),
    }],
    notas: [
      'El índice PUEDE pasar del 100% y no es un error: el recaudo de un mes incluye pagos de facturas viejas. Por encima de 100 se está recuperando cartera; varios meses por debajo significa que la cartera crece.',
      'Solo cuenta ingresos VIGENTES y facturas no anuladas.',
    ],
  };
}

/** Cuánto deja cada cliente al mes. */
export function arpuReporte(d: any, periodo: string): ReporteData {
  const r = d.resumen ?? {};
  return {
    titulo: d.sede ? `ARPU · ${d.sede}` : 'ARPU — ingreso medio por abonado',
    periodo,
    resumen: [
      ['ARPU recaudado', cop(r.arpuActual)],
      ['ARPU facturado', cop(r.arpuFacturadoActual)],
      ['Abonados', int(r.abonadosActual)],
      ['Variación del periodo', r.variacionPct == null ? '—' : `${r.variacionPct > 0 ? '+' : ''}${r.variacionPct}%`],
    ],
    tablas: [{
      titulo: 'Mes a mes',
      cols: [
        { label: 'Mes', peso: 18 },
        { label: 'Abonados', peso: 18, align: 'right' },
        { label: 'ARPU facturado', peso: 32, align: 'right' },
        { label: 'ARPU recaudado', peso: 32, align: 'right' },
      ],
      filas: (d.items ?? []).map((x: any) => [
        x.mes, int(x.abonados), cop(x.arpuFacturado), { t: cop(x.arpuRecaudado), bold: true },
      ]),
    }],
    notas: [
      'El divisor son los abonados DISTINTOS facturados en el mes, no los "activos": el estado activo de un mes pasado no se puede reconstruir de forma fiable, mientras que a quién se le facturó sale de las facturas y es auditable.',
      'El ARPU recaudado puede superar al facturado cuando se cobra cartera atrasada.',
    ],
  };
}

/** Dónde se puede conectar sin obra. */
export function capacidadRedReporte(d: any): ReporteData {
  const r = d.resumen ?? {};
  return {
    titulo: d.sede ? `Capacidad de red · ${d.sede}` : 'Capacidad de red (NAPs)',
    periodo: 'Foto de hoy',
    resumen: [
      ['Puertos libres', int(r.libres)],
      ['Puertos ocupados', int(r.ocupados)],
      ['Ocupación', pct(r.ocupacionPct)],
      ['NAPs llenas', int(r.saturadas)],
      ['NAPs casi llenas', int(r.casiLlenas)],
      ['NAPs sin inventario', int(r.sinInventario)],
    ],
    tablas: [
      distribucion('Puertos libres por sede', 'Sede', 'Libres',
        (d.porSede ?? []).map((x: any) => [x.sede, x.libres, int(x.saturadas)]),
        int, undefined, 'Llenas'),
      {
        titulo: 'NAPs llenas o casi llenas (ampliar primero)',
        cols: [
          { label: 'NAP', peso: 22 },
          { label: 'Sede', peso: 18 },
          { label: 'Dirección', peso: 30 },
          { label: 'Ocupados', peso: 15, align: 'right' },
          { label: 'Libres', peso: 15, align: 'right' },
        ],
        filas: (d.criticas ?? []).map((n: any) => [
          corto(n.nap, 24), corto(n.sede, 20), corto(n.direccion ?? '—', 34), int(n.ocupados),
          { t: int(n.libres), color: n.libres === 0 ? B.BAD : undefined, bold: true },
        ]),
        vacio: 'Ninguna NAP está llena ni por encima del 90%.',
      },
    ],
    notas: [
      'Se ordena por CUÁNTOS clientes hay colgando, no por porcentaje: una NAP de un solo puerto ocupado da 100% pero no le bloquea una venta a nadie.',
      `${int(r.sinInventario)} NAP(s) no tienen ni un puerto registrado: no se sabe si están llenas o vacías, y NO se cuentan como disponibles. Es trabajo de inventario pendiente, no capacidad.`,
    ],
  };
}

/** Quién entra en ciclo de corte y reconexión. */
export function reincidenciaReporte(d: any, periodo: string): ReporteData {
  const r = d.resumen ?? {};
  return {
    titulo: d.sede ? `Reincidencia de cortes · ${d.sede}` : 'Reincidencia de cortes y reconexiones',
    periodo,
    resumen: [
      ['Clientes con reconexión', int(r.clientes)],
      ['Reconexiones', int(r.reconexiones)],
      ['Cortes', int(r.cortes)],
      ['Crónicos (3 o más)', int(r.cronicos)],
      ['Deuda de los crónicos', cop(r.deudaCronicos)],
    ],
    tablas: [
      distribucion('Cuántas veces se les reconectó', 'Reconexiones en el periodo', 'Clientes',
        (d.distribucion ?? []).map((x: any) => [`${x.veces} vez/veces`, x.clientes])),
      {
        titulo: 'Los 100 con más reconexiones',
        cols: [
          { label: 'Cliente', peso: 30 },
          { label: 'Abonado', peso: 12, align: 'right' },
          { label: 'Sede', peso: 16 },
          { label: 'Estado', peso: 14 },
          { label: 'Reconex.', peso: 12, align: 'right' },
          { label: 'Debe', peso: 16, align: 'right' },
        ],
        filas: (d.items ?? []).map((c: any) => [
          corto(c.cliente, 32), int(c.abonado), corto(c.sede, 18), corto(c.estado, 14),
          { t: int(c.reconexiones), bold: true },
          { t: cop(c.deuda), color: c.deuda > 0 ? B.BAD : undefined },
        ]),
        vacio: 'No hubo reconexiones en el periodo.',
      },
    ],
    notas: [
      'Un cliente que se corta y reconecta todos los meses es un problema de COBRANZA, no técnico: cambiarle el equipo no lo arregla. Por eso se muestra al lado lo que debe.',
      'El resumen y la distribución salen de TODOS los clientes del periodo; la tabla de abajo es solo una muestra de los 100 con más reconexiones.',
    ],
  };
}

/** De los que entraron cada año, cuántos siguen. */
export function permanenciaReporte(d: any): ReporteData {
  const r = d.resumen ?? {};
  return {
    titulo: d.sede ? `Permanencia de clientes · ${d.sede}` : 'Antigüedad y permanencia de clientes',
    periodo: 'Foto de hoy',
    resumen: [
      ['Antigüedad media', `${Math.round((r.antiguedadMediaMeses ?? 0) / 12 * 10) / 10} años`],
      ['Cohortes medidas', int(r.cohortes)],
      ['Sin fecha de ingreso', int(r.sinFechaIngreso)],
    ],
    tablas: [
      {
        titulo: 'Por año de ingreso: cuántos siguen',
        cols: [
          { label: 'Año', peso: 14 },
          { label: 'Entraron', peso: 18, align: 'right' },
          { label: 'Siguen activos', peso: 22, align: 'right' },
          { label: 'Retirados', peso: 18, align: 'right' },
          { label: 'Retención', peso: 16, align: 'right' },
          { label: '', peso: 12 },
        ],
        filas: (d.cohortes ?? []).map((c: any) => [
          c.anio, int(c.ingresaron), int(c.activos), int(c.retirados),
          { t: pct(c.retencionPct), bold: true },
          { bar: (c.retencionPct ?? 0) / 100 },
        ]),
      },
      distribucion('Antigüedad de los clientes activos', 'Tramo', 'Clientes',
        (d.antiguedad ?? []).map((a: any) => [a.tramo, a.clientes])),
    ],
    notas: [
      'Mide supervivencia HASTA HOY, no la curva de abandono mes a mes: se sabe quién sigue, pero no cuándo se fue exactamente (eso exigiría el historial de estados, que en esta base no es fiable).',
      `${int(r.sinFechaIngreso)} abonado(s) no tienen fecha de ingreso y quedan fuera de las cohortes.`,
      'Las cohortes recientes tienen retención alta por definición: han tenido menos tiempo para irse. Compara años con años completos.',
    ],
  };
}
