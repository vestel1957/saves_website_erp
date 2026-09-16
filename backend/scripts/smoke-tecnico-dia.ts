/**
 * El día del técnico y sus dos candados nuevos, contra la BD real y SIN ESCRIBIR
 * NADA (2026-09-10). Comprueba los tres requerimientos que se pueden comprobar
 * leyendo:
 *
 *  1. **`/soporte` es sólo su día.** Se cuenta lo que veía antes (TODAS sus órdenes)
 *     y lo que ve ahora (`whereTrabajoDelDia`), y se verifica que lo que queda es de
 *     hoy: agendado para hoy o atrasado abierto, empezado, asignado hoy sin agendar,
 *     o cerrado/apartado hoy. Que el número baje no basta: lo que importa es que no
 *     se le esconda trabajo vivo.
 *  2. **La ficha del cliente, sólo la de sus órdenes** (`esClienteDeSuOrden`): sí
 *     para un abonado suyo, no para uno de otro técnico.
 *  3. **El turno le aplica sin el interruptor general** (`turnoAplicaA`), que es el
 *     cambio del día: hasta ayer el candado estaba apagado para todo el mundo.
 *
 * Sólo lee. Uso: npx tsx scripts/smoke-tecnico-dia.ts
 */
import 'reflect-metadata';
import { PrismaClient, Prisma } from '@prisma/client';
import { hoyEnColombia } from '../src/common/fecha-colombia';
import { DIAS_REZAGO, whereTrabajoDelDia } from '../src/support/agenda-dia';
import { esClienteDeSuOrden, esTecnicoDeCampo } from '../src/common/tecnico-scope';
import { ordenEnCurso, puedeEmpezarOrden, turnoAplicaA } from '../src/support/turno';
import type { AuthUser } from '../src/auth/current-user.decorator';

const prisma = new PrismaClient();
let ok = 0, fail = 0;
const assert = (cond: boolean, msg: string, extra: unknown = '') => {
  if (cond) { ok++; console.log(`  OK    ${msg}`); }
  else { fail++; console.log(`  FALLO ${msg}`, extra); }
};

/** Una sesión de técnico de campo como la que arma `resolveUser` para su cuenta. */
const sesionTecnica = (u: { id: string; email: string; name: string }): AuthUser =>
  ({ ...u, permissions: ['area.tecnicos'], roles: ['Técnicos'] }) as unknown as AuthUser;

async function main() {
  const hoy = hoyEnColombia();
  // El candado no ancla a una orden empezada más vieja que el rezago (ver `turno.ts`).
  const corteRezago = new Date(hoy.getTime() - DIAS_REZAGO * 86400_000);
  console.log(`\nHoy en Colombia: ${hoy.toISOString().slice(0, 10)}\n`);

  // — El interruptor general sigue apagado: es la premisa de todo lo de abajo —
  delete process.env.UNA_ORDEN_A_LA_VEZ;
  assert(turnoAplicaA(sesionTecnica({ id: 'u', email: 'x@y.z', name: 'X' })), 'el turno le aplica al técnico de campo sin el interruptor');
  assert(!turnoAplicaA({ id: 'u', email: 'x@y.z', name: 'X', permissions: ['area.caja'] } as unknown as AuthUser), 'a la cajera NO le aplica (el interruptor sigue apagado)');
  assert(!turnoAplicaA(undefined), 'los procesos internos (sin usuario) siguen sin turno');

  // — Los técnicos con más carga viva, que son los que notarán el recorte —
  // Sólo fichas VIVAS: un ex-empleado (`banned`) no resuelve ficha —y por tanto no
  // ve nada, que es el lado seguro—, así que elegirlo de cobaya haría fallar la
  // prueba por el motivo correcto. Le pasa a Fabio Enrique, que sigue con 6.615
  // órdenes a su nombre y hace tiempo que no trabaja aquí.
  const vivos = await prisma.staff.findMany({ where: { banned: false }, select: { id: true } });
  const cargas = await prisma.ticket.groupBy({
    by: ['assignedStaffId'],
    where: { assignedStaffId: { in: vivos.map((v) => v.id) } },
    _count: { _all: true },
    orderBy: { _count: { assignedStaffId: 'desc' } },
    take: 6,
  });

  for (const c of cargas) {
    const staff = await prisma.staff.findUnique({
      where: { id: c.assignedStaffId! },
      select: { id: true, name: true, username: true, email: true },
    });
    if (!staff) continue;
    const claves = [staff.name, staff.username].filter((s): s is string => Boolean(s?.trim()));
    const suyas: Prisma.TicketWhereInput = {
      OR: [{ assignedStaffId: staff.id }, ...(claves.length ? [{ assigned: { in: claves } }] : [])],
    };

    const antes = await prisma.ticket.count({ where: suyas });
    const ahora = await prisma.ticket.findMany({
      where: { AND: [suyas, whereTrabajoDelDia(hoy)] },
      select: { code: true, status: true, scheduledFor: true, created: true, finalDate: true, resolvedAt: true, skippedAt: true },
    });

    console.log(`\n${staff.name} — antes veía ${antes} órdenes; ahora ve ${ahora.length}`);
    assert(ahora.length <= antes, 'el día es un subconjunto de lo suyo');

    // Cada una que se le enseña tiene que ser de hoy por alguna de las cuatro vías.
    const iso = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
    const hoyIso = iso(hoy);
    const intrusas = ahora.filter((t) => {
      const agendadaHoyOAtrasada = t.scheduledFor != null && iso(t.scheduledFor)! <= hoyIso!;
      const empezada = t.status === 'REALIZANDO';
      const asignadaHoy = t.scheduledFor == null && iso(t.created) === hoyIso;
      const tocadaHoy = iso(t.finalDate) === hoyIso || iso(t.resolvedAt) === hoyIso || iso(t.skippedAt) === hoyIso;
      return !(agendadaHoyOAtrasada || empezada || asignadaHoy || tocadaHoy);
    });
    assert(intrusas.length === 0, 'todo lo que ve es trabajo de hoy', intrusas.slice(0, 3).map((t) => t.code));

    // Y no se le esconde nada que esté EMPEZADO: sería dejarlo anclado a ciegas.
    const empezadas = await prisma.ticket.count({ where: { AND: [suyas, { status: 'REALIZANDO' }] } });
    const empezadasVisibles = ahora.filter((t) => t.status === 'REALIZANDO').length;
    assert(empezadas === empezadasVisibles, `sus ${empezadas} órdenes empezadas siguen a la vista`, { empezadas, empezadasVisibles });

    // — La ficha del cliente: la suya sí, la del vecino no —
    if (staff.email) {
      const sesion = sesionTecnica({ id: `smoke-${staff.id}`, email: staff.email, name: staff.name });
      if (!esTecnicoDeCampo(sesion)) continue;
      const unaSuya = await prisma.ticket.findFirst({ where: { AND: [suyas, { subscriberId: { not: null } }] }, select: { subscriberId: true } });
      const ajena = await prisma.ticket.findFirst({
        where: { subscriberId: { not: null }, NOT: suyas, assignedStaffId: { not: staff.id } },
        select: { subscriberId: true },
      });
      if (unaSuya?.subscriberId) {
        assert(await esClienteDeSuOrden(prisma as any, sesion, unaSuya.subscriberId), 'abre la ficha del cliente de una orden suya');
      }
      if (ajena?.subscriberId) {
        const mio = await prisma.ticket.count({ where: { AND: [suyas, { subscriberId: ajena.subscriberId }] } });
        if (mio === 0) {
          assert(!(await esClienteDeSuOrden(prisma as any, sesion, ajena.subscriberId)), 'NO abre la de un cliente que no es de ninguna orden suya');
        }
      }
    }
  }

  // — "Una orden a la vez", SIN el interruptor general y con la regla del legacy
  //   (2026-09-10): al técnico sólo lo ancla lo que tiene EMPEZADO (`REALIZANDO`).
  //   Tener la agenda del día repartida no lo ancla: puede entrar a cualquiera de sus
  //   visitas y empezar la que le toque. Lo que no puede es empezar una segunda.
  console.log('\n"Una orden a la vez" (sólo ancla lo EMPEZADO), sin el interruptor general:');
  const conAgenda = await prisma.ticket.groupBy({
    by: ['assignedStaffId'],
    where: { status: { in: ['PENDIENTE', 'REALIZANDO'] }, scheduledFor: { lte: hoy }, assignedStaffId: { not: null } },
    _count: { _all: true },
    having: { assignedStaffId: { _count: { gt: 1 } } },
    // Sin `orderBy` propio, Prisma le mete el `{ id: 'asc' }` por defecto y exige
    // que `id` esté en el `by` — que no puede estarlo, o agruparía de a una fila.
    orderBy: { _count: { assignedStaffId: 'desc' } },
    take: 3,
  });
  for (const g of conAgenda) {
    const staff = await prisma.staff.findUnique({
      where: { id: g.assignedStaffId! },
      select: { id: true, name: true, email: true, agendaLibre: true },
    });
    if (!staff?.email || staff.agendaLibre) continue; // el exento no lleva candado
    const sesion = sesionTecnica({ id: `smoke-${staff.id}`, email: staff.email, name: staff.name });
    const ancla = await ordenEnCurso(prisma as any, staff.id, sesion);
    const empezadas = await prisma.ticket.count({
      where: { assignedStaffId: staff.id, status: 'REALIZANDO', created: { gte: corteRezago } },
    });
    assert(!!ancla === empezadas > 0, `${staff.name}: lo ancla lo empezado y sólo eso`, `empezadas=${empezadas}`);

    // Sus visitas del día, que ya no anclan: la agenda se abre y se empieza libremente
    // mientras no haya nada en curso.
    const delDia = await prisma.ticket.findMany({
      where: { assignedStaffId: staff.id, status: 'PENDIENTE', scheduledFor: { lte: hoy } },
      select: { id: true, code: true },
      take: 2,
    });
    if (!ancla) {
      for (const v of delDia) {
        const puede = await puedeEmpezarOrden(prisma as any, staff.id, { id: v.id }, sesion);
        assert(puede.permitido, `  sin nada empezado puede empezar la #${v.code}`);
      }
    } else {
      const propia = await puedeEmpezarOrden(prisma as any, staff.id, { id: ancla.id }, sesion);
      assert(propia.permitido, `  la que ya tiene empezada (#${ancla.code}) no se bloquea a sí misma`);
      const otra = delDia.find((v) => v.id !== ancla.id);
      if (otra) {
        const v = await puedeEmpezarOrden(prisma as any, staff.id, { id: otra.id }, sesion);
        assert(!v.permitido, `  y no puede empezar una segunda (#${otra.code})`);
      }
    }
  }

  // Lo que hay que mirar el día del despliegue: el trabajo abierto que NO está
  // agendado deja de salirle al técnico en `/soporte`. No se pierde —está en la
  // bandeja de quien agenda, que es justamente lo que trae lo que no tiene día—,
  // pero alguien tiene que repartirlo o se queda quieto.
  const sinAgendar = await prisma.ticket.count({
    where: { status: { in: ['PENDIENTE', 'REALIZANDO'] }, scheduledFor: null, assignedStaffId: { not: null } },
  });
  console.log(`\nAviso: ${sinAgendar} órdenes abiertas están asignadas pero SIN agendar.`);
  console.log('Al técnico ya no le salen en /soporte: hay que darles día desde /soporte/agenda.');

  console.log(`\n${ok} OK · ${fail} fallos\n`);
  process.exitCode = fail ? 1 : 0;
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
