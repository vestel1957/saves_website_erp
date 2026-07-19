import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { BaseTransport } from '@s4gk/wa-agent';
import { WhatsappService } from '../common/whatsapp/whatsapp.service';
import { WHATSAPP_INBOUND_EVENT, type InboundWhatsappMessage } from '../common/whatsapp/whatsapp.types';
import { ChatbotGateService } from './chatbot-gate.service';

// El nombre vive en `chatbot.identity` (módulo sin dependencias) porque el gate
// también lo necesita y este archivo ya depende del gate. Se re-exporta para no
// cambiarles el import a quienes ya lo traían de aquí.
export { SAVES_TRANSPORT_NAME } from './chatbot.identity';
import { SAVES_TRANSPORT_NAME } from './chatbot.identity';

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
  private readonly logger = new Logger('SavesTransport');

  constructor(
    private readonly whatsapp: WhatsappService,
    private readonly gate: ChatbotGateService,
  ) {
    super();
  }

  /** Listo si Kapso está configurado (API key + phone number id). */
  get ready(): boolean {
    return this.whatsapp.enabled;
  }

  /** No-op: el webhook lo sirve el WhatsappWebhookController, no el transporte. */
  async start(): Promise<void> {}

  /**
   * Entrada: reemite hacia el motor lo que el transporte del ERP ya normalizó.
   *
   * Este es el único punto de corte del bot: si el interruptor está apagado o el
   * número no está en la lista blanca del piloto, el mensaje NO llega al motor (cero
   * LLM, cero respuesta) pero el WhatsappLogService sí lo registra igual — es un
   * listener aparte del mismo evento. Así, apagar el bot deja el canal exactamente
   * como estaba antes de que existiera: el mensaje queda guardado y lo atiende una
   * persona.
   */
  @OnEvent(WHATSAPP_INBOUND_EVENT)
  async onWhatsappInbound(msg: InboundWhatsappMessage): Promise<void> {
    const { ok, reason } = await this.gate.shouldHandle(msg.from);
    if (!ok) {
      this.logger.log(`Mensaje de ${msg.from} no atendido por el bot (${reason}).`);
      return;
    }
    this.emit({
      transport: this.name,
      from: msg.from,
      text: msg.text,
      audio: msg.audio,
      messageId: msg.messageId,
    });
  }

  /**
   * Salida. `sendText` del ERP degrada a log y devuelve false cuando Kapso no está
   * bien configurado; el motor ignora ese booleano. Sin este error explícito, el bot
   * pensaría el mensaje, gastaría tokens y el cliente no vería NADA, con solo un
   * warning perdido en el log. Si esto aparece, revisa `probe()`.
   */
  async sendText(to: string, text: string): Promise<boolean> {
    const ok = await this.whatsapp.sendText(to, text);
    if (!ok) this.logger.error(`RESPUESTA NO ENTREGADA a ${to} (${text.length} car.). Revisa el diagnóstico de Kapso.`);
    return ok;
  }

  async sendDocument(
    to: string,
    buffer: Buffer,
    fileName: string,
    caption?: string,
    mimetype?: string,
  ): Promise<boolean> {
    const ok = await this.whatsapp.sendDocument(to, buffer, fileName, caption, mimetype);
    if (!ok) this.logger.error(`DOCUMENTO NO ENTREGADO a ${to} (${fileName}). Revisa el diagnóstico de Kapso.`);
    return ok;
  }
}
