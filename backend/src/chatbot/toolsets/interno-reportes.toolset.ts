import { Injectable } from '@nestjs/common';
import type { Toolset, ToolContext, ToolDef } from '@s4gk/wa-agent';
import { PERMISSION_DENIED } from '@s4gk/wa-agent';
import { APP_PERMISSIONS as P } from '../../auth/permissions.catalog';
import { ReportsService } from '../../reports/reports.service';
import { DashboardService } from '../../dashboard/dashboard.service';
import { canAny, cop, gated, safe } from './toolset.util';

/** Reportes y dashboard son de gerencia, igual que en la web. */
const GERENCIA = [P.AREA_GERENCIA];

/**
 * Indicadores para dirección: el resumen del negocio y los reportes, sin abrir el
 * portátil. Todo lectura.
 */
@Injectable()
export class InternoReportesToolset implements Toolset {
  constructor(
    private readonly reports: ReportsService,
    private readonly dashboard: DashboardService,
  ) {}

  definitions(ctx: ToolContext): ToolDef[] {
    return gated(canAny(ctx, GERENCIA), [
      {
        name: 'resumen_negocio',
        description:
          'Resumen general del negocio (dashboard): abonados, cartera, recaudo y tickets. Úsala para "cómo vamos", "resumen", "indicadores".',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'reporte_recaudo',
        description: 'Recaudo del periodo indicado.',
        input_schema: {
          type: 'object',
          properties: {
            desde: { type: 'string', description: 'YYYY-MM-DD' },
            hasta: { type: 'string', description: 'YYYY-MM-DD' },
          },
        },
      },
      {
        name: 'top_deudores',
        description: 'Abonados con mayor deuda acumulada.',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'reporte_servicios',
        description: 'Estadísticas de servicios contratados (cuántos por plan/tipo).',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'reporte_cortes',
        description: 'Cortes y activaciones del periodo.',
        input_schema: {
          type: 'object',
          properties: {
            desde: { type: 'string', description: 'YYYY-MM-DD' },
            hasta: { type: 'string', description: 'YYYY-MM-DD' },
          },
        },
      },
    ]);
  }

  async execute(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    if (!canAny(ctx, GERENCIA)) return PERMISSION_DENIED;
    const desde = input.desde ? String(input.desde) : undefined;
    const hasta = input.hasta ? String(input.hasta) : undefined;

    switch (name) {
      case 'resumen_negocio':
        return safe(async () => this.compacto(await this.dashboard.summary()));
      case 'reporte_recaudo':
        return safe(async () => this.compacto(await this.reports.recaudo(desde, hasta)));
      case 'top_deudores':
        return safe(async () => this.deudores(await this.reports.topDeudores()));
      case 'reporte_servicios':
        return safe(async () => this.compacto(await this.reports.estadisticasServicios()));
      case 'reporte_cortes':
        return safe(async () => this.compacto(await this.reports.cortesActivaciones(desde, hasta)));
      default:
        return `Herramienta no disponible: ${name}`;
    }
  }

  private async deudores(rows: any): Promise<string> {
    const items: any[] = Array.isArray(rows) ? rows : (rows?.items ?? []);
    if (!items.length) return 'No hay deudores registrados.';
    return items.slice(0, 10)
      .map((d, i) => `${i + 1}. ${d.name ?? d.cliente ?? '—'} — ${cop(d.debt ?? d.total ?? d.deuda)}`)
      .join('\n');
  }

  /**
   * Los reportes devuelven estructuras distintas (series, agregados, listas). En vez
   * de un formateador por reporte —que se desincroniza en cuanto alguien toque uno—
   * se entrega el JSON compacto y el modelo lo redacta. Se recorta para no reventar
   * el contexto con series largas.
   */
  private compacto(data: unknown): string {
    const json = JSON.stringify(data, (_k, v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v));
    const max = 2500;
    return json.length > max
      ? `${json.slice(0, max)}… (recortado; pide un periodo más corto para el detalle)`
      : json;
  }
}
