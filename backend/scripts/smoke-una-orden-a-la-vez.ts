/**
 * "Una orden a la vez", contra la BD real y SIN ESCRIBIR NADA.
 *
 * Nació como el smoke del turno del técnico (2026-09-02) y comprueba lo mismo que
 * entonces, con el alcance que quedó el 2026-09-10 después de leer el legacy
 * (`application/controllers/Tickets.php` → `update_status`):
 *
 *  1. Ancla lo EMPEZADO (`REALIZANDO`) y sólo eso — el `status='Realizando'` del
 *     legacy—, y nunca una empezada del rezago.
 *  2. Lo único que se bloquea es EMPEZAR una segunda. La suya se puede volver a
 *     empezar, y quien no tiene ninguna empezada empieza la que quiera.
 *  3. **Lo que ya NO se bloquea, y es el cambio del día**: tener la agenda repartida
 *     no ancla. Quien sólo tiene órdenes asignadas o agendadas —aunque sean catorce y
 *     sean de hoy— trabaja sin candado.
 *  4. La pantalla dice lo mismo que el candado (`miAgenda.enCurso`), que es lo que
 *     evita ofrecer una visita que la API rechaza.
 *  5. Y el exento (`Staff.agendaLibre`) sigue exento.
 *
 * Sólo lee. No agenda, no cierra y no aparta: meterle a un funcionario un cambio en su
 * día es trabajo que alguien iría a hacer.
 *
 * Uso: npx tsx scripts/smoke-una-orden-a-la-vez.ts
 */
import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { BusDeEventos } from '../src/core/eventos';
import { RoutingService } from '../src/geo/routing.service';
import { AgendaService } from '../src/support/agenda.service';
import { ordenEnCurso, puedeEmpezarOrden, tieneAgendaLibre } from '../src/support/turno';
import { DIAS_REZAGO } from '../src/support/agenda-dia';
import { hoyEnColombia } from '../src/common/fecha-colombia';

const prisma = new PrismaClient();
const agenda = new AgendaService(prisma as any, new BusDeEventos(), new RoutingService());
let ok = 0, fail = 0;
const assert = (cond: boolean, msg: string, extra: unknown = '') => {
  if (cond) { ok++; console.log(`  OK    ${msg}`); }
  else { fail++; console.log(`  FALLO ${msg}`, extra); }
};

const ABIERTA = ['PENDIENTE', 'REALIZANDO'] as const;

async function main() {
  // El interruptor general está APAGADO en producción (sólo el técnico de campo lleva
  // el candado, ver `turnoAplicaA`). El smoke lo enciende para poder probar la regla
  // con cualquier funcionario, sea o no de campo. Nada de esto escribe nada.
  process.env.UNA_ORDEN_A_LA_VEZ = 'true';
  console.log('\n(el interruptor general está apagado en producción; este smoke lo enciende sólo para probar la regla)');

  const hoy = hoyEnColombia();
  const corteRezago = new Date(hoy.getTime() - DIAS_REZAGO * 86400_000);
  console.log(`\nHoy en Colombia: ${hoy.toISOString().slice(0, 10)} · el rezago empieza antes del ${corteRezago.toISOString().slice(0, 10)}\n`);

  // Los exentos (`Staff.agendaLibre`) quedan fuera de las pruebas del candado: a ellos
  // no les rige, y elegir a uno de cobaya haría fallar la prueba por el motivo correcto.
  const exentos = await prisma.staff.findMany({ where: { agendaLibre: true }, select: { id: true, name: true, email: true } });
  const idsExentos = exentos.map((e) => e.id);

  // ── 1 y 2: alguien con una orden EMPEZADA viva ──────────────────────────────
  const empezada = await prisma.ticket.findFirst({
    where: { status: 'REALIZANDO', created: { gte: corteRezago }, assignedStaffId: { not: null, notIn: idsExentos } },
    select: { id: true, code: true, assignedStaffId: true },
    orderBy: { created: 'desc' },
  });
  if (!empezada) {
    console.log('(nadie tiene una orden EMPEZADA viva: no hay a quién anclar hoy)');
  } else {
    const staffId = empezada.assignedStaffId!;
    const staff = await prisma.staff.findUnique({ where: { id: staffId }, select: { name: true, email: true, area: { select: { name: true } } } });
    console.log(`Funcionario con orden empezada: ${staff?.name} · área ${staff?.area?.name ?? '—'}\n`);

    console.log('1) La orden que lo ancla');
    const enCurso = await ordenEnCurso(prisma as any, staffId);
    assert(!!enCurso, 'tiene una orden en curso', enCurso);
    const ancla = await prisma.ticket.findUnique({ where: { id: enCurso!.id }, select: { status: true, created: true, code: true } });
    assert(ancla!.status === 'REALIZANDO', 'está EMPEZADA (no basta con estar asignada o agendada)', ancla!.status);
    assert(ancla!.created >= corteRezago, 'NO es rezago: nadie queda anclado a una empezada de hace dos años', ancla!.created);
    console.log(`  #${enCurso!.code} · ${enCurso!.type} · ${enCurso!.cliente ?? 'sin cliente'} · agendada: ${enCurso!.agendadaPara ?? 'no'}`);

    console.log('\n2) El candado: sólo tapa EMPEZAR la segunda');
    const v = await puedeEmpezarOrden(prisma as any, staffId, { id: enCurso!.id });
    assert(v.permitido, 'la que ya tiene empezada no se bloquea a sí misma');

    const otraSuya = await prisma.ticket.findFirst({
      where: { assignedStaffId: staffId, status: { in: [...ABIERTA] }, id: { not: enCurso!.id } },
      select: { id: true, code: true },
    });
    if (otraSuya) {
      const w = await puedeEmpezarOrden(prisma as any, staffId, otraSuya);
      assert(!w.permitido, `no puede empezar otra suya (#${otraSuya.code})`);
      if (!w.permitido) assert(w.enCurso.id === enCurso!.id, 'y el 403 dice a cuál ir (el enlace del aviso)');
    }

    console.log('\n3) La pantalla dice lo mismo que el candado');
    const sesion = { id: 'smoke', name: staff?.name ?? '', email: staff?.email ?? '', permissions: ['area.tecnicos'], roles: [] } as any;
    const mi = await agenda.miAgenda(sesion);
    assert(mi.resolved, 'la ficha de empleado se resuelve por correo');
    assert(mi.enCurso?.id === enCurso!.id, '`miAgenda.enCurso` es la MISMA orden que ancla el candado', { pantalla: mi.enCurso?.id, candado: enCurso!.id });
    assert(
      mi.enTurno === null || mi.ordenes.some((o: any) => o.id === mi.enTurno),
      'y si destaca una tarjeta del día, es una de su jornada',
    );
  }

  // ── 4: EL CAMBIO DEL 2026-09-10 ────────────────────────────────────────────
  // Tener la agenda repartida ya no ancla. Es lo que se rompería si alguien devolviera
  // el `OR` con `PENDIENTE` a `ordenEnCurso`, y es lo que el usuario pidió al ver el
  // legacy: allá sólo cuenta `Realizando`.
  console.log('\n4) Tener la agenda repartida NO ancla (el cambio del día)');
  const conAgendaSinEmpezar = await prisma.staff.findMany({
    where: {
      banned: false,
      agendaLibre: false,
      tickets: {
        some: { status: 'PENDIENTE', scheduledFor: { lte: hoy }, created: { gte: corteRezago } },
        none: { status: 'REALIZANDO', created: { gte: corteRezago } },
      },
    },
    select: { id: true, name: true, _count: { select: { tickets: { where: { status: { in: [...ABIERTA] } } } } } },
    take: 5,
  });
  if (conAgendaSinEmpezar.length === 0) {
    console.log('  (hoy nadie tiene visitas del día sin haber empezado ninguna)');
  }
  for (const s of conAgendaSinEmpezar) {
    const suya = await ordenEnCurso(prisma as any, s.id);
    assert(suya === null, `${s.name} (${s._count.tickets} abiertas) NO queda anclado por su agenda`, suya?.code);
    const cualquiera = await prisma.ticket.findFirst({
      where: { assignedStaffId: s.id, status: 'PENDIENTE' },
      select: { id: true, code: true },
    });
    if (cualquiera) {
      const r = await puedeEmpezarOrden(prisma as any, s.id, cualquiera);
      assert(r.permitido, `  y puede empezar la visita que le toque (#${cualquiera.code})`);
    }
  }

  console.log('\n5) Quien no tiene ninguna empezada trabaja sin candado');
  const libreDeCarga = await prisma.staff.findFirst({
    where: {
      banned: false,
      agendaLibre: false,
      tickets: { none: { status: 'REALIZANDO', created: { gte: corteRezago } }, some: {} },
    },
    select: { id: true, name: true },
  });
  if (libreDeCarga) {
    const s = await puedeEmpezarOrden(prisma as any, libreDeCarga.id, { id: 'la-que-sea' });
    assert(s.permitido, `${libreDeCarga.name} puede empezar cualquier orden`);
  } else {
    console.log('  (no se encontró a nadie sin órdenes empezadas)');
  }

  console.log('\n6) El exento sigue exento');
  if (exentos.length === 0) console.log('  (nadie tiene la excepción `agendaLibre`)');
  for (const ex of exentos) {
    assert(await tieneAgendaLibre(prisma as any, ex.id), `${ex.name} está marcado como exento`);
    const otra = await prisma.ticket.findFirst({ where: { status: { in: [...ABIERTA] } }, select: { id: true } });
    if (otra) {
      const r = await puedeEmpezarOrden(prisma as any, ex.id, otra);
      assert(r.permitido, 'y empieza cualquier orden abierta');
    }
    const suya = await agenda.miAgenda({ id: 'smoke', name: ex.name, email: ex.email ?? '', permissions: ['area.tecnicos'], roles: [] } as any);
    assert(suya.turnoLibre === true && suya.enCurso === null, 'su agenda viaja sin candado (turnoLibre, enCurso null)');
  }

  console.log(`\n${fail === 0 ? 'TODO OK' : 'HAY FALLOS'} — ${ok} ok, ${fail} fallos\n`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
