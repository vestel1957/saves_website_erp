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
