import { Injectable } from '@nestjs/common';
import type { Toolset, ToolContext, ToolDef } from '@s4gk/wa-agent';
import { PERMISSION_DENIED } from '@s4gk/wa-agent';
import { APP_PERMISSIONS as P } from '../../auth/permissions.catalog';
import { InventoryService } from '../../inventory/inventory.service';
import { SupportService } from '../../support/support.service';
import { SupportWriteService } from '../../support/support-write.service';
import { authUserOf } from '../chatbot.identity';
import { canAny, cop, gated, safe } from './toolset.util';

/** Mismo gate que el controller de inventario. */
const INVENTARIO = [P.AREA_ADMINISTRACION, P.AREA_TECNICOS];

/**
 * Quién puede ESCRIBIR. Más estrecho que `INVENTARIO`, y tiene que coincidir con el
 * `permission` del `preparePending`: el motor lo revalida al confirmar, así que
 * declararle la herramienta a quien no lo tiene le hace recorrer todo el flujo para
 * chocar al final con "ya no tienes permiso" — que además insinúa que el permiso
 * cambió, cuando nunca lo tuvo.
 */
const INVENTARIO_ESCRIBE = [P.AREA_TECNICOS];

/**
 * Stock y consumo de material. El descuento de stock NO se hace suelto: se hace
 * SIEMPRE contra un ticket (`SupportWriteService.consumeMaterials`), que es el único
 * camino que el ERP tiene para descontar material dejando trazabilidad de en qué
 * orden se gastó. `InventoryService` no expone un descuento directo, y está bien:
 * material que sale sin ticket es material que se pierde.
 */
@Injectable()
export class InternoInventarioToolset implements Toolset {
  constructor(
    private readonly inventory: InventoryService,
    private readonly support: SupportService,
    private readonly write: SupportWriteService,
  ) {}

  definitions(ctx: ToolContext): ToolDef[] {
    return [
      ...gated(canAny(ctx, INVENTARIO), [
      {
        name: 'consultar_stock',
        description: 'Consulta el stock de materiales por nombre o código. Devuelve cantidad disponible y bodega.',
        input_schema: {
          type: 'object',
          properties: {
            q: { type: 'string', description: 'Nombre o código del material' },
            solo_bajos: { type: 'boolean', description: 'Solo los que están en o bajo el punto de alerta' },
          },
        },
      },
      ]),
      ...gated(canAny(ctx, INVENTARIO_ESCRIBE), [
      {
        name: 'descontar_material',
        description:
          'Descuenta material del inventario cargándolo a un ticket (así queda la trazabilidad de en qué orden se usó). Requiere confirmación.',
        input_schema: {
          type: 'object',
          properties: {
            ticketId: { type: 'string', description: 'id del ticket al que se carga el material' },
            materialId: { type: 'string', description: 'id del material (de consultar_stock)' },
            cantidad: { type: 'number', description: 'Unidades a descontar (entero ≥ 1)' },
          },
          required: ['ticketId', 'materialId', 'cantidad'],
        },
      },
      ]),
    ];
  }

  async execute(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    if (!canAny(ctx, INVENTARIO)) return PERMISSION_DENIED;

    switch (name) {
      case 'consultar_stock':
        return safe(() => this.stock(input));
      case 'descontar_material':
        return safe(() => this.descontar(input, ctx));
      default:
        return `Herramienta no disponible: ${name}`;
    }
  }

  private async stock(input: Record<string, unknown>): Promise<string> {
    const res = await this.inventory.materials({
      search: input.q ? String(input.q) : undefined,
      lowStock: input.solo_bajos ? '1' : undefined,
      pageSize: 8,
    });
    if (!res.items.length) return 'No encontré materiales con esa búsqueda.';
    const lineas = res.items.map(
      (m) => `• ${m.name}${m.code ? ` (${m.code})` : ''}: ${m.qty} und${m.low ? ' ⚠️ BAJO' : ''}` +
        ` · ${m.warehouse ?? 'sin bodega'} · ${cop(m.price)}\n  id: ${m.id}`,
    );
    const extra = res.total > res.items.length ? `\n(+${res.total - res.items.length} más)` : '';
    return `${res.total} material(es):\n${lineas.join('\n')}${extra}`;
  }

  private async descontar(input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const ticketId = String(input.ticketId ?? '');
    const materialId = String(input.materialId ?? '');
    const cantidad = Math.trunc(Number(input.cantidad));

    if (ctx.committing) {
      await this.write.consumeMaterials(ticketId, { items: [{ materialId, qty: cantidad }] } as any, authUserOf(ctx.user));
      await ctx.audit({
        userId: ctx.user.id, action: 'inventory.consume',
        summary: `Descontadas ${cantidad} und por WhatsApp`, detail: { ticketId, materialId, cantidad },
      });
      return `Listo: ${cantidad} unidad(es) descontadas y cargadas al ticket.`;
    }

    if (!Number.isInteger(cantidad) || cantidad < 1) return 'La cantidad debe ser un entero mayor o igual a 1.';
    const m = await this.inventory.materialDetail(materialId).catch(() => null);
    if (!m) return 'No encontré ese material. Búscalo primero con consultar_stock.';
    if ((m as any).qty < cantidad) {
      return `No alcanza el stock: hay ${(m as any).qty} und de ${(m as any).name} y pides ${cantidad}.`;
    }
    const t: any = await this.support.ticketDetail(ticketId, authUserOf(ctx.user));
    return ctx.preparePending({
      summary: `Descontar ${cantidad} und de ${(m as any).name} y cargarlas al ticket #${t.code} (${t.client ?? 'sin cliente'}).`,
      permission: P.AREA_TECNICOS,
      commitInput: { ticketId, materialId, cantidad },
    });
  }
}
