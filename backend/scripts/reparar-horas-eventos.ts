/**
 * Endereza la HORA de los eventos de la agenda importados del legacy.
 *
 * El fallo: `etl-config-omni.js` leía `events.start` / `events.end` con
 * `new Date(v)` sobre un DATETIME de MySQL, que llega sin zona. Node lo
 * interpretó en la zona del SERVIDOR (Europe/Berlin), no en la de Colombia,
 * así que cada instante quedó guardado con el desfase equivocado:
 *
 *   legacy  2026-07-01 17:59:22  (hora de Colombia, la que ve la gente)
 *   nexus   2026-07-01 15:59:22 UTC   ← se restó el offset de Berlín (+2)
 *   debía   2026-07-01 22:59:22 UTC   ← el de Colombia (-5)
 *
 * Siete horas de diferencia en pantalla: la fila que el legacy fecha a las 5:58
 * de la tarde la agenda la pinta a las 10:59 de la mañana. Y no es sólo estética
 * — 5.620 eventos caen en un DÍA distinto del que les toca, así que el filtro
 * "Desde / Hasta" los archiva bajo la fecha equivocada por más correcto que sea.
 *
 * La corrección es exactamente invertible y no necesita adivinar nada: se lee el
 * instante guardado en Berlín (con lo que se recupera la hora de pared original,
 * DST incluido, que es distinto en enero y en julio) y se vuelve a fijar contra
 * Colombia, que no tiene horario de verano.
 *
 * Sólo toca filas con `legacyId`: lo que se crea desde Nexus ya se guarda bien y
 * pasarle esto encima lo estropearía.
 *
 *   npx ts-node scripts/reparar-horas-eventos.ts            → sólo enseña qué haría
 *   npx ts-node scripts/reparar-horas-eventos.ts --aplicar  → escribe
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const APLICAR = process.argv.includes('--aplicar');

const CORRECCION = `(("col" AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin') + interval '5 hours')`;

async function main() {
  const [antes]: any[] = await prisma.$queryRawUnsafe(`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE start IS NOT NULL)::int AS con_inicio,
           count(*) FILTER (WHERE "end" IS NOT NULL)::int AS con_fin
      FROM "CalendarEvent" WHERE "legacyId" IS NOT NULL`);
  console.log(`eventos del legacy: ${antes.total} (inicio: ${antes.con_inicio}, fin: ${antes.con_fin})`);

  const muestra: any[] = await prisma.$queryRawUnsafe(`
    SELECT "legacyId", start AS ahora,
           ${CORRECCION.replace(/"col"/g, 'start')} AS quedaria
      FROM "CalendarEvent"
     WHERE "legacyId" IS NOT NULL AND start IS NOT NULL
     ORDER BY start DESC LIMIT 5`);
  console.log('\nmuestra (contrastar contra `SELECT id,start FROM events` del legacy):');
  for (const m of muestra) {
    console.log(`  legacy #${m.legacyId}  ${m.ahora.toISOString()} → ${m.quedaria.toISOString()}`);
  }

  const [dias]: any[] = await prisma.$queryRawUnsafe(`
    SELECT count(*)::int AS n FROM "CalendarEvent"
     WHERE "legacyId" IS NOT NULL AND start IS NOT NULL
       AND (start - interval '5 hours')::date
        <> (${CORRECCION.replace(/"col"/g, 'start')} - interval '5 hours')::date`);
  console.log(`\neventos que hoy caen en otro día de Colombia: ${dias.n}`);

  if (!APLICAR) {
    console.log('\n(simulación — nada escrito. Repite con --aplicar)');
    return;
  }

  const n: number = await prisma.$executeRawUnsafe(`
    UPDATE "CalendarEvent"
       SET start = CASE WHEN start IS NULL THEN NULL ELSE ${CORRECCION.replace(/"col"/g, 'start')} END,
           "end" = CASE WHEN "end" IS NULL THEN NULL ELSE ${CORRECCION.replace(/"col"/g, '"end"')} END
     WHERE "legacyId" IS NOT NULL AND (start IS NOT NULL OR "end" IS NOT NULL)`);
  console.log(`\n✔ ${n} eventos corregidos.`);
  console.log('  Es idempotente NO: ejecutarlo dos veces vuelve a desplazar. Una sola pasada.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
