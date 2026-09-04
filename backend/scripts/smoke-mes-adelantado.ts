/**
 * Smoke del MES ADELANTADO CON DESCUENTO (la casilla "pagar también <mes>").
 *
 *   npm run smoke:mes-adelantado
 *
 * El caso de ventanilla: el 2 de septiembre el cliente paga septiembre y, de paso,
 * deja pagado octubre. Octubre todavía no está facturado (nace el día 1 con la
 * corrida), así que no hay ninguna factura donde escribirle el descuento por
 * adelantarlo: la rebaja viaja PROMETIDA en el anticipo y se concede cuando la
 * factura nace.
 *
 * Corre contra la base de VERDAD y no deja rastro: `collect()` abre su propia
 * transacción, así que se le pasa un Prisma de pega cuyo `$transaction` reutiliza la
 * de fuera — la que al final se revienta a propósito.
 *
 * Comprueba:
 *   1. la ventanilla propone el precio del mes ya rebajado,
 *   2. no se acepta adelantar si el monto no alcanza,
 *   3. cobrando deuda + adelanto: el excedente queda como anticipo CON el descuento
 *      prometido, y el recibo abre el mes al valor neto,
 *   4. al nacer la factura del mes siguiente se le pone la nota crédito y el anticipo
 *      la deja PAGADA (no PARTIAL debiendo justo el 5%),
 *   5. la rebaja no se concede dos veces ni alcanza a la mora.
 */
import 'reflect-metadata';
import { PrismaClient, Prisma } from '@prisma/client';
import { CobranzasService } from '../src/treasury/cobranzas.service';
import { TreasuryService } from '../src/treasury/treasury.service';
import { aplicarAnticipos, saldoAFavor } from '../src/billing/anticipos';
import { num } from '../src/common/money';

const prisma = new PrismaClient();
const cop = (n: number) => `$${Math.round(n).toLocaleString('es-CO')}`;
const ROLLBACK = 'SMOKE_ROLLBACK';

let fallos = 0;
function check(ok: boolean, texto: string) {
  console.log(`${ok ? '  ✓' : '  ✗'} ${texto}`);
  if (!ok) fallos++;
}

const USUARIO = { id: '', email: 'smoke@vestel', name: 'smoke', roles: [], permissions: [] } as any;

function prismaDePega(tx: Prisma.TransactionClient) {
  return new Proxy({} as any, {
    get(_t, k: string) {
      if (k === '$transaction') return (fn: any) => fn(tx);
      return (tx as any)[k];
    },
  });
}

async function main() {
  // Un cliente con UNA sola factura pendiente: es el que se pone al día de un tirón y
  // puede adelantar. Con dos, el adelanto se rechaza a propósito (se comprueba abajo).
  const candidato = await prisma.subscriber.findFirst({
    where: {
      branchId: { not: null },
      invoices: { some: { status: 'DUE', kind: 'RECURRENTE' } },
      services: { some: { status: 'ACTIVO' } },
    },
    select: { id: true, abonado: true, firstName: true, lastName1: true },
  });
  const caja = await prisma.cashAccount.findFirst({
    where: { legacyId: { not: null }, branchLegacy: { not: 0 } },
    select: { legacyId: true, holder: true },
  });
  if (!candidato || !caja?.legacyId) {
    console.log('No hay cliente con factura pendiente / caja de sede con la que probar.');
    return;
  }
  console.log(
    `Cliente #${candidato.abonado} ${[candidato.firstName, candidato.lastName1].filter(Boolean).join(' ')}`
    + ` · caja ${caja.holder}\n`,
  );

  try {
    await prisma.$transaction(async (tx) => {
      const fake = prismaDePega(tx);
      const cobranzas = new CobranzasService(
        fake,
        { postCustomerPayment: async () => undefined } as any,
        { porPago: async () => null } as any,
        { emit: () => undefined } as any,
      );

      // Sólo una pendiente: se cancelan las demás dentro de la transacción que se
      // revienta, para tener el escenario limpio sin tocar nada de verdad.
      const pendientes = await tx.subInvoice.findMany({
        where: { subscriberId: candidato.id, status: { in: ['DUE', 'PARTIAL'] } },
        orderBy: [{ invoiceDate: 'desc' }, { tid: 'desc' }],
        select: { id: true, total: true, paidAmount: true },
      });
      const laQueSeQueda = pendientes[0];
      if (pendientes.length > 1) {
        await tx.subInvoice.updateMany({
          where: { id: { in: pendientes.slice(1).map((i) => i.id) } },
          data: { status: 'CANCELED' },
        });
      }
      const deuda = Math.round((num(laQueSeQueda.total) - num(laQueSeQueda.paidAmount)) * 100) / 100;

      // --- 1. la ventanilla propone el mes siguiente ya rebajado ---
      const debt: any = await cobranzas.subscriberDebt(candidato.id);
      const adelanto = debt.adelanto;
      check(!!adelanto && adelanto.meses.length === 1, 'la deuda trae la propuesta de UN mes adelantado');
      check(adelanto.pct > 0, `con descuento del ${adelanto.pct}%`);
      check(
        Math.abs(adelanto.neto - (adelanto.bruto - adelanto.descuento)) < 0.5,
        `${cop(adelanto.bruto)} − ${cop(adelanto.descuento)} = ${cop(adelanto.neto)} (${adelanto.meses[0].label})`,
      );

      const aCobrar = Math.round((debt.totalConDescuento ?? debt.totalDebt) + adelanto.neto);

      // --- 2. adelantar sin poner la plata se rechaza ---
      let corto = '';
      try {
        await cobranzas.collect(
          {
            subscriberId: candidato.id, amount: Math.max(1, Math.round(deuda)), method: 'Cash',
            cashAccountId: caja.legacyId!, adelantarMeses: 1, reconectar: false,
          } as any,
          USUARIO,
        );
      } catch (e: any) { corto = e?.message ?? ''; }
      check(/Faltan/i.test(corto), 'sin el dinero del adelanto, el recaudo se rechaza');

      // --- 3. deuda + adelanto en un solo recaudo ---
      const r: any = await cobranzas.collect(
        {
          subscriberId: candidato.id, amount: aCobrar, method: 'Cash',
          cashAccountId: caja.legacyId!, adelantarMeses: 1, reconectar: false,
        } as any,
        USUARIO,
      );
      check(r.adelanto?.meses?.length === 1, `la respuesta canta el mes: ${r.adelanto?.meses?.join(', ')}`);
      check(Math.abs(r.adelanto.descuento - adelanto.descuento) < 0.5,
        `y el descuento prometido: ${cop(r.adelanto.descuento)}`);
      check(Math.abs(r.advance - adelanto.neto) < 1.5, `el excedente ${cop(r.advance)} quedó como anticipo`);

      const adv = await tx.customerAdvance.findFirst({
        where: { subscriberId: candidato.id, status: 'ABIERTO' },
        orderBy: { createdAt: 'desc' },
        select: { id: true, amount: true, discountAmount: true, discountApplied: true, months: true, monthlyNet: true },
      });
      check(!!adv && num(adv.discountAmount) > 0, 'el anticipo guarda el descuento PROMETIDO');
      check(num(adv!.discountApplied) === 0, 'todavía sin conceder (la factura no existe)');

      // El papel: un renglón por el mes, al valor NETO (no al de lista con un resto suelto).
      const pdf: any = await new TreasuryService(fake).receiptPdfData(r.receiptId);
      const renglonMes = pdf.items.find((i: any) => String(i.concept).startsWith(adelanto.meses[0].label));
      check(!!renglonMes, `el recibo trae el renglón "${adelanto.meses[0].label}"`);
      check(!!renglonMes && Math.abs(renglonMes.amount - adelanto.neto) < 1.5,
        `por ${cop(renglonMes?.amount ?? 0)}, que es lo que se le cobró`);
      check(Math.abs(pdf.paid - aCobrar) < 1.5, `el recibo suma lo recibido (${cop(pdf.paid)})`);

      // --- 4. nace la factura del mes siguiente ---
      const plantilla = await tx.subInvoice.findFirst({
        where: { subscriberId: candidato.id },
        orderBy: { invoiceDate: 'desc' },
        select: { branchRef: true, term: true },
      });
      const mesSig = new Date(adelanto.meses[0].fecha);
      const nueva = await tx.subInvoice.create({
        data: {
          subscriberId: candidato.id, tid: -999_101, kind: 'RECURRENTE', status: 'DUE',
          invoiceDate: mesSig, dueDate: mesSig,
          subtotal: adelanto.bruto, tax: 0, total: adelanto.bruto, paidAmount: 0,
          branchRef: plantilla?.branchRef ?? null, term: plantilla?.term ?? null,
        },
        select: { id: true },
      });
      await aplicarAnticipos(tx, candidato.id, { fecha: new Date() });

      const quedo = await tx.subInvoice.findUnique({
        where: { id: nueva.id },
        select: { status: true, total: true, paidAmount: true, items: { select: { productName: true, description: true, price: true } } },
      });
      const nota = quedo!.items.find((i) => i.productName === 'Nota Credito');
      check(!!nota, 'la factura nueva recibe la nota crédito del adelanto');
      check(!!nota && Math.abs(Math.abs(num(nota.price)) - adelanto.descuento) < 0.5,
        `por ${cop(adelanto.descuento)} — "${nota?.description}"`);
      check(Math.abs(num(quedo!.total) - adelanto.neto) < 0.5,
        `el total baja a ${cop(num(quedo!.total))}`);
      check(quedo!.status === 'PAID', 'y el anticipo la deja PAGADA (no PARTIAL debiendo el descuento)');
      check(Math.round(await saldoAFavor(tx, candidato.id)) === 0, 'el saldo a favor se consumió entero');

      // --- 5. no se concede dos veces ---
      const antesDeRepetir = quedo!.items.length;
      await aplicarAnticipos(tx, candidato.id, { fecha: new Date() });
      const otraVez = await tx.subInvoice.findUnique({
        where: { id: nueva.id }, select: { items: { select: { id: true } } },
      });
      check(otraVez!.items.length === antesDeRepetir, 'una segunda pasada no vuelve a rebajarla');

      // --- 6. anular el recaudo también RETIRA la rebaja ---
      // Si no, el cliente se queda con la plata devuelta Y con la factura un 5% más
      // barata.
      const movAdelanto = await tx.customerAdvance.findUnique({
        where: { id: adv!.id }, select: { transactionId: true },
      });
      await cobranzas.voidTransactionTx(tx, movAdelanto!.transactionId!, { reason: 'smoke' } as any, USUARIO);
      const tras = await tx.subInvoice.findUnique({
        where: { id: nueva.id },
        select: { status: true, total: true, paidAmount: true, items: { select: { productName: true } } },
      });
      check(tras!.items.filter((i) => i.productName === 'Nota Debito').length === 1,
        'la anulación escribe la nota débito que retira el descuento');
      check(Math.abs(num(tras!.total) - adelanto.bruto) < 0.5,
        `el total vuelve a ${cop(adelanto.bruto)}`);
      check(tras!.status !== 'PAID', 'y la factura deja de estar pagada');

      throw new Error(ROLLBACK);
    }, { timeout: 120_000 });
  } catch (e: any) {
    if (e?.message !== ROLLBACK) throw e;
  }

  console.log(`\n${fallos ? `${fallos} comprobación(es) FALLARON` : 'Todo bien.'} (nada quedó escrito)`);
  process.exitCode = fallos ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
