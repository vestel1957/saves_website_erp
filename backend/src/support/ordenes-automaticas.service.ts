import { Logger } from '../core/logger';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ResponsibilityNotifierService } from '../responsibilities/responsibility-notifier.service';
import { nextTid, TID_SEQ } from '../common/tid';
import { eventos } from '../core/eventos';
import { TICKET_CREADO_EVENT } from './support.events';
import { hoyEnColombia } from '../common/fecha-colombia';
import { autorSistema } from './autor-orden';

/**
 * Órdenes de servicio que abre el SISTEMA, no una persona.
 *
 * Hay trabajo que nace de un fallo, no de una llamada: el cliente paga, el sistema
 * intenta devolverle la señal y el equipo no responde. Antes eso terminaba en un
 * aviso en pantalla que la cajera leía (o no) y se perdía; el cliente quedaba
 * pagando un servicio que nadie iba a restablecer.
 *
 * Este servicio convierte ese fallo en trabajo que existe: una orden PENDIENTE
 * colgada del abonado, con el motivo dentro, que aparece en la bandeja de soporte
 * como cualquier otra y se le avisa a quien reparte.
 *
 * Va aparte de `SupportWriteService` a propósito:
 *  · aquel exige un `AuthUser` y le prohíbe abrir órdenes al técnico de campo —
 *    reglas de quien atiende un mostrador, no de un proceso automático;
 *  · sus dependencias (agenda, geo-cerca, puntajes) no pintan nada aquí y lo harían
 *    imposible de cablear desde red/tesorería sin dar la vuelta al contenedor.
 *
 * Lo único que comparte —y es lo que importa— es de dónde sale el número de orden:
 * `TID_SEQ.ticketCode`, el rango propio de nexus. Ver `consecutivos-tid`.
 */

export type OrdenAbierta = {
  id: string;
  code: number | null;
  type: string;
  /** false = ya había una orden abierta igual y se reusó (no se duplica trabajo). */
  nueva: boolean;
  /** PENDIENTE = queda trabajo por hacer · RESUELTO = es la constancia de algo ya hecho. */
  estado?: 'PENDIENTE' | 'RESUELTO';
};

export type AbrirOrdenInput = {
  subscriberId: string;
  /** Detalle del catálogo (`tickets.detalle`), p. ej. 'Reconexion Television'. */
  type: string;
  /** Clase de la orden: servicio / reclamo / incidente. */
  subject?: string;
  /** Qué pasó, en una línea (va a `tickets.problema`). */
  problem?: string;
  /** Detalle largo: el error técnico tal cual, para que el técnico no adivine. */
  section?: string;
  priority?: string;
  /** Cargo al que se le avisa. Por defecto, quien reparte el trabajo de campo. */
  post?: string;
  /** Quién queda como autor en la orden (columna `col`). */
  autor?: string;
  /**
   * Otros detalles que cuentan como LA MISMA orden a la hora de no duplicar.
   *
   * Existe por el sufijo "2" de las reconexiones: 'Reconexion Television' y
   * 'Reconexion Television2' son el mismo trabajo —devolverle la señal a este
   * cliente— y sólo se diferencian en si además hay días que cobrar. Sin esto, un
   * abonado con la reconexión pendiente de visita al que le cambia la respuesta
   * (porque cambió el mes) acabaría con dos órdenes abiertas y dos visitas.
   */
  tiposEquivalentes?: string[];
};

export class OrdenesAutomaticasService {
  private readonly logger = new Logger(OrdenesAutomaticasService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly porCargo: ResponsibilityNotifierService,
  ) {}

  /**
   * Deja CONSTANCIA de un trabajo que el sistema ya hizo: la orden nace y se cierra
   * en el mismo acto.
   *
   * Es lo que hacía la cajera del legacy a mano — al reconectar a alguien que pagaba,
   * abría su "Reconexion Internet" y la cerraba—, y el motivo de conservarlo es que
   * sin esa orden el trabajo no existe para nadie: la ficha del cliente no cuenta que
   * se le devolvió el servicio, los informes de campo no lo ven, y la propia señal de
   * "¿sigue cortado?" se queda mirando un corte sin reconexión posterior (ver
   * `cortesSegunOrdenes` en ReconexionService).
   *
   * Nace ya RESUELTA y sin técnico asignado a propósito: no es trabajo para nadie —lo
   * hizo el sistema en dos segundos contra el equipo— y colgárselo a un técnico le
   * ensuciaría el tablero de rendimiento con visitas que no hizo.
   *
   * Si el abonado tenía una orden ABIERTA de lo mismo (porque la vez pasada el equipo
   * falló y quedó pendiente de visita), no se crea otra: se cierra ESA. Así el ciclo
   * se cierra solo y el técnico no va a una casa donde ya no hay nada que hacer.
   */
  async registrarResuelta(input: AbrirOrdenInput): Promise<OrdenAbierta | null> {
    try {
      const ahora = new Date();
      const cierre = {
        status: 'RESUELTO' as const,
        finalDate: hoyEnColombia(),
        resolvedAt: ahora,
        section: input.section ?? null,
      };

      const abierta = await this.prisma.ticket.findFirst({
        where: {
          subscriberId: input.subscriberId,
          type: { in: [input.type, ...(input.tiposEquivalentes ?? [])] },
          status: { in: ['PENDIENTE', 'REALIZANDO'] },
        },
        select: { id: true, code: true, type: true },
        orderBy: { createdAt: 'desc' },
      });
      if (abierta) {
        await this.prisma.ticket.update({ where: { id: abierta.id }, data: cierre });
        this.logger.log(`Orden #${abierta.code} (${input.type}) cerrada sola: el sistema hizo el trabajo.`);
        return { ...abierta, nueva: false, estado: 'RESUELTO' };
      }

      const creada = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const code = await nextTid(tx, TID_SEQ.ticketCode);
        return tx.ticket.create({
          data: {
            code,
            subject: input.subject ?? 'servicio',
            type: input.type,
            created: hoyEnColombia(),
            subscriberId: input.subscriberId,
            // Quién la generó: aquí NUNCA una persona, siempre el proceso que la
            // abrió (ver `autor-orden`). Que se distinga es justo el punto: una
            // orden del sistema no se le reclama a nadie.
            ...autorSistema(input.autor),
            priority: input.priority ?? 'Media',
            problem: input.problem ?? null,
            ...cierre,
          },
          select: { id: true, code: true, type: true },
        });
      });
      // No se avisa a nadie: no hay trabajo que repartir, es un asiento de lo ocurrido.
      // Al legacy sí sale en el acto: allá es donde se consulta el historial del abonado,
      // y cuanto antes viaje menos ocasión hay de que le den su número a otra orden.
      this.emitirCreada(creada, input.subscriberId);
      this.logger.log(`Orden #${creada.code} (${input.type}) registrada y cerrada para el abonado ${input.subscriberId}.`);
      return { ...creada, nueva: true, estado: 'RESUELTO' };
    } catch (e) {
      this.logger.error(`No se pudo registrar la orden de "${input.type}": ${(e as Error).message}`);
      return null;
    }
  }

  /**
   * Abre la orden si el abonado no tiene ya una igual abierta.
   *
   * La comprobación de duplicados no es cosmética: un cliente en Cartera puede
   * abonar tres veces en una semana, y sin esto cada abono le abriría otra orden
   * de "Reconexion Television" — el técnico vería tres visitas para el mismo
   * trabajo y el tablero de rendimiento contaría tres.
   *
   * NUNCA lanza: la abre quien está haciendo otra cosa (cobrar, reconectar), y un
   * fallo escribiendo la orden no puede tumbar esa operación. Si no se pudo, se
   * devuelve `null` y queda el error en el log.
   */
  async abrirSiNoHay(input: AbrirOrdenInput): Promise<OrdenAbierta | null> {
    try {
      const abierta = await this.prisma.ticket.findFirst({
        where: {
          subscriberId: input.subscriberId,
          type: { in: [input.type, ...(input.tiposEquivalentes ?? [])] },
          status: { in: ['PENDIENTE', 'REALIZANDO'] },
        },
        select: { id: true, code: true, type: true },
        orderBy: { createdAt: 'desc' },
      });
      if (abierta) return { ...abierta, nueva: false, estado: 'PENDIENTE' };

      const creada = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const code = await nextTid(tx, TID_SEQ.ticketCode);
        return tx.ticket.create({
          data: {
            code,
            subject: input.subject ?? 'servicio',
            type: input.type,
            created: hoyEnColombia(),
            subscriberId: input.subscriberId,
            ...autorSistema(input.autor),
            status: 'PENDIENTE',
            priority: input.priority ?? 'Media',
            problem: input.problem ?? null,
            section: input.section ?? null,
          },
          select: { id: true, code: true, type: true },
        });
      });

      // Ésta SÍ es trabajo pendiente: sale hacia el legacy en el acto, que es donde el
      // técnico mira lo que tiene que hacer.
      this.emitirCreada(creada, input.subscriberId);

      // NO se avisa por campanita (2026-08-29, decisión del usuario). Una orden
      // automática es un evento rutinario —unas 38 al día, casi todas reconexiones
      // por pago— y avisarlas una a una llenaba la campana de 31 personas con 4.688
      // avisos en cuatro días. Es exactamente lo que la regla de oro de
      // `NotificationsService` prohíbe: notificar lo que nadie tiene que ir a hacer
      // en ese momento. Se reparten desde la bandeja de "sin agendar" y desde el
      // legacy, que es donde el técnico mira su trabajo. Al técnico se le avisa
      // cuando la orden pasa a ser SUYA (`AvisoTecnicoService`), que es lo que sí
      // le toca hacer.

      this.logger.log(`Orden automática #${creada.code} (${input.type}) para el abonado ${input.subscriberId}: ${input.problem ?? ''}`);
      return { ...creada, nueva: true, estado: 'PENDIENTE' };
    } catch (e) {
      this.logger.error(`No se pudo abrir la orden automática (${input.type}): ${(e as Error).message}`);
      return null;
    }
  }

  /**
   * Avisa de que la orden nació, para que salga hacia el legacy sin esperar al cron.
   *
   * Usa el bus directamente en vez de recibirlo por constructor porque este servicio se
   * cablea desde red y tesorería, y añadirle una dependencia más obliga a tocar todos
   * esos sitios. Nunca lanza: abrir la orden es lo importante; que el empuje se retrase
   * cinco minutos no puede tumbar el cobro o la reconexión que la abrió.
   */
  private emitirCreada(creada: { id: string; code: number | null }, subscriberId: string): void {
    try {
      eventos.emit(TICKET_CREADO_EVENT, { ticketId: creada.id, code: creada.code, subscriberId });
    } catch (e) {
      this.logger.warn(`No se pudo avisar de la orden #${creada.code}: ${(e as Error).message}`);
    }
  }

}
