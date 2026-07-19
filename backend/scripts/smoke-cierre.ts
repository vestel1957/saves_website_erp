/**
 * Smoke del cierre de caja contra la BD real: cierra una caja/fecha de verdad, comprueba
 * las dos patas del arrastre, la guarda anti-duplicado y que el cajón queda en 0, y
 * LIMPIA todo lo que escribió.
 *
 * Uso: npx ts-node --transpile-only scripts/smoke-cierre.ts
 */
import { PrismaClient } from '@prisma/client';
import { aporteEfectivo, notaSaldo, proximoDiaHabil, sinElBarridoDelDia, whereEfectivo } from '../src/treasury/cierre-legacy';

const prisma = new PrismaClient();
let ok = 0;
let fail = 0;
const assert = (cond: boolean, msg: string, extra = '') => {
  if (cond) { ok++; console.log(`  OK    ${msg}`); }
  else { fail++; console.log(`  FALLO ${msg} ${extra}`); }
};

/** Réplica del cierre, sin pasar por Nest (mismo código de `cierre-legacy`). */
async function efectivoDe(cashAccountId: number, d: Date) {
  const filas = await prisma.transaction.findMany({
    where: { ...whereEfectivo(cashAccountId, d), ...sinElBarridoDelDia(d) },
    select: { credit: true, debit: true },
  });
  return filas.reduce((s, f) => s + aporteEfectivo(f), 0);
}

async function main() {
  // Un día con movimiento y SIN cierre previo en Nexus (los datos llegan al 2026-07-02).
  const CAJA = 1; // Villanueva
  const d = new Date('2026-07-02T00:00:00.000Z');
  const cuenta = await prisma.cashAccount.findUnique({ where: { legacyId: CAJA }, select: { holder: true } });
  console.log(`\nCaja ${cuenta?.holder} (${CAJA}) · ${d.toISOString().slice(0, 10)}\n`);

  const yaEstaba = await prisma.transaction.findFirst({
    where: { cashAccountId: CAJA, date: d, type: 'EXPENSE', note: notaSaldo(d) },
  });
  if (yaEstaba) { console.log('Ese día ya está cerrado en Nexus; elige otro. Abortando.'); await prisma.$disconnect(); process.exit(1); }

  const efectivoAntes = await efectivoDe(CAJA, d);
  console.log(`Efectivo en el cajón antes de cerrar: ${efectivoAntes}\n`);
  assert(efectivoAntes > 0, 'hay efectivo que barrer');

  const habil = proximoDiaHabil(d);
  const creadas: string[] = [];
  try {
    // --- cerrar (mismo cuerpo que createCashClose) ---
    const comun = {
      cashAccountId: CAJA, accountName: cuenta!.holder, category: 'Sales', method: 'Cash',
      payerName: 'SMOKE TEST', note: notaSaldo(d), status: 'VIGENTE' as const,
      ext: false, issuerUserId: null, invoiceId: null,
    };
    const [salida, entrada] = await prisma.$transaction([
      prisma.transaction.create({ data: { ...comun, type: 'EXPENSE', debit: efectivoAntes, credit: 0, date: d } }),
      prisma.transaction.create({ data: { ...comun, type: 'INCOME', debit: 0, credit: efectivoAntes, date: habil } }),
    ]);
    creadas.push(salida.id, entrada.id);

    assert(Number(salida.debit) === efectivoAntes, 'la pata EXPENSE barre el efectivo entero');
    assert(salida.date.toISOString().slice(0, 10) === '2026-07-02', 'el EXPENSE queda en el día del cierre');
    assert(Number(entrada.credit) === efectivoAntes, 'la pata INCOME arrastra el mismo importe');
    assert(entrada.date.toISOString().slice(0, 10) === '2026-07-03', 'el INCOME cae en el próximo día hábil (vie 3-jul)', `-> ${entrada.date.toISOString().slice(0, 10)}`);
    assert(salida.note === entrada.note && salida.note === 'Saldo 2026-07-02', 'ambas patas llevan la fecha del CIERRE');

    // Tras cerrar, el cajón (contando ya el barrido) debe quedar en 0.
    const filas = await prisma.transaction.findMany({
      where: whereEfectivo(CAJA, d), select: { credit: true, debit: true },
    });
    const cajonDespues = filas.reduce((s, f) => s + aporteEfectivo(f), 0);
    assert(cajonDespues === 0, 'el cajón queda VACÍO tras cerrar (autoconsistente)', `-> ${cajonDespues}`);

    // El arqueo (que excluye el barrido) sigue mostrando lo que se llevó.
    assert((await efectivoDe(CAJA, d)) === efectivoAntes, 'el arqueo sigue mostrando el efectivo barrido');

    // Guarda anti-duplicado.
    const dup = await prisma.transaction.findFirst({
      where: { cashAccountId: CAJA, date: d, type: 'EXPENSE', note: notaSaldo(d), status: 'VIGENTE' },
      select: { id: true },
    });
    assert(!!dup, 'la guarda anti-duplicado detecta el cierre del día');

    // El arrastre entra como efectivo del día hábil siguiente.
    const efectivoManana = await efectivoDe(CAJA, habil);
    assert(efectivoManana >= efectivoAntes, 'el arrastre ya es efectivo del día hábil siguiente', `-> ${efectivoManana}`);
  } finally {
    if (creadas.length) {
      await prisma.transaction.deleteMany({ where: { id: { in: creadas } } });
      console.log(`\nLimpieza: ${creadas.length} transacciones de prueba borradas.`);
    }
    const quedan = await prisma.transaction.count({ where: { payerName: 'SMOKE TEST' } });
    assert(quedan === 0, 'no queda basura del test en la BD');
  }

  console.log(`\n${ok} OK · ${fail} fallos`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
