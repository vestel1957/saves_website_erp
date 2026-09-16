/**
 * Informe forense de la cuenta 14 «PAYU» — todos los años (2022–2025).
 *
 * Lee de la base de Nexus (PostgreSQL `saves_vestel`), no del legacy: los datos
 * migrados coinciden movimiento por movimiento con `admin_vestel.transactions`,
 * y así el informe se puede regenerar sin depender del MySQL viejo.
 *
 * Uso:  npx ts-node --transpile-only scripts/informe-forense-payu.ts [salida.pdf]
 *
 * Se viste con el kit de marca de `src/common/pdf/brand.ts` —el mismo membrete con
 * logo, el mismo navy y el mismo pie que el recibo, la factura y el cierre de caja—,
 * así que si la marca cambia, este informe cambia con ella. El rojo `BAD` del kit
 * queda reservado para las cifras del desvío: es lo único que no es azul de marca,
 * y aquí significa algo.
 *
 * Maquetación: flujo continuo. Ni saltos de página decorativos ni filas de relleno;
 * una página nueva se abre sólo cuando lo que sigue no cabe, ningún título queda
 * huérfano al pie y ninguna celda se parte en dos renglones.
 */
import PDFDocument from 'pdfkit';
import { createWriteStream } from 'fs';
import { PrismaClient } from '@prisma/client';
import {
  newDoc, docHeader, section, stats, note, newPage, finish,
  M, RIGHT, WIDTH, NAVY, BRAND, BRAND_2, BRAND_SOFT,
  INK, INK_2, INK_3, LINE, ZEBRA, BAD, EMPRESA,
} from '../src/common/pdf/brand';

const prisma = new PrismaClient();
const OUT = process.argv[2] ?? 'informe-forense-payu.pdf';

/* --------------------------------------------------------------- utilidades */

const cop = (v: number | string) => '$' + Math.round(Number(v)).toLocaleString('es-CO');
const num = (v: number | string) => Number(v).toLocaleString('es-CO');
const pctS = (v: number) => v.toFixed(1).replace('.', ',') + ' %';

const MESES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];

type Doc = PDFKit.PDFDocument;
type Celda = string | number | { t: string; color?: string; bold?: boolean };
type Colu = { label: string; x: number; w: number; align: 'left' | 'right' };

/** Columnas al estilo del kit a partir de anchos: calcula la x de cada una. */
function cols(defs: [string, number, ('left' | 'right')?][]): Colu[] {
  let x = M;
  return defs.map(([label, w, align]) => {
    const c: Colu = {
      label, x,
      w: w - (align === 'right' ? 8 : 4),
      align: align ?? 'left',
    };
    x += w;
    return c;
  });
}

/** Abre página si lo que viene (alto `h`) no cabe. Evita títulos huérfanos. */
function need(doc: Doc, h: number) {
  if (doc.y + h > 770) newPage(doc);
}

/** Cabecera navy del kit, compacta y con guarda de página. */
function head(doc: Doc, c: Colu[], altoTabla = 60) {
  need(doc, 16 + altoTabla);
  const y = doc.y;
  doc.rect(M, y, WIDTH, 15).fill(NAVY);
  doc.fillColor('#ffffff').fontSize(7).font('Helvetica-Bold');
  for (const col of c) {
    doc.text(col.label.toUpperCase(), col.x, y + 4.6,
      { width: col.w, align: col.align, characterSpacing: 0.3, lineBreak: false });
  }
  doc.x = M;
  doc.y = y + 15;
}

/** Fila compacta: un renglón, cebra del kit, nada que se parta. */
function row(doc: Doc, c: Colu[], celdas: Celda[], i: number, h = 13.5): number {
  need(doc, h + 2);
  const y = doc.y;
  if (i % 2 === 1) doc.rect(M, y, WIDTH, h).fill(ZEBRA);
  c.forEach((col, k) => {
    const cel = celdas[k] ?? '';
    const o = cel !== null && typeof cel === 'object' ? cel : { t: String(cel) };
    doc.font(o.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(7.8)
      .fillColor(o.color ?? INK_2)
      .text(String(o.t), col.x, y + 3.7,
        { width: col.w, align: col.align, ellipsis: true, lineBreak: false });
  });
  doc.x = M;
  doc.y = y + h;
  doc.moveTo(M, doc.y).lineTo(RIGHT, doc.y).lineWidth(0.4).strokeColor(LINE).stroke();
  return y;
}

/** Barra proporcional dentro de la propia fila. */
function barra(doc: Doc, x: number, y: number, w: number, color: string) {
  if (w > 0) doc.rect(x, y + 4.4, w, 5).fill(color);
}

function parr(doc: Doc, texto: string) {
  doc.font('Helvetica').fontSize(8.4).fillColor(INK_2);
  need(doc, doc.heightOfString(texto, { width: WIDTH, align: 'justify' }) + 4);
  doc.text(texto, M, doc.y, { width: WIDTH, align: 'justify' });
  doc.x = M;
  doc.y += 3;
}

/** Recuadro de aviso. Azul de marca por defecto; rojo sólo para el desvío. */
function caja(doc: Doc, kicker: string, lineas: string[], tono: 'marca' | 'alerta' = 'marca') {
  const bg = tono === 'marca' ? BRAND_SOFT : '#fdf0ee';
  const bd = tono === 'marca' ? BRAND_2 : BAD;
  doc.font('Helvetica').fontSize(8);
  const alto = lineas.reduce(
    (a, t) => a + doc.heightOfString(t, { width: WIDTH - 22, align: 'justify' }) + 3, 0) + 20;
  need(doc, alto + 8);
  const y = doc.y + 5;
  doc.roundedRect(M, y, WIDTH, alto, 3).fill(bg);
  doc.rect(M, y + 3, 2.6, alto - 6).fill(bd);
  doc.font('Helvetica-Bold').fontSize(6.6).fillColor(bd)
    .text(kicker.toUpperCase(), M + 11, y + 6,
      { width: WIDTH - 22, characterSpacing: 0.8, lineBreak: false });
  let yy = y + 15;
  for (const t of lineas) {
    doc.font('Helvetica').fontSize(8).fillColor(INK_2);
    doc.text(t, M + 11, yy, { width: WIDTH - 22, align: 'justify' });
    yy = doc.y + 3;
  }
  doc.x = M;
  doc.y = y + alto + 6;
}

/* -------------------------------------------------------------------- datos */

async function datos() {
  const sql = prisma.$queryRawUnsafe.bind(prisma);

  const porAnio: any[] = await sql(`
    SELECT EXTRACT(YEAR FROM date)::int AS anio, COUNT(*)::int n,
           SUM(credit)::float monto, COUNT(DISTINCT "subscriberId")::int clientes,
           COUNT(DISTINCT "issuerUserId")::int ops,
           COUNT(*) FILTER (WHERE status <> 'VIGENTE')::int anuladas
    FROM "Transaction" WHERE "accountName" = 'PAYU' GROUP BY 1 ORDER BY 1`);

  const mensual: any[] = await sql(`
    SELECT to_char(date,'YYYY-MM') mes, COUNT(*)::int n, SUM(credit)::float monto
    FROM "Transaction" WHERE "accountName" = 'PAYU' GROUP BY 1 ORDER BY 1`);

  const previos: any[] = await sql(`
    SELECT to_char(t.date,'YYYY-MM-DD') fecha, t.credit::float credito,
           COALESCE(t."payerName",'—') pagador, t."issuerUserId" eid,
           COALESCE(u.username,'—') usr, t.status::text estado
    FROM "Transaction" t LEFT JOIN "Staff" u ON u."legacyId" = t."issuerUserId"
    WHERE t."accountName" = 'PAYU' AND t.date < DATE '2025-01-01'
    ORDER BY t.date, t.id`);

  const comparativo: any[] = await sql(`
    SELECT to_char(date,'YYYY-MM') mes,
      COUNT(*) FILTER (WHERE "accountName"='PAYU')::int n_payu,
      COALESCE(SUM(credit) FILTER (WHERE "accountName"='PAYU'),0)::float m_payu,
      COALESCE(SUM(credit) FILTER (WHERE "accountName"='Yopal'),0)::float m_caja
    FROM "Transaction"
    WHERE "issuerUserId" = 27 AND type = 'INCOME'
      AND date BETWEEN DATE '2025-01-01' AND DATE '2025-12-31'
      AND "accountName" IN ('PAYU','Yopal')
    GROUP BY 1 ORDER BY 1`);

  const perfil: any[] = await sql(`
    SELECT COUNT(DISTINCT "subscriberId")::int clientes,
           COUNT(DISTINCT "invoiceId")::int facturas,
           MIN(credit)::float minimo, MAX(credit)::float maximo,
           ROUND(AVG(credit))::float promedio
    FROM "Transaction"
    WHERE "accountName" = 'PAYU' AND date >= DATE '2025-02-01'`);

  const opsAnio: any[] = await sql(`
    SELECT EXTRACT(YEAR FROM t.date)::int AS anio, t."issuerUserId" eid,
           COALESCE(u.username,'—') usr, COUNT(*)::int n, SUM(t.credit)::float monto
    FROM "Transaction" t LEFT JOIN "Staff" u ON u."legacyId" = t."issuerUserId"
    WHERE t."accountName" = 'PAYU' GROUP BY 1, 2, 3 ORDER BY 1, 4 DESC`);

  const cajaOk: any[] = await sql(`
    SELECT COUNT(*)::int n FROM "Transaction"
    WHERE "issuerUserId" = 27 AND "accountName" = 'Yopal' AND type = 'INCOME'
      AND date BETWEEN DATE '2025-02-01' AND DATE '2025-11-30'`);

  return { porAnio, mensual, previos, comparativo, perfil: perfil[0], opsAnio, cajaOk: cajaOk[0].n };
}

/* --------------------------------------------------------------- documento */

async function main() {
  const d = await datos();

  const totN = d.porAnio.reduce((a: number, r: any) => a + r.n, 0);
  const totM = d.porAnio.reduce((a: number, r: any) => a + r.monto, 0);
  const m2025 = d.porAnio.find((r: any) => r.anio === 2025);
  const previosM = d.previos.reduce((a: number, r: any) => a + r.credito, 0);
  const previosAnul = d.previos.filter((r: any) => r.estado !== 'VIGENTE').length;
  const logins = new Set(d.previos.map((r: any) => r.eid)).size;
  const mapMes = new Map<string, any>(d.mensual.map((r: any) => [r.mes, r]));
  const maxMes = Math.max(...d.mensual.map((r: any) => r.monto));

  const doc: Doc = newDoc(PDFDocument);
  doc.pipe(createWriteStream(OUT));

  docHeader(doc, 'Desvío de fondos por PayU', {
    right: 'Informe forense de tesorería\nCuenta contable 14 «PAYU» · 2022–2025',
    chip: 'CONFIDENCIAL',
  });

  parr(doc,
    'Historia completa de la cuenta contable 14 «PAYU», desde su primer movimiento en julio de 2022 ' +
    'hasta su eliminación en noviembre de 2025. Durante nueve meses de 2025, casi uno de cada cuatro pagos ' +
    'en efectivo del mostrador de Yopal se registró en esa cuenta, que todos los reportes del sistema ' +
    'tienen orden de ignorar.');

  stats(doc, [
    ['Movimientos históricos', num(totN)],
    ['Monto histórico', cop(totM)],
    ['Concentración', `${((m2025.monto / totM) * 100).toFixed(1).replace('.', ',')} % en 2025`],
    ['Vida de la cuenta', 'jul-2022 a nov-2025'],
    ['Clientes afectados', num(d.perfil.clientes)],
    ['Origen de los datos', 'Nexus · PostgreSQL'],
  ]);

  section(doc, 'Resumen');
  parr(doc,
    'La cuenta 14 quedó viva cuando PayU dejó de ser la pasarela de pagos en línea, en 2023. ' +
    'Arrastraba una propiedad peligrosa: todos los cálculos de ingresos del sistema legacy la excluyen ' +
    "por nombre, con el filtro account != 'PAYU' escrito a mano en cinco archivos. Registrar un pago en " +
    'efectivo contra ella dejaba la factura del cliente en paid —así que el cliente nunca reclamaba— ' +
    'pero el dinero no entraba al arqueo, ni al cierre de caja, ni al dashboard, ni al estado de resultados.');
  parr(doc,
    `Entre 2022 y 2024 la cuenta registró ${d.previos.length} movimientos aislados por ${cop(previosM)}. ` +
    `El 3 de febrero de 2025 empezó un uso sostenido que duró hasta el 5 de noviembre: ${num(m2025.n)} ` +
    `transacciones por ${cop(m2025.monto)}, todas desde el mismo login. La presidencia eliminó la cuenta ` +
    'la madrugada siguiente.');

  /* --- 1 --- */
  section(doc, '1 · La cuenta año por año');
  const c1 = cols([['Año', 55], ['Movimientos', 95, 'right'], ['Monto', 115, 'right'],
    ['Clientes', 80, 'right'], ['Operadores', 85, 'right'], ['Anuladas', 85, 'right']]);
  head(doc, c1, 75);
  d.porAnio.forEach((a: any, i: number) => {
    const hot = a.anio === 2025;
    row(doc, c1, [
      { t: String(a.anio), bold: true, color: NAVY },
      num(a.n),
      { t: cop(a.monto), color: hot ? BAD : INK_2, bold: hot },
      num(a.clientes), num(a.ops), a.anuladas || '—',
    ], i);
  });
  row(doc, c1, [
    { t: 'Total', bold: true, color: NAVY }, { t: num(totN), bold: true },
    { t: cop(totM), bold: true, color: NAVY }, '—', '—', { t: String(previosAnul), bold: true },
  ], d.porAnio.length);

  section(doc, 'Todos los meses, todos los años');
  note(doc,
    'Matriz completa mes por año. El punto marca los meses sin movimiento; no hay filas de relleno. ' +
    `La barra está a escala común y la más larga es julio de 2025, con ${cop(maxMes)}.`);
  const anios = [2022, 2023, 2024, 2025];
  const cm = cols([
    ['Mes', 68],
    ...anios.map((a) => [String(a), 92, 'right'] as [string, number, 'right']),
    ['', 79],
  ]);
  head(doc, cm, 95);
  MESES.forEach((nombre, i) => {
    const mm = String(i + 1).padStart(2, '0');
    const celdas: Celda[] = [{ t: nombre, color: INK }];
    anios.forEach((a) => {
      const r = mapMes.get(`${a}-${mm}`);
      celdas.push(r
        ? { t: cop(r.monto), color: a === 2025 ? BAD : INK_2, bold: a === 2025 }
        : { t: '·', color: INK_3 });
    });
    celdas.push('');
    const y = row(doc, cm, celdas, i);
    const r25 = mapMes.get(`2025-${mm}`);
    if (r25) barra(doc, M + 68 + 92 * 4 + 2, y, (r25.monto / maxMes) * 74, BAD);
  });

  /* --- 2 --- */
  section(doc, '2 · Los años previos, movimiento por movimiento');
  parr(doc,
    `Antes de 2025 la cuenta tuvo ${d.previos.length} movimientos en tres años, desde ${logins} logins ` +
    'distintos. Caben completos, y conviene leerlos: muestran que la cuenta se usaba de forma esporádica ' +
    `y que ${previosAnul} de esos movimientos ya habían sido anulados en su momento.`);
  const c2 = cols([['Fecha', 78], ['Cliente', 120], ['Monto', 88, 'right'], ['Login', 152], ['Estado', 77]]);
  head(doc, c2, 70);
  d.previos.forEach((p: any, i: number) => {
    const anul = p.estado !== 'VIGENTE';
    row(doc, c2, [
      p.fecha, p.pagador, cop(p.credito), `${p.usr} (${p.eid})`,
      { t: anul ? 'Anulada' : 'Vigente', color: anul ? BAD : INK_2, bold: anul },
    ], i);
  });

  caja(doc, 'Un detalle para verificar por fuera del sistema', [
    'Los tres movimientos de febrero de 2023 —todos anulados— los hizo el login MargaritaCajasM (id 52). ' +
    'Los siete de octubre de 2024 y los 1.635 de 2025 los hizo MargaritaR (id 27). Son dos cuentas de ' +
    'usuario distintas con el mismo nombre de pila. El sistema no permite establecer si corresponden a ' +
    'la misma persona; eso sólo se resuelve con los registros de personal.',
  ]);

  section(doc, 'Operadores por año');
  const c2b = cols([['Año', 55], ['Login', 220], ['Movimientos', 110, 'right'], ['Monto', 130, 'right']]);
  head(doc, c2b, 60);
  d.opsAnio.forEach((o: any, i: number) => {
    const hot = o.n > 100;
    row(doc, c2b, [
      { t: String(o.anio), color: NAVY, bold: true }, `${o.usr} (id ${o.eid})`, num(o.n),
      { t: cop(o.monto), color: hot ? BAD : INK_2, bold: hot },
    ], i);
  });

  /* --- 3 --- */
  section(doc, '3 · 2025, el año del desvío');
  parr(doc,
    'La tabla compara, mes a mes, todo el efectivo que ese mostrador recaudó en 2025: lo que entró a la ' +
    'caja «Yopal» y quedó registrado, contra lo que se fue a la cuenta invisible. La cuenta aparece de la ' +
    'nada en febrero, llega a representar más de un tercio del recaudo entre junio y octubre, y ' +
    'desaparece el 6 de noviembre.');

  const yl = doc.y + 2;
  doc.roundedRect(M, yl, 8, 5, 2).fill(BRAND);
  doc.font('Helvetica').fontSize(7).fillColor(INK_3)
    .text('Caja «Yopal» · registrado', M + 12, yl - 1, { width: 130, lineBreak: false });
  doc.roundedRect(M + 150, yl, 8, 5, 2).fill(BAD);
  doc.font('Helvetica').fontSize(7).fillColor(INK_3)
    .text('Cuenta «PAYU» · invisible', M + 162, yl - 1, { width: 130, lineBreak: false });
  doc.x = M;
  doc.y = yl + 11;

  const maxTot = Math.max(...d.comparativo.map((c: any) => c.m_caja + c.m_payu));
  const BARW = 116;
  const c3 = cols([['Mes', 62], ['Composición', BARW + 8], ['Caja «Yopal»', 100, 'right'],
    ['Cuenta «PAYU»', 100, 'right'], ['Pagos', 60, 'right'], ['% oculto', 69, 'right']]);
  head(doc, c3, 95);
  let sCaja = 0, sPayu = 0, sN = 0;
  d.comparativo.forEach((c: any, i: number) => {
    const mm = Number(c.mes.slice(5)) - 1;
    const tot = c.m_caja + c.m_payu;
    sCaja += c.m_caja; sPayu += c.m_payu; sN += c.n_payu;
    const y = row(doc, c3, [
      { t: MESES[mm], color: INK }, '',
      cop(c.m_caja),
      c.m_payu > 0 ? { t: cop(c.m_payu), color: BAD, bold: true } : '—',
      c.n_payu || '—',
      c.m_payu > 0 ? pctS((c.m_payu * 100) / tot) : '—',
    ], i);
    const wc = (c.m_caja / maxTot) * BARW;
    const wp = (c.m_payu / maxTot) * BARW;
    barra(doc, M + 62, y, wc, BRAND);
    if (wp > 0) barra(doc, M + 62 + wc + 1.5, y, wp, BAD);
  });
  row(doc, c3, [
    { t: 'Total 2025', bold: true, color: NAVY }, '',
    { t: cop(sCaja), bold: true }, { t: cop(sPayu), bold: true, color: BAD },
    { t: num(sN), bold: true }, { t: pctS((sPayu * 100) / (sCaja + sPayu)), bold: true },
  ], d.comparativo.length);

  section(doc, 'Perfil de los pagos y contraste con la hipótesis del error administrativo');
  const c3b = cols([['Comprobación', 380], ['Resultado', 135, 'right']]);
  head(doc, c3b, 100);
  const filas: [string, Celda][] = [
    ['Clientes distintos afectados', num(d.perfil.clientes)],
    ['Facturas distintas afectadas', num(d.perfil.facturas)],
    ['Monto promedio por pago', cop(d.perfil.promedio)],
    ['Monto mínimo / máximo', `${cop(d.perfil.minimo)} / ${cop(d.perfil.maximo)}`],
    ['Pagos con una transacción Wompi real detrás (ventana de ±2 días)',
      { t: '0 de 1.635', color: BAD, bold: true }],
    ['Pagos del mismo login a la caja correcta, feb–nov 2025', num(d.cajaOk)],
    ['Otros operadores que usaron la cuenta en 2024–2025', '0'],
  ];
  filas.forEach(([k, v], i) => row(doc, c3b, [k, v], i));

  /* --- 4 --- */
  section(doc, '4 · Cómo terminó');
  parr(doc,
    'El registro de auditoría del legacy conserva la secuencia completa. En menos de doce horas, la ' +
    'presidencia le modificó los permisos al usuario, eliminó la cuenta y empezó a revisar los cierres ' +
    'de caja de Yopal.');
  const c4 = cols([['Fecha y hora', 92], ['Usuario', 105], ['Qué ocurrió', 318]]);
  head(doc, c4, 60);
  const crono: [string, string, string, boolean][] = [
    ['2025-11-05 16:52', 'MargaritaR (27)', 'Último pago registrado contra la cuenta 14', false],
    ['2025-11-05 17:25', 'presidencia (17)', 'Se modifican los permisos del usuario 27', false],
    ['2025-11-06 04:43', 'presidencia (17)', 'Se elimina la cuenta: aquí termina el esquema', true],
    ['2025-11-06 14:45', 'presidencia (17)', 'Revisión del cierre de caja de Yopal', false],
  ];
  crono.forEach(([f, u, q, hot], i) =>
    row(doc, c4, [f, u, { t: q, color: hot ? BAD : INK_2, bold: hot }], i));

  caja(doc, 'Lo que quedó sin resolver', [
    `Ninguna de las ${num(m2025.n)} transacciones de 2025 fue anulada. Las ${num(d.perfil.facturas)} ` +
    `facturas siguen marcadas como pagadas y los ${cop(m2025.monto)} nunca se reversaron ni se ` +
    'reconocieron como pérdida en el sistema.',
    'Eliminar la cuenta 14 detuvo el mecanismo, pero también borró el saldo acumulado que llevaba. Las ' +
    'cifras de este informe se reconstruyeron sumando las transacciones, que sí sobrevivieron al borrado.',
  ], 'alerta');

  /* --- 5 --- */
  section(doc, '5 · Atribución y límites');
  parr(doc,
    `Las ${num(m2025.n)} transacciones de 2025 tienen el mismo autor registrado: el login ` +
    'yopal@vestel.com.co (id 27), con rol 5. Es el único de los operadores activos que tocó esa cuenta, ' +
    'y el registro de auditoría lo confirma de forma independiente en 1.608 de los casos.');
  parr(doc,
    'Hasta ahí llega la evidencia técnica. Ese login es un buzón de sede, no un nombre propio. El sistema ' +
    'registra qué cuenta de usuario ejecutó cada operación, no qué persona estaba frente al computador. ' +
    'Vincularlo a alguien concreto exige los turnos de caja de esos días, y eso está fuera de lo que la ' +
    'base de datos puede responder.');
  caja(doc, 'Dos cosas que no cuadran con la versión que circula internamente', [
    'Las fechas. El esquema se cortó el 6 de noviembre de 2025. Si hubo un despido a mediados de 2025, ' +
    'fue por otra cosa: en junio de 2025 esta cuenta estaba en pleno funcionamiento y siguió cinco meses más.',
    'El login sigue activo. No está bloqueado y registra actividad diaria, con último ingreso el 22 de ' +
    'agosto de 2026. Se revisaron además los usuarios que sí están bloqueados y cuya actividad termina ' +
    'en 2025 —incluido uno cuya última acción es del 27 de junio de 2025—: ninguno tocó jamás la cuenta PAYU.',
  ]);

  /* --- 6 --- */
  section(doc, '6 · El otro hallazgo: el webhook de PayU');
  parr(doc,
    'Durante la investigación apareció un problema distinto y sin relación con el anterior, que se deja ' +
    'anotado porque una parte sigue vigente. El webhook que recibía las confirmaciones de PayU ' +
    '(Tickets.php::data_reception) registraba el pago no sólo cuando la pasarela respondía APPROVED, sino ' +
    'también en la rama ABANDONED_TRANSACTION: el cliente iniciaba un pago PSE, lo abandonaba en el banco, ' +
    'y la factura quedaba pagada. Entre junio de 2022 y febrero de 2023 hubo 88 órdenes abandonadas por ' +
    '$5.698.872, contra 32 pagos reales. Casi todas esas transacciones se detectaron y se anularon a mano ' +
    'en su momento, y el problema dejó de aplicar en mayo de 2023, cuando PayU dejó de enviar notificaciones.');
  caja(doc, 'Esto sí sigue explotable hoy', [
    'Ninguno de los dos webhooks valida la firma que envía la pasarela. La firma de integridad de Wompi ' +
    'se genera al salir (crm/.../Invoices.php:58) y nunca se verifica al volver. Con unas 28.000 órdenes ' +
    'en estado Inicial, un JSON forjado contra /crm/tickets/data_reception_wompi, con una referencia ' +
    'válida y status APPROVED, paga facturas gratis.',
  ], 'alerta');

  /* --- 7 --- */
  section(doc, '7 · Recomendaciones');
  const recs: [string, string][] = [
    ['Cruzar los recibos contra los soportes físicos',
      'Única vía para establecer el faltante real. La lista de facturas, clientes y fechas está completa en la base.'],
    ["Eliminar los filtros account != 'PAYU'",
      'Están en cinco archivos del legacy y excluyen por nombre, no por naturaleza de la cuenta.'],
    ['Quitar el remapeo de PAYU a WOMPI',
      'Customers.php:1437 muestra al cliente una etiqueta que no corresponde a la cuenta real del movimiento.'],
    ['Validar el checksum de Wompi en el webhook',
      'SHA-256 de id + status + amount_in_cents + timestamp + events_secret. Es lo único que sigue explotable.'],
    ['Impedir el borrado de cuentas contables',
      'Borrar la cuenta 14 destruyó su saldo acumulado. Con movimientos debería inactivarse, nunca borrarse.'],
    ['Alertar sobre cuentas excluidas de reportes',
      'Nueve meses es demasiado tiempo para detectar esto a ojo.'],
    ['Revisar los roles de los logins de sede',
      'yopal@vestel.com.co tiene rol 5. Un mostrador no lo necesita, y un login compartido impide saber quién hizo qué.'],
  ];
  const cr = cols([['#', 22], ['Acción', 175], ['Por qué', 318]]);
  head(doc, cr, 70);
  recs.forEach(([t, s], i) =>
    row(doc, cr, [{ t: String(i + 1), color: BRAND, bold: true }, { t, bold: true, color: INK }, s], i));

  /* --- 8 --- */
  section(doc, '8 · Alcance y método');
  parr(doc,
    'Este informe lo genera Nexus contra su propia base PostgreSQL (saves_vestel), con consultas de sólo ' +
    'lectura sobre las tablas Transaction, Staff y CashAccount. Los datos migrados coinciden movimiento a ' +
    `movimiento con el legacy: mismos totales por año, mismos ${num(totN)} registros. No se modificó ningún dato.`);
  [
    `Los ${cop(m2025.monto)} son lo que se registró en la cuenta invisible, no necesariamente el faltante de caja.`,
    'El sistema registra logins, no personas: la atribución a un individuo necesita los turnos de caja.',
    'No se puede saber si la cuenta 14 se dejó viva por descuido o a propósito. El filtro que la volvió invisible se escribió en 2022 con un motivo legítimo.',
    'El borrado de la cuenta el 6-nov-2025 eliminó su saldo acumulado; el monto es reconstruible desde las transacciones, el saldo de ese día no.',
  ].forEach((t) => {
    doc.font('Helvetica').fontSize(7.6).fillColor(INK_3);
    need(doc, doc.heightOfString(t, { width: WIDTH - 14, align: 'justify' }) + 3);
    const y = doc.y;
    doc.circle(M + 3, y + 3.5, 1.4).fill(BRAND_2);
    doc.fillColor(INK_3).text(t, M + 14, y, { width: WIDTH - 14, align: 'justify' });
    doc.x = M;
    doc.y += 2;
  });

  const paginas = doc.bufferedPageRange().count;
  finish(doc, `${EMPRESA.nombre} · ${EMPRESA.nit} · Informe forense — confidencial, uso interno`);

  await prisma.$disconnect();
  console.log(`OK: ${OUT}`);
  console.log(`Movimientos: ${num(totN)} · Monto: ${cop(totM)} · Páginas: ${paginas}`);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
