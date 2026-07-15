import { Injectable } from '@nestjs/common';
import type { Toolset, ToolContext, ToolDef } from '@s4gk/wa-agent';
import { PERMISSION_DENIED } from '@s4gk/wa-agent';
import { APP_PERMISSIONS as P } from '../../auth/permissions.catalog';
import { TreasuryService } from '../../treasury/treasury.service';
import { CobranzasService } from '../../treasury/cobranzas.service';
import { authUserOf } from '../chatbot.identity';
import { canAny, cop, fecha, gated, safe } from './toolset.util';

/** Mismo gate que el controller de tesorería. */
const CAJA = [P.AREA_CAJA, P.AREA_CONTABILIDAD, P.AREA_ADMINISTRACION];

/** Fecha de hoy en ISO corto, para acotar consultas al día. */
const hoy = () => new Date().toISOString().slice(0, 10);

/**
 * Caja y tesorería para el agente interno: cómo va el día, movimientos y registro
 * de un ingreso.
 *
 * Nota deliberada: NO se expone "recaudar" (`CobranzasService.collect`, que aplica
 * el pago en cascada sobre las facturas del cliente). Aplicar cartera por chat, sin
 * el recibo a la vista, es de las cosas más caras de deshacer del ERP; el ingreso
 * simple sí, porque es un asiento aislado y anulable.
 */
@Injectable()
export class InternoCajaToolset implements Toolset {
  constructor(
    private readonly treasury: TreasuryService,
    private readonly cobranzas: CobranzasService,
  ) {}

  definitions(ctx: ToolContext): ToolDef[] {
    return gated(canAny(ctx, CAJA), [
      {
        name: 'caja_del_dia',
        description: 'Resumen de tesorería: ingresos, egresos y saldo. Por defecto el día de hoy.',
        input_schema: {
          type: 'object',
          properties: {
            desde: { type: 'string', description: 'Fecha inicial YYYY-MM-DD (por defecto hoy)' },
            hasta: { type: 'string', description: 'Fecha final YYYY-MM-DD (por defecto hoy)' },
          },
        },
      },
      {
        name: 'movimientos_caja',
        description: 'Últimos movimientos de tesorería (ingresos/egresos), opcionalmente filtrados por texto o tipo.',
        input_schema: {
          type: 'object',
          properties: {
            search: { type: 'string', description: 'Texto (pagador, nota, cuenta)' },
            tipo: { type: 'string', enum: ['INCOME', 'EXPENSE'] },
            desde: { type: 'string', description: 'YYYY-MM-DD' },
            hasta: { type: 'string', description: 'YYYY-MM-DD' },
          },
        },
      },
      {
        name: 'cierres_caja',
        description: 'Últimos cierres de caja registrados.',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'cuentas_caja',
        description: 'Cuentas de caja/banco disponibles, con su id (necesario para registrar un ingreso).',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'registrar_ingreso',
        description:
          'Registra un ingreso en tesorería (NO aplica pagos a facturas del cliente: es un asiento suelto). Requiere confirmación.',
        input_schema: {
          type: 'object',
          properties: {
            monto: { type: 'number', description: 'Valor en pesos (mínimo 1)' },
            categoria: { type: 'string', description: 'Categoría del ingreso' },
            metodo: { type: 'string', description: 'Método de pago, ej. Cash, Bank' },
            cashAccountId: { type: 'number', description: 'id de la cuenta de caja (de cuentas_caja)' },
            pagador: { type: 'string', description: 'Quién paga' },
            nota: { type: 'string' },
          },
          required: ['monto', 'categoria', 'metodo'],
        },
      },
    ]);
  }

  async execute(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    if (!canAny(ctx, CAJA)) return PERMISSION_DENIED;

    switch (name) {
      case 'caja_del_dia':
        return safe(() => this.resumen(input));
      case 'movimientos_caja':
        return safe(() => this.movimientos(input));
      case 'cierres_caja':
        return safe(() => this.cierres());
      case 'cuentas_caja':
        return safe(() => this.cuentas());
      case 'registrar_ingreso':
        return safe(() => this.ingreso(input, ctx));
      default:
        return `Herramienta no disponible: ${name}`;
    }
  }

  private async resumen(input: Record<string, unknown>): Promise<string> {
    const desde = input.desde ? String(input.desde) : hoy();
    const hasta = input.hasta ? String(input.hasta) : hoy();
    const s = await this.treasury.stats({ from: desde, to: hasta });
    return [
      `Tesorería ${desde === hasta ? `del ${fecha(desde)}` : `de ${fecha(desde)} a ${fecha(hasta)}`}:`,
      `• Ingresos: ${cop(s.ingresos)} (${s.nIngresos} movimiento(s))`,
      `• Egresos: ${cop(s.egresos)} (${s.nEgresos} movimiento(s))`,
      `• Balance: ${cop(s.balance)}`,
    ].join('\n');
  }

  private async movimientos(input: Record<string, unknown>): Promise<string> {
    const res: any = await this.treasury.list({
      search: input.search ? String(input.search) : undefined,
      type: input.tipo ? String(input.tipo) : undefined,
      from: input.desde ? String(input.desde) : hoy(),
      to: input.hasta ? String(input.hasta) : hoy(),
      pageSize: 8,
    } as any);
    if (!res.items?.length) return 'No hay movimientos con esos criterios.';
    const lineas = res.items.map(
      (t: any) => `• ${fecha(t.date)} ${t.type === 'INCOME' ? '↑' : '↓'} ${cop(t.credit || t.debit)} · ${t.category ?? '—'}` +
        `${t.payerName ? ` · ${t.payerName}` : ''} [${t.status}]`,
    );
    const extra = res.total > res.items.length ? `\n(+${res.total - res.items.length} más)` : '';
    return `${res.total} movimiento(s):\n${lineas.join('\n')}${extra}`;
  }

  private async cierres(): Promise<string> {
    const res: any = await this.treasury.cashCloses({ pageSize: 5 } as any);
    if (!res.items?.length) return 'No hay cierres de caja registrados.';
    return res.items
      .map((c: any) => `• ${fecha(c.date)} · ${c.cashAccountName ?? c.accountName ?? 'caja'} · ${cop(c.total ?? c.amount)}`)
      .join('\n');
  }

  private async cuentas(): Promise<string> {
    const rows: any[] = await this.cobranzas.cashAccounts();
    if (!rows.length) return 'No hay cuentas de caja configuradas.';
    return rows.map((c) => `• ${c.name ?? c.title} — id: ${c.id}`).join('\n');
  }

  private async ingreso(input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const monto = Number(input.monto);
    const categoria = String(input.categoria ?? '').trim();
    const metodo = String(input.metodo ?? '').trim();

    if (ctx.committing) {
      const r: any = await this.cobranzas.createIncome(
        {
          amount: monto, category: categoria, method: metodo,
          cashAccountId: input.cashAccountId ? Number(input.cashAccountId) : undefined,
          payerName: input.pagador ? String(input.pagador) : undefined,
          note: input.nota ? String(input.nota) : undefined,
        } as any,
        authUserOf(ctx.user),
      );
      await ctx.audit({
        userId: ctx.user.id, action: 'treasury.income.create',
        summary: `Ingreso de ${cop(monto)} por WhatsApp`, detail: { categoria, metodo, id: r?.id },
      });
      return `Listo: ingreso de ${cop(monto)} registrado en ${categoria}.`;
    }

    if (!(monto >= 1)) return 'El monto debe ser mayor o igual a 1.';
    if (!categoria || !metodo) return 'Necesito la categoría y el método de pago del ingreso.';
    return ctx.preparePending({
      summary: `Registrar un ingreso de ${cop(monto)} en "${categoria}" (${metodo})` +
        `${input.pagador ? ` de ${input.pagador}` : ''}.`,
      permission: P.AREA_CAJA,
      commitInput: {
        monto, categoria, metodo,
        cashAccountId: input.cashAccountId ? Number(input.cashAccountId) : undefined,
        pagador: input.pagador ? String(input.pagador) : undefined,
        nota: input.nota ? String(input.nota) : undefined,
      },
    });
  }
}
