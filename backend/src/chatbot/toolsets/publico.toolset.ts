import { Injectable } from '@nestjs/common';
import type { Toolset, ToolContext, ToolDef } from '@s4gk/wa-agent';
import { PlansService } from '../../plans/plans.service';
import { ConfigDataService } from '../../config/config.service';
import { cop, safe } from './toolset.util';

/**
 * Herramientas para números NO registrados (ni funcionario ni abonado).
 *
 * Solo información comercial pública: planes, sedes y datos de la empresa. No hay
 * ninguna herramienta que reciba un identificador de cliente, así que este agente
 * no tiene forma de tocar datos de una cuenta ni aunque el modelo lo intente: la
 * barrera es que la capacidad no existe, no que el prompt lo prohíba.
 */
@Injectable()
export class PublicoToolset implements Toolset {
  constructor(
    private readonly plans: PlansService,
    private readonly config: ConfigDataService,
  ) {}

  definitions(_ctx: ToolContext): ToolDef[] {
    return [
      {
        name: 'planes_disponibles',
        description: 'Planes que la empresa ofrece hoy, con su velocidad y precio mensual.',
        input_schema: {
          type: 'object',
          properties: {
            tipo: { type: 'string', description: 'Filtrar por tipo de servicio (ej. INTERNET, TV). Opcional.' },
          },
        },
      },
      {
        name: 'sedes',
        description: 'Sedes/oficinas de la empresa con su dirección, para atención presencial.',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'datos_empresa',
        description: 'Datos de contacto de la empresa: nombre, dirección, teléfono y correo.',
        input_schema: { type: 'object', properties: {} },
      },
    ];
  }

  async execute(name: string, input: Record<string, unknown>, _ctx: ToolContext): Promise<string> {
    switch (name) {
      case 'planes_disponibles':
        return safe(() => this.planes(input));
      case 'sedes':
        return safe(() => this.sedes());
      case 'datos_empresa':
        return safe(() => this.empresa());
      default:
        return `Herramienta no disponible: ${name}`;
    }
  }

  private async planes(input: Record<string, unknown>): Promise<string> {
    const kind = input.tipo ? String(input.tipo).toUpperCase() : undefined;
    // activeOnly: nunca ofrecer un plan descatalogado a alguien que quiere comprar.
    const rows = await this.plans.list({ activeOnly: true, kind: kind as any });
    if (!rows.length) return 'No tengo planes publicados en este momento.';
    return rows
      .map((p) => `• ${p.name} (${p.kind})${p.megas ? ` — ${p.megas} megas` : ''}: ${cop(p.price)}/mes`)
      .join('\n');
  }

  private async sedes(): Promise<string> {
    const rows = await this.config.branches();
    if (!rows.length) return 'No tengo sedes registradas.';
    return rows.map((b) => `• ${b.name}${b.dir ? ` — ${b.dir}` : ''}`).join('\n');
  }

  private async empresa(): Promise<string> {
    const c = await this.config.company();
    if (!c) return 'No tengo los datos de contacto de la empresa a la mano.';
    return [
      c.name,
      c.address ? `Dirección: ${c.address}${c.city ? `, ${c.city}` : ''}` : '',
      c.phone ? `Teléfono: ${c.phone}` : '',
      c.email ? `Correo: ${c.email}` : '',
    ].filter(Boolean).join('\n');
  }
}
