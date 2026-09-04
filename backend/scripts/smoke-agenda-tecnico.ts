/**
 * La orden asignada TIENE que llegarle al técnico. Contra la BD real.
 *
 * Comprueba de punta a punta los tres agujeros que se taparon el 2026-08-11:
 *  1. el bus de eventos sin cablear (`assign` reventaba con un 500 tras guardar),
 *  2. asignar desde la ficha no metía la orden en el día de nadie,
 *  3. lo agendado un día anterior y no cerrado no lo veía ya ni el técnico ni la caja.
 *
 * Escribe sobre la BD real y lo REVIERTE: la orden que usa para probar vuelve a
 * quedar como estaba. No es una limpieza de cortesía — meterle a un técnico una
 * orden del legacy en la agenda de hoy es trabajo que alguien iría a hacer.
 *
 * Uso: npx ts-node --transpile-only scripts/smoke-agenda-tecnico.ts
 */
import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { BusDeEventos } from '../src/core/eventos';
import { RoutingService } from '../src/geo/routing.service';
import { AgendaService } from '../src/support/agenda.service';
import { SupportWriteService } from '../src/support/support-write.service';
import { hoyEnColombia } from '../src/common/fecha-colombia';

const prisma = new PrismaClient();
const bus = new BusDeEventos(); // sin suscriptores: nadie manda WhatsApp desde aquí
let ok = 0, fail = 0;
const assert = (cond: boolean, msg: string, extra: unknown = '') => {
  if (cond) { ok++; console.log(`  OK    ${msg}`); }
  else { fail++; console.log(`  FALLO ${msg}`, extra); }
};

const agenda = new AgendaService(prisma as any, bus, new RoutingService());
const write = new SupportWriteService(
  prisma as any, {} as any, {} as any, {} as any, bus, agenda,
  { alCerrar: async () => null } as any,
);

/** La sesión de un empleado, tal como la arma `resolveUser()`. */
const sesion = (u: { id: string; name: string; email: string }, permisos: string[]) =>
  ({ ...u, permissions: permisos, roles: [] }) as any;

async function main() {
  const hoy = hoyEnColombia().toISOString().slice(0, 10);
  console.log(`\nHoy en Colombia: ${hoy}\n`);

  // --- 1. Asignar desde la ficha mete la orden en el día del técnico ---------
  console.log('1) Asignar técnico desde la ficha de la orden');
  // `assignedAt: not null` a propósito: las 200 órdenes del legacy vienen con
  // técnico y SIN fecha de asignación, y en un `desc` Postgres pone los nulos
  // primero — la prueba acababa agendándole a alguien una orden de 2021.
  const orden = await prisma.ticket.findFirst({
    where: { status: 'PENDIENTE', assignedStaffId: { not: null }, scheduledFor: null, assignedAt: { not: null } },
    orderBy: { assignedAt: 'desc' },
    select: { id: true, code: true, assigned: true, assignedStaffId: true, assignedAt: true },
  });
  if (!orden) { console.log('  (no hay ninguna asignada sin agendar: nada que probar)'); }
  else {
    const caja = await prisma.user.findFirst({ where: { email: 'prueba.caja@vestel.com.co' }, select: { id: true, name: true, email: true } });
    if (!caja) throw new Error('no está el usuario de prueba de caja');
    console.log(`  orden #${orden.code} → ${orden.assigned}`);
    await write.assign(orden.id, { assigned: orden.assigned! } as any, sesion(caja, ['area.caja']));
    const despues = await prisma.ticket.findUnique({
      where: { id: orden.id },
      select: { scheduledFor: true, scheduledSeq: true, assignedStaffId: true },
    });
    assert(despues?.scheduledFor?.toISOString().slice(0, 10) === hoy, 'queda agendada para HOY', despues?.scheduledFor);
    assert((despues?.scheduledSeq ?? 0) > 0, 'con posición en la cola del técnico', despues?.scheduledSeq);
    assert(despues?.assignedStaffId === orden.assignedStaffId, 'sigue siendo del mismo técnico');

    // --- 2. Y el técnico la ve ------------------------------------------------
    console.log('2) El técnico la ve en su agenda del día');
    const staff = await prisma.staff.findUnique({ where: { id: orden.assignedStaffId! }, select: { name: true, email: true } });
    const suUser = await prisma.user.findFirst({
      where: { OR: [{ email: { equals: staff!.email ?? '—', mode: 'insensitive' } }, { name: { equals: staff!.name, mode: 'insensitive' } }] },
      select: { id: true, name: true, email: true },
    });
    if (!suUser) assert(false, `el técnico ${staff!.name} tiene usuario`);
    else {
      const dia = await agenda.miAgenda(sesion(suUser, ['area.tecnicos']));
      assert(dia.ordenes.length > 0, `${staff!.name} tiene ${dia.ordenes.length} visita(s) hoy`);
      assert(
        dia.ordenes.some((o: any) => o.id === orden.id),
        'la orden recién asignada está en su día',
        dia.ordenes.find((o: any) => o.id === orden.id)?.code,
      );
    }
    // Devuelta a como estaba: la prueba no reparte trabajo de verdad.
    await prisma.ticket.update({
      where: { id: orden.id },
      // `assignedAt` también: `assign()` lo vuelve a sellar, y dejarlo puesto le
      // arranca a un técnico el reloj de una orden que nadie le acaba de dar.
      data: { scheduledFor: null, scheduledSeq: null, scheduledById: null, scheduledByName: null, scheduledAt: null, assigned: orden.assigned, assignedAt: orden.assignedAt },
    });
    console.log(`  (revertida: la #${orden.code} vuelve a quedar sin agendar)`);
  }

  // --- 3. Lo atrasado se arrastra al día de hoy -------------------------------
  console.log('3) Lo agendado en días anteriores y sin cerrar aparece hoy');
  const vieja = await prisma.ticket.findFirst({
    where: { status: { in: ['PENDIENTE', 'REALIZANDO'] }, scheduledFor: { lt: hoyEnColombia() }, assignedStaffId: { not: null } },
    orderBy: { scheduledFor: 'asc' },
    select: { id: true, code: true, scheduledFor: true, assignedStaffId: true },
  });
  if (!vieja) { console.log('  (no hay atrasadas: nada que probar)'); }
  else {
    const staff = await prisma.staff.findUnique({ where: { id: vieja.assignedStaffId! }, select: { name: true, email: true } });
    const suUser = await prisma.user.findFirst({
      where: { OR: [{ email: { equals: staff!.email ?? '—', mode: 'insensitive' } }, { name: { equals: staff!.name, mode: 'insensitive' } }] },
      select: { id: true, name: true, email: true },
    });
    const suDia = await agenda.miAgenda(sesion(suUser!, ['area.tecnicos']));
    const dia = vieja.scheduledFor!.toISOString().slice(0, 10);
    const arrastrada = suDia.ordenes.find((o: any) => o.id === vieja.id) as any;
    console.log(`  orden #${vieja.code} (${staff!.name}) quedó agendada el ${dia}`);
    assert(!!arrastrada, 'le sale en la agenda de hoy', arrastrada?.code);
    assert(arrastrada?.atrasada === true, 'y marcada como ATRASADA', arrastrada?.atrasada);
  }

  // --- 4. La cajera también la ve en el tablero de hoy ------------------------
  console.log('4) El tablero de la cajera muestra lo atrasado en la columna del técnico');
  const admin = await prisma.user.findFirst({ where: { email: 'prueba.superusuario@vestel.com.co' }, select: { id: true, name: true, email: true } });
  const tablero = await agenda.tablero(sesion(admin!, ['system.admin']), hoy);
  const enColumnas = tablero.columnas.flatMap((c: any) => c.ordenes);
  assert(tablero.fecha === hoy, 'el tablero es el de hoy');
  if (vieja) assert(enColumnas.some((o: any) => o.id === vieja.id), `la #${vieja.code} está en una columna`);
  const atrasadas = enColumnas.filter((o: any) => o.atrasada);
  console.log(`  ${enColumnas.length} órdenes repartidas hoy · ${atrasadas.length} vienen atrasadas`);

  console.log(`\n${ok} OK · ${fail} fallos\n`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
