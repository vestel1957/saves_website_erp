/**
 * El calendario de agendamiento, contra la BD real (2026-08-26).
 *
 * Comprueba las tres cosas por las que el calendario podría mentir:
 *  1. que los conteos del MES cuadren con las órdenes que de verdad hay en el rango,
 *  2. que la SEMANA reparta cada visita en una sola casilla (técnico × día) y numere
 *     1..N sin repetir dentro de ella,
 *  3. que agendar para un día FUTURO se vea en las dos vistas y le llegue al técnico
 *     en "lo que viene" — sin romperle el turno de hoy.
 *
 * Escribe sobre la BD real y lo REVIERTE: la orden de prueba vuelve a quedar como
 * estaba. Agendarle a un técnico una visita de verdad es trabajo que alguien iría a
 * hacer.
 *
 * Uso: npx ts-node --transpile-only scripts/smoke-agenda-calendario.ts
 */
import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { BusDeEventos } from '../src/core/eventos';
import { RoutingService } from '../src/geo/routing.service';
import { AgendaService } from '../src/support/agenda.service';
import { hoyEnColombia } from '../src/common/fecha-colombia';

const prisma = new PrismaClient();
const bus = new BusDeEventos(); // sin suscriptores: nadie manda WhatsApp desde aquí
const agenda = new AgendaService(prisma as any, bus, new RoutingService());

let ok = 0, fail = 0;
const assert = (cond: boolean, msg: string, extra: unknown = '') => {
  if (cond) { ok++; console.log(`  OK    ${msg}`); }
  else { fail++; console.log(`  FALLO ${msg}`, extra); }
};
const sesion = (u: { id: string; name: string; email: string }, permisos: string[]) =>
  ({ ...u, permissions: permisos, roles: [] }) as any;
const masDias = (ymd: string, n: number) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

async function main() {
  const hoy = hoyEnColombia().toISOString().slice(0, 10);
  console.log(`\nHoy en Colombia: ${hoy}\n`);
  const admin = await prisma.user.findFirst({ where: { email: 'prueba.superusuario@vestel.com.co' }, select: { id: true, name: true, email: true } });
  if (!admin) throw new Error('no está el usuario de prueba de superusuario');
  const yo = sesion(admin, ['system.admin']);

  // --- 1. El mes cuenta lo que hay -------------------------------------------
  console.log('1) Calendario del mes');
  const desde = `${hoy.slice(0, 7)}-01`;
  const hasta = masDias(desde, 30);
  const mes = await agenda.calendario(yo, desde, hasta);
  const sumaMes = mes.dias.reduce((s, d) => s + d.total, 0);
  const enBD = await prisma.ticket.count({
    where: {
      OR: [
        { scheduledFor: { gte: new Date(`${desde}T00:00:00Z`), lte: new Date(`${hasta}T00:00:00Z`) } },
        ...(hoy >= desde && hoy <= hasta
          ? [{ scheduledFor: { lt: new Date(`${hoy}T00:00:00Z`) }, status: { in: ['PENDIENTE', 'REALIZANDO'] } } as any]
          : []),
      ],
    },
  });
  console.log(`  ${desde} → ${hasta}: ${sumaMes} visitas en ${mes.dias.filter((d) => d.total).length} días con trabajo`);
  assert(sumaMes === enBD, 'la suma del calendario cuadra con la base', { sumaMes, enBD });
  assert(mes.dias.length === 31, 'devuelve un día por casilla', mes.dias.length);
  const conAtraso = mes.dias.find((d) => d.atrasadas > 0);
  if (conAtraso) assert(conAtraso.fecha === hoy, 'lo atrasado se cuenta en HOY, no en su día viejo', conAtraso.fecha);
  const cargado = [...mes.dias].sort((a, b) => b.total - a.total)[0];
  console.log(`  día más cargado: ${cargado.fecha} · ${cargado.total} visitas · ${cargado.porTecnico.length} técnicos`);
  assert(
    cargado.porTecnico.reduce((s, t) => s + t.total, 0) <= cargado.total,
    'el desglose por técnico no se pasa del total del día',
  );

  // --- 2. La semana reparte cada visita en UNA casilla ------------------------
  console.log('2) Semana (técnicos × días)');
  const lunes = masDias(hoy, -3);
  const semana = await agenda.semana(yo, lunes, 7);
  assert(semana.dias.length === 7, 'siete columnas de día', semana.dias.length);
  const vistas = new Map<string, string>();
  let repetidas = 0, puestosMal = 0, total = 0;
  for (const c of semana.columnas) {
    for (const dia of semana.dias) {
      const celda = (c.dias as any)[dia];
      const puestos = celda.ordenes.map((o: any) => o.puesto);
      if (new Set(puestos).size !== puestos.length) puestosMal++;
      for (const o of celda.ordenes) {
        total++;
        const donde = `${c.nombre}|${dia}`;
        if (vistas.has(o.id)) repetidas++;
        vistas.set(o.id, donde);
      }
    }
  }
  console.log(`  ${total} visitas repartidas entre ${semana.columnas.length} técnicos · ${semana.sinAgendarTotal} sin agendar`);
  assert(repetidas === 0, 'ninguna visita se pinta en dos casillas', repetidas);
  assert(puestosMal === 0, 'los puestos no se repiten dentro de una casilla', puestosMal);

  // --- 3. Agendar para un día futuro ------------------------------------------
  console.log('3) Agendar para un día futuro');
  const candidata = semana.sinAgendar[0] as any;
  const tecnico = semana.columnas[0];
  if (!candidata || !tecnico) { console.log('  (no hay bandeja o no hay técnicos: nada que probar)'); }
  else {
    const futuro = masDias(hoy, 3);
    const antes = await prisma.ticket.findUnique({
      where: { id: candidata.id },
      select: { scheduledFor: true, scheduledSeq: true, assigned: true, assignedStaffId: true, assignedAt: true, editedAt: true, editedBy: true },
    });
    console.log(`  orden #${candidata.code} → ${tecnico.nombre}, el ${futuro}`);
    await agenda.mover(yo, { ticketId: candidata.id, staffId: tecnico.staffId, fecha: futuro });

    const semana2 = await agenda.semana(yo, hoy, 7);
    const col = semana2.columnas.find((c) => c.staffId === tecnico.staffId)!;
    const enCasilla = ((col.dias as any)[futuro]?.ordenes ?? []).some((o: any) => o.id === candidata.id);
    assert(enCasilla, `aparece en la casilla ${tecnico.nombre} × ${futuro}`);
    assert(
      !semana2.sinAgendar.some((o: any) => o.id === candidata.id),
      'y ya no está en la bandeja de sin agendar',
    );

    const mes2 = await agenda.calendario(yo, futuro, futuro);
    assert(mes2.dias[0].total >= 1, 'el calendario cuenta ese día', mes2.dias[0]);

    // El técnico la ve en "lo que viene", pero NO en su turno de hoy.
    const staff = await prisma.staff.findUnique({ where: { id: tecnico.staffId }, select: { name: true, email: true } });
    const suUser = await prisma.user.findFirst({
      where: { OR: [{ email: { equals: staff!.email ?? '—', mode: 'insensitive' } }, { name: { equals: staff!.name, mode: 'insensitive' } }] },
      select: { id: true, name: true, email: true },
    });
    if (!suUser) console.log(`  (${staff!.name} no tiene usuario: no se puede probar "lo que viene")`);
    else {
      const suSesion = sesion(suUser, ['area.tecnicos']);
      const proximas = await agenda.misProximas(suSesion, 7);
      const enProximas = proximas.dias.flatMap((d: any) => d.ordenes).some((o: any) => o.id === candidata.id);
      assert(enProximas, `${staff!.name} la ve en "lo que viene" (${proximas.total} próximas)`);
      const hoyDelTecnico = await agenda.miAgenda(suSesion);
      assert(
        !hoyDelTecnico.ordenes.some((o: any) => o.id === candidata.id),
        'y NO se le cuela en la agenda de hoy',
        hoyDelTecnico.ordenes.length,
      );
    }

    // Devuelta a como estaba.
    await prisma.ticket.update({
      where: { id: candidata.id },
      data: {
        scheduledFor: antes!.scheduledFor, scheduledSeq: antes!.scheduledSeq,
        scheduledById: null, scheduledByName: null, scheduledAt: null,
        assigned: antes!.assigned, assignedStaffId: antes!.assignedStaffId,
        assignedAt: antes!.assignedAt, editedAt: antes!.editedAt, editedBy: antes!.editedBy,
      },
    });
    console.log(`  (revertida: la #${candidata.code} vuelve a quedar como estaba)`);
  }

  console.log(`\n${ok} OK · ${fail} fallos\n`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
