/**
 * El recorrido sugerido, contra la BD real.
 *
 * Comprueba lo que de verdad importa de la función: que el orden propuesto NO es
 * más largo que el que ya había, que las visitas no se pierden ni se duplican por
 * el camino, y que aplicarlo deja `scheduledSeq` en 1..N sin huecos ni repetidos
 * —el estado que el renumerado entero de la agenda existe para hacer imposible—.
 *
 * Escribe y REVIERTE: al terminar, la agenda del técnico que usó queda con el
 * mismo orden que tenía. No es cortesía: reordenarle el día a un técnico que ya
 * salió a la calle es cambiarle el trabajo.
 *
 * Uso: npx ts-node --transpile-only scripts/smoke-recorrido-agenda.ts
 */
import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { BusDeEventos } from '../src/core/eventos';
import { RoutingService } from '../src/geo/routing.service';
import { AgendaService } from '../src/support/agenda.service';

const prisma = new PrismaClient();
const agenda = new AgendaService(prisma as any, new BusDeEventos(), new RoutingService());
let ok = 0, fail = 0;
const assert = (cond: boolean, msg: string, extra: unknown = '') => {
  if (cond) { ok++; console.log(`  OK    ${msg}`); }
  else { fail++; console.log(`  FALLO ${msg}`, extra); }
};

const sesion = (u: { id: string; name: string; email: string }, permisos: string[]) =>
  ({ ...u, permissions: permisos, roles: [] }) as any;

async function main() {
  // La jornada más cargada que haya en la base, sea del día que sea: es donde el
  // recorrido tiene algo que decir. Con una o dos visitas no se prueba nada.
  const grupos = await prisma.ticket.groupBy({
    by: ['assignedStaffId', 'scheduledFor'],
    // PENDIENTES: una jornada entera de visitas ya cerradas no ejercita nada
    // —todas son `fija`— y el smoke pasaba en verde midiendo 0 metros.
    where: { scheduledFor: { not: null }, assignedStaffId: { not: null }, status: 'PENDIENTE' },
    _count: { _all: true },
    orderBy: { _count: { id: 'desc' } },
    take: 5,
  });
  const jornada = grupos.find((g) => g._count._all >= 3);
  if (!jornada?.assignedStaffId || !jornada.scheduledFor) {
    console.log('No hay ninguna jornada con 3+ visitas agendadas: no hay nada que probar.');
    return;
  }

  const staff = await prisma.staff.findUnique({
    where: { id: jornada.assignedStaffId },
    select: { id: true, name: true, sedeAccede: true },
  });
  const fecha = jornada.scheduledFor.toISOString().slice(0, 10);
  console.log(`\nJornada de prueba: ${staff?.name} · ${fecha} · ${jornada._count._all} visitas\n`);

  // Un superusuario: aquí se prueba el cálculo, no el alcance por sede (eso lo
  // cubre `puedeAgendarA`, compartido con `mover` y ya probado en otros smokes).
  const jefe = await prisma.user.findFirst({
    where: { isActive: true },
    select: { id: true, name: true, email: true },
    orderBy: { createdAt: 'asc' },
  });
  const user = sesion(jefe!, ['*']);

  const antes = await prisma.ticket.findMany({
    where: { scheduledFor: jornada.scheduledFor, assignedStaffId: staff!.id },
    select: { id: true, scheduledSeq: true },
    orderBy: [{ scheduledSeq: 'asc' }, { created: 'asc' }],
  });

  // --- 1. La propuesta ------------------------------------------------------
  const p: any = await agenda.recorrido(user, staff!.id, fecha);
  console.log(`  antes ${p.metrosAntes} m · propuesto ${p.metrosDespues} m · ahorro ${p.ahorroM} m` +
    ` · ${p.porCarretera ? 'por carretera' : 'línea recta'}${p.aproximado ? ' · alguna por barrio' : ''}`);

  assert(p.visitas.length === antes.length, 'no se pierde ni se inventa ninguna visita', { p: p.visitas.length, base: antes.length });
  assert(new Set(p.visitas.map((v: any) => v.id)).size === p.visitas.length, 'ninguna visita sale dos veces');
  assert(p.metrosDespues <= p.metrosAntes, 'el recorrido propuesto no es más largo que el actual');
  assert(
    p.visitas.every((v: any, i: number) => v.puestoPropuesto === i + 1),
    'los puestos propuestos van 1..N en el orden de la lista',
  );
  const cuenta = (u: string | null) => p.visitas.filter((v: any) => v.ubicacion === u).length;
  console.log(`  de campo: ${cuenta('exacto')} por GPS · ${cuenta('barrio')} por barrio · ` +
    `${cuenta(null)} sin ubicar · ${cuenta('remota')} sin desplazamiento (no entran en la ruta)`);

  // --- 2. Aplicar deja la columna 1..N --------------------------------------
  await agenda.aplicarRecorrido(user, { staffId: staff!.id, fecha, ticketIds: p.visitas.map((v: any) => v.id) });
  const despues = await prisma.ticket.findMany({
    where: { scheduledFor: jornada.scheduledFor, assignedStaffId: staff!.id },
    select: { id: true, scheduledSeq: true },
    orderBy: { scheduledSeq: 'asc' },
  });
  const seqs = despues.map((t) => t.scheduledSeq);
  assert(
    seqs.every((s, i) => s === i + 1),
    'la columna queda numerada 1..N, sin huecos ni repetidos',
    seqs,
  );
  assert(
    despues.map((t) => t.id).join() === p.visitas.map((v: any) => v.id).join(),
    'el orden guardado es exactamente el propuesto',
  );

  // --- 3. Rechaza una lista que no sea la jornada completa -------------------
  let rechazo = '';
  await agenda
    .aplicarRecorrido(user, { staffId: staff!.id, fecha, ticketIds: p.visitas.slice(1).map((v: any) => v.id) })
    .catch((e) => { rechazo = e.message; });
  assert(/cambió/i.test(rechazo), 'rechaza aplicar una lista incompleta (la agenda pudo cambiar)', rechazo);

  // --- Revertir -------------------------------------------------------------
  for (const t of antes) {
    await prisma.ticket.update({ where: { id: t.id }, data: { scheduledSeq: t.scheduledSeq } });
  }
  console.log('\n  (revertido: la agenda queda como estaba)');
  console.log(`\n${fail ? '❌' : '✅'} ${ok} bien, ${fail} mal\n`);
  process.exitCode = fail ? 1 : 0;
}

main().finally(() => prisma.$disconnect());
