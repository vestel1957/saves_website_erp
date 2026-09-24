/**
 * Comprueba el informe del cierre contra la BD real: que los bloques cuadren entre sí y
 * con el libro. Uso: npx ts-node --transpile-only scripts/smoke-informe.ts [caja] [fecha]
 */
import { PrismaClient } from '@prisma/client';
import { informeCierre } from '../src/treasury/cierre-informe';

const prisma = new PrismaClient();
const cop = (n: number) => '$ ' + new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 }).format(Math.round(n || 0));

async function main() {
  const caja = Number(process.argv[2] ?? 1);
  const fecha = process.argv[3] ?? '2026-07-01';
  const d = new Date(`${fecha}T00:00:00.000Z`);
  const inf = await informeCierre(prisma as any, caja, d);

  console.log(`\n=== Informe · ${inf.caja.holder} · ${fecha} ===\n`);
  const fila = (l: string, c: number | string, m: number) =>
    console.log(`  ${l.padEnd(38)} ${String(c).padStart(5)}  ${cop(m).padStart(16)}`);

  console.log('Resumen Cobranza');
  fila('Excento', inf.cobranza.excento.cantidad, inf.cobranza.excento.monto);
  fila('Base', inf.cobranza.base.cantidad, inf.cobranza.base.monto);
  fila('iva', '', inf.cobranza.iva.monto);
  fila('TOTAL COBRANZA', inf.cobranza.total.cantidad, inf.cobranza.total.monto);

  console.log('\nResumen por Banco');
  for (const b of inf.porBanco) fila(b.nombre, b.cantidad, b.monto);

  console.log('\nDinero en caja');
  fila('Saldo Anterior', inf.dineroEnCaja.saldoAnterior.cantidad, inf.dineroEnCaja.saldoAnterior.monto);
  fila('Recaudo del día', inf.dineroEnCaja.recaudo.cantidad, inf.dineroEnCaja.recaudo.monto);
  fila('TOTAL EN CAJA', '', inf.dineroEnCaja.totalEnCaja);
  fila('Egresos del día', inf.dineroEnCaja.egresos.cantidad, -inf.dineroEnCaja.egresos.monto);
  fila('EXCEDENTE BARRIDO', '', inf.dineroEnCaja.excedente);

  console.log('\nResumen por tipo de servicio');
  fila('Internet', inf.tipoServicio.Internet.cantidad, inf.tipoServicio.Internet.monto);
  fila('Television', inf.tipoServicio.Television.cantidad, inf.tipoServicio.Television.monto);

  console.log('\nResumen por Servicios');
  for (const p of inf.servicios.planes) fila(`Internet ${p.megas}MG  (${p.clave})`, p.cantidad, p.monto);
  if (inf.servicios.television.cantidad) fila('Television', inf.servicios.television.cantidad, inf.servicios.television.monto);
  for (const a of inf.servicios.afiliaciones) fila(a.producto, a.cantidad, a.monto);
  fila('Total Reconexiones', inf.servicios.reconexiones.cantidad, inf.servicios.reconexiones.monto);
  fila('TOTAL', inf.servicios.total.cantidad, inf.servicios.total.monto);

  console.log('\nCargos cobrados por meses');
  fila('mes actual', inf.meses.actual.cantidad, inf.meses.actual.monto);
  fila('mes anterior', inf.meses.anterior.cantidad, inf.meses.anterior.monto);
  fila('meses anteriores', inf.meses.anteriores.cantidad, inf.meses.anteriores.monto);

  console.log('\nEgresos');
  fila('Pago Orden de Compra', inf.egresos.ordenes.cantidad, inf.egresos.ordenes.monto);
  fila('Transferencias', inf.egresos.traslados.cantidad, inf.egresos.traslados.monto);
  fila('Transacciones', inf.egresos.transacciones.cantidad, inf.egresos.transacciones.monto);
  fila('TOTAL EGRESOS', inf.egresos.total.cantidad, inf.egresos.total.monto);

  // --- Invariantes que el legacy sí cumple ---
  let fail = 0;
  const chk = (cond: boolean, m: string, extra = '') => {
    console.log(`  ${cond ? 'OK   ' : 'FALLO'} ${m} ${extra}`);
    if (!cond) fail++;
  };
  console.log('\nInvariantes:');
  const totalTipo = inf.tipoServicio.Internet.monto + inf.tipoServicio.Television.monto;
  chk(Math.abs(inf.cobranza.total.monto - totalTipo) < 1,
    'TOTAL COBRANZA == TOTAL TIPO DE SERVICIOS (colapso algebraico del legacy)',
    `-> ${cop(inf.cobranza.total.monto)} vs ${cop(totalTipo)}`);

  // OJO: el esperado NO es sólo el recaudo de la caja — el informe consolida además los
  // movimientos de banco cuyo `refer` apunta a esta caja (WOMPI, Bancolombia...).
  const sumaMeses = inf.meses.actual.monto + inf.meses.anterior.monto + inf.meses.anteriores.monto;
  const propio = await prisma.transaction.aggregate({
    _sum: { credit: true },
    where: { cashAccountId: caja, date: { gte: d, lt: new Date(d.getTime() + 86400000) }, noShow: false, status: 'VIGENTE', invoiceId: { not: null } },
  });
  const esperado = Number(propio._sum.credit ?? 0) + inf.porBanco.reduce((s, b) => s + b.monto, 0);
  chk(Math.abs(sumaMeses - esperado) < 1,
    'suma de los meses == recaudo propio + banco consolidado (monto crudo)',
    `-> ${cop(sumaMeses)} vs ${cop(esperado)}`);

  chk(inf.servicios.afiliaciones.every((a) => a.producto !== 'Afiliación Combo'),
    'el combo se repartió 40/60 y ya no aparece como tal');

  console.log(`\n${fail === 0 ? 'TODO OK' : `${fail} FALLOS`}`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
