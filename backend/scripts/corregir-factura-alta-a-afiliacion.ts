/**
 * Corrige una factura de alta que se emitió con la MENSUALIDAD en vez de la AFILIACIÓN.
 *
 * El alta de nexus emitió hasta el 2026-08-29 una RECURRENTE con los planes contratados
 * como "factura de afiliación" (ver `subscribers/alta.service.ts`). En ventanilla eso se
 * traduce en que la cajera cobra la afiliación —70.000— contra una factura de 76.900 y el
 * cliente entra debiendo la diferencia el mismo día que se da de alta.
 *
 * Este script deja la factura como debió nacer: FIJA, con el producto «Afiliación …» del
 * catálogo. Va por `FacturasService.updateInvoice`, no por SQL, para que pase por todo lo
 * que ese camino ya hace:
 *
 *   · recalcula el estado contra lo ya pagado (70.000 sobre 70.000 → PAGADA),
 *   · deja auditoría antes/después con el motivo,
 *   · marca `editedAt` para que el sync de ida no restaure los renglones del legacy,
 *   · ajusta el asiento contable por la diferencia.
 *
 * Al quedar PAGADA, el barrido `instalaciones-pagadas` (cada 5 min) abre sola la orden
 * de instalación que estaba esperando el pago.
 *
 *   npx ts-node scripts/corregir-factura-alta-a-afiliacion.ts <tid> [--afiliacion="Afiliación Combo"] [--aplicar]
 *
 * Sin `--aplicar` sólo enseña lo que haría.
 */
import 'reflect-metadata';
import { PrismaService } from '../src/prisma/prisma.service';
import { facturasService } from '../src/core/contenedor';
import { catalogoAfiliaciones, nombreSugerido } from '../src/subscribers/afiliacion';

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
const APLICAR = process.argv.includes('--aplicar');
const TID = Number(process.argv.find((a) => /^\d+$/.test(a)));

const pesos = (n: number) => n.toLocaleString('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });

async function main() {
  if (!Number.isFinite(TID)) throw new Error('Falta el número de factura (tid).');
  const prisma = new PrismaService();

  const inv = await prisma.subInvoice.findUnique({
    where: { tid: TID },
    include: {
      items: { orderBy: { id: 'asc' } },
      subscriber: { select: { id: true, abonado: true, fullName: true } },
    },
  });
  if (!inv) throw new Error(`No existe la factura #${TID}.`);

  const pagado = Number(inv.paidAmount);
  const servicios = await prisma.subscriberService.findMany({
    where: { subscriberId: inv.subscriberId },
    select: { kind: true },
  });

  // La afiliación: la que se pida, o la que le corresponde por lo que tiene contratado.
  const catalogo = await catalogoAfiliaciones(prisma);
  const pedida = arg('afiliacion');
  const sugerida = nombreSugerido(servicios.map((s) => s.kind));
  const nombre = pedida ?? sugerida;
  if (!nombre) throw new Error('No se pudo deducir la afiliación: pásala con --afiliacion="…".');
  const afiliacion = catalogo.find((a) => a.name.toLowerCase() === nombre.toLowerCase());
  if (!afiliacion) throw new Error(`«${nombre}» no está en el catálogo de afiliaciones.`);

  // Lo que ya se pagó manda sobre el precio de lista: si el cliente entregó 70.000 y la
  // afiliación son 70.000, cuadra; si entregó menos, `updateInvoice` la dejaría PARCIAL,
  // que es lo correcto. Lo que NO se puede es dejar la factura por debajo de lo pagado.
  const precio = Math.max(afiliacion.price, pagado);

  console.log(`Factura #${inv.tid} · ${inv.subscriber.fullName} (abonado ${inv.subscriber.abonado})`);
  console.log(`  ANTES : ${inv.kind} ${pesos(Number(inv.total))} · ${inv.status} · pagado ${pesos(pagado)}`);
  for (const it of inv.items) console.log(`          · ${it.productName} ${pesos(Number(it.price))}`);
  console.log(`  DESPUÉS: FIJA ${pesos(precio)} · ${precio <= pagado ? 'PAID' : pagado > 0 ? 'PARTIAL' : 'DUE'}`);
  console.log(`          · ${afiliacion.name} ${pesos(precio)}`);
  if (precio !== afiliacion.price) {
    console.log(`  (el catálogo dice ${pesos(afiliacion.price)}; se sube a lo ya pagado para no dejar saldo a favor invisible)`);
  }

  if (!APLICAR) {
    console.log('\nSimulación. Añade --aplicar para escribirlo.');
    await prisma.$disconnect();
    return;
  }

  const res = await facturasService.updateInvoice(
    inv.id,
    {
      kind: 'FIJA',
      notes: 'Factura de afiliación (alta del cliente).',
      reason: 'El alta emitió la mensualidad en vez de la afiliación: se corrige al producto del catálogo.',
      items: [{
        productId: afiliacion.productId, productName: afiliacion.name, description: afiliacion.name,
        qty: 1, price: precio, taxRate: afiliacion.taxRate,
      }],
    } as any,
    { id: 'system', email: 'cron@vestel', name: 'Corrección de afiliación', roles: [], permissions: ['system.admin'] } as any,
  );

  console.log(`\nHecho: #${res.tid} queda ${res.status} por ${pesos(res.total)} (saldo ${pesos(res.balance)}).`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
