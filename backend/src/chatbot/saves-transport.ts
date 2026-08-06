import { Logger } from '../core/logger';
import { BaseTransport } from '@s4gk/wa-agent';
import { WhatsappService } from '../common/whatsapp/whatsapp.service';
import { WHATSAPP_INBOUND_EVENT, type InboundWhatsappMessage } from '../common/whatsapp/whatsapp.types';
import { ChatbotGateService } from './chatbot-gate.service';
import { TicketConfirmacionService } from './ticket-confirmacion.service';

// El nombre vive en `chatbot.identity` (módulo sin dependencias) porque el gate
// también lo necesita y este archivo ya depende del gate. Se re-exporta para no
// cambiarles el import a quienes ya lo traían de aquí.
export { SAVES_TRANSPORT_NAME } from './chatbot.identity';
import { SAVES_TRANSPORT_NAME } from './chatbot.identity';
import { aFormatoWhatsapp, pausaMs, trocear } from './chat-chunks';

/** Interruptor de pánico del troceado: `WA_BOT_TROCEAR=false` vuelve al mensaje único. */
const TROCEAR = process.env.WA_BOT_TROCEAR !== 'false';

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
export class SavesTransport extends BaseTransport {
  readonly name = SAVES_TRANSPORT_NAME;
  private readonly logger = new Logger('SavesTransport');

  constructor(
    private readonly whatsapp: WhatsappService,
    private readonly gate: ChatbotGateService,
    private readonly confirmacion: TicketConfirmacionService,
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
  async onWhatsappInbound(msg: InboundWhatsappMessage): Promise<void> {
    const { ok, reason, aviso } = await this.gate.shouldHandle(msg.from);
    if (!ok) {
      this.logger.log(`Mensaje de ${msg.from} no atendido por el bot (${reason}).`);
      // Hay vetos que NO pueden resolverse en silencio: si el bot topó el cupo del día,
      // el cliente acaba de escribir y merece saber que su mensaje llegó. El gate ya lo
      // escaló a una persona; esto solo es la cortesía de no dejarlo hablando solo.
      //
      // Sin `reopenWithTemplate`: esto responde a un mensaje que acaba de entrar, así
      // que la ventana de 24 h está abierta por definición y gastar una plantilla de
      // pago en un "te atiende un asesor" no tendría sentido.
      if (aviso) {
        void this.enviarUno(msg.from, aviso, false).catch((e) =>
          this.logger.warn(`No se pudo avisar a ${msg.from} del corte del bot: ${(e as Error).message}`),
        );
      }
      return;
    }

    // Decisión de alcance (2026-07-27, revisada): WhatsApp es el ÚNICO canal del
    // bot. Al retirarse el chat web de vestel.com.co, la página manda su botón a
    // este mismo número, así que un desconocido ya no es "alguien que se equivocó
    // de puerta" sino un posible cliente que viene de la web: lo atiende el agente
    // público (solo info comercial, cero datos de cuenta). Los ambiguos siguen
    // degradando a público a propósito — nunca a la cuenta de nadie.

    // Señal de vida inmediata: chulitos azules + "escribiendo…". Va DESPUÉS del gate
    // —a un número que el bot no atiende no se le marca leído, porque lo va a
    // contestar una persona— y es fire-and-forget: si Kapso lo rechaza, el turno
    // sigue igual. Sin esto, entre la nota de voz, las herramientas y el modelo, el
    // cliente pasa diez segundos sin ver absolutamente nada.
    if (msg.messageId) {
      this.ultimoEntrante.set(msg.from, msg.messageId);
      void this.whatsapp.sendTypingIndicator(msg.messageId);
    }

    // ¿Está contestando a "¿le quedó funcionando?"? Eso se resuelve de forma
    // DETERMINISTA y no se le pasa al modelo: de esa respuesta depende que una avería
    // se cierre o que salga un técnico (ver TicketConfirmacionService). Va aquí, y no
    // antes del gate, para heredar sus reglas: con el bot apagado, la conversación
    // escalada a una persona o el número fuera del piloto, el sistema no contesta solo.
    if (await this.confirmacion.intentarResponder(msg.from, msg.text ?? '')) return;

    this.emit({
      transport: this.name,
      from: msg.from,
      text: msg.text,
      audio: msg.audio,
      messageId: msg.messageId,
    });
  }

  /**
   * Último mensaje entrante de cada número, para poder volver a encender el
   * "escribiendo…" entre trozo y trozo (la Cloud API solo lo enciende al marcar como
   * leído un mensaje RECIBIDO, así que hace falta su id). Es un Map en memoria a
   * propósito: si se pierde en un reinicio no pasa nada, solo se deja de ver el
   * indicador en un turno.
   */
  private readonly ultimoEntrante = new Map<string, string>();

  /**
   * ¿Meta sigue aceptando que reencendamos el indicador? Marcar dos veces como leído
   * el mismo mensaje puede rechazarlo, y no vale la pena pagar una llamada HTTP
   * fallida por cada trozo: al primer no, se deja de intentar y quedan solo las
   * pausas, que ya dan el efecto.
   */
  private reencenderTyping = true;

  /**
   * Salida. `sendText` del ERP degrada a log y devuelve false cuando Kapso no está
   * bien configurado; el motor ignora ese booleano. Sin este error explícito, el bot
   * pensaría el mensaje, gastaría tokens y el cliente no vería NADA, con solo un
   * warning perdido en el log. Si esto aparece, revisa `probe()`.
   */
  async sendText(to: string, text: string): Promise<boolean> {
    // El modelo escribe markdown por mucho que el prompt se lo prohíba; se traduce al
    // formato de WhatsApp aquí, en el último punto por el que pasa TODO lo que sale.
    const limpio = aFormatoWhatsapp(text);
    const trozos = TROCEAR ? trocear(limpio) : [limpio];
    if (trozos.length <= 1) return this.enviarUno(to, trozos[0] ?? limpio, true);

    // El PRIMER trozo sale ya: quien preguntó lleva esperando al modelo y sumarle
    // una pausa artificial encima sería empeorar justo lo que se vino a arreglar.
    // Si ese falla se aborta: insistir con los demás solo llena el log de errores.
    if (!(await this.enviarUno(to, trozos[0], true))) return false;

    for (const trozo of trozos.slice(1)) {
      await this.escribiendo(to);
      await new Promise((r) => setTimeout(r, pausaMs(trozo)));
      // A partir del segundo NO va `reopenWithTemplate`: si la ventana estaba
      // cerrada, el primero ya la reabrió; y si aun así fallara, gastar una
      // plantilla de pago por media respuesta es lo último que queremos.
      if (!(await this.enviarUno(to, trozo, false))) {
        this.logger.error(`RESPUESTA INCOMPLETA a ${to}: se entregó parte y falló un trozo de ${trozo.length} car.`);
        return false;
      }
    }
    return true;
  }

  /** Un trozo, con el mismo diagnóstico ruidoso de siempre si no llega. */
  private async enviarUno(to: string, text: string, reabrir: boolean): Promise<boolean> {
    // `reopenWithTemplate` solo aquí: si Meta cerró la ventana de 24 h, esta es una
    // RESPUESTA a algo que el cliente acaba de escribir, no una campaña — dejarlo sin
    // contestar es el peor resultado posible. Las alertas y las masivas no lo llevan:
    // esas ya nacen como plantilla o pueden esperar.
    const ok = await this.whatsapp.sendText(to, text, { reopenWithTemplate: reabrir });
    if (!ok) this.logger.error(`RESPUESTA NO ENTREGADA a ${to} (${text.length} car.). Revisa el diagnóstico de Kapso.`);
    return ok;
  }

  /** Reenciende el "escribiendo…" antes del siguiente trozo, si Meta lo permite. */
  private async escribiendo(to: string): Promise<void> {
    if (!this.reencenderTyping) return;
    const id = this.ultimoEntrante.get(to);
    if (!id) return;
    if (!(await this.whatsapp.sendTypingIndicator(id))) {
      this.logger.log('Meta no acepta reencender el "escribiendo…" entre mensajes; se deja solo la pausa.');
      this.reencenderTyping = false;
    }
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
