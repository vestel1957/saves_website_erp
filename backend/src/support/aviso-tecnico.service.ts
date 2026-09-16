import { Logger } from '../core/logger';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../common/notifications/notifications.service';
import { usuarioDelTecnico } from '../common/tecnico-scope';
import { equiposDeOrdenes } from './equipo-reserva.service';
import type { TicketAsignadoEvent } from './support.events';

/** El `kind` de "esta orden ya es tuya". Se usa también para retirarlo. */
const KIND_ORDEN = 'soporte.orden_asignada';

/**
 * El aviso de "hay un equipo a tu nombre" NO se emite desde aquí: lo crea la ida del
 * legacy (`scripts/sync-legacy-vivo.js`, `avisarEquiposDeTecnico`), que es donde de
 * verdad ocurre. En nexus un equipo se le asigna a un CLIENTE o vive en una bodega
 * de sede; quien lo pone a nombre de una persona es el sistema viejo. El `kind` es
 * `inventario.equipo_asignado`.
 */

/**
 * Lo único que la campanita le dice a un técnico de campo sobre órdenes: **ésta ya
 * es tuya** (y qué caja tiene que llevarse).
 *
 * Nace de quitarle el ruido (2026-08-29): hasta entonces el técnico recibía un aviso
 * por CADA orden que abría el sistema en toda la empresa —4.688 avisos en cuatro días
 * repartidos entre 16 personas— y ninguno por las que le tocaban a él. Justo al
 * revés de lo que sirve.
 *
 * Va enganchado a `TICKET_ASIGNADO_EVENT` y no a cada sitio que asigna, que son
 * cuatro (`assign`, `createTicket`, `agenda.mover`, `agenda.moverLote`): el evento
 * ya se emite UNA vez por asignación de verdad, así que reordenar el tablero —que
 * llama a `mover` en cada arrastre sin cambiar de técnico— no le suena el teléfono.
 *
 * Y desde el 2026-09-04 el aviso también se RETIRA: una orden que se le pasa a otro
 * técnico desaparece de la campanita del anterior. Sin eso, el aviso decía "te
 * asignaron esta orden" de un trabajo que ya no era suyo, que es la queja del
 * usuario ("los técnicos están viendo de todo") en su forma más literal.
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
      // Se retira SIEMPRE, incluso si el nuevo técnico no tiene login: lo que hace
      // falta es que el anterior deje de verla, y eso no depende de que al de ahora
      // se le pueda avisar. `usuario?.id` como excepción evita el parpadeo de
      // borrar y recrear el aviso de quien ya lo tenía (la orden que va y vuelve).
      await this.avisos.retirar(`ticket:${e.ticketId}`, KIND_ORDEN, usuario ? [usuario.id] : []);

      // Sin login no hay a quién avisar. Pasa con los técnicos que sólo existen en el
      // legacy, y no es un fallo: ellos ven su trabajo allá.
      if (!usuario) return;
      await this.avisos.notify([usuario.id], {
        kind: KIND_ORDEN,
        title: `Orden #${e.code ?? '—'} · ${e.type ?? 'Servicio'}`,
        body: `Te asignaron esta orden. Está en Mi agenda.${await this.frasePorEquipo(e)}`,
        link: `/soporte/${e.ticketId}`,
        // Una orden es UN asunto: si se la reasignan y se la devuelven, se le refresca
        // el aviso que ya tenía en vez de apilarle dos por lo mismo.
        groupKey: `ticket:${e.ticketId}`,
      });
    } catch (err) {
      this.logger.warn(`No se pudo avisarle al técnico de la orden ${e.ticketId}: ${(err as Error).message}`);
    }
  }

  /**
   * La orden dejó de tener técnico: se le quita el aviso al que la tenía.
   *
   * Es el mismo caso que la reasignación pero sin nadie a quien pasársela, así que
   * no hay evento del que colgarlo — lo llama `assign` cuando se desasigna. Sin
   * esto, desasignar dejaba al técnico con un aviso de trabajo que ya no existe.
   */
  async alDesasignar(ticketId: string): Promise<void> {
    await this.avisos.retirar(`ticket:${ticketId}`, KIND_ORDEN).catch(() => 0);
  }

  /**
   * "Llévese el equipo 4821": la caja que la orden apartó del estante.
   *
   * El dato ya existía y ya se pinta en la ficha y en el agendamiento
   * (`AvisoEquipo`), pero el técnico no entra ahí — él mira la campanita y sale. Sin
   * esta frase se enteraba del equipo al llegar a la casa del cliente, y si instalaba
   * otra unidad la ONU no se autenticaba sola.
   *
   * Devuelve cadena vacía cuando la orden no pide equipo, que son la mayoría: un
   * "no lleva equipo" en cada aviso es la clase de ruido que hace que no se lean.
   */
  private async frasePorEquipo(e: TicketAsignadoEvent): Promise<string> {
    try {
      const mapa = await equiposDeOrdenes(this.prisma, [{ id: e.ticketId, type: e.type }]);
      const dato = mapa.get(e.ticketId);
      if (!dato) return '';
      const eq = dato.equipo;
      if (!eq) return ' ⚠️ Necesita equipo y no hay ninguno apartado: sáquelo de la bodega.';
      // "Ya es suyo" no es lo mismo que "apartado": si la caja ya figura a nombre del
      // cliente, es ESA la que se instala (y la que se autentica sola), esté en su
      // casa o esperándole en la bodega. Decirle "llévese" una que quizá ya está
      // instalada manda al técnico a buscar lo que no hay.
      const donde = `${eq.serial ? ` (S/N ${eq.serial})` : ''}${eq.bodega ? ` de ${eq.bodega}` : ''}`;
      return eq.origen === 'asignado'
        ? ` El equipo de este cliente es el ${eq.code}${donde}: ese es el que se instala.`
        : ` Llévese el equipo ${eq.code}${donde}.`;
    } catch {
      return ''; // el equipo es un extra del aviso: si falla, el aviso sale igual
    }
  }
}
