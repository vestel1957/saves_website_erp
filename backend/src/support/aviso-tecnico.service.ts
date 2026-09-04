import { Logger } from '../core/logger';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../common/notifications/notifications.service';
import { usuarioDelTecnico } from '../common/tecnico-scope';
import type { TicketAsignadoEvent } from './support.events';

/**
 * Lo único que la campanita le dice a un técnico de campo sobre órdenes: **ésta ya
 * es tuya**.
 *
 * Nace de quitarle el ruido (2026-08-29): hasta hoy el técnico recibía un aviso por
 * CADA orden que abría el sistema en toda la empresa —4.688 avisos en cuatro días
 * repartidos entre 16 personas— y ninguno por las que le tocaban a él. Justo al
 * revés de lo que sirve.
 *
 * Va enganchado a `TICKET_ASIGNADO_EVENT` y no a cada sitio que asigna, que son
 * cuatro (`assign`, `createTicket`, `agenda.mover`, `agenda.moverLote`): el evento
 * ya se emite UNA vez por asignación de verdad, así que reordenar el tablero —que
 * llama a `mover` en cada arrastre sin cambiar de técnico— no le suena el teléfono.
 */
export class AvisoTecnicoService {
  private readonly logger = new Logger('AvisoTecnico');

  constructor(
    private readonly prisma: PrismaService,
    private readonly avisos: NotificationsService,
  ) {}

  /** Nunca lanza: un aviso que falla no puede tumbar la asignación que lo produjo. */
  async alAsignar(e: TicketAsignadoEvent): Promise<void> {
    try {
      const usuario = await usuarioDelTecnico(this.prisma, e.tecnico);
      // Sin login no hay a quién avisar. Pasa con los técnicos que sólo existen en el
      // legacy, y no es un fallo: ellos ven su trabajo allá.
      if (!usuario) return;
      await this.avisos.notify([usuario.id], {
        kind: 'soporte.orden_asignada',
        title: `Orden #${e.code ?? '—'} · ${e.type ?? 'Servicio'}`,
        body: 'Te asignaron esta orden. Está en Mi agenda.',
        link: `/soporte/${e.ticketId}`,
        // Una orden es UN asunto: si se la reasignan y se la devuelven, se le refresca
        // el aviso que ya tenía en vez de apilarle dos por lo mismo.
        groupKey: `ticket:${e.ticketId}`,
      });
    } catch (err) {
      this.logger.warn(`No se pudo avisarle al técnico de la orden ${e.ticketId}: ${(err as Error).message}`);
    }
  }
}
