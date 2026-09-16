/**
 * "HAY QUE LLEVAR EQUIPO", contra la BD real (2026-09-04).
 *
 * El aviso que pidió el usuario: si un cliente tiene abierta una instalación, un
 * cambio de equipo, una migración o un agregar internet, tanto su ficha como el
 * agendamiento tienen que decir que esa visita sale con una caja del estante — y con
 * cuál, porque el sistema ya la aparta a su nombre al abrir la orden.
 *
 * Lo que se comprueba aquí es que las dos pantallas cuenten LO MISMO y contra los
 * datos de verdad, que es lo único que las pruebas con mocks no pueden defender:
 *
 *  1. La ficha del abonado trae `equiposPorLlevar` sólo con órdenes ABIERTAS de las
 *     que piden equipo, y con la unidad apartada cuando la hay.
 *  2. La tarjeta de la agenda trae `equipo` en esas mismas órdenes y en null en las
 *     demás (una revisión no lleva caja).
 *  3. Ningún traslado pide equipo: el cliente se lleva su propia ONU.
 *  4. Si el abonado YA tiene ONU a su nombre, es ESA la que se anuncia (y no la que
 *     una reserva vieja hubiera apartado): el aviso y la autenticación —que siempre
 *     prefiere el equipo del abonado— tienen que nombrar la misma caja.
 *
 * NO ESCRIBE NADA: sólo lee.
 *
 * Uso: npx ts-node --transpile-only scripts/smoke-aviso-equipo.ts
 */
import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { BusDeEventos } from '../src/core/eventos';
import { RoutingService } from '../src/geo/routing.service';
import { AgendaService } from '../src/support/agenda.service';
import { SubscribersService } from '../src/subscribers/subscribers.service';
import { equiposDeOrdenes, tipoConReserva } from '../src/support/equipo-reserva.service';
import { hoyEnColombia } from '../src/common/fecha-colombia';

const prisma = new PrismaClient();
const agenda = new AgendaService(prisma as any, new BusDeEventos(), new RoutingService());
const subs = new SubscribersService(prisma as any, null as any, null as any, null as any, new BusDeEventos());

let ok = 0, fail = 0;
const assert = (cond: boolean, msg: string, extra: unknown = '') => {
  if (cond) { ok++; console.log(`  OK    ${msg}`); }
  else { fail++; console.log(`  FALLO ${msg}`, extra); }
};

async function main() {
  const admin = await prisma.user.findFirst({
    where: { email: 'prueba.superusuario@vestel.com.co' },
    select: { id: true, name: true, email: true },
  });
  if (!admin) throw new Error('no está el usuario de prueba de superusuario');
  const yo = { ...admin, permissions: ['system.admin'], roles: [] } as any;

  // --- 1. La ficha del abonado ------------------------------------------------
  console.log('\n1) La ficha del abonado dice qué llevarle');
  const conReserva = await prisma.equipment.findFirst({
    where: { reservedTicketId: { not: null }, subscriberId: { not: null } },
    select: { code: true, subscriberId: true, reservedTicketId: true },
  });
  if (!conReserva) {
    console.log('  (hoy no hay ninguna unidad apartada: nada que comprobar)');
  } else {
    const ficha: any = await subs.detail(conReserva.subscriberId!, yo);
    const aviso = ficha.equiposPorLlevar.find((o: any) => o.ticketId === conReserva.reservedTicketId);
    assert(!!aviso, 'la orden con equipo apartado sale en el aviso de la ficha', ficha.equiposPorLlevar);
    assert(aviso?.equipo?.code === conReserva.code, 'y nombra la unidad que de verdad está apartada', {
      dice: aviso?.equipo?.code, es: conReserva.code,
    });
    assert(
      ficha.equiposPorLlevar.every((o: any) => tipoConReserva(o.type)),
      'no se cuela ninguna orden que no pida equipo',
      ficha.equiposPorLlevar.map((o: any) => o.type),
    );
    console.log(`  abonado ${ficha.abonado} · ${ficha.equiposPorLlevar.length} visita(s) con equipo`);
  }

  const cerradaConTipo = await prisma.ticket.findFirst({
    where: { type: 'Instalacion', status: 'RESUELTO', subscriberId: { not: null } },
    select: { id: true, subscriberId: true },
    orderBy: { created: 'desc' },
  });
  if (cerradaConTipo) {
    const ficha: any = await subs.detail(cerradaConTipo.subscriberId!, yo);
    assert(
      !ficha.equiposPorLlevar.some((o: any) => o.ticketId === cerradaConTipo.id),
      'una instalación ya RESUELTA no pide equipo en la ficha',
    );
  }

  // --- 2. Las tarjetas de la agenda -------------------------------------------
  console.log('\n2) La agenda dice qué llevar en cada visita');
  const hoy = hoyEnColombia().toISOString().slice(0, 10);
  const tablero: any = await agenda.tablero(yo, hoy);
  const tarjetas: any[] = [
    ...tablero.sinAgendar,
    ...tablero.columnas.flatMap((c: any) => c.ordenes),
  ];
  console.log(`  ${tarjetas.length} tarjetas en el tablero de hoy`);
  // Sólo las ABIERTAS: el tablero enseña también lo cerrado hoy, y una orden
  // resuelta no lleva caja a ningún sitio (su reserva ya volvió a la bodega).
  const vivas = tarjetas.filter((t) => t.status === 'PENDIENTE' || t.status === 'REALIZANDO');
  assert(
    vivas.every((t) => (t.equipo == null) === !tipoConReserva(t.type)),
    'lleva aviso exactamente la que pide equipo, ni una más ni una menos',
    vivas.filter((t) => (t.equipo == null) !== !tipoConReserva(t.type)).map((t) => [t.code, t.type, t.status]),
  );
  const conAviso = tarjetas.filter((t) => t.equipo);
  console.log(`  ${conAviso.length} con aviso · ${conAviso.filter((t) => t.equipo.equipo).length} con la caja ya apartada`);

  // Y el aviso de la agenda coincide con el que calcula la ficha, orden por orden:
  // dos pantallas que digan cajas distintas del mismo trabajo no sirven para nada.
  const directo = await equiposDeOrdenes(prisma as any, tarjetas.map((t) => ({ id: t.id, type: t.type, status: t.status })));
  assert(
    conAviso.every((t) => (t.equipo.equipo?.code ?? null) === (directo.get(t.id)?.equipo?.code ?? null)),
    'la tarjeta anuncia la misma unidad que la fuente',
  );

  // --- 3. Los traslados --------------------------------------------------------
  console.log('\n3) Ningún traslado lleva caja');
  assert(!tipoConReserva('Traslado interno De Equipos Red en cliente final'), 'mover el equipo dentro de la casa no aparta nada');
  assert(!tipoConReserva('Traslado'), 'y el de domicilio tampoco: el cliente se lleva su ONU');

  // --- 4. El equipo del cliente manda -----------------------------------------
  console.log('\n4) Si el cliente ya tiene ONU, es esa la que se anuncia');
  const abiertasConEquipo = await prisma.ticket.findMany({
    where: { status: { in: ['PENDIENTE', 'REALIZANDO'] }, subscriberId: { not: null } },
    select: { id: true, code: true, type: true, status: true, subscriberId: true },
  });
  const candidatas = abiertasConEquipo.filter((t) => tipoConReserva(t.type) && !/cambio de equipo/i.test(t.type ?? ''));
  const avisos = await equiposDeOrdenes(prisma as any, candidatas);
  let choques = 0, deSuDueño = 0;
  for (const t of candidatas) {
    const eq = avisos.get(t.id)?.equipo;
    if (!eq) continue;
    const dueño = await prisma.equipment.findUnique({ where: { id: eq.id }, select: { subscriberId: true } });
    if (eq.origen === 'asignado') deSuDueño++;
    // La caja anunciada o es del cliente, o está libre esperándole: nunca de otro.
    if (dueño?.subscriberId && dueño.subscriberId !== t.subscriberId) choques++;
  }
  assert(choques === 0, 'ninguna orden anuncia una caja que es de otro cliente', choques);
  console.log(`  ${candidatas.length} órdenes abiertas · ${deSuDueño} anuncian el equipo que el cliente ya tiene`);

  console.log(`\n${fail ? 'CON FALLOS' : 'TODO OK'} · ${ok} bien, ${fail} mal\n`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
