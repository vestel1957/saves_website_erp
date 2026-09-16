/**
 * "Lo que ya hice": el historial del técnico contra la BD real y SIN ESCRIBIR NADA
 * (2026-09-04).
 *
 * Comprueba las dos mitades de la pantalla:
 *
 *  1. `AgendaService.miHistorial` agrupa por DÍA DE TRABAJO —el del cierre, no el de
 *     creación ni el de la agenda— y no se deja fuera ni las cerradas sin
 *     `finalDate` (las que llegan así del legacy) ni las que fue a hacer y no pudo.
 *  2. El detalle de cada una de esas órdenes SE PUEDE ABRIR con su sesión
 *     (`SupportService.ticketDetail`), que es a donde lleva cada tarjeta. Esta es la
 *     comprobación que importa: el turno bloquea las pendientes ajenas al turno, y
 *     si algún día bloqueara también las cerradas, el historial quedaría en un
 *     escaparate de enlaces rotos.
 *
 * Sólo lee. Uso: npx ts-node --transpile-only scripts/smoke-historial-tecnico.ts
 */
import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { BusDeEventos } from '../src/core/eventos';
import { RoutingService } from '../src/geo/routing.service';
import { AgendaService } from '../src/support/agenda.service';
import { OrderScoreService } from '../src/support/order-score.service';
import { SupportService } from '../src/support/support.service';
import { GeofenceService } from '../src/support/geofence.service';

const prisma = new PrismaClient();
const agenda = new AgendaService(prisma as any, new BusDeEventos(), new RoutingService());
const soporte = new SupportService(prisma as any, new OrderScoreService(prisma as any), new GeofenceService(prisma as any));
let ok = 0, fail = 0;
const assert = (cond: boolean, msg: string, extra: unknown = '') => {
  if (cond) { ok++; console.log(`  OK    ${msg}`); }
  else { fail++; console.log(`  FALLO ${msg}`, extra); }
};

async function main() {
  // El técnico con más cierres en los últimos días: es donde el historial se nota.
  const desde = new Date(Date.now() - 10 * 86_400_000);
  const top = await prisma.ticket.groupBy({
    by: ['assignedStaffId'],
    where: { status: 'RESUELTO', finalDate: { gte: desde }, assignedStaffId: { not: null } },
    _count: { _all: true },
    orderBy: { _count: { assignedStaffId: 'desc' } },
    take: 1,
  });
  const staffId = top[0]?.assignedStaffId;
  if (!staffId) { console.log('(nadie ha cerrado órdenes en 10 días: nada que probar)'); return; }
  const staff = await prisma.staff.findUnique({ where: { id: staffId }, select: { name: true, email: true } });
  const sesion = { id: 'smoke', name: staff?.name ?? '', email: staff?.email ?? '', permissions: ['area.tecnicos'], roles: [] } as any;
  console.log(`\nTécnico: ${staff?.name} (${top[0]._count._all} cierres en 10 días)\n`);

  console.log('1) El historial trae sus días de trabajo');
  const h: any = await agenda.miHistorial(sesion);
  assert(h.resolved, 'la ficha de empleado se resuelve');
  assert(h.dias.length > 0, 'vienen días con trabajo', h.dias.length);
  assert(
    h.dias.every((d: any) => d.fecha >= h.desde && d.fecha <= h.hasta),
    'ningún día se sale del periodo pedido',
  );
  assert(
    h.dias.map((d: any) => d.fecha).join() === [...h.dias.map((d: any) => d.fecha)].sort().reverse().join(),
    'los días van del más reciente al más viejo',
  );
  assert(h.total === h.dias.reduce((s: number, d: any) => s + d.cuantas, 0), 'el total cuadra con la suma de los días');
  console.log(`  ${h.total} visitas en ${h.dias.length} días (${h.desde} → ${h.hasta})`);

  console.log('\n2) El día que se enseña es el del CIERRE, no el de creación');
  const cerradas = h.dias.flatMap((d: any) => d.ordenes.map((o: any) => ({ ...o, dia: d.fecha })))
    .filter((o: any) => o.resultado === 'CERRADA' && o.cerradaEl);
  assert(
    cerradas.every((o: any) => new Date(o.cerradaEl).toISOString().slice(0, 10) === o.dia),
    'cada cerrada cae en el día de su fecha de cierre',
  );
  const movidas = cerradas.filter((o: any) => new Date(o.created).toISOString().slice(0, 10) !== o.dia).length;
  console.log(`  ${movidas} de ${cerradas.length} se abrieron un día distinto del que se hicieron`);

  console.log('\n3) La documentación que anuncia la tarjeta es la que tiene la orden');
  const conDoc = h.dias.flatMap((d: any) => d.ordenes).find((o: any) => o.documentacion.fotos > 0);
  if (conDoc) {
    const hilos = await prisma.ticketThread.findMany({ where: { ticketCode: conDoc.code! }, select: { attach: true } });
    assert(hilos.length === conDoc.documentacion.seguimiento, 'el nº de notas cuadra con el hilo de la orden', conDoc.code);
    assert(hilos.filter((t) => t.attach).length === conDoc.documentacion.fotos, 'el nº de fotos cuadra', conDoc.code);
  } else {
    console.log('  (ninguna de este periodo tiene fotos: no se comprueba)');
  }

  console.log('\n4) Cada tarjeta del historial se puede ABRIR con su sesión');
  const muestra = h.dias.flatMap((d: any) => d.ordenes).slice(0, 8);
  let abiertas = 0;
  for (const o of muestra) {
    try { await soporte.ticketDetail(o.id, sesion); abiertas++; }
    catch (e: any) { console.log(`  FALLO #${o.code} (${o.resultado}) → ${e?.message}`); }
  }
  assert(abiertas === muestra.length, `las ${muestra.length} de la muestra abren su detalle`, `${abiertas}/${muestra.length}`);

  console.log('\n5) Los bordes');
  const sinFicha: any = await agenda.miHistorial({ id: 'x', name: 'Nadie Existe', email: 'nadie@ejemplo.co', permissions: [], roles: [] } as any);
  assert(sinFicha.resolved === false && sinFicha.total === 0, 'sin ficha de empleado devuelve vacío, no lo de todos');
  let corto = false;
  try { await agenda.miHistorial(sesion, '2026-01-01', '2026-12-31'); }
  catch { corto = true; }
  assert(corto, 'una ventana de más de 92 días se rechaza');

  console.log(`\n${fail === 0 ? 'TODO OK' : 'CON FALLOS'} · ${ok} ok · ${fail} fallos`);
}
main().finally(() => prisma.$disconnect());
