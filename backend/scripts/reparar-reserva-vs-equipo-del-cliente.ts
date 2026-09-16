/**
 * Suelta las reservas que contradicen al equipo del cliente (2026-09-04).
 *
 * Hasta hoy la reserva se hacía sin mirar si el abonado ya tenía ONU a su nombre:
 * la ficha y el agendamiento anunciaban una caja y la autenticación —que siempre
 * prefiere "el equipo del abonado"— iba a montar otra. Desde
 * `EquipoReservaService.reservarParaOrden` esto ya no vuelve a pasar; esto limpia
 * las órdenes abiertas que quedaron así.
 *
 * Devuelve al estante SOLO la unidad apartada (status `Reservado`): el equipo del
 * cliente no se toca. Con `--aplicar` escribe; sin él, solo enseña.
 *
 *   npx ts-node --transpile-only scripts/reparar-reserva-vs-equipo-del-cliente.ts [--aplicar]
 */
import { PrismaClient } from '@prisma/client';
import { ESTADO_RESERVADO, equipoDelCliente, tipoConReserva } from '../src/support/equipo-reserva.service';

const prisma = new PrismaClient();
const APLICAR = process.argv.includes('--aplicar');

async function main() {
  const abiertas = await prisma.ticket.findMany({
    where: { status: { in: ['PENDIENTE', 'REALIZANDO'] }, subscriberId: { not: null } },
    select: { id: true, code: true, type: true, subscriberId: true },
  });
  const piden = abiertas.filter((t) => tipoConReserva(t.type) && !/cambio de equipo/i.test(t.type ?? ''));
  console.log(`Órdenes abiertas que piden equipo (sin cambios de equipo): ${piden.length}`);

  let sueltos = 0;
  for (const t of piden) {
    // Sin filtrar por estado a propósito: la ida del legacy le deshace el estado a
    // algunas reservas (`status` vuelve a 'Bueno' y pierde el dueño) pero les deja
    // puesto el `reservedTicketId`, y son justo esas las que el aviso anunciaba.
    const reserva = await prisma.equipment.findFirst({
      where: { reservedTicketId: t.id },
      select: { id: true, code: true, serial: true, status: true, subscriberId: true },
    });
    if (!reserva) continue;
    const suyo = await equipoDelCliente(prisma as any, t.subscriberId!);
    if (!suyo || suyo.id === reserva.id) continue;
    console.log(`  orden ${t.code} (${t.type}): apartada ${reserva.code} · el cliente ya tiene la ${suyo.code} → se suelta ${reserva.code}`);
    sueltos++;
    if (!APLICAR) continue;
    // Si seguía apartada, vuelve al estante entera; si el sync ya le había quitado
    // el dueño, basta con borrar la marca de reserva —su estado real es el que
    // tiene ahora y no se le inventa uno.
    const enteraAlEstante = reserva.status === ESTADO_RESERVADO || reserva.subscriberId === t.subscriberId;
    await prisma.equipment.update({
      where: { id: reserva.id },
      data: enteraAlEstante
        ? { subscriberId: null, assignedRaw: null, reservedTicketId: null, status: 'Disponible', editedAt: new Date() }
        : { reservedTicketId: null, editedAt: new Date() },
    });
    await prisma.ticketThread.create({
      data: {
        ticketCode: t.code!, subscriberId: t.subscriberId, employeeId: 0, date: new Date(),
        message: `El equipo ${reserva.code} que esta orden tenía apartado vuelve a la bodega: el cliente ya tiene a su nombre el ${suyo.code}, que es el que se instala.`,
      },
    }).catch(() => undefined);
  }
  console.log(sueltos ? `${sueltos} reserva(s) ${APLICAR ? 'liberadas' : 'por liberar (usa --aplicar)'}` : 'Nada que corregir.');
}

main().finally(() => prisma.$disconnect());
