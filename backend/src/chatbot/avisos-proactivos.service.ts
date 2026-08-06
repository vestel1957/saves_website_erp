import { Logger } from '../core/logger';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsappService } from '../common/whatsapp/whatsapp.service';
import { TICKET_ASIGNADO_EVENT, type TicketAsignadoEvent } from '../support/support.events';
import { PAGO_APLICADO_EVENT, type PagoAplicadoEvent } from '../treasury/treasury.events';
import { ChatbotGateService } from './chatbot-gate.service';
import { BOT_ACTOR } from './chatbot.identity';

/**
 * Cinturón de seguridad: máximo de avisos proactivos por día.
 *
 * Es en memoria y por proceso, así que no es exacto — y aun así vale la pena. Lo que
 * protege es del escenario tonto: una operación masiva (un cargue de pagos, un reparto
 * de órdenes) que dispare cientos de eventos seguidos y convierta al número en un
 * emisor de spam a ojos de Meta, que es una calificación que cuesta semanas recuperar.
 * El tope real y fino lo pone el tier del número (hoy TIER_250).
 */
const TOPE_DIARIO = 150;

/**
 * Los avisos que el bot manda SIN que le pregunten.
 *
 * Es la única conducta del bot que le llega a alguien que no escribió nada, así que
 * está sujeta a cuatro frenos, y ninguno sobra:
 *
 *  1. **Interruptor propio**, apagado por omisión (`chatbot.avisosProactivos`).
 *  2. **Solo a quien ya nos escribió** por WhatsApp. Un abonado que nunca usó el canal
 *     no eligió recibir nada por aquí; tiene su factura y su recibo.
 *  3. **Solo casos que le importan**: su orden ya tiene técnico, o pagó y le volvió el
 *     servicio. Un "gracias por su pago" a quien nunca estuvo cortado es ruido.
 *  4. **Tope diario**, por si una operación masiva dispara una avalancha.
 *
 * Fuera de la ventana de 24 h de Meta esto sale por plantilla aprobada, que se paga.
 * Es otra razón para que la lista sea corta.
 */
export class AvisosProactivosService {
  private readonly logger = new Logger('AvisosProactivos');
  private enviadosHoy = 0;
  private diaDelConteo = '';

  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsapp: WhatsappService,
    private readonly gate: ChatbotGateService,
  ) {}

  // ── "Su caso ya tiene técnico" ─────────────────────────────────────────────

  async alAsignar(e: TicketAsignadoEvent): Promise<void> {
    try {
      if (!(await this.activo()) || !e?.subscriberId || e.code == null) return;
      // Solo órdenes nacidas en WhatsApp: el ERP reparte órdenes todo el día y avisar
      // por cada una sería una campaña masiva que nadie pidió.
      if ((e.abiertaPor ?? '') !== BOT_ACTOR.name) return;

      const phone = await this.telefonoDe(e.subscriberId);
      if (!phone) return;

      const tecnico = (e.tecnico ?? '').trim();
      await this.enviar(
        phone,
        `Le cuento que su caso (orden #${e.code}) ya tiene técnico asignado` +
          `${tecnico ? `: ${tecnico}` : ''}. Se comunicará con usted antes de ir. 🔧`,
        `orden #${e.code} asignada`,
      );
    } catch (err) {
      this.logger.warn(`No se pudo avisar de la asignación: ${(err as Error).message}`);
    }
  }

  // ── "Recibimos su pago y volvió el servicio" ───────────────────────────────

  async alPagar(e: PagoAplicadoEvent): Promise<void> {
    try {
      if (!(await this.activo()) || !e?.subscriberId) return;
      // Solo cuando el pago DEVOLVIÓ el servicio. Avisarle de cada pago a los 7.000
      // abonados sería una campaña mensual; esto, en cambio, es la noticia que el
      // cliente está esperando con el celular en la mano.
      if (e.reconexion !== 'reconectado') return;

      const phone = await this.telefonoDe(e.subscriberId);
      if (!phone) return;

      await this.enviar(
        phone,
        '¡Listo! ✅ Recibimos su pago y su servicio ya quedó activo. ' +
          'Si en unos minutos sigue sin navegar, reinicie el equipo y me cuenta.',
        'pago aplicado con reconexión',
      );
    } catch (err) {
      this.logger.warn(`No se pudo avisar del pago: ${(err as Error).message}`);
    }
  }

  // ── Internos ───────────────────────────────────────────────────────────────

  private async activo(): Promise<boolean> {
    return (await this.gate.conductas()).avisosProactivos;
  }

  /**
   * El número por el que ese cliente ya nos escribió. Si no hay ninguno se devuelve
   * null y no se manda nada: esa es la regla del consentimiento — el canal lo abre el
   * cliente, no nosotros.
   */
  private async telefonoDe(subscriberId: string): Promise<string | null> {
    const conv = await this.prisma.whatsappConversation.findFirst({
      where: { subscriberId, lastInboundAt: { not: null } },
      orderBy: { lastInboundAt: 'desc' },
      select: { phone: true, status: true },
    });
    if (!conv) return null;
    // Si la conversación la está atendiendo una persona, el aviso automático se calla:
    // quien está escribiendo sabe mejor qué decirle y cuándo.
    if (conv.status === 'ASIGNADA' || conv.status === 'PENDIENTE') return null;
    return conv.phone;
  }

  private async enviar(phone: string, texto: string, motivo: string): Promise<void> {
    if (!this.hayCupo()) {
      this.logger.warn(`Aviso proactivo NO enviado a ${phone} (${motivo}): se llegó al tope de ${TOPE_DIARIO}/día.`);
      return;
    }
    // Fuera de la ventana de 24 h sale por plantilla aprobada: un aviso que no llega
    // no sirve de nada, y este el cliente lo está esperando.
    const ok = await this.whatsapp.sendText(phone, texto, { reopenWithTemplate: true });
    if (ok) {
      this.enviadosHoy += 1;
      this.logger.log(`Aviso proactivo a ${phone}: ${motivo}.`);
    } else {
      this.logger.warn(`No salió el aviso proactivo a ${phone} (${motivo}).`);
    }
  }

  /** Tope diario, con el día en hora de Colombia (el corte del negocio, no el del servidor). */
  private hayCupo(): boolean {
    const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
    if (hoy !== this.diaDelConteo) {
      this.diaDelConteo = hoy;
      this.enviadosHoy = 0;
    }
    return this.enviadosHoy < TOPE_DIARIO;
  }
}
