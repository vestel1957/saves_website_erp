#!/usr/bin/env ts-node
/**
 * Quita el COBRO DE RECONEXIÓN QUE SE HIZO DOS VECES.
 *
 * Mientras el portal de pagos le habló al legacy, un pago disparaba la reconexión en
 * los DOS sistemas y cada uno emitía su propio cargo prorrateado por los días que
 * quedaban del mes: el legacy dentro de `Customers_model::pay_invoices()` y este
 * sistema en `ProrrateoReconexionService`. Ninguno sabía del otro, así que el abonado
 * acababa con el mismo cargo repetido — mismo día, mismo valor, mismo concepto.
 *
 * Detectado el 2026-09-10 a partir de un caso real (abonado 57383: dos facturas de
 * $42.900 el 9-sep, $85.800 en total cuando debía $42.900). Desde ese día el portal
 * pregunta AQUÍ y sólo un sistema cobra ([[portal-pagos-web-service]]), así que esto
 * limpia lo que quedó y no vuelve a haber más.
 *
 * ─── POR QUÉ UNA NOTA CRÉDITO Y NO ANULAR ───────────────────────────────────────
 *
 * Anular la factura aquí NO sirve: `voidInvoice` deja `status: CANCELED` pero el
 * writeback no empuja el estado —sólo `pushInvoiceUpdates` compara la huella del
 * cobro— y la ida, que corre cada 15 minutos, ve `due` en el legacy y `CANCELED` aquí
 * y la devuelve a DUE. La factura reaparecería sola antes de la media hora.
 *
 * La nota crédito sí viaja: `aplicarNotaEnTx` sella `editedAt`, y `pushEditedInvoices`
 * reescribe allá `total` y `notes`. La factura queda en 0 en los dos sistemas, con el
 * renglón que dice por qué, y el historial conserva las dos huellas. Es el mismo
 * mecanismo con el que se retiran los descuentos mal concedidos.
 *
 * ─── QUÉ CONSIDERA DUPLICADO ────────────────────────────────────────────────────
 *
 * Dos facturas del MISMO abonado, la MISMA fecha y el MISMO valor, las dos pendientes,
 * de las cuales UNA la emitió este sistema como prorrateo de reconexión (su renglón
 * dice "· reconexión"). Se le pone la nota a ESA —la de aquí—, no a la del legacy:
 * la del legacy es la que su corrida mensual y sus informes referencian, y dejarla
 * viva evita tocar nada de allá que no sea el total de la nuestra.
 *
 * Nunca entra un par donde alguna de las dos tenga algún pago: ahí ya hay plata
 * imputada y quitar el cargo cambia lo que el cliente pagó. Se reportan aparte.
 *
 *   npx ts-node --transpile-only scripts/corregir-reconexion-duplicada.ts             # simulacro
 *   npx ts-node --transpile-only scripts/corregir-reconexion-duplicada.ts --aplicar
 *   ... --abonado=57383      acota a un abonado
 *   ... --desde=2026-08-01   (por defecto 2026-08-25, cuando empezó a pasar)
 */
import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { aplicarNotaEnTx } from '../src/billing/nota-en-tx';

const prisma = new PrismaClient();
const args = process.argv.slice(2);
const APLICA = args.includes('--aplicar');
const DESDE = (args.find((a) => a.startsWith('--desde=')) || '--desde=2026-08-25').split('=')[1];
const ABONADO = Number((args.find((a) => a.startsWith('--abonado=')) || '').split('=')[1]) || null;

const cop = (n: number) => `$${Math.round(n).toLocaleString('es-CO')}`;
const num = (d: unknown) => Number(d ?? 0);

/** El renglón que delata al prorrateo de este sistema. */
const MARCA = 'reconexión';

async function main() {
  const desde = new Date(`${DESDE}T00:00:00.000Z`);

  // Se traen TODAS las de la ventana, pagadas incluidas. El gemelo bueno puede estar ya
  // cobrado —el cliente pagó lo que debía— y aun así seguir abierto el duplicado: es el
  // caso del abonado 54193, que pagó su factura del 1-sep y arrastraba el cargo repetido.
  // Filtrar por pendientes de entrada deshacía el par y ese caso no se veía.
  const candidatas = await prisma.subInvoice.findMany({
    where: {
      invoiceDate: { gte: desde },
      status: { in: ['DUE', 'PARTIAL', 'PAID'] },
      ...(ABONADO ? { subscriber: { abonado: ABONADO } } : {}),
    },
    select: {
      id: true, tid: true, legacyId: true, invoiceDate: true, total: true, paidAmount: true,
      status: true, subscriberId: true,
      subscriber: { select: { abonado: true, firstName: true, lastName1: true } },
      items: { select: { description: true, productName: true } },
    },
    orderBy: [{ subscriberId: 'asc' }, { invoiceDate: 'asc' }, { tid: 'asc' }],
  });

  // Se agrupa por (abonado, fecha, valor): así es como se ve el duplicado.
  const grupos = new Map<string, typeof candidatas>();
  for (const f of candidatas) {
    const k = `${f.subscriberId}|${f.invoiceDate.toISOString().slice(0, 10)}|${num(f.total)}`;
    grupos.set(k, [...(grupos.get(k) ?? []), f]);
  }

  const aCorregir: { dejar: typeof candidatas[0]; anular: typeof candidatas[0] }[] = [];
  const conPago: typeof candidatas = [];

  for (const filas of grupos.values()) {
    if (filas.length < 2) continue;
    const deAqui = filas.filter((f) => f.items.some((i) => (i.description ?? '').toLowerCase().includes(MARCA)));
    // Sin una de aquí no hay nada que atribuir a este sistema: dos cargos iguales
    // nacidos los dos en el legacy son asunto suyo y no se tocan a ciegas.
    if (!deAqui.length || deAqui.length === filas.length) continue;

    const anular = deAqui[0];
    const dejar = filas.find((f) => f.id !== anular.id)!;
    // Que el gemelo bueno esté pagado no estorba: el cliente pagó lo que debía. Lo que
    // NO se toca es un duplicado con plata encima — ahí ya hay un pago imputado contra
    // este cargo y quitarlo cambia lo que el cliente pagó.
    if (num(anular.paidAmount) > 0) { conPago.push(anular); continue; }
    aCorregir.push({ dejar, anular });
  }

  console.log(`\n${APLICA ? 'APLICANDO' : 'SIMULACRO'} · desde ${DESDE}`
    + (ABONADO ? ` · abonado ${ABONADO}` : '') + '\n');

  if (!aCorregir.length && !conPago.length) {
    console.log('No hay cobros de reconexión duplicados.');
    return;
  }

  let total = 0;
  for (const { dejar, anular } of aCorregir) {
    const nombre = [anular.subscriber?.firstName, anular.subscriber?.lastName1].filter(Boolean).join(' ');
    const monto = num(anular.total);
    total += monto;
    console.log(`  abonado ${anular.subscriber?.abonado} · ${nombre}`);
    console.log(`     se deja  #${dejar.tid}  ${cop(num(dejar.total))}`
      + (dejar.status === 'PAID' ? '  (ya pagada)' : ''));
    console.log(`     se anula #${anular.tid}  ${cop(monto)}  (nota crédito)`);

    if (!APLICA) continue;
    await prisma.$transaction(async (tx) => {
      await aplicarNotaEnTx(tx, anular.id, {
        type: 'CREDITO',
        amount: monto,
        description: `Cobro de reconexión duplicado: el mismo cargo ya está en la factura #${dejar.tid}.`,
        editedBy: 'Corrección de reconexión duplicada',
      } as never);
    });
    console.log('     ✔ nota crédito aplicada');
  }

  if (conPago.length) {
    console.log('\n  ⚠️ EL DUPLICADO TIENE PAGO — no se toca, hay que mirarlo a mano'
      + ' (el cliente pagó de más y hay que devolverle o abonarle):');
    for (const f of conPago) {
      console.log(`     abonado ${f.subscriber?.abonado} · factura #${f.tid} · ${cop(num(f.total))}`
        + ` · pagado ${cop(num(f.paidAmount))}`);
    }
  }

  console.log(`\n${aCorregir.length} factura(s) · ${cop(total)}`
    + (APLICA ? ' corregidos.' : ' se corregirían. Repite con --aplicar.'));
  if (APLICA && aCorregir.length) {
    console.log('El writeback (cada 15 min) lleva los totales nuevos al legacy.');
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
