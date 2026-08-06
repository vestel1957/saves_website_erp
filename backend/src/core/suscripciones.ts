/**
 * Suscripciones al bus de eventos (sustituyen al decorador `@OnEvent`).
 *
 * Con Nest esto era invisible: nueve métodos repartidos por siete ficheros que Nest
 * descubría por reflexión al arrancar. Para saber quién reaccionaba a "pago aplicado"
 * había que buscar `@OnEvent` por todo el proyecto y confiar en no dejarse ninguno.
 *
 * Aquí está la lista entera, en un sitio, y ese es justamente el objetivo de quitar
 * la magia: los efectos secundarios del sistema —avisar al abonado, registrar el
 * mensaje, actualizar una campaña— se leen de una vez.
 *
 * El orden no importa: el bus entrega a todos los suscriptores de un evento, y los
 * errores de cada uno se capturan por separado (ver `eventos.ts`).
 */
import { eventos } from './eventos';
import {
  avisosProactivosService,
  savesTransport,
  ticketConfirmacionService,
  whatsappCampaignService,
  whatsappInternalAlertListener,
  whatsappLogService,
} from './contenedor';
import { TICKET_ASIGNADO_EVENT, TICKET_RESUELTO_EVENT } from '../support/support.events';
import { PAGO_APLICADO_EVENT } from '../treasury/treasury.events';
import {
  INTERNAL_ALERT_EVENT,
  WHATSAPP_INBOUND_EVENT,
  WHATSAPP_OUTBOUND_EVENT,
  WHATSAPP_STATUS_EVENT,
} from '../common/whatsapp/whatsapp.types';

export function registrarSuscripciones(): void {
  // --- Soporte ---------------------------------------------------------------
  // Al resolver un ticket se le pregunta al abonado si quedó conforme.
  eventos.on(TICKET_RESUELTO_EVENT, (e) => ticketConfirmacionService.alResolver(e as never), 'ticketConfirmacion');
  // Al asignar, se avisa por WhatsApp a quien corresponda.
  eventos.on(TICKET_ASIGNADO_EVENT, (e) => avisosProactivosService.alAsignar(e as never), 'avisosProactivos');

  // --- Tesorería -------------------------------------------------------------
  // Al aplicar un pago, el abonado recibe su confirmación.
  eventos.on(PAGO_APLICADO_EVENT, (e) => avisosProactivosService.alPagar(e as never), 'avisosProactivos');

  // --- WhatsApp --------------------------------------------------------------
  // Un mensaje entrante tiene DOS destinos, y los dos importan: el bot que lo
  // contesta y la bitácora de la conversación. Con `@OnEvent` esto quedaba repartido
  // en dos ficheros distintos y no se veía que compartían evento.
  eventos.on(WHATSAPP_INBOUND_EVENT, (m) => savesTransport.onWhatsappInbound(m as never), 'savesTransport');
  eventos.on(WHATSAPP_INBOUND_EVENT, (m) => whatsappLogService.onInbound(m as never), 'whatsappLog');

  eventos.on(WHATSAPP_OUTBOUND_EVENT, (e) => whatsappLogService.onOutbound(e as never), 'whatsappLog');

  // El estado de entrega alimenta la bitácora y el progreso de las campañas.
  eventos.on(WHATSAPP_STATUS_EVENT, (e) => whatsappLogService.onStatus(e as never), 'whatsappLog');
  eventos.on(WHATSAPP_STATUS_EVENT, (e) => whatsappCampaignService.onStatus(e as never), 'whatsappCampaign');

  // --- Alertas internas ------------------------------------------------------
  eventos.on(INTERNAL_ALERT_EVENT, (a) => whatsappInternalAlertListener.handle(a as never), 'alertaInterna');
}
