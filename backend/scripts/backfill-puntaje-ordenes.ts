/**
 * Le pone puntaje a las órdenes que ya estaban cerradas.
 *
 * El puntaje se sella al cerrar (ver `support-write.service.ts`), así que el día
 * que se enciende sólo puntúan las órdenes NUEVAS. Sin esto, el tablero de
 * rendimiento arrancaría con la columna de puntos en cero para todo el mundo
 * durante tres meses —su ventana por defecto son 90 días— y nadie lo miraría.
 *
 * Qué escribe: `Ticket.score` con el valor que hoy tiene el tipo de la orden
 * (`TicketTypeScore`, o el sugerido de `order-score.policy.ts` si nadie lo ha
 * fijado), y `Ticket.scoredAt` con la fecha real del cierre —`resolvedAt` si
 * existe, si no `finalDate`, si no `created`— y no con "ahora": un sello de hoy
 * en una orden de marzo diría que se puntuó en marzo, que es falso, o que se
 * cerró hoy, que es peor.
 *
 * Sólo toca órdenes RESUELTAS y sin puntaje. Es idempotente: correrlo dos veces
 * no cambia nada la segunda vez, y NO reescribe lo que ya se selló al cerrar.
 *
 *   npx ts-node scripts/backfill-puntaje-ordenes.ts                → sólo enseña qué haría
 *   npx ts-node scripts/backfill-puntaje-ordenes.ts --aplicar      → escribe
 *   npx ts-node scripts/backfill-puntaje-ordenes.ts --desde 2026-01-01 --aplicar
 *
 * Sin `--desde` recorre TODO el histórico (unas 300.000 órdenes). Es lo razonable
 * por defecto —la ficha del empleado y los informes anuales también miran atrás—,
 * pero el rango existe para poder hacerlo por partes.
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { puntajeSugerido } from '../src/support/order-score.policy';

const prisma = new PrismaClient();
const APLICAR = process.argv.includes('--aplicar');
const LOTE = 2_000;

function argumento(nombre: string): string | undefined {
  const i = process.argv.indexOf(nombre);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const desdeArg = argumento('--desde');
  const desde = desdeArg ? new Date(`${desdeArg}T00:00:00.000Z`) : null;
  if (desdeArg && Number.isNaN(desde!.getTime())) {
    throw new Error(`--desde no es una fecha válida: ${desdeArg} (se espera AAAA-MM-DD)`);
  }

  // Lo configurado a mano manda sobre el sugerido, igual que en el cierre.
  const definidos = new Map(
    (await prisma.ticketTypeScore.findMany()).map((t) => [t.type, t.points] as const),
  );
  const puntosDe = (tipo: string) => definidos.get(tipo) ?? puntajeSugerido(tipo);

  const where = {
    status: 'RESUELTO' as const,
    score: null,
    ...(desde ? { created: { gte: desde } } : {}),
  };

  const total = await prisma.ticket.count({ where });
  console.log(
    `Órdenes cerradas sin puntaje${desde ? ` desde ${desdeArg}` : ''}: ${total.toLocaleString('es-CO')}`,
  );
  if (!total) return;

  // Reparto por tipo, para poder revisar el criterio ANTES de escribir: si un
  // tipo con 40.000 órdenes está valorado en 5, eso se ve aquí y no después.
  const porTipo = await prisma.ticket.groupBy({ by: ['type'], where, _count: { _all: true } });
  const resumen = porTipo
    .map((t) => ({ tipo: t.type, ordenes: t._count._all, puntos: puntosDe(t.type) }))
    .sort((a, b) => b.ordenes - a.ordenes);
  console.table(
    resumen.slice(0, 25).map((r) => ({
      Tipo: r.tipo,
      Órdenes: r.ordenes.toLocaleString('es-CO'),
      Puntos: r.puntos,
      Total: (r.ordenes * r.puntos).toLocaleString('es-CO'),
    })),
  );
  const puntosTotales = resumen.reduce((s, r) => s + r.ordenes * r.puntos, 0);
  console.log(`Puntos que se repartirían: ${puntosTotales.toLocaleString('es-CO')}`);

  if (!APLICAR) {
    console.log('\nSimulación. Nada se escribió. Añade --aplicar para hacerlo de verdad.');
    return;
  }

  // Un UPDATE por tipo: son ~45 sentencias en vez de 300.000 idas y vueltas, y
  // cada una escribe el mismo valor en todas sus filas. En lotes por id para no
  // tener una transacción de 76.000 filas bloqueando la tabla mientras el resto
  // del sistema sigue cerrando órdenes.
  //
  // `score IS NULL` en el WHERE mantiene la idempotencia: si el script se corta a
  // la mitad, volver a lanzarlo sigue por donde iba y no repisa nada.
  let escritas = 0;
  for (const { tipo, puntos } of resumen) {
    for (;;) {
      const n = await prisma.$executeRaw`
        UPDATE "Ticket"
           SET score = ${puntos},
               "scoredAt" = COALESCE("resolvedAt", "finalDate"::timestamp, created::timestamp)
         WHERE id IN (
           SELECT id FROM "Ticket"
            WHERE type = ${tipo}
              AND status = 'RESUELTO'
              AND score IS NULL
              ${desde ? Prisma.sql`AND created >= ${desde}` : Prisma.empty}
            LIMIT ${LOTE}
         )`;
      if (!n) break;
      escritas += n;
      console.log(`  ${escritas.toLocaleString('es-CO')} / ${total.toLocaleString('es-CO')}…`);
    }
  }

  console.log(`\nListo: ${escritas.toLocaleString('es-CO')} órdenes puntuadas.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
