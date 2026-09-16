/**
 * Endereza la HORA de los eventos que trajo el ETL (`CalendarEvent`).
 *
 * El legacy guarda `events.start` como hora de pared COLOMBIANA, sin zona. La primera
 * importación (`etl-config-omni.js`, antes de que su `dt()` se arreglara) la leyó con
 * la zona del proceso —Berlín—, así que los 131.913 eventos del histórico quedaron
 * guardados 6 h (invierno) o 7 h (verano) por delante del instante real: en pantalla
 * una visita de las 4:52 p. m. se lee a las 9:52 a. m. Con la agenda como TABLA no
 * saltaba a la vista; con la rejilla de horas de `/agenda` (mes/semana/día) sí, y
 * además deja los eventos en la casilla equivocada.
 *
 * Los que baja el sync desde el 2026-09-10 (`syncEventos`) ya vienen bien: éste sólo
 * toca los que NO cuadran con el legacy.
 *
 * Es idempotente y no inventa nada: la hora buena se vuelve a leer del legacy fila a
 * fila (por `legacyId`) y se compara antes de escribir. Correrlo dos veces no hace
 * nada la segunda.
 *
 *   node scripts/corregir-horas-agenda.js             # sólo informe
 *   node scripts/corregir-horas-agenda.js --aplicar
 */
// El entorno lo pone quien lo lanza (PM2/cron ya lo traen); en consola: `set -a; . .env; set +a`.
const mysql = require('mysql2/promise');
const { PrismaClient } = require('@prisma/client');
const { INSTANTE_CO } = require('./lib/hora-co');

const APLICAR = process.argv.includes('--aplicar');
const LOTE = 5000;

/** 'YYYY-MM-DD HH:MM:SS' del legacy (hora de Colombia) → el instante real. */
const instante = (txt) => {
  const t = String(txt || '').trim();
  if (!t || t.startsWith('0000-00-00')) return null;
  return INSTANTE_CO(t.slice(0, 10), t.slice(11, 19));
};
const igual = (a, b) => (a == null && b == null) || (a != null && b != null && a.getTime() === b.getTime());

(async () => {
  const prisma = new PrismaClient();
  const my = await mysql.createConnection({
    host: process.env.LEGACY_DB_HOST, port: +(process.env.LEGACY_DB_PORT || 3306),
    user: process.env.LEGACY_DB_USER, password: process.env.LEGACY_DB_PASSWORD,
    database: process.env.LEGACY_DB_NAME, dateStrings: true,
  });

  let desde = 0, revisados = 0, corregidos = 0, sinParEnLegacy = 0;
  const muestra = [];
  for (;;) {
    const filas = await prisma.calendarEvent.findMany({
      where: { legacyId: { gt: desde } }, orderBy: { legacyId: 'asc' }, take: LOTE,
      select: { legacyId: true, start: true, end: true },
    });
    if (!filas.length) break;
    desde = filas[filas.length - 1].legacyId;
    revisados += filas.length;

    const [leg] = await my.query('SELECT id, start, end FROM events WHERE id IN (?)', [filas.map((f) => f.legacyId)]);
    const porId = new Map(leg.map((r) => [r.id, r]));

    const ids = [], starts = [], ends = [];
    for (const f of filas) {
      const l = porId.get(f.legacyId);
      if (!l) { sinParEnLegacy++; continue; }
      const s = instante(l.start), e = instante(l.end);
      if (igual(s, f.start) && igual(e, f.end)) continue;
      // SE ESCRIBE LA HORA UTC COMO TEXTO NAÏF, y las dos mitades importan.
      //
      // `CalendarEvent.start` es `timestamp` SIN zona (lo que genera Prisma para un
      // `DateTime`) y la sesión de Postgres corre en Europe/Berlin. O sea que todo lo
      // que llegue con zona —un `Date` atado como parámetro, o un ISO con 'Z' casteado
      // a `timestamptz`— se convierte a hora de Berlín ANTES de guardarse, y vuelve a
      // salir corrido 1 h en invierno y 2 h en verano. Ya pasó dos veces en este mismo
      // script. Prisma guarda sus fechas como la hora UTC de pared, así que se le da
      // exactamente eso: 'YYYY-MM-DD HH:MM:SS.mmm' de UTC, casteado a `timestamp`.
      const naif = (d) => (d ? d.toISOString().slice(0, 23).replace('T', ' ') : null);
      ids.push(f.legacyId); starts.push(naif(s)); ends.push(naif(e));
      if (muestra.length < 5) muestra.push(`  legacy ${f.legacyId}: ${f.start?.toISOString() ?? '—'} → ${s?.toISOString() ?? '—'}`);
    }
    corregidos += ids.length;
    if (APLICAR && ids.length) {
      await prisma.$executeRawUnsafe(
        `UPDATE "CalendarEvent" AS c SET "start" = v.s, "end" = v.e
           FROM (SELECT unnest($1::int[]) AS lid, unnest($2::text[])::timestamp AS s, unnest($3::text[])::timestamp AS e) v
          WHERE c."legacyId" = v.lid`,
        ids, starts, ends,
      );
    }
    process.stdout.write(`\r  revisados ${revisados} · a corregir ${corregidos}   `);
  }
  console.log('\n' + (APLICAR ? 'CORREGIDOS' : 'SE CORREGIRÍAN') + `: ${corregidos} de ${revisados} eventos` +
    (sinParEnLegacy ? ` (${sinParEnLegacy} ya no están en el legacy: se dejan como están)` : ''));
  if (muestra.length) console.log('ejemplos:\n' + muestra.join('\n'));
  if (!APLICAR) console.log('\n(informe: no se escribió nada — añade --aplicar)');
  await my.end(); await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
