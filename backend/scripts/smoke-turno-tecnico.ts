/**
 * El turno obligatorio, contra la BD real y SIN ESCRIBIR NADA (2026-09-02).
 *
 * Comprueba las dos cosas que tienen que coincidir para que el técnico no se
 * encuentre con una pantalla que le ofrece una visita y una API que se la niega:
 *
 *  1. `miAgenda` marca como `enTurno` la PRIMERA abierta de su jornada (contando lo
 *     arrastrado de días anteriores, que va delante).
 *  2. `puedeAbrirOrden` deja abrir esa y sólo esa: las demás pendientes 403, las ya
 *     cerradas siempre sí, y un técnico sin nada agendado no queda bloqueado.
 *
 * Sólo lee. No agenda, no cierra y no aparta: meterle a un técnico un cambio en su
 * día de hoy es trabajo que alguien iría a hacer.
 *
 * Uso: npx ts-node --transpile-only scripts/smoke-turno-tecnico.ts
 */
import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { BusDeEventos } from '../src/core/eventos';
import { RoutingService } from '../src/geo/routing.service';
import { AgendaService } from '../src/support/agenda.service';
import { puedeAbrirOrden, tieneAgendaLibre } from '../src/support/turno';
import { hoyEnColombia } from '../src/common/fecha-colombia';

const prisma = new PrismaClient();
const agenda = new AgendaService(prisma as any, new BusDeEventos(), new RoutingService());
let ok = 0, fail = 0;
const assert = (cond: boolean, msg: string, extra: unknown = '') => {
  if (cond) { ok++; console.log(`  OK    ${msg}`); }
  else { fail++; console.log(`  FALLO ${msg}`, extra); }
};

async function main() {
  const hoy = hoyEnColombia();
  console.log(`\nHoy en Colombia: ${hoy.toISOString().slice(0, 10)}\n`);

  // Los exentos del turno (`Staff.agendaLibre`) quedan fuera de las tres primeras
  // pruebas: a ellos no les rige, y elegir a uno como cobaya haría fallar el turno
  // por el motivo correcto. Se prueban aparte, en el punto 4.
  const exentos = (await prisma.staff.findMany({ where: { agendaLibre: true }, select: { id: true, name: true, email: true } }));
  const idsExentos = exentos.map((e) => e.id);

  // El técnico con más visitas abiertas hoy: es el único caso donde el turno se nota.
  const abiertas = await prisma.ticket.groupBy({
    by: ['assignedStaffId'],
    where: { scheduledFor: { lte: hoy }, status: { in: ['PENDIENTE', 'REALIZANDO'] }, assignedStaffId: { not: null, notIn: idsExentos } },
    _count: { _all: true },
    orderBy: { _count: { assignedStaffId: 'desc' } },
    take: 1,
  });
  const staffId = abiertas[0]?.assignedStaffId;
  if (!staffId) {
    console.log('(hoy nadie tiene visitas abiertas agendadas: nada que probar)');
    return;
  }
  const staff = await prisma.staff.findUnique({ where: { id: staffId }, select: { name: true, email: true } });
  console.log(`Técnico: ${staff?.name} (${abiertas[0]._count._all} abiertas hoy)\n`);

  // La sesión tal como la arma `resolveUser()`. Da igual el id: `miAgenda` resuelve
  // la ficha por correo (o por nombre), que es como se liga usuario ↔ empleado.
  const sesion = { id: 'smoke', name: staff?.name ?? '', email: staff?.email ?? '', permissions: ['area.tecnicos'], roles: [] } as any;

  console.log('1) La pantalla marca UNA visita en turno');
  const mi = await agenda.miAgenda(sesion);
  const pendientes = mi.ordenes.filter((o: any) => o.status === 'PENDIENTE' || o.status === 'REALIZANDO');
  assert(mi.resolved, 'la ficha de empleado se resuelve por correo');
  assert(!!mi.enTurno, 'viene una visita en turno', mi.enTurno);
  assert(mi.enTurno === pendientes[0]?.id, 'la en turno es la PRIMERA abierta de la jornada', {
    enTurno: mi.enTurno, primera: pendientes[0]?.id,
  });
  console.log(`  jornada: ${mi.ordenes.length} visitas (${pendientes.length} abiertas)`);

  console.log('\n2) El candado del backend dice lo mismo que la pantalla');
  const v = await puedeAbrirOrden(prisma as any, staffId, { id: mi.enTurno!, status: 'PENDIENTE' });
  assert(v.permitido, 'la visita en turno se puede abrir');

  const otra = pendientes.find((o: any) => o.id !== mi.enTurno);
  if (otra) {
    const w = await puedeAbrirOrden(prisma as any, staffId, { id: otra.id, status: otra.status });
    assert(!w.permitido, 'otra pendiente del mismo día queda bloqueada', otra.id);
  } else {
    console.log('  (sólo tiene una abierta: no hay "siguiente" con la que probar el bloqueo)');
  }

  const cerrada = await prisma.ticket.findFirst({
    where: { assignedStaffId: staffId, status: { in: ['RESUELTO', 'ANULADA'] } },
    select: { id: true, status: true },
  });
  if (cerrada) {
    const c = await puedeAbrirOrden(prisma as any, staffId, cerrada);
    assert(c.permitido, 'una orden ya cerrada sigue abriéndose (es su historial)');
  }

  console.log('\n3) Un técnico sin agenda hoy no queda bloqueado');
  const sinAgenda = await prisma.staff.findFirst({
    where: {
      banned: false,
      id: { not: staffId },
      // Sin nada agendado hoy, pero con órdenes suyas: si no, se probaría con alguien
      // que no es técnico y el caso perdería el sentido.
      tickets: {
        none: { scheduledFor: { lte: hoy }, status: { in: ['PENDIENTE', 'REALIZANDO'] } },
        some: {},
      },
    },
    select: { id: true, name: true },
  }).catch(() => null);
  if (sinAgenda) {
    const s = await puedeAbrirOrden(prisma as any, sinAgenda.id, { id: 'la-que-sea', status: 'PENDIENTE' });
    assert(s.permitido, `${sinAgenda.name} puede trabajar aunque no le repartieran el día`);
  } else {
    console.log('  (no se encontró un técnico sin agenda con el que probarlo)');
  }

  console.log('\n4) El técnico exento ve y abre TODA su agenda');
  if (exentos.length === 0) {
    console.log('  (nadie tiene la excepción `agendaLibre`: nada que probar)');
  }
  for (const ex of exentos) {
    const libre = await tieneAgendaLibre(prisma as any, ex.id);
    assert(libre, `${ex.name} está marcado como exento del turno`);

    const sesionEx = { id: 'smoke', name: ex.name, email: ex.email ?? '', permissions: ['area.tecnicos'], roles: [] } as any;
    const suya = await agenda.miAgenda(sesionEx);
    assert(suya.turnoLibre === true, 'su agenda viaja con turnoLibre = true');
    assert(suya.enTurno === null, 'y sin visita en turno: no hay ninguna que le tape las demás');

    const susPendientes = suya.ordenes.filter((o: any) => o.status === 'PENDIENTE' || o.status === 'REALIZANDO');
    console.log(`  jornada de ${ex.name}: ${suya.ordenes.length} visitas (${susPendientes.length} abiertas)`);
    if (susPendientes.length > 1) {
      const veredictos = await Promise.all(
        susPendientes.map((o: any) => puedeAbrirOrden(prisma as any, ex.id, { id: o.id, status: o.status })),
      );
      assert(veredictos.every((r) => r.permitido), 'puede abrir cualquiera de sus pendientes de hoy');
    } else {
      console.log('  (hoy no tiene dos abiertas con las que probar que puede elegir)');
    }
  }

  console.log(`\n${fail === 0 ? 'TODO OK' : 'HAY FALLOS'} — ${ok} ok, ${fail} fallos\n`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
