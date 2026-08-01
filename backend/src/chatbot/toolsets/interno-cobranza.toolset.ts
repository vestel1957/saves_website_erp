import { Injectable } from '@nestjs/common';
import type { Toolset, ToolContext, ToolDef } from '@s4gk/wa-agent';
import { APP_PERMISSIONS as P } from '../../auth/permissions.catalog';
import { CollectionsService } from '../../collections/collections.service';
import { CobranzasService } from '../../treasury/cobranzas.service';
import { canAny, cop, fecha, gated, safe } from './toolset.util';

/** Mismo gate que `CollectionsController` (`@RequireArea('administracion','caja')`). */
const COBRANZA = [P.AREA_ADMINISTRACION, P.AREA_CAJA, P.AREA_CONTABILIDAD];

/**
 * Cobranza: acuerdos de pago y gestiones de cobro.
 *
 * SOLO LECTURA, y falta a propósito lo más goloso: **aplicar un pago** (`collect`).
 * Es la operación más cara de deshacer del ERP —reparte la plata en cascada sobre las
 * facturas, mueve caja y puede disparar la reconexión— y por chat no hay forma de
 * revisar sobre qué facturas va a caer antes de aceptar. Se cobra en /cobranza.
 */
@Injectable()
export class InternoCobranzaToolset implements Toolset {
  constructor(
    private readonly collections: CollectionsService,
    private readonly cobranzas: CobranzasService,
  ) {}

  definitions(ctx: ToolContext): ToolDef[] {
    return gated(canAny(ctx, COBRANZA), [
      {
        name: 'acuerdos_de_pago',
        description:
          'Acuerdos y compromisos de pago pactados con los clientes: quién prometió pagar, cuánto y para cuándo, ' +
          'y cuáles ya se vencieron. Úsala para "qué compromisos hay", "quién incumplió el acuerdo", ' +
          '"acuerdos que vencen esta semana".',
        input_schema: {
          type: 'object',
          properties: {
            vencidos: { type: 'boolean', description: 'Solo los que ya pasaron su fecha' },
            q: { type: 'string', description: 'Cliente o abonado. Opcional.' },
          },
        },
      },
      {
        name: 'gestiones_de_cobro',
        description:
          'Historial de gestiones de cobro hechas a un abonado: llamadas, respuestas y compromisos. ' +
          'Necesita el id del abonado (de buscar_abonado).',
        input_schema: {
          type: 'object',
          properties: { subscriberId: { type: 'string', description: 'id del abonado' } },
          required: ['subscriberId'],
        },
      },
      {
        name: 'deuda_abonado',
        description:
          'Cuánto debe exactamente un abonado, factura por factura, y desde cuándo. ' +
          'Necesita el id del abonado (de buscar_abonado).',
        input_schema: {
          type: 'object',
          properties: { subscriberId: { type: 'string', description: 'id del abonado' } },
          required: ['subscriberId'],
        },
      },
    ]);
  }

  async execute(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    if (!canAny(ctx, COBRANZA)) return 'PERMISO_DENEGADO';
    switch (name) {
      case 'acuerdos_de_pago':
        return safe(() => this.acuerdos(input));
      case 'gestiones_de_cobro':
        return safe(() => this.gestiones(String(input.subscriberId ?? '')));
      case 'deuda_abonado':
        return safe(() => this.deuda(String(input.subscriberId ?? '')));
      default:
        return `Herramienta no disponible: ${name}`;
    }
  }

  private async acuerdos(input: Record<string, unknown>): Promise<string> {
    const res: any = await this.collections.agreements({
      search: input.q ? String(input.q) : undefined,
      // El filtro del servicio se llama `state` y espera 'vencido' | 'vigente'.
      state: input.vencidos ? 'vencido' : undefined,
      pageSize: 8,
    });
    if (!res.items?.length) return 'No hay acuerdos de pago con esos criterios.';

    const lineas = res.items.map(
      (a: any) => `• ${a.cliente} (ab. ${a.abonado ?? '—'})${a.telefono ? ` · ${a.telefono}` : ''}` +
        `\n  se comprometió el ${fecha(a.date)} a pagar el ${fecha(a.dueDate)}` +
        `${a.vencido ? ' — YA SE VENCIÓ' : ''}${a.responsible ? ` · lo gestionó ${a.responsible}` : ''}` +
        `${a.notes ? `\n  "${String(a.notes).slice(0, 90)}"` : ''}`,
    );
    const extra = res.total > res.items.length ? `\n(+${res.total - res.items.length} más)` : '';
    return `${res.total} acuerdo(s):\n${lineas.join('\n')}${extra}`;
  }

  private async gestiones(id: string): Promise<string> {
    if (!id) return 'Indica el id del abonado (búscalo primero con buscar_abonado).';
    const rows: any[] = await this.collections.listBySubscriber(id);
    if (!rows.length) return 'A ese abonado no se le ha registrado ninguna gestión de cobro.';
    return rows.slice(0, 8).map(
      (c: any) => `• ${fecha(c.date)}${c.time ? ` ${c.time}` : ''} — ${c.callType ?? 'gestión'}` +
        `${c.responsible ? ` (${c.responsible})` : ''}${c.dueDate ? ` · prometió pagar el ${fecha(c.dueDate)}` : ''}` +
        `${c.notes ? `\n  "${String(c.notes).slice(0, 90)}"` : ''}`,
    ).join('\n');
  }

  private async deuda(id: string): Promise<string> {
    if (!id) return 'Indica el id del abonado (búscalo primero con buscar_abonado).';
    const d: any = await this.cobranzas.subscriberDebt(id);
    if (!d.totalDebt) return 'Ese abonado está al día: no tiene saldo pendiente.';
    const facturas = (d.invoices ?? []).slice(0, 8).map(
      (i: any) => `• #${i.tid} ${fecha(i.dueDate ?? i.date)} — debe ${cop(i.balance ?? i.total)}`,
    );
    return [
      `Debe ${cop(d.totalDebt)} en ${d.invoices?.length ?? 0} factura(s).`,
      facturas.join('\n'),
    ].filter(Boolean).join('\n');
  }
}
