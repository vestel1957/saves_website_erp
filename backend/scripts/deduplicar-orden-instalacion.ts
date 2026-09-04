/**
 * Deja UNA sola orden de instalación por alta.
 *
 * El caso que lo motiva (2026-09-02, abonado 57443): el cliente pagó la afiliación por
 * el PORTAL (PSE). El pago se aplica en el sistema anterior, que abre su propia orden
 * (`Invoices_model::validacion_generar_orden_instalacion`); el sync la trajo, y cinco
 * minutos después el barrido de nexus abrió otra. Dos visitas para la misma casa.
 *
 * El código ya no las duplica —ahora ADOPTA la que exista, ver `instalacion-existente.ts`—,
 * pero las que ya nacieron duplicadas hay que juntarlas a mano, que es lo que hace esto:
 *
 *   · se QUEDA la orden más antigua (la primera que se abrió);
 *   · se le añade el contexto de la visita (dirección, tecnología, PPPoE, celular) que
 *     traía la otra, sin pisar lo que ya tuviera;
 *   · la sobrante se ANULA (no se borra: borrar aquí no se propaga allá — ver la nota de
 *     los borrados con lápida— mientras que anular sí viaja por el writeback);
 *   · la instalación pendiente queda apuntando a la que se queda.
 *
 * En SECO por defecto. Para aplicarlo:
 *   npx ts-node --transpile-only scripts/deduplicar-orden-instalacion.ts --aplicar
 *   npx ts-node --transpile-only scripts/deduplicar-orden-instalacion.ts --abonado=57443 --aplicar
 */
import { PrismaClient } from '@prisma/client';
import { completarOrdenAdoptada } from '../src/subscribers/instalacion-existente';

const prisma = new PrismaClient();
const APLICAR = process.argv.includes('--aplicar');
const ABONADO = Number(process.argv.find((a) => a.startsWith('--abonado='))?.split('=')[1]) || null;
/** Sólo se miran las órdenes recientes: las instalaciones viejas del legacy no se tocan. */
const DIAS = Number(process.argv.find((a) => a.startsWith('--dias='))?.split('=')[1]) || 60;

async function main() {
  const desde = new Date(Date.now() - DIAS * 24 * 60 * 60 * 1000);
  const abiertas = await prisma.ticket.findMany({
    where: {
      type: 'Instalacion',
      status: { in: ['PENDIENTE', 'REALIZANDO'] },
      createdAt: { gte: desde },
      // Las órdenes SIN abonado (las que abre el chatbot para un interesado que aún no
      // es cliente) no se agrupan: no son la misma casa, sólo comparten el hueco.
      subscriberId: { not: null },
      ...(ABONADO ? { subscriber: { abonado: ABONADO } } : {}),
    },
    select: {
      id: true, code: true, legacyId: true, status: true, section: true, problem: true,
      invoiceLegacy: true, createdAt: true, col: true,
      subscriberId: true, subscriber: { select: { abonado: true, fullName: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  const porAbonado = new Map<string, typeof abiertas>();
  for (const t of abiertas) {
    if (!t.subscriberId) continue;
    const lista = porAbonado.get(t.subscriberId) ?? [];
    lista.push(t);
    porAbonado.set(t.subscriberId, lista);
  }

  const duplicados = [...porAbonado.values()].filter((l) => l.length > 1);
  console.log(`Órdenes de instalación abiertas en los últimos ${DIAS} días: ${abiertas.length}`);
  console.log(`Abonados con MÁS DE UNA: ${duplicados.length}${APLICAR ? '' : '  (SECO: no se escribe nada)'}\n`);

  for (const lista of duplicados) {
    const [sequeda, ...sobran] = lista;
    const ab = sequeda.subscriber;
    console.log(`Abonado ${ab?.abonado} · ${ab?.fullName}`);
    console.log(`  SE QUEDA   #${sequeda.code} (${sequeda.createdAt.toISOString()}) ${sequeda.col ?? '—'} · factura ${sequeda.invoiceLegacy ?? '—'}`);

    // El contexto de la visita: el que tenga la sobrante y le falte a la que se queda.
    const contexto = sobran.map((s) => s.section).find((sec) => (sec ?? '').includes('Dirección:')) ?? null;
    const cambios = completarOrdenAdoptada(sequeda, contexto);
    if (Object.keys(cambios).length) console.log(`  + contexto  ${JSON.stringify(cambios)}`);

    for (const s of sobran) {
      console.log(`  SE ANULA   #${s.code} (${s.createdAt.toISOString()}) ${s.col ?? '—'}`);
    }

    if (!APLICAR) { console.log(''); continue; }

    if (Object.keys(cambios).length) {
      await prisma.ticket.update({ where: { id: sequeda.id }, data: { ...cambios, editedAt: new Date() } });
    }
    for (const s of sobran) {
      await prisma.ticket.update({
        where: { id: s.id },
        // `editedAt` es lo que hace que la anulación viaje al sistema anterior y que la
        // ida no la resucite en la pasada siguiente.
        data: { status: 'ANULADA', editedAt: new Date() },
      });
    }
    // La instalación pendiente apunta a la que se queda.
    await prisma.pendingInstall.updateMany({
      where: { subscriberId: sequeda.subscriberId!, ticketId: { in: sobran.map((s) => s.id) } },
      data: { ticketId: sequeda.id, ticketCode: sequeda.code },
    });
    console.log('  ✓ aplicado\n');
  }

  if (!duplicados.length) console.log('Nada que juntar.');
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
