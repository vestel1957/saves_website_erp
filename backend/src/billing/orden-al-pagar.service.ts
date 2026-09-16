/**
 * LA ORDEN QUE NACE DEL PAGO.
 *
 * Hay trabajos que se cobran ANTES de hacerse: el cliente pide algo en la ventanilla,
 * la cajera se lo factura y el técnico sale cuando el cliente paga. Eso ya funcionaba
 * para el alta —la orden de instalación nace al pagarse la afiliación
 * (`AltaClienteService`)— y desde el 2026-09-08 funciona igual para el TRASLADO, que
 * es lo que pidió el usuario: «se selecciona una factura por traslado, ahí mismo se
 * pone la nueva dirección, y una vez se cancele dicha factura ahí sí se genera la
 * orden de servicio de traslado automáticamente».
 *
 * Esta clase es el disparador genérico: mira las filas de `PendingOrder` cuya factura
 * ya está PAGADA y abre su orden. El qué abrir lo dice la fila (`type`) y el catálogo
 * de motivos (`motivos-factura.ts`); aquí sólo está la mecánica, que es la misma para
 * cualquier trabajo que se pague por adelantado.
 *
 * DOS CAMINOS, como en la instalación:
 *   · el evento `treasury.pago.aplicado` — lo que se cobra AQUÍ, al instante;
 *   · el barrido de los 5 minutos — lo que se cobra EN EL LEGACY (llega por el sync,
 *     sin pasar por `collect`, o sea sin evento) y los intentos que fallaron.
 *
 * EL CANDADO es el mismo `updateMany` condicionado a `fulfilledAt: null` antes de
 * tocar nada: el evento y el barrido pueden ver el mismo pago y sólo uno se lleva la
 * fila. Si la creación falla, se suelta el sello y se guarda el motivo para el
 * siguiente barrido.
 *
 * NO SE VUELVE A COBRAR. La orden se abre con `yaFacturada`, que apaga el cargo
 * automático del tipo de orden (`cargos-orden.ts`) y ata la orden a la factura que ya
 * se pagó. Sin eso, un traslado facturado en ventanilla acabaría con dos facturas de
 * 30.000: la que pagó el cliente y la que emite la orden al abrirse.
 */

import { Prisma } from '@prisma/client';
import { Logger } from '../core/logger';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/current-user.decorator';
import type { SupportWriteService } from '../support/support-write.service';
import type { TrasladoDto } from '../common/traslado';
import { etiquetaDeMotivo } from './motivos-factura';

const PENDIENTE_SELECT = {
  id: true, subscriberId: true, motivo: true, type: true, payload: true,
  resumen: true, context: true, createdAt: true,
  invoice: { select: { tid: true } },
} satisfies Prisma.PendingOrderSelect;

type Pendiente = Prisma.PendingOrderGetPayload<{ select: typeof PENDIENTE_SELECT }>;

export type ResultadoOrdenesAlPagar = { creadas: number };

export class OrdenAlPagarService {
  private readonly logger = new Logger(OrdenAlPagarService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly soporte: SupportWriteService,
  ) {}

  /**
   * Se registró un pago de este cliente: si con él quedó pagada una factura que
   * llevaba trabajo detrás, se abre la orden.
   *
   * Best-effort: nunca puede tumbar un recaudo que ya está hecho y contabilizado.
   */
  async alPagar(subscriberId: string): Promise<ResultadoOrdenesAlPagar> {
    const pendientes = await this.prisma.pendingOrder.findMany({
      where: { subscriberId, fulfilledAt: null, invoice: { status: 'PAID' } },
      select: PENDIENTE_SELECT,
    });
    return this.abrir(pendientes);
  }

  /**
   * Barrido de red de seguridad: TODAS las órdenes en espera cuya factura ya está
   * pagada. Recoge lo que se cobró en el legacy (que no emite evento aquí) y
   * reintenta lo que falló.
   */
  async barrer(): Promise<ResultadoOrdenesAlPagar> {
    const pendientes = await this.prisma.pendingOrder.findMany({
      where: { fulfilledAt: null, invoice: { status: 'PAID' } },
      select: PENDIENTE_SELECT,
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
    return this.abrir(pendientes);
  }

  private async abrir(pendientes: Pendiente[]): Promise<ResultadoOrdenesAlPagar> {
    let creadas = 0;
    for (const p of pendientes) {
      const tomada = await this.prisma.pendingOrder.updateMany({
        where: { id: p.id, fulfilledAt: null },
        data: { fulfilledAt: new Date(), lastError: null },
      });
      if (!tomada.count) continue; // se la llevó el otro camino

      try {
        const t = await this.crearOrden(p);
        await this.prisma.pendingOrder.update({
          where: { id: p.id },
          data: { ticketId: t.id, ticketCode: t.code },
        });
        creadas++;
        this.logger.log(
          `[orden-al-pagar] orden #${t.code} (${p.type}) abierta al pagarse la factura #${p.invoice?.tid ?? '?'} (cliente ${p.subscriberId})`,
        );
      } catch (e) {
        // Se suelta el sello: la orden vuelve a la cola del barrido.
        await this.prisma.pendingOrder.update({
          where: { id: p.id },
          data: { fulfilledAt: null, lastError: (e as Error).message.slice(0, 500) },
        });
        this.logger.error(`[orden-al-pagar] no se pudo abrir la orden ${p.type} del cliente ${p.subscriberId}: ${(e as Error).message}`);
      }
    }
    return { creadas };
  }

  /** La orden en sí, atada a la factura que la pagó y sin volver a cobrarla. */
  private async crearOrden(p: Pendiente): Promise<{ id: string; code: number | null }> {
    const destino = this.destinoDe(p);
    const yaFacturada = p.invoice?.tid
      ? { tid: p.invoice.tid, concepto: etiquetaDeMotivo(p.motivo) }
      : undefined;
    const base = {
      subscriberId: p.subscriberId,
      subject: 'servicio',
      type: p.type,
      section: p.context || undefined,
    };

    // Si entre la factura y el pago alguien ya le movió la dirección al cliente (una
    // orden de traslado abierta a mano, o el sistema viejo), la orden se abre igual:
    // repetir la dirección que la ficha ya tiene dejó de ser un error (`armarTraslado`),
    // y el parche que se le escribe a la ficha es entonces el mismo que ya está puesto.
    return await this.soporte.createTicket(
      { ...base, moveTo: destino ?? undefined } as never,
      this.usuarioSistema(),
      { yaFacturada },
    );
  }

  /** El destino de un traslado, tal como se guardó al facturar. */
  private destinoDe(p: Pendiente): TrasladoDto | null {
    const payload = p.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const obj = payload as Record<string, unknown>;
    if (!obj.nomenclature || typeof obj.nomenclature !== 'object') return null;
    return obj as unknown as TrasladoDto;
  }

  /**
   * Usuario con el que se firma una orden que abre el sistema, no una persona. El
   * pago puede llegar por caja, por el cargue de Excel o por el legacy: el
   * denominador común es que la orden no la pidió nadie a mano, la disparó el pago.
   */
  private usuarioSistema(): AuthUser {
    return { id: 'system', email: 'cron@vestel', name: 'Sistema (factura pagada)', roles: [], permissions: ['system.admin'] };
  }
}
