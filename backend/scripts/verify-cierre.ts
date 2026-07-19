/**
 * Verifica que el motor del cierre de Nexus reproduce EXACTO lo que el legacy escribió.
 *
 * Cada transacción EXPENSE 'Saldo <fecha>' del histórico es un cierre real que hizo el
 * legacy: su `debit` es el excedente que barrió. Se recalcula ese excedente con el código
 * de Nexus (`whereEfectivo` + `aporteEfectivo`) y se compara.
 *
 * Uso: npx ts-node --transpile-only scripts/verify-cierre.ts [YYYY-MM-DD desde]
 */
import { PrismaClient } from '@prisma/client';
import {
  aporteEfectivo, esNotaSaldo, notaSaldo, proximoDiaHabil, sinElBarridoDelDia, whereEfectivo,
} from '../src/treasury/cierre-legacy';

const prisma = new PrismaClient();

/** Cuentas de banco: no son cajas y el legacy nunca las cerró con esta fórmula. */
const BANCOS = [6, 7, 8, 23];

async function main() {
  const desde = process.argv[2] ?? '2021-01-01';
  const cierres = await prisma.transaction.findMany({
    where: {
      type: 'EXPENSE', status: 'VIGENTE', note: { startsWith: 'Saldo ' },
      invoiceId: null, cashAccountId: { notIn: BANCOS },
      date: { gte: new Date(`${desde}T00:00:00.000Z`) },
    },
    select: { id: true, cashAccountId: true, accountName: true, date: true, debit: true, note: true },
    orderBy: { date: 'asc' },
  });

  let ok = 0;
  const fallos: { caja: string; fecha: string; legacy: number; nexus: number; dif: number }[] = [];

  for (const c of cierres) {
    // Sólo cuenta como cierre si la nota coincide con su propia fecha.
    if (c.note !== notaSaldo(c.date)) continue;
    const filas = await prisma.transaction.findMany({
      where: {
        ...whereEfectivo(c.cashAccountId!, c.date),
        ...sinElBarridoDelDia(c.date),
      },
      select: { credit: true, debit: true },
    });
    const nexus = filas.reduce((s, f) => s + aporteEfectivo(f), 0);
    const legacy = Number(c.debit);
    if (legacy === nexus) ok++;
    else fallos.push({
      caja: c.accountName ?? String(c.cashAccountId), fecha: c.date.toISOString().slice(0, 10),
      legacy, nexus, dif: legacy - nexus,
    });
  }

  const total = ok + fallos.length;
  console.log(`\nCierres de caja comparados: ${total}`);
  console.log(`  idénticos al legacy : ${ok} (${((ok / total) * 100).toFixed(2)}%)`);
  console.log(`  difieren            : ${fallos.length}`);
  if (fallos.length) {
    console.log('\nDiferencias (session obsoleta / rango multi-día del legacy, ver cierre-legacy.ts):');
    for (const f of fallos.slice(0, 30)) {
      console.log(`  ${f.fecha}  ${f.caja.padEnd(12)} legacy=${f.legacy}  nexus=${f.nexus}  dif=${f.dif}`);
    }
  }

  // Comprobación del arrastre: la pata INCOME debe estar en el próximo día hábil.
  let habilOk = 0;
  const habilMal: string[] = [];
  for (const c of cierres.slice(-200)) {
    const entrada = await prisma.transaction.findFirst({
      where: { cashAccountId: c.cashAccountId!, type: 'INCOME', note: c.note, status: 'VIGENTE' },
      select: { date: true },
    });
    if (!entrada) continue;
    const esperado = proximoDiaHabil(c.date).toISOString().slice(0, 10);
    const real = entrada.date.toISOString().slice(0, 10);
    if (esperado === real) habilOk++;
    else habilMal.push(`${c.date.toISOString().slice(0, 10)} ${c.accountName}: legacy=${real} nexus=${esperado}`);
  }
  console.log(`\nArrastre al próximo día hábil (últimos 200): ${habilOk} correctos, ${habilMal.length} mal`);
  habilMal.slice(0, 10).forEach((m) => console.log(`  ${m}`));

  // Los impostores: gastos corrientes cuya nota empieza por "Saldo " pero no son cierres.
  // Si alguno se colara, la pantalla mostraría cierres falsos y el arrastre podría leer
  // uno como suyo.
  const conPrefijo = await prisma.transaction.count({
    where: { note: { startsWith: 'Saldo ' }, status: 'VIGENTE' },
  });
  const todos = await prisma.transaction.findMany({
    where: { note: { startsWith: 'Saldo ' }, status: 'VIGENTE' },
    select: { note: true },
  });
  const reales = todos.filter((t) => esNotaSaldo(t.note)).length;
  console.log(`\nNotas que empiezan por 'Saldo ': ${conPrefijo}`);
  console.log(`  cierres de verdad (regex)  : ${reales}`);
  console.log(`  impostores descartados     : ${conPrefijo - reales}  <- 'Saldo de mano de obra...', etc.`);

  await prisma.$disconnect();
  process.exit(fallos.length === 0 && habilMal.length === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
