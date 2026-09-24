/**
 * Rellena `JournalLine.costCenterId` en los asientos que ya existían antes de que la
 * contabilización pusiera el centro (fase 4 de docs/centros-de-costo/PLAN.md).
 *
 * Reglas (las mismas que usa hoy la contabilización, vía `src/common/centro-costo.ts`):
 *   - SALES_INVOICE / SALES_INVOICE_ADJ: `sourceId` (sin el `#edición`) → SubInvoice →
 *     sede del abonado.
 *   - CUSTOMER_PAYMENT: `sourceId` = PaymentReceipt → abonado de sus transacciones (o, si no
 *     traen abonado, el de la factura del recibo). Si apuntan a abonados distintos: ambiguo.
 *   - TREASURY_INCOME / TREASURY_EXPENSE: `sourceId` = Transaction → `centroDeTesoreria` de
 *     su caja (sede de la caja; banco → Administración general).
 *   - Cualquier otra cosa (manuales, cierres…) no se toca.
 * Lo que no se pueda resolver sin adivinar queda en null («Sin asignar», decisión D3), y
 * se cuenta con su motivo.
 *
 * Sólo escribe en líneas con `costCenterId IS NULL`; no toca importes ni cuentas. Idempotente:
 * se puede volver a correr para lo que se contabilice sin centro más adelante.
 *
 * Uso: npx ts-node --transpile-only scripts/backfill-centros-costo.ts [--aplicar]
 *      (sin --aplicar es un ensayo: no escribe nada)
 */
import { PrismaClient } from '@prisma/client';
import { centroDeSede, centroDeTesoreria } from '../src/common/centro-costo';

const prisma = new PrismaClient();
const aplicar = process.argv.includes('--aplicar');
const LOTE = 500;

type Asiento = { id: string; sourceType: string | null; sourceId: string | null; nulas: number };

const motivos = new Map<string, { asientos: number; lineas: number }>();
function sinAsignar(a: Asiento, motivo: string) {
  const m = motivos.get(motivo) ?? { asientos: 0, lineas: 0 };
  m.asientos++;
  m.lineas += a.nulas;
  motivos.set(motivo, m);
}

async function sumasPorCuenta() {
  const filas = await prisma.$queryRaw<{ accountId: string; n: bigint; debito: string; credito: string }[]>`
    SELECT "accountId", count(*) AS n, sum(debit)::text AS debito, sum(credit)::text AS credito
    FROM "JournalLine" GROUP BY "accountId" ORDER BY "accountId"`;
  return filas.map((f) => `${f.accountId}|${f.n}|${f.debito}|${f.credito}`).join('\n');
}

async function main() {
  console.log(aplicar ? '== APLICANDO backfill de centros de costo ==' : '== ENSAYO (--dry): no se escribe nada ==');
  const sumasAntes = await sumasPorCuenta();

  // Asientos con al menos una línea sin centro, y cuántas.
  const asientos = await prisma.$queryRaw<Asiento[]>`
    SELECT e.id, e."sourceType", e."sourceId", count(l.id)::int AS nulas
    FROM "JournalEntry" e JOIN "JournalLine" l ON l."entryId" = e.id AND l."costCenterId" IS NULL
    GROUP BY e.id`;
  const totalNulas = asientos.reduce((s, a) => s + a.nulas, 0);
  console.log(`Asientos con líneas sin centro: ${asientos.length} (${totalNulas} líneas)`);

  // ---- Mapas en bloque (evita una consulta por asiento) ----
  const idFactura = (a: Asiento) => (a.sourceId ?? '').split('#')[0];
  const facturasIds = [
    ...new Set(
      asientos.filter((a) => a.sourceType === 'SALES_INVOICE' || a.sourceType === 'SALES_INVOICE_ADJ').map(idFactura),
    ),
  ];
  const facturas = new Map<string, string>(); // SubInvoice.id → subscriberId
  for (let i = 0; i < facturasIds.length; i += 5000) {
    const fs = await prisma.subInvoice.findMany({
      where: { id: { in: facturasIds.slice(i, i + 5000) } },
      select: { id: true, subscriberId: true },
    });
    for (const f of fs) facturas.set(f.id, f.subscriberId);
  }

  const recibosIds = asientos.filter((a) => a.sourceType === 'CUSTOMER_PAYMENT').map((a) => a.sourceId!);
  const recibos = new Map<string, { txSubs: Set<string>; facturaSub: string | null }>();
  for (let i = 0; i < recibosIds.length; i += 2000) {
    const rs = await prisma.paymentReceipt.findMany({
      where: { id: { in: recibosIds.slice(i, i + 2000) } },
      select: {
        id: true,
        invoice: { select: { subscriberId: true } },
        transactions: { select: { transaction: { select: { subscriberId: true } } } },
      },
    });
    for (const r of rs) {
      const txSubs = new Set<string>();
      for (const rt of r.transactions) if (rt.transaction.subscriberId) txSubs.add(rt.transaction.subscriberId);
      recibos.set(r.id, { txSubs, facturaSub: r.invoice?.subscriberId ?? null });
    }
  }

  const subsIds = new Set<string>(facturas.values());
  for (const r of recibos.values()) {
    r.txSubs.forEach((s) => subsIds.add(s));
    if (r.facturaSub) subsIds.add(r.facturaSub);
  }
  const sedeDeAbonado = new Map<string, number | null>();
  const subsLista = [...subsIds];
  for (let i = 0; i < subsLista.length; i += 5000) {
    const ss = await prisma.subscriber.findMany({
      where: { id: { in: subsLista.slice(i, i + 5000) } },
      select: { id: true, branch: { select: { legacyId: true } } },
    });
    for (const s of ss) sedeDeAbonado.set(s.id, s.branch?.legacyId ?? null);
  }

  const txIds = asientos.filter((a) => a.sourceType?.startsWith('TREASURY_')).map((a) => a.sourceId!);
  const cajaDeTx = new Map<string, number | null>();
  const txs = await prisma.transaction.findMany({ where: { id: { in: txIds } }, select: { id: true, cashAccountId: true } });
  for (const t of txs) cajaDeTx.set(t.id, t.cashAccountId);

  // ---- Resolver cada asiento ----
  const centroAbonado = async (a: Asiento, sub: string): Promise<string | null> => {
    if (!sedeDeAbonado.has(sub)) return sinAsignar(a, `${a.sourceType}: abonado ya no existe`), null;
    const sede = sedeDeAbonado.get(sub);
    if (sede == null) return sinAsignar(a, `${a.sourceType}: abonado sin sede`), null;
    const cc = await centroDeSede(prisma, sede);
    if (!cc) sinAsignar(a, `${a.sourceType}: sede ${sede} sin centro activo`);
    return cc;
  };

  const porCentro = new Map<string, Asiento[]>();
  for (const a of asientos) {
    let cc: string | null = null;
    switch (a.sourceType) {
      case 'SALES_INVOICE':
      case 'SALES_INVOICE_ADJ': {
        const sub = facturas.get(idFactura(a));
        if (!sub) sinAsignar(a, `${a.sourceType}: la factura ya no existe (borrada)`);
        else cc = await centroAbonado(a, sub);
        break;
      }
      case 'CUSTOMER_PAYMENT': {
        const r = recibos.get(a.sourceId!);
        if (!r) {
          sinAsignar(a, 'CUSTOMER_PAYMENT: el recibo ya no existe (borrado)');
          break;
        }
        const candidatos = new Set(r.txSubs);
        if (!candidatos.size && r.facturaSub) candidatos.add(r.facturaSub);
        if (candidatos.size === 0) sinAsignar(a, 'CUSTOMER_PAYMENT: recibo sin abonado (ni transacciones ni factura)');
        else if (candidatos.size > 1) sinAsignar(a, 'CUSTOMER_PAYMENT: recibo con varios abonados (ambiguo)');
        else if (r.txSubs.size && r.facturaSub && !r.txSubs.has(r.facturaSub))
          sinAsignar(a, 'CUSTOMER_PAYMENT: el abonado del pago no es el de la factura (ambiguo)');
        else cc = await centroAbonado(a, [...candidatos][0]);
        break;
      }
      case 'TREASURY_INCOME':
      case 'TREASURY_EXPENSE': {
        if (!cajaDeTx.has(a.sourceId!)) {
          sinAsignar(a, `${a.sourceType}: la transacción ya no existe (borrada)`);
          break;
        }
        const caja = cajaDeTx.get(a.sourceId!);
        cc = await centroDeTesoreria(prisma, caja);
        if (!cc) sinAsignar(a, `${a.sourceType}: caja ${caja ?? '(ninguna)'} sin sede`);
        break;
      }
      default:
        sinAsignar(a, `${a.sourceType ?? 'sin sourceType'}: tipo que no se rellena`);
    }
    if (cc) porCentro.set(cc, [...(porCentro.get(cc) ?? []), a]);
  }

  // ---- Resumen ----
  const centros = await prisma.costCenter.findMany({ select: { id: true, code: true } });
  const codigo = new Map(centros.map((c) => [c.id, c.code]));
  console.log('\nAsignación por centro:');
  let asignadas = 0;
  const filas = [...porCentro].map(([id, as]) => ({
    code: codigo.get(id) ?? id,
    asientos: as.length,
    lineas: as.reduce((s, a) => s + a.nulas, 0),
  }));
  for (const f of filas.sort((x, y) => x.code.localeCompare(y.code))) {
    asignadas += f.lineas;
    console.log(`  ${f.code.padEnd(18)} ${String(f.asientos).padStart(6)} asientos ${String(f.lineas).padStart(7)} líneas`);
  }
  const sinAsig = totalNulas - asignadas;
  console.log(`  ${'TOTAL asignado'.padEnd(18)} ${' '.repeat(15)} ${String(asignadas).padStart(7)} líneas`);
  console.log(
    `\nSin asignar: ${sinAsig} líneas de ${totalNulas} (${totalNulas ? ((100 * sinAsig) / totalNulas).toFixed(1) : 0} %). Motivos:`,
  );
  for (const [m, v] of [...motivos].sort((x, y) => y[1].lineas - x[1].lineas))
    console.log(`  ${String(v.asientos).padStart(6)} asientos ${String(v.lineas).padStart(7)} líneas  ${m}`);

  if (!aplicar) {
    console.log('\nEnsayo: no se escribió nada. Para aplicar: --aplicar');
    return;
  }

  // ---- Escribir por lotes, cada lote en su transacción; sólo líneas aún null ----
  let escritas = 0;
  for (const [cc, as] of porCentro) {
    for (let i = 0; i < as.length; i += LOTE) {
      const ids = as.slice(i, i + LOTE).map((a) => a.id);
      const r = await prisma.$transaction((tx) =>
        tx.journalLine.updateMany({ where: { entryId: { in: ids }, costCenterId: null }, data: { costCenterId: cc } }),
      );
      escritas += r.count;
    }
  }
  console.log(`\nEscritas: ${escritas} líneas.`);

  const sumasDespues = await sumasPorCuenta();
  if (sumasAntes === sumasDespues) console.log('Sumas por cuenta (líneas, débito, crédito): IGUALES antes y después ✔');
  else {
    console.log('⚠️ LAS SUMAS POR CUENTA CAMBIARON (¿se contabilizó algo mientras corría?)');
    console.log('--- antes\n' + sumasAntes + '\n--- después\n' + sumasDespues);
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
