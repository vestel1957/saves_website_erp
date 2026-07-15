import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { BaseTransport } from '@s4gk/wa-agent';
import { WhatsappService } from '../common/whatsapp/whatsapp.service';
import { WHATSAPP_INBOUND_EVENT, type InboundWhatsappMessage } from '../common/whatsapp/whatsapp.types';

/** Nombre del transporte. Compone la clave de conversación: `kapso:573001112233`. */
export const SAVES_TRANSPORT_NAME = 'kapso';

/**
 * Puente entre el transporte de WhatsApp que ya existe en el ERP (WhatsappService,
 * sobre Kapso) y el motor del agente. NO habla con Kapso ni con Meta: delega.
 *
 * La entrada llega por el evento que el WhatsappService ya emite tras validar la
 * firma en su webhook público; la salida vuelve por su `sendText`/`sendDocument`,
 * que a su vez emiten el evento saliente que persiste el WhatsappLogService. Así el
 * agente hereda gratis el webhook, la verificación de firma y el log de conversación,
 * y no existe una segunda puerta de entrada que asegurar.
 *
 * El acople es por evento, no por import: el WhatsappModule no conoce al chatbot, lo
 * que evita un ciclo de módulos (BillingModule → WhatsappModule → …).
 */
@Injectable()
export class SavesTransport extends BaseTransport {
  readonly name = SAVES_TRANSPORT_NAME;

  constructor(private readonly whatsapp: WhatsappService) {
    super();
  }

  /** Listo si Kapso está configurado (API key + phone number id). */
  get ready(): boolean {
    return this.whatsapp.enabled;
  }

  /** No-op: el webhook lo sirve el WhatsappWebhookController, no el transporte. */
  async start(): Promise<void> {}

  /** Entrada: reemite hacia el motor lo que el transporte del ERP ya normalizó. */
  @OnEvent(WHATSAPP_INBOUND_EVENT)
  onWhatsappInbound(msg: InboundWhatsappMessage): void {
    this.emit({
      transport: this.name,
      from: msg.from,
      text: msg.text,
      audio: msg.audio,
      messageId: msg.messageId,
    });
  }

  sendText(to: string, text: string): Promise<boolean> {
    return this.whatsapp.sendText(to, text);
  }

  sendDocument(
    to: string,
    buffer: Buffer,
    fileName: string,
    caption?: string,
    mimetype?: string,
  ): Promise<boolean> {
    return this.whatsapp.sendDocument(to, buffer, fileName, caption, mimetype);
  }
}
