import { Logger } from '../core/logger';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsappService } from '../common/whatsapp/whatsapp.service';
import { ChatbotGateService } from './chatbot-gate.service';
import { SupportWriteService } from '../support/support-write.service';
import { TICKET_RESUELTO_EVENT, type TicketResueltoEvent } from '../support/support.events';
import { BOT_ACTOR } from './chatbot.identity';
import { interpretarConfirmacion } from './confirmacion.parser';

/**
 * Cuánto se espera la respuesta del cliente. Pasado ese plazo la espera se descarta y
 * el bot lo atiende con normalidad: dejar la marca puesta para siempre significaría
 * que el próximo "¿cuánto debo?" de ese cliente, dos meses después, se leería como la
 * respuesta a una pregunta que ya nadie recuerda.
 */
const ESPERA_MAX_MS = 48 * 60 * 60 * 1000;

/**
 * Cierra el bucle que en SAM cerraban los botones de Telegram.
 *
 * En SAM, sistemas apretaba IR TÉCNICO o MARCAR RESUELTO en un mensaje del grupo, y el
 * bot le escribía al cliente para que verificara. Aquí no hacen falta botones: el
 * equipo ya trabaja las órdenes en `/soporte`, así que la señal es el propio cierre de
 * la orden (`TICKET_RESUELTO_EVENT`).
 *
 * Lo que aporta, y es la razón de existir: hoy, cuando un técnico pasa una orden a
 * RESUELTO, **al cliente no se le dice nada**. Si el problema no quedó, nadie se
 * enteraba hasta que el cliente volvía a llamar — y para entonces ya estaba molesto y
 * la orden figuraba como resuelta en los indicadores. Ahora la orden solo se da por
 * buena cuando el cliente lo confirma, y si dice que no, sale una re-visita en el acto.
 *
 * Dos decisiones que acotan el daño posible:
 *
 *  1. **Solo órdenes que nacieron en WhatsApp** (`Ticket.col` = el bot). El ERP cierra
 *     cientos de cortes y reconexiones al día de forma automática; preguntarle a cada
 *     cliente por cada una sería una campaña de spam involuntaria.
 *  2. **Solo si hay conversación abierta con ese cliente** y la lleva el bot. Si un
 *     compañero está atendiendo el chat a mano, el sistema no se mete en medio.
 */
export class TicketConfirmacionService {
  private readonly logger = new Logger('ConfirmacionSolucion');

  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsapp: WhatsappService,
    private readonly soporte: SupportWriteService,
    private readonly gate: ChatbotGateService,
  ) {}

  /**
   * Interruptor. Manda el ajuste de Configuración → Agente de WhatsApp (efecto
   * inmediato) y, si no está definido, `WA_BOT_CONFIRMAR`. Apagado, el cierre de
   * órdenes sigue funcionando exactamente igual: solo se deja de preguntar.
   */
  private async activo(): Promise<boolean> {
    return (await this.gate.conductas()).confirmarSolucion;
  }

  // ── Se cerró la orden: se le pregunta al cliente ───────────────────────────

  async alResolver(e: TicketResueltoEvent): Promise<void> {
    try {
      if (!(await this.activo()) || !e?.subscriberId || e.code == null) return;
      // Órdenes del bot únicamente (ver la nota de arriba).
      if ((e.abiertaPor ?? '') !== BOT_ACTOR.name) return;

      const conv = await this.conversacionDe(e.subscriberId);
      if (!conv) return;

      // La atiende una persona: no se le encima un mensaje automático.
      if (conv.status === 'ASIGNADA' || conv.status === 'PENDIENTE') {
        this.logger.log(`Orden #${e.code}: la conversación de ${conv.phone} la lleva una persona; no se pregunta.`);
        return;
      }
      // Ya se le preguntó por otra orden y no ha contestado: una pregunta a la vez.
      if (conv.awaitingTicketId && !this.caduco(conv.awaitingSince)) {
        this.logger.log(`Orden #${e.code}: ${conv.phone} ya tiene una confirmación pendiente; no se apila otra.`);
        return;
      }

      const texto =
        `¡Buenas noticias! 🙌 Desde el área técnica me indican que ya quedó solucionado el servicio ` +
        `(orden #${e.code}). ¿Me confirma si le está funcionando bien?`;

      // `reopenWithTemplate`: el técnico puede cerrar la orden al día siguiente, y para
      // entonces la ventana de 24 h de Meta ya se cerró. Sin esto, justo el mensaje que
      // cierra el caso sería el que no sale.
      const ok = await this.whatsapp.sendText(conv.phone, texto, { reopenWithTemplate: true });
      if (!ok) {
        this.logger.warn(`No se pudo preguntarle a ${conv.phone} por la orden #${e.code}.`);
        return;
      }

      await this.prisma.whatsappConversation.update({
        where: { phone: conv.phone },
        data: { awaitingTicketId: e.ticketId, awaitingSince: new Date() },
      });
      this.logger.log(`Orden #${e.code}: se le preguntó a ${conv.phone} si le quedó funcionando.`);
    } catch (err) {
      // Nunca propaga: esto corre en un listener de evento, y que falle no puede
      // deshacer el cierre de la orden que el técnico acaba de hacer.
      this.logger.warn(`No se pudo pedir confirmación de la orden #${e?.code}: ${(err as Error).message}`);
    }
  }

  // ── El cliente contestó ────────────────────────────────────────────────────

  /**
   * ¿Este mensaje es la respuesta a "¿le quedó funcionando?"? Si lo es, lo resuelve y
   * devuelve true para que el bot NO lo procese: la decisión es determinista y no puede
   * depender de que el modelo entienda bien un "sigue igual".
   *
   * Si el cliente escribe cualquier otra cosa, devuelve false y se descarta la espera:
   * quien preguntó por su factura merece una respuesta sobre su factura, no un "responda
   * sí o no" (que es donde SAM dejaba atrapada a la gente).
   */
  async intentarResponder(phone: string, texto: string): Promise<boolean> {
    if (!(await this.activo())) return false;
    const digits = (phone || '').replace(/\D/g, '');
    if (!digits || !texto?.trim()) return false;

    try {
      const conv = await this.prisma.whatsappConversation.findUnique({
        where: { phone: digits },
        select: { phone: true, awaitingTicketId: true, awaitingSince: true },
      });
      if (!conv?.awaitingTicketId) return false;

      if (this.caduco(conv.awaitingSince)) {
        await this.limpiar(digits);
        this.logger.log(`La espera de confirmación de ${digits} caducó; se atiende normal.`);
        return false;
      }

      const veredicto = interpretarConfirmacion(texto);
      if (veredicto === 'no-claro') {
        // No estaba contestando la pregunta: se suelta la espera y contesta el bot.
        await this.limpiar(digits);
        this.logger.log(`${digits} escribió otra cosa en vez de confirmar; lo atiende el bot.`);
        return false;
      }

      const ticket = await this.prisma.ticket.findUnique({
        where: { id: conv.awaitingTicketId },
        select: { id: true, code: true, type: true, subscriberId: true },
      });
      await this.limpiar(digits);
      if (!ticket) return false;

      return veredicto === 'si' ? this.cerrarBien(digits, ticket) : this.abrirRevisita(digits, ticket);
    } catch (e) {
      this.logger.warn(`Error procesando la confirmación de ${digits}: ${(e as Error).message}`);
      return false;
    }
  }

  /** Confirmó que quedó: se agradece y queda escrito en la orden. */
  private async cerrarBien(
    phone: string,
    ticket: { id: string; code: number | null },
  ): Promise<boolean> {
    await this.whatsapp.sendText(
      phone,
      '¡Qué bueno! 😊 Me alegra que su servicio ya esté funcionando. Si necesita algo más, quedo atento por aquí.',
    );
    await this.anotar(ticket.id, 'El cliente confirmó por WhatsApp que el servicio quedó funcionando.');
    this.logger.log(`Orden #${ticket.code}: el cliente confirmó que quedó bien.`);
    return true;
  }

  /**
   * Dijo que NO quedó: sale una orden nueva de re-visita.
   *
   * Se crea una orden en vez de reabrir la anterior por dos razones: el histórico
   * conserva que se cerró y que el cliente lo rechazó (que es lo que hay que poder
   * auditar), y el tablero de rendimiento mide precisamente la RE-VISITA a 15 días —
   * reabrir la misma orden le escondería el dato. Nace en prioridad Alta y sin técnico,
   * así que `createTicket` avisa al encargado de soporte por su cuenta.
   */
  private async abrirRevisita(
    phone: string,
    ticket: { id: string; code: number | null; type: string | null; subscriberId: string | null },
  ): Promise<boolean> {
    if (!ticket.subscriberId) return false;

    const nueva = await this.soporte.createTicket(
      {
        subscriberId: ticket.subscriberId,
        subject: `Re-visita: el cliente reporta que no quedó (orden #${ticket.code})`,
        type: ticket.type || 'Revision de Internet',
        problem: 'El cliente confirmó por WhatsApp que el servicio NO quedó funcionando.',
        section:
          `[Bot WhatsApp] La orden #${ticket.code} se cerró como resuelta y el cliente respondió que su ` +
          `servicio sigue sin funcionar. Requiere visita técnica.`,
        priority: 'Alta',
      } as any,
      BOT_ACTOR,
    );

    await this.whatsapp.sendText(
      phone,
      'Lamento que el inconveniente siga. 🔧 Ya dejé el caso registrado de nuevo con el número ' +
        `#${nueva.code} y con prioridad alta para que un técnico se desplace a la vivienda. ` +
        'Le contactamos para coordinar la visita.',
    );
    await this.anotar(
      ticket.id,
      `El cliente respondió por WhatsApp que NO quedó funcionando. Se abrió la orden #${nueva.code} (re-visita).`,
    );
    this.logger.warn(`Orden #${ticket.code}: el cliente dijo que NO quedó → re-visita #${nueva.code}.`);
    return true;
  }

  // ── Internos ───────────────────────────────────────────────────────────────

  /**
   * La conversación por la que se le puede escribir a este cliente: la suya, y solo si
   * alguna vez escribió él (`lastInboundAt`). Un cliente que nunca nos ha escrito no
   * tiene ventana de 24 h abierta ni ha consentido este canal.
   */
  private async conversacionDe(subscriberId: string) {
    return this.prisma.whatsappConversation.findFirst({
      where: { subscriberId, lastInboundAt: { not: null } },
      orderBy: { lastInboundAt: 'desc' },
      select: { phone: true, status: true, awaitingTicketId: true, awaitingSince: true },
    });
  }

  private caduco(desde: Date | null): boolean {
    return !desde || Date.now() - desde.getTime() > ESPERA_MAX_MS;
  }

  private async limpiar(phone: string): Promise<void> {
    await this.prisma.whatsappConversation
      .update({ where: { phone }, data: { awaitingTicketId: null, awaitingSince: null } })
      .catch(() => undefined);
  }

  /** Deja el rastro en el hilo de la orden. Que falle no cambia lo ya hecho. */
  private async anotar(ticketId: string, mensaje: string): Promise<void> {
    await this.soporte
      .addThread(ticketId, { message: mensaje }, BOT_ACTOR)
      .catch((e) => this.logger.warn(`No se pudo anotar en la orden: ${(e as Error).message}`));
  }
}
