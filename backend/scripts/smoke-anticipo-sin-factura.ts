/**
 * Smoke del RECAUDO SIN FACTURA PENDIENTE (dejar pagado el mes siguiente).
 *
 *   npx ts-node --transpile-only scripts/smoke-anticipo-sin-factura.ts
 *
 * El caso: el cliente está al día y viene a pagar el mes que viene, que todavía no se
 * ha facturado (la corrida es el día 1). Antes el recaudo se caía con "El cliente no
 * tiene facturas pendientes"; ahora la plata entra entera como saldo a favor.
 *
 * Corre contra la base de VERDAD y no deja rastro: `collect()` abre su propia
 * transacción, así que se le pasa un Prisma de pega cuyo `$transaction` reutiliza la
 * transacción de fuera — la que al final se revienta a propósito.
 *
 * Comprueba:
 *   1. sin `comoAnticipo` sigue fallando (el cargue masivo no debe convertir en
 *      anticipo una fila que no cuadra),
 *   2. con `comoAnticipo` entra la plata: movimiento de caja SIN factura, anticipo
 *      abierto por el total y nada imputado,
 *   3. el recibo de caja nace sin factura principal y su PDF se puede armar igual
 *      (cliente y sede salen del movimiento),
 *   4. cuando nazca la factura del mes siguiente, ese saldo la paga sola.
 */
import 'reflect-metadata';
import { PrismaClient, Prisma } from '@prisma/client';
import { CobranzasService } from '../src/treasury/cobranzas.service';
import { TreasuryService } from '../src/treasury/treasury.service';
import { aplicarAnticipos, mesesCubiertos, saldoAFavor } from '../src/billing/anticipos';
import { reciboRolloPdf } from '../src/common/pdf/recibo-rollo';

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

const prisma = new PrismaClient();
const cop = (n: number) => `$${n.toLocaleString('es-CO')}`;
const ROLLBACK = 'SMOKE_ROLLBACK';

let fallos = 0;
function check(ok: boolean, texto: string) {
  console.log(`${ok ? '  ✓' : '  ✗'} ${texto}`);
  if (!ok) fallos++;
}

/** Usuario interno: sin `id` el alcance de cajas no acota (ver `alcanceDe`). */
const USUARIO = { id: '', email: 'smoke@vestel', name: 'smoke', roles: [], permissions: [] } as any;

/**
 * Prisma de pega: todo va contra la transacción de fuera y `$transaction` se limita a
 * ejecutar el callback con ella, para que lo que escriba `collect()` se pueda revertir.
 */
function prismaDePega(tx: Prisma.TransactionClient) {
  return new Proxy({} as any, {
    get(_t, k: string) {
      if (k === '$transaction') return (fn: any) => fn(tx);
      return (tx as any)[k];
    },
  });
}

/** Renderiza el rollo a memoria con un `Response` de pega y devuelve su tamaño. */
function renderRollo(d: any): Promise<number> {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const res: any = {
      setHeader: () => undefined,
      write: (c: any) => { bytes += Buffer.byteLength(c); return true; },
      end: (c?: any) => { if (c) bytes += Buffer.byteLength(c); resolve(bytes); },
      on: () => undefined, once: () => undefined, emit: () => undefined,
      destroy: (e: any) => reject(e),
    };
    reciboRolloPdf(res, { ...d, cashier: 'smoke', cashierRole: 'Caja' });
  });
}

async function main() {
  // Un cliente al día: sin ninguna factura DUE/PARTIAL. Es el escenario de ventanilla.
  const candidato = await prisma.subscriber.findFirst({
    where: { invoices: { none: { status: { in: ['DUE', 'PARTIAL'] } } }, branchId: { not: null } },
    select: { id: true, abonado: true, firstName: true, lastName1: true },
  });
  if (!candidato) {
    console.log('No hay ningún cliente sin facturas pendientes con el que probar.');
    return;
  }
  const caja = await prisma.cashAccount.findFirst({
    where: { legacyId: { not: null }, branchLegacy: { not: 0 } },
    select: { legacyId: true, holder: true },
  });
  if (!caja?.legacyId) {
    console.log('No hay ninguna caja de sede con la que probar.');
    return;
  }
  const MONTO = 45000;
  console.log(
    `Cliente #${candidato.abonado} ${[candidato.firstName, candidato.lastName1].filter(Boolean).join(' ')}`
    + ` · caja ${caja.holder} · ${cop(MONTO)}\n`,
  );

  try {
    await prisma.$transaction(async (tx) => {
      const fake = prismaDePega(tx);
      const cobranzas = new CobranzasService(
        fake,
        { postCustomerPayment: async () => undefined } as any,
        { porPago: async () => { throw new Error('no debería reconectar'); } } as any,
        { emit: () => undefined } as any,
      );

      // --- 1. sin pedirlo, sigue siendo un error ---
      let rechazado = false;
      try {
        await cobranzas.collect(
          { subscriberId: candidato.id, amount: MONTO, method: 'Cash', cashAccountId: caja.legacyId! } as any,
          USUARIO,
        );
      } catch (e: any) {
        rechazado = /no tiene facturas pendientes/i.test(e?.message ?? '');
      }
      check(rechazado, 'sin `comoAnticipo` se rechaza (el cargue masivo no lo convierte en saldo)');

      // --- 2. pidiéndolo, la plata entra como saldo a favor ---
      const antes = await saldoAFavor(tx, candidato.id);
      const r = await cobranzas.collect(
        {
          subscriberId: candidato.id, amount: MONTO, method: 'Cash',
          cashAccountId: caja.legacyId!, comoAnticipo: true,
        } as any,
        USUARIO,
      );
      check(r.totalApplied === 0 && r.applied.length === 0, 'no se imputó nada (no había factura)');
      check(r.advance === MONTO, `queda ${cop(r.advance)} a favor`);
      check(await saldoAFavor(tx, candidato.id) === antes + MONTO, 'el saldo a favor del cliente subió');
      check(r.reconexion == null, 'no se tocó ningún equipo (el cliente no estaba cortado)');

      const mov = await tx.transaction.findFirst({
        where: { subscriberId: candidato.id, credit: MONTO, status: 'VIGENTE' },
        orderBy: { createdAt: 'desc' },
        select: { invoiceId: true, cashAccountId: true, note: true },
      });
      check(mov?.invoiceId == null, 'el movimiento entra SIN factura');
      check(mov?.cashAccountId === caja.legacyId, 'cae en la caja de quien recauda (cuadra el cierre)');
      check(!!mov?.note?.startsWith('Pago adelantado'), 'la nota no empieza por "Saldo " (no es arrastre)');

      // --- 3. el recibo existe y su PDF se puede armar sin factura ---
      const recibo = await tx.paymentReceipt.findUnique({
        where: { id: r.receiptId }, select: { invoiceId: true },
      });
      check(recibo != null && recibo.invoiceId == null, 'el recibo de caja nace sin factura principal');
      const pdf: any = await new TreasuryService(fake).receiptPdfData(r.receiptId);
      check(pdf.subscriber?.abonado === candidato.abonado, 'el PDF saca el cliente del movimiento');
      // El papel tiene que decir QUÉ MESES quedan pagados (paridad legacy): un renglón
      // por mes, no un "saldo a favor" mudo.
      const ultima = await tx.subInvoice.findFirst({
        where: { subscriberId: candidato.id },
        orderBy: [{ invoiceDate: 'desc' }, { tid: 'desc' }],
        select: { invoiceDate: true },
      });
      const d = new Date(ultima!.invoiceDate);
      const siguiente = MESES[(d.getUTCMonth() + 1) % 12];
      const meses = await mesesCubiertos(tx, candidato.id, MONTO);
      check(pdf.items.length === meses.length && meses.length > 0,
        `el papel abre el adelanto en ${meses.length} mes(es), no en un "saldo a favor" mudo`);
      check(!!pdf.items[0]?.concept?.startsWith(siguiente),
        `el primer renglón es "${pdf.items[0]?.concept}" (el mes siguiente al último facturado)`);
      check(Math.abs(pdf.items.reduce((a: number, i: any) => a + i.amount, 0) - MONTO) < 0.5,
        'los meses suman exactamente lo que se recibió');
      check(pdf.paid === MONTO && pdf.balance === 0, `el recibo cuadra: pagó ${cop(pdf.paid)}, no debe nada`);

      // --- 4. al nacer la factura del mes siguiente, se paga sola ---
      const plantilla = await tx.subInvoice.findFirst({
        where: { subscriberId: candidato.id },
        orderBy: { invoiceDate: 'desc' },
        select: { branchRef: true, term: true },
      });
      const nueva = await tx.subInvoice.create({
        data: {
          subscriberId: candidato.id, tid: -999_001, kind: 'RECURRENTE', status: 'DUE',
          invoiceDate: new Date(), dueDate: new Date(),
          subtotal: MONTO, tax: 0, total: MONTO, paidAmount: 0,
          branchRef: plantilla?.branchRef ?? null, term: plantilla?.term ?? null,
        },
        select: { id: true },
      });
      const aplicado = await aplicarAnticipos(tx, candidato.id);
      check(aplicado.total === MONTO, `el saldo se imputó solo a la factura nueva (${cop(aplicado.total)})`);
      const quedo = await tx.subInvoice.findUnique({
        where: { id: nueva.id }, select: { status: true, paidAmount: true },
      });
      check(quedo?.status === 'PAID', 'la factura del mes siguiente NACE PAGADA');
      check(Number(quedo?.paidAmount) === MONTO, 'con el valor completo');
      check(await saldoAFavor(tx, candidato.id) === antes, 'y el saldo a favor vuelve a donde estaba');

      throw new Error(ROLLBACK);
    }, { timeout: 60_000 });
  } catch (e: any) {
    if (e?.message !== ROLLBACK) throw e;
  }

  await conExcedente();

  console.log(`\n${fallos ? `${fallos} comprobación(es) FALLARON` : 'Todo bien.'} (nada quedó escrito)`);
  process.exitCode = fallos ? 1 : 0;
}

/**
 * El otro camino, y el más común en ventanilla: el cliente SÍ debe el mes corriente y
 * paga dos de una vez. El recibo tiene que salir con los dos renglones —el mes que se
 * facturó y el que se adelanta—, no con uno y un "saldo a favor" suelto.
 */
async function conExcedente() {
  const factura = await prisma.subInvoice.findFirst({
    where: { status: 'DUE', kind: 'RECURRENTE', paidAmount: 0, total: { gt: 0 } },
    orderBy: { invoiceDate: 'desc' },
    select: { id: true, tid: true, total: true, subscriberId: true, invoiceDate: true },
  });
  const caja = await prisma.cashAccount.findFirst({
    where: { legacyId: { not: null }, branchLegacy: { not: 0 } },
    select: { legacyId: true },
  });
  if (!factura?.subscriberId || !caja?.legacyId) {
    console.log('\nSin datos para el caso del excedente. Saltado.');
    return;
  }
  const mes = Number(factura.total);
  const d = new Date(factura.invoiceDate);
  const esteMes = MESES[d.getUTCMonth()];
  const proximo = MESES[(d.getUTCMonth() + 1) % 12];
  console.log(`\nExcedente · factura #${factura.tid} ${esteMes} ${cop(mes)} → paga ${cop(mes * 2)}\n`);

  try {
    await prisma.$transaction(async (tx) => {
      const fake = prismaDePega(tx);
      const cobranzas = new CobranzasService(
        fake,
        { postCustomerPayment: async () => undefined } as any,
        { porPago: async () => ({ aplica: false, ok: true, enCurso: false, dryRun: true, servicios: [], mensaje: '' }) } as any,
        { emit: () => undefined } as any,
      );
      const r = await cobranzas.collect(
        {
          subscriberId: factura.subscriberId!, amount: mes * 2, method: 'Cash',
          cashAccountId: caja.legacyId!, invoiceIds: [factura.id],
        } as any,
        USUARIO,
      );
      check(r.totalApplied === mes, `se saldó la factura de ${esteMes} (${cop(r.totalApplied)})`);
      check(r.advance === mes, `y sobró un mes: ${cop(r.advance)}`);

      const pdf: any = await new TreasuryService(fake).receiptPdfData(r.receiptId);
      check(pdf.items.length === 2, `el recibo trae 2 renglones (trae ${pdf.items.length})`);
      check(!!pdf.items[0]?.concept?.startsWith(esteMes), `1º: "${pdf.items[0]?.concept}"`);
      check(
        !!pdf.items[1]?.concept?.startsWith(proximo) && pdf.items[1]?.concept?.includes(`CTA:${factura.tid}`),
        `2º: "${pdf.items[1]?.concept}" (mes adelantado, con el CTA de la factura — como el legacy)`,
      );
      check(Math.abs(pdf.paid - mes * 2) < 0.5, `el papel dice que pagó ${cop(pdf.paid)}`);

      // Y que el rollo de 80 mm se imprima de verdad con esos renglones: el dato puede
      // estar bien y el PDF reventar igual (es la ruta que abre la cajera al cobrar).
      const bytes = await renderRollo(pdf);
      check(bytes > 1000, `el recibo de 80 mm se genera (${bytes} bytes)`);

      throw new Error(ROLLBACK);
    }, { timeout: 60_000 });
  } catch (e: any) {
    if (e?.message !== ROLLBACK) throw e;
  }
}

main().finally(() => prisma.$disconnect());
