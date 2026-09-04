/**
 * Prueba de humo del prorrateo de reconexión CONTRA UNA BASE DE VERDAD.
 *
 * Las unitarias prueban la DECISIÓN con dobles de Prisma; esto prueba la
 * ESCRITURA, que es lo que ningún doble puede demostrar: que el renglón entra
 * donde tiene que entrar, que los totales de la factura cuadran después, que
 * queda blindada contra el sync (`editedAt`), que la factura nueva sale con el
 * consecutivo del rango de nexus y con vencimiento a fin de mes, y que llamarlo
 * dos veces NO cobra dos veces.
 *
 * Se monta sus propios datos en una base vacía y la deja como estaba. Nunca se
 * corre contra producción: aborta si la URL no dice "smoke".
 *
 *   createdb saves_prorrateo_smoke && DATABASE_URL="…saves_prorrateo_smoke…" \
 *     npx prisma migrate deploy
 *   DATABASE_URL="…saves_prorrateo_smoke…" npx ts-node --transpile-only \
 *     scripts/smoke-prorrateo-reconexion.ts
 */

import { PrismaService } from '../src/prisma/prisma.service';
import { PostingService } from '../src/accounting/posting.service';
import { ProrrateoReconexionService } from '../src/billing/prorrateo-reconexion.service';
import { ventanaProrrateo } from '../src/billing/prorrateo-reconexion';

if (!/smoke/.test(process.env.DATABASE_URL || '')) {
  console.error('ABORTA: esto sólo se corre contra una base desechable (DATABASE_URL debe decir "smoke").');
  process.exit(1);
}

const money = (n: any) => `$${Number(n).toLocaleString('es-CO')}`;
let fallos = 0;
const comprobar = (etiqueta: string, ok: boolean, detalle = '') => {
  console.log(`   ${ok ? '✓' : '✗'} ${etiqueta}${detalle ? ` — ${detalle}` : ''}`);
  if (!ok) fallos++;
};

async function main() {
  const prisma = new PrismaService();
  process.env.BILLING_PRORRATEO_RECONEXION = 'on';
  const posting = { postSalesInvoice: async () => null, postSalesInvoiceAdjustment: async () => null } as unknown as PostingService;
  const servicio = new ProrrateoReconexionService(prisma, posting);

  const v = ventanaProrrateo();
  const esperadoInternet = Math.round((50500 / v.diasDelMes) * v.dias);
  const esperadoTv = Math.round((22269 / v.diasDelMes) * v.dias);
  console.log(`\nHoy quedan ${v.dias} de ${v.diasDelMes} días del mes.`);
  console.log(`Internet "100 Megas F-26" ($50.500) → ${money(esperadoInternet)} · TV "Television26" ($22.269) → ${money(esperadoTv)} + IVA`);

  // El suelo del consecutivo, como en producción: nexus factura desde 900.000 para
  // no chocar con el legacy (ver `consecutivos-tid`, y la migración `tid_seq_900k` que
  // subió el bloque desde 500.000 cuando el legacy adoptó ese máximo). En una base
  // recién migrada la secuencia arranca en 1 porque se siembra desde MAX(tid).
  await prisma.$executeRawUnsafe(`SELECT setval('"SubInvoice_tid_seq"', 900000, true)`);

  await prisma.plan.createMany({
    data: [
      { name: '100 Megas F-26', kind: 'INTERNET', price: 50500, taxRate: 0 },
      { name: 'Television26', kind: 'TV', price: 22269, taxRate: 19 },
    ],
  });

  const nuevoAbonado = async (abonado: number, conTv = false) => {
    const s = await prisma.subscriber.create({ data: { abonado, fullName: `Prueba ${abonado}`, status: 'CARTERA' } });
    await prisma.subscriberService.create({
      data: { subscriberId: s.id, kind: 'INTERNET', planName: '100 Megas F-26', price: 50500, taxRate: 0, status: 'CORTADO' },
    });
    if (conTv) {
      await prisma.subscriberService.create({
        data: { subscriberId: s.id, kind: 'TV', planName: 'Television26', price: 22269, taxRate: 19, status: 'CORTADO' },
      });
    }
    return s;
  };

  // ---------------------------------------------------------------- A ----
  // Factura del mes CON SALDO y sin la línea de internet: el renglón se le añade.
  console.log('\n=== A) Renglón sobre la factura del mes que tiene saldo ===');
  const a = await nuevoAbonado(9001, true);
  const facturaA = await prisma.subInvoice.create({
    data: {
      tid: 499001, subscriberId: a.id, invoiceDate: v.desde, dueDate: v.hasta,
      subtotal: 22269, tax: 4231, total: 26500, paidAmount: 0, status: 'DUE', kind: 'RECURRENTE', itemsCount: 1,
      items: { create: [{ productId: 0, productName: 'Television26', description: 'Television26', qty: 1, price: 22269, taxRate: 19, subtotal: 22269, taxTotal: 4231 }] },
    },
  });

  const rA = await servicio.aplicar(a.id, ['INTERNET'], { ctx: 'smoke', autor: 'Prueba' });
  console.log(`   → ${rA.mensaje}`);
  const despuesA = await prisma.subInvoice.findUnique({
    where: { id: facturaA.id },
    include: { items: { orderBy: { createdAt: 'asc' } } },
  });
  const nuevoItem = despuesA!.items.find((i) => i.productName === '100 Megas F-26');
  comprobar('cobró sobre la factura que ya existía', rA.cobrado && rA.invoiceTid === 499001 && !rA.facturaNueva);
  comprobar('el renglón lleva el nombre del plan y el pedazo de mes en la descripción',
    nuevoItem?.productName === '100 Megas F-26' && /reconexión .* días?\)/.test(nuevoItem?.description ?? ''), nuevoItem?.description ?? '(sin renglón)');
  comprobar('la base es la del legacy, al peso', Number(nuevoItem?.price) === esperadoInternet, money(nuevoItem?.price));
  comprobar('el total de la factura sube exactamente lo cobrado',
    Number(despuesA!.total) === 26500 + rA.total, `${money(despuesA!.total)} = ${money(26500)} + ${money(rA.total)}`);
  comprobar('subtotal + IVA = total', Number(despuesA!.subtotal) + Number(despuesA!.tax) === Number(despuesA!.total));
  comprobar('itemsCount se actualizó', despuesA!.itemsCount === 2);
  comprobar('la factura queda blindada contra el sync (editedAt)', !!despuesA!.editedAt);
  const otraVezA = await servicio.aplicar(a.id, ['INTERNET'], { ctx: 'smoke 2' });
  comprobar('llamarlo otra vez NO vuelve a cobrar', !otraVezA.cobrado && !otraVezA.aplica, otraVezA.mensaje);

  // ---------------------------------------------------------------- B ----
  // Sin factura del mes: factura nueva, con vencimiento a fin de mes.
  console.log('\n=== B) Factura nueva (el abonado no tiene factura este mes) ===');
  const b = await nuevoAbonado(9002, true);
  const rB = await servicio.aplicar(b.id, ['INTERNET', 'TV'], { ctx: 'smoke', autor: 'Prueba' });
  console.log(`   → ${rB.mensaje}`);
  const facturaB = await prisma.subInvoice.findUnique({ where: { tid: rB.invoiceTid! }, include: { items: true } });
  comprobar('creó factura nueva', !!rB.facturaNueva && !!facturaB);
  comprobar('el consecutivo sale del rango de nexus (≥900.000)', (facturaB?.tid ?? 0) >= 900000, String(facturaB?.tid));
  comprobar('vence el último día del mes, no el 20',
    facturaB?.dueDate.toISOString().slice(0, 10) === v.hasta.toISOString().slice(0, 10), facturaB?.dueDate.toISOString().slice(0, 10));
  comprobar('es RECURRENTE y queda debiendo', facturaB?.kind === 'RECURRENTE' && facturaB?.status === 'DUE');
  comprobar('el combo sale en UNA factura con las dos líneas', facturaB?.items.length === 2, facturaB?.items.map((i) => i.productName).join(' + '));
  comprobar('la TV lleva su IVA del 19% y el internet 0%',
    facturaB?.items.every((i) => (i.productName === 'Television26' ? Number(i.taxTotal) > 0 : Number(i.taxTotal) === 0)) ?? false);
  comprobar('el snapshot de servicios queda en la cabecera',
    facturaB?.serviceCombo === '100 Megas F-26' && facturaB?.serviceTv === 'Television26');
  const otraVezB = await servicio.aplicar(b.id, ['INTERNET', 'TV'], { ctx: 'smoke 2' });
  comprobar('llamarlo otra vez NO crea otra factura', !otraVezB.cobrado, otraVezB.mensaje);

  // ---------------------------------------------------------------- C ----
  // Factura del mes YA PAGADA: no se toca, se emite una nueva.
  console.log('\n=== C) La factura del mes ya está pagada: no se revive, se emite otra ===');
  const c = await nuevoAbonado(9003);
  const pagada = await prisma.subInvoice.create({
    data: {
      tid: 499002, subscriberId: c.id, invoiceDate: v.desde, dueDate: v.hasta,
      subtotal: 22269, tax: 4231, total: 26500, paidAmount: 26500, status: 'PAID', kind: 'RECURRENTE', itemsCount: 1,
      items: { create: [{ productId: 0, productName: 'Television26', description: 'Television26', qty: 1, price: 22269, taxRate: 19, subtotal: 22269, taxTotal: 4231 }] },
    },
  });
  const rC = await servicio.aplicar(c.id, ['INTERNET'], { ctx: 'smoke' });
  const pagadaDespues = await prisma.subInvoice.findUnique({ where: { id: pagada.id } });
  comprobar('la factura pagada queda intacta', Number(pagadaDespues!.total) === 26500 && pagadaDespues!.status === 'PAID' && !pagadaDespues!.editedAt);
  comprobar('el cobro se fue a una factura nueva', !!rC.facturaNueva && rC.invoiceTid !== 499002, `#${rC.invoiceTid}`);

  // ---------------------------------------------------------------- D ----
  // Mes ya facturado: no se cobra nada.
  console.log('\n=== D) El mes ya está facturado: no se cobra ===');
  const d = await nuevoAbonado(9004);
  await prisma.subInvoice.create({
    data: {
      tid: 499003, subscriberId: d.id, invoiceDate: v.desde, dueDate: v.hasta,
      subtotal: 50500, tax: 0, total: 50500, paidAmount: 0, status: 'DUE', kind: 'RECURRENTE', itemsCount: 1,
      items: { create: [{ productId: 0, productName: '100 Megas F-26', description: '100 Megas F-26', qty: 1, price: 50500, taxRate: 0, subtotal: 50500, taxTotal: 0 }] },
    },
  });
  const rD = await servicio.aplicar(d.id, ['INTERNET'], { ctx: 'smoke' });
  comprobar('no cobra ni crea nada', !rD.aplica && !rD.cobrado, rD.mensaje);
  comprobar('no aparecieron facturas de más', (await prisma.subInvoice.count({ where: { subscriberId: d.id } })) === 1);

  // ---------------------------------------------------------------- E ----
  // Modo informe: calcula pero no escribe.
  console.log('\n=== E) Modo informe: calcula y no toca la plata ===');
  await prisma.appSetting.create({ data: { key: 'billing.prorrateoReconexion', value: 'informe' } });
  const e = await nuevoAbonado(9005);
  const rE = await servicio.aplicar(e.id, ['INTERNET'], { ctx: 'smoke' });
  comprobar('dice cuánto sería', rE.aplica && rE.total === esperadoInternet, money(rE.total));
  comprobar('pero no escribe ninguna factura', !rE.cobrado && (await prisma.subInvoice.count({ where: { subscriberId: e.id } })) === 0);

  console.log(`\n${fallos === 0 ? '✅ Todo cuadra.' : `❌ ${fallos} comprobación(es) fallaron.`}\n`);
  await prisma.$disconnect();
  process.exit(fallos === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
