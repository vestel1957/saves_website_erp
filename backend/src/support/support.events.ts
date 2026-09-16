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
 * El cierre de una orden DEVOLVIÓ el servicio (reconexión o activación).
 *
 * La cuarta cara de la misma moneda que `BAJA_APLICADA_EVENT` y
 * `ACTIVACION_APLICADA_EVENT`, y la que faltaba. El corte vive en dos sitios que la ida
 * del sync vuelve a traer cada 15 minutos —`customers.usu_estado` y el
 * `invoices.estado_tv`/`estado_combo` de la factura vigente—, así que una reconexión
 * hecha aquí que no llegue al legacy antes de esa pasada se DESHACE sola: el cliente
 * navegando y las dos pantallas diciendo "Cortado". Le pasó a la orden #505799 el
 * 09-09-2026.
 *
 * El camino del PAGO ya tenía el suyo (`RECONEXION_APLICADA_EVENT` en red); el del
 * cierre de orden —la otra puerta por la que vuelve un servicio, la del técnico que lo
 * restablece en sitio— no tenía ninguno.
 */
export const RECONEXION_APLICADA_ORDEN_EVENT = 'support.reconexion.aplicada';

export interface ReconexionAplicadaOrdenEvent {
  subscriberId: string;
  /** Orden que lo provocó, para el rastro. */
  code: number | null;
}

/**
 * El cierre de una orden ACTIVÓ a un abonado que estaba por instalar.
 *
 * La tercera cara de la misma moneda que `RECONEXION_APLICADA_EVENT` y
 * `BAJA_APLICADA_EVENT`, y por el mismo motivo: `customers.usu_estado` lo manda el
 * legacy en la ida (cada 15 min), así que la activación que no llegue allá antes se
 * DESHACE sola y el cliente recién instalado —navegando ya— vuelve a salir 'INSTALAR'
 * en las dos pantallas. Le pasó a nueve abonados entre el 02 y el 05-09-2026.
 */
export const ACTIVACION_APLICADA_EVENT = 'support.activacion.aplicada';

export interface ActivacionAplicadaEvent {
  subscriberId: string;
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

/**
 * A una orden se le QUITÓ el técnico (se desasignó sin darle otro dueño).
 *
 * Existe para lo contrario que `TICKET_ASIGNADO_EVENT`: retirar de la campanita del
 * técnico el aviso de un trabajo que ya no es suyo. La reasignación no lo necesita
 * —el aviso del nuevo dueño ya barre el del anterior—, pero desasignar no emitía
 * nada y dejaba al técnico con la orden colgada en la campanita para siempre.
 */
export const TICKET_DESASIGNADO_EVENT = 'support.ticket.desasignado';

export interface TicketDesasignadoEvent {
  ticketId: string;
  code: number | null;
}
