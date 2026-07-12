/**
 * Tipos compartidos por el transporte de WhatsApp (Kapso, Cloud API oficial de
 * Meta a través de su proxy) y el agente de IA (ChatbotService).
 *
 * Se ubican en `common/whatsapp` (lugar neutral) para que el transporte pueda
 * emitir el evento entrante sin depender del módulo del chatbot.
 */

/** Nombre del evento (EventEmitter2) que emite el transporte al recibir un mensaje. */
export const WHATSAPP_INBOUND_EVENT = 'whatsapp.inbound';

/** Evento emitido tras enviar un mensaje saliente (para el log de conversación). */
export const WHATSAPP_OUTBOUND_EVENT = 'whatsapp.outbound';

/** Evento emitido cuando el webhook trae un cambio de estado de un mensaje saliente. */
export const WHATSAPP_STATUS_EVENT = 'whatsapp.status';

/** Cambio de estado de entrega de un mensaje saliente (sent/delivered/read/failed). */
export interface WhatsappStatusUpdate {
  /** Id del mensaje en Meta (casa con WhatsappSend.waMessageId). */
  messageId: string;
  /** Estado normalizado del transporte. */
  status: 'sent' | 'delivered' | 'read' | 'failed';
  /** Descripción del error, si status = failed. */
  error?: string;
}

/**
 * Identifica por cuál transporte entró/sale un mensaje. Hoy existe uno solo
 * (Kapso); se conserva como literal para no acoplar la clave de conversación
 * (`transporte:teléfono`) a un valor mágico repartido por el código.
 */
export type WhatsappTransportName = 'kapso';

/** Mensaje entrante normalizado que emite el transporte. */
export interface InboundWhatsappMessage {
  transport: WhatsappTransportName;
  /** Número del remitente en E.164 sin '+', ej. 573001112233. */
  from: string;
  /**
   * Texto del mensaje. Vacío cuando es una nota de voz: en ese caso `audio`
   * trae el buffer y el ChatbotService lo transcribe antes de procesar.
   */
  text: string;
  /** Nota de voz / audio entrante (ya descargado por el transporte). */
  audio?: { data: Buffer; mimetype?: string };
  /** Id del mensaje en el transporte (para deduplicar / logs), si aplica. */
  messageId?: string;
}
