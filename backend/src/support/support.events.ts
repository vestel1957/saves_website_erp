/**
 * Eventos que emite el módulo de soporte para que otros reaccionen sin que soporte
 * los conozca.
 *
 * Archivo sin imports a propósito: lo consumen módulos que soporte NO importa (hoy el
 * chatbot, que sí importa a soporte). Es el mismo recurso que `INTERNAL_ALERT_EVENT`
 * usa para que "Encargados por cargo" pueda mandar WhatsApp sin depender del canal.
 */

/** Una orden de servicio pasó a RESUELTO. */
export const TICKET_RESUELTO_EVENT = 'support.ticket.resuelto';

export interface TicketResueltoEvent {
  ticketId: string;
  /** Número de orden que ve el cliente. */
  code: number | null;
  /** Tipo de orden del ERP ("Revision de Internet", "Traslado"…). */
  type: string | null;
  subscriberId: string | null;
  /**
   * Quién abrió la orden (`Ticket.col`). Es lo que distingue una orden que nació de
   * una conversación de WhatsApp de las cientos de cortes y reconexiones que el
   * sistema cierra a diario: solo por las primeras se le pregunta algo al cliente.
   */
  abiertaPor: string | null;
}

/** Se le asignó un técnico a una orden. */
export const TICKET_ASIGNADO_EVENT = 'support.ticket.asignado';

export interface TicketAsignadoEvent {
  ticketId: string;
  code: number | null;
  type: string | null;
  subscriberId: string | null;
  /** Nombre del técnico, tal como quedó en la orden. */
  tecnico: string | null;
  abiertaPor: string | null;
}

/**
 * Nació una orden de servicio.
 *
 * Existe para una sola cosa: sacarla hacia el legacy en el acto. Mientras los técnicos
 * atiendan desde allá, una orden que tarda cinco minutos en aparecerles es una visita
 * que no sale — y de paso, cuanto antes viaje, menos ventana hay para que el legacy
 * reparta el mismo consecutivo (ver `nextLegacyTicketCode` en el writeback).
 */
export const TICKET_CREADO_EVENT = 'support.ticket.creado';

export interface TicketCreadoEvent {
  ticketId: string;
  code: number | null;
  subscriberId: string | null;
}

/**
 * El cierre de una orden dio de BAJA el servicio de un abonado (retiro o suspensión).
 *
 * Existe por lo mismo que `RECONEXION_APLICADA_EVENT` y con más urgencia: el estado del
 * abonado es de los campos que manda el legacy (`CAMPOS_DE_ALLA` en la ida), así que una
 * baja que no llegue allá antes de la siguiente pasada del sync —cada 15 minutos— se
 * DESHACE sola y el cliente retirado vuelve a aparecer ACTIVO. Es lo que pasó con la
 * orden #504994 el 31-08-2026.
 */
export const BAJA_APLICADA_EVENT = 'support.baja.aplicada';

export interface BajaAplicadaEvent {
  subscriberId: string;
  /** Estado que quedó en la ficha ('RETIRADO' | 'SUSPENDIDO'). */
  estado: string;
  /** Orden que lo provocó, para el rastro. */
  code: number | null;
}

/**
 * Se ANULÓ una orden. Existe para deshacer lo que se apartó al abrirla: el equipo
 * reservado en bodega vuelve a estar disponible (ver `EquipoReservaService`).
 */
export const TICKET_ANULADA_EVENT = 'support.ticket.anulada';

export interface TicketAnuladaEvent {
  ticketId: string;
  code: number | null;
  subscriberId: string | null;
}
