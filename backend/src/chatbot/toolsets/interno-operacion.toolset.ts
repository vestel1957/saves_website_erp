import type { Toolset, ToolContext, ToolDef } from '@s4gk/wa-agent';
import { APP_PERMISSIONS as P } from '../../auth/permissions.catalog';
import { PlansService } from '../../plans/plans.service';
import { PromotionsService } from '../../promotions/promotions.service';
import { ReturnsService } from '../../returns/returns.service';
import { ProjectsService } from '../../projects/projects.service';
import { GeoService } from '../../geo/geo.service';
import { authUserOf } from '../chatbot.identity';
import { canAny, cop, fecha, gated, safe } from './toolset.util';

// Cada gate copia el `@RequireArea` del controller correspondiente, para que el bot
// no sea nunca una puerta más ancha que la web.
const PLANES = [P.AREA_ADMINISTRACION, P.AREA_CONTABILIDAD, P.AREA_TECNICOS, P.AREA_SISTEMAS, P.AREA_CAJA];
const DEVOLUCIONES = [P.AREA_ADMINISTRACION];
const PROYECTOS = [P.AREA_ADMINISTRACION, P.AREA_GERENCIA];
const MAPA = [P.AREA_GERENCIA, P.AREA_ADMINISTRACION, P.AREA_CONTABILIDAD, P.AREA_TECNICOS, P.AREA_SISTEMAS, P.AREA_CAJA];
/** Las promociones son del superusuario, igual que su controller. */
const PROMOS = [P.SYSTEM_ADMIN];

/**
 * El resto de la operación: catálogo de planes, promociones, devoluciones a
 * proveedores, proyectos y dónde está la gente en campo.
 *
 * Son áreas de consulta rápida —"¿cuánto vale el plan de 100 megas?", "¿dónde anda
 * el técnico?"— que son justo las que uno necesita fuera de la oficina y hoy se
 * resuelven llamando a alguien que sí esté frente al computador.
 */
export class InternoOperacionToolset implements Toolset {
  constructor(
    private readonly plans: PlansService,
    private readonly promotions: PromotionsService,
    private readonly returns: ReturnsService,
    private readonly projects: ProjectsService,
    private readonly geo: GeoService,
  ) {}

  definitions(ctx: ToolContext): ToolDef[] {
    return [
      ...gated(canAny(ctx, PLANES), [
        {
          name: 'catalogo_planes',
          description:
            'Planes del sistema con su precio y velocidad, incluidos los inactivos si se piden. ' +
            'Es el catálogo COMPLETO para uso interno (cotizar, revisar una tarifa), no el comercial del bot público.',
          input_schema: {
            type: 'object',
            properties: {
              tipo: { type: 'string', enum: ['INTERNET', 'TV'] },
              q: { type: 'string', description: 'Filtra por nombre, ej. "100 megas"' },
            },
          },
        },
      ]),
      ...gated(canAny(ctx, MAPA), [
        {
          name: 'tecnicos_en_campo',
          description:
            'Dónde estuvo cada técnico por última vez y hace cuánto, según el GPS que reporta la app. ' +
            'Úsala para "dónde está Fulano", "quién anda cerca de tal sector", "quién está en la calle".',
          input_schema: {
            type: 'object',
            properties: { horas: { type: 'number', description: 'Ventana en horas (por defecto la del sistema)' } },
          },
        },
      ]),
      ...gated(canAny(ctx, DEVOLUCIONES), [
        {
          name: 'devoluciones',
          description: 'Devoluciones de material a proveedores: cuántas hay, en qué estado y por cuánto.',
          input_schema: {
            type: 'object',
            properties: { q: { type: 'string', description: 'Proveedor o número. Opcional.' } },
          },
        },
      ]),
      ...gated(canAny(ctx, PROYECTOS), [
        {
          name: 'proyectos',
          description: 'Proyectos de la empresa con su estado y avance (hitos cumplidos).',
          input_schema: {
            type: 'object',
            properties: { q: { type: 'string', description: 'Nombre del proyecto. Opcional.' } },
          },
        },
      ]),
      ...gated(canAny(ctx, PROMOS), [
        {
          name: 'promociones',
          description:
            'Promociones y descuentos vigentes, a qué funcionarios están asignadas y cuánto se ha aplicado.',
          input_schema: { type: 'object', properties: {} },
        },
      ]),
    ];
  }

  async execute(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    // Cada herramienta revalida SU gate: que el modelo consiga el nombre de una que
    // no se le ofreció no puede alcanzar para ejecutarla.
    const permitido: Record<string, string[]> = {
      catalogo_planes: PLANES,
      tecnicos_en_campo: MAPA,
      devoluciones: DEVOLUCIONES,
      proyectos: PROYECTOS,
      promociones: PROMOS,
    };
    if (!permitido[name]) return `Herramienta no disponible: ${name}`;
    if (!canAny(ctx, permitido[name])) return 'PERMISO_DENEGADO';

    switch (name) {
      case 'catalogo_planes':
        return safe(() => this.planes(input));
      case 'tecnicos_en_campo':
        return safe(() => this.tecnicos(input, ctx));
      case 'devoluciones':
        return safe(() => this.devoluciones(input));
      case 'proyectos':
        return safe(() => this.proyectos(input));
      case 'promociones':
        return safe(() => this.promociones());
      default:
        return `Herramienta no disponible: ${name}`;
    }
  }

  private async planes(input: Record<string, unknown>): Promise<string> {
    const rows: any[] = await this.plans.list({ kind: input.tipo ? (String(input.tipo).toUpperCase() as any) : undefined });
    const q = String(input.q ?? '').trim().toLowerCase();
    const filtrados = q ? rows.filter((p) => p.name.toLowerCase().includes(q)) : rows;
    if (!filtrados.length) return 'No hay planes que coincidan con eso.';

    // El catálogo heredado tiene decenas de tarifas: se recorta y se dice cuántas
    // quedaron fuera, en vez de mandar un muro por WhatsApp.
    const lista = filtrados.slice(0, 15).map(
      (p) => `• ${p.name} (${p.kind})${p.megas ? ` — ${p.megas} megas` : ''}: ${cop(p.price)}/mes` +
        `${p.active ? '' : ' · INACTIVO'}`,
    );
    const extra = filtrados.length > 15 ? `\n(+${filtrados.length - 15} más; afina con el nombre)` : '';
    return `${filtrados.length} plan(es):\n${lista.join('\n')}${extra}`;
  }

  private async tecnicos(input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const horas = Number(input.horas);
    const rows: any[] = await this.geo.technicians(authUserOf(ctx.user), Number.isFinite(horas) && horas > 0 ? horas : undefined);
    if (!rows.length) return 'Nadie ha reportado ubicación en las últimas horas. Recuerda que el GPS solo llega si usan la app con permiso de ubicación.';
    return rows.slice(0, 12).map(
      (t) => `• ${t.userName}: hace ${t.minutosDesde} min${t.reason ? ` (${t.reason})` : ''}` +
        `\n  ubicación: ${t.lat.toFixed(5)}, ${t.lng.toFixed(5)}` +
        `${t.accuracy ? ` (±${Math.round(t.accuracy)} m)` : ''} · https://maps.google.com/?q=${t.lat},${t.lng}`,
    ).join('\n');
  }

  private async devoluciones(input: Record<string, unknown>): Promise<string> {
    const [s, res]: any[] = await Promise.all([
      this.returns.stats(),
      this.returns.list({ search: input.q ? String(input.q) : undefined, pageSize: 8 }),
    ]);
    if (!res.items?.length) return 'No hay devoluciones con esos criterios.';
    const lineas = res.items.map(
      (d: any) => `• #${d.tid} [${d.status}] ${d.supplier ?? '—'} — ${cop(d.total)} · ${fecha(d.date)}`,
    );
    return [
      s?.total != null ? `${s.total} devolución(es) registradas en total.` : '',
      `${res.total} con esos criterios:`,
      lineas.join('\n'),
    ].filter(Boolean).join('\n');
  }

  private async proyectos(input: Record<string, unknown>): Promise<string> {
    const res: any = await this.projects.list({ search: input.q ? String(input.q) : undefined, pageSize: 8 });
    if (!res.items?.length) return 'No hay proyectos con esos criterios.';
    const lineas = res.items.map((p: any) => {
      const hitos = p.milestonesDone != null && p.milestonesTotal != null
        ? ` · hitos ${p.milestonesDone}/${p.milestonesTotal}`
        : '';
      return `• ${p.name} [${p.status}]${hitos}${p.dueDate ? ` · vence ${fecha(p.dueDate)}` : ''}`;
    });
    return `${res.total} proyecto(s):\n${lineas.join('\n')}`;
  }

  private async promociones(): Promise<string> {
    const rows: any[] = await this.promotions.list();
    if (!rows.length) return 'No hay promociones creadas.';
    return rows.slice(0, 10).map(
      (p) => `• ${p.name}: ${p.percent != null ? `${p.percent}%` : cop(p.amount)}` +
        `${p.active === false ? ' · INACTIVA' : ''}` +
        `${p.assignedCount != null ? ` · asignada a ${p.assignedCount} funcionario(s)` : ''}` +
        `${p.usedCount != null ? ` · aplicada ${p.usedCount} vez(ces)` : ''}`,
    ).join('\n');
  }
}
