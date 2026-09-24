/**
 * Arma a posteriori la cohorte del seguimiento de cartera de un mes que no se
 * fotografió el día 1 (ver src/reports/cartera-seguimiento.ts, `reconstruirMes`).
 *
 *   npx ts-node --transpile-only scripts/cartera-seguimiento-reconstruir.ts 2026-09 ids.txt
 *
 * `ids.txt`: un Subscriber.id por línea — quienes estaban en CARTERA el día 1. Para
 * septiembre de 2026 salió del respaldo más cercano (nexus_20260909, 1.239 en
 * CARTERA), más los 5 que el historial muestra saliendo de CARTERA entre el 1 y el 9,
 * menos los 2 que entraron en esos días. Idempotente (skipDuplicates).
 */
import { readFileSync } from 'fs';
import { PrismaClient } from '@prisma/client';
import { primerDia, reconstruirMes } from '../src/reports/cartera-seguimiento';

async function main() {
  const [mesArg, archivo] = process.argv.slice(2);
  if (!mesArg || !archivo) throw new Error('uso: <YYYY-MM> <archivo de ids>');
  const ids = [...new Set(readFileSync(archivo, 'utf8').split(/\s+/).filter(Boolean))];
  const prisma = new PrismaClient();
  try {
    const r = await reconstruirMes(prisma as never, primerDia(mesArg), ids);
    console.log(`${r.mes}: ${ids.length} ids → ${r.creados} filas nuevas (los que no debían nada al día 1 quedan fuera)`);
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
