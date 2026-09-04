import type { Prisma } from '@prisma/client';

/**
 * El orden cronológico REAL de las órdenes de servicio.
 *
 * `Ticket.created` es `@db.Date`: no guarda hora, y no puede guardarla —así viene del
 * legacy, donde `tickets.fecha` también es una fecha pelada—. Ordenar sólo por ella
 * deja empatadas a todas las órdenes del mismo día y Postgres las devuelve como le
 * queda cómodo, así que la ficha del cliente enseñaba el mismo día en un orden
 * distinto en cada visita. No es un caso raro: 71.359 días de cliente tienen dos o
 * más órdenes (un corte y su reconexión son el pan de cada día).
 *
 * El desempate es `code`, el consecutivo de la orden: lo reparte el legacy con
 * MAX+1, así que crece con el tiempo y es la única marca cronológica que tienen las
 * 325.724 órdenes heredadas. Comprobado contra los datos: en un día con corte de TV,
 * corte de internet y las dos reconexiones, el código ascendente reproduce
 * exactamente la secuencia en que pasaron las cosas.
 *
 * `createdAt` (el instante en que se escribió la fila) va de tercero y sólo decide
 * en las 999 órdenes sin código. NO puede ir primero: en las importadas es el
 * momento en que pasó el sync, no cuándo se abrió la orden.
 */
export const ORDEN_CRONOLOGICO: Prisma.TicketOrderByWithRelationInput[] = [
  { created: 'desc' },
  { code: { sort: 'desc', nulls: 'last' } },
  { createdAt: 'desc' },
];

/** El mismo desempate, para cuando el usuario ordena por fecha en la lista. */
export const porFecha = (dir: 'asc' | 'desc'): Prisma.TicketOrderByWithRelationInput[] => [
  { created: dir },
  { code: { sort: dir, nulls: 'last' } },
  { createdAt: dir },
];

/**
 * ¿Esta orden tiene hora de verdad?
 *
 * Sólo las que nacieron en nexus: ahí `createdAt` es el momento en que alguien pulsó
 * el botón. En las heredadas es la pasada del sync que las trajo, que no le sirve a
 * nadie —y que además engaña, porque parece una hora del día que dice la orden—.
 *
 * No vale mirar `legacyId`: el writeback se lo pone también a las que nacieron aquí
 * cuando las empuja al legacy (ver writeback-legacy.js).
 */
export const NACIDA_AQUI = ['USUARIO', 'CHATBOT', 'SISTEMA'];
export const tieneHoraReal = (createdBySource: string | null | undefined) =>
  createdBySource != null && NACIDA_AQUI.includes(createdBySource);
