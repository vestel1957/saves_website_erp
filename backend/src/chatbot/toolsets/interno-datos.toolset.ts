import type { Toolset, ToolContext, ToolDef } from '@s4gk/wa-agent';
import { DataQueryService, type Consulta } from '../../search/data-query.service';
import { esSonda, safe } from './toolset.util';

/**
 * Preguntar CUALQUIER COSA sobre los datos de la empresa, con dos herramientas.
 *
 * El resto de toolsets contestan preguntas concretas y hay una herramienta por
 * pregunta. Eso funcionó hasta las 69 herramientas: sus definiciones ya pesan ~7.700
 * tokens en CADA llamada al modelo, y con tantas parecidas el modelo empezó a
 * escoger mal. Seguir añadiendo empeora las dos cosas.
 *
 * Aquí el planteamiento se invierte: en vez de una herramienta por pregunta, una que
 * sabe consultar. `catalogo_de_datos` dice qué hay y `consultar_datos` lo pregunta.
 * Cubrir un área nueva de la empresa pasa a ser una entrada en `data-catalog.ts` — ni
 * una herramienta más, ni un token más en el prompt.
 *
 * No sustituye a los toolsets específicos: esos siguen siendo mejores para lo que
 * hacen (llevan reglas de negocio, avisos y acciones). Este cubre la cola larga —
 * todo lo que nadie previó que se iba a preguntar.
 */
export class InternoDatosToolset implements Toolset {
  constructor(private readonly datos: DataQueryService) {}

  /** Permisos del usuario actual; ante la sonda del motor, ninguno. */
  private permisos(ctx: ToolContext): string[] {
    return esSonda(ctx) ? [] : (ctx.user?.permissions ?? []);
  }

  definitions(ctx: ToolContext): ToolDef[] {
    // Ante la sonda no hay usuario: se declaran igual para que queden registradas en
    // el enrutador del motor (ver combineToolsets). El permiso real se comprueba en
    // `execute`, entidad por entidad.
    const entidades = esSonda(ctx)
      ? Object.keys(this.datos.entidadesPara(['system.admin'])).length
        ? this.datos.entidadesPara(['system.admin'])
        : []
      : this.datos.entidadesPara(this.permisos(ctx));

    if (!entidades.length) return [];

    return [
      {
        name: 'catalogo_de_datos',
        description:
          'Qué se puede preguntar sobre la empresa. Sin argumentos lista las áreas de datos disponibles; ' +
          'con una entidad devuelve sus filtros, agrupaciones y cifras exactas. ' +
          'ÚSALA SIEMPRE ANTES de consultar_datos si no estás seguro de los nombres: inventarte un campo ' +
          'gasta un turno para nada.',
        input_schema: {
          type: 'object',
          properties: {
            entidad: { type: 'string', enum: entidades.map((e) => e.clave), description: 'Opcional: la ficha de esa entidad.' },
          },
        },
      },
      {
        name: 'consultar_datos',
        description:
          'CONSULTA LIBRE sobre los datos de la empresa: cuenta, suma, promedia y agrupa lo que le pidas. ' +
          'Es la herramienta comodín para preguntas que no tienen un reporte propio ' +
          '("cuántos abonados hay por barrio en Yopal", "cuánto se le debe a cada proveedor", ' +
          '"qué material vale más en la bodega principal", "cuántas órdenes de instalación hubo por técnico"). ' +
          `Áreas de datos: ${entidades.map((e) => `${e.clave} (${e.etiqueta})`).join(', ')}. ` +
          'Los nombres de filtros, agrupaciones y cifras salen de catalogo_de_datos — NO te los inventes. ' +
          'Si un reporte específico ya contesta la pregunta, usa ese: trae avisos y contexto que esto no tiene.',
        input_schema: {
          type: 'object',
          properties: {
            entidad: { type: 'string', enum: entidades.map((e) => e.clave) },
            filtros: {
              type: 'object',
              description: 'Objeto { campo: valor }. Para rangos, { campo: { desde, hasta } }. Para varios valores, una lista.',
              additionalProperties: true,
            },
            agrupar: {
              type: 'array', items: { type: 'string' }, maxItems: 2,
              description: 'Dimensiones por las que partir el resultado (máximo 2). Vacío = un único total.',
            },
            metricas: {
              type: 'array', items: { type: 'string' },
              description: 'Cifras a calcular. Por defecto "cantidad".',
            },
            limite: { type: 'number', description: 'Máximo de filas (tope 50).' },
          },
          required: ['entidad'],
        },
      },
    ];
  }

  async execute(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const permisos = this.permisos(ctx);
    switch (name) {
      case 'catalogo_de_datos':
        return safe(async () => this.catalogo(input.entidad ? String(input.entidad) : undefined, permisos));
      case 'consultar_datos':
        return safe(async () => this.consultar(input as unknown as Consulta, permisos));
      default:
        return `Herramienta no disponible: ${name}`;
    }
  }

  private async catalogo(entidad: string | undefined, permisos: string[]): Promise<string> {
    if (!entidad) {
      const e = this.datos.entidadesPara(permisos);
      if (!e.length) return 'Este usuario no tiene acceso a ninguna área de datos.';
      return [
        'Áreas de datos que puedes consultar:',
        ...e.map((x) => `• ${x.clave} — ${x.etiqueta}: ${x.descripcion}`),
        'Pide catalogo_de_datos con una entidad para ver sus campos exactos.',
      ].join('\n');
    }
    const f: any = this.datos.ficha(entidad, permisos);
    if (!f.ok) return f.error;
    const d = f.detalle;
    const filtros = Object.entries(d.filtros).map(([k, v]: any) =>
      `• ${k} (${v.tipo})${v.valores ? ` — valores: ${v.valores.join(', ')}` : ''}: ${v.descripcion}`);
    return [
      `${f.etiqueta} — ${d.descripcion}`,
      `FILTROS:\n${filtros.join('\n')}`,
      `AGRUPAR POR: ${Object.entries(d.agrupar_por).map(([k, v]) => `${k} (${v})`).join(', ')}`,
      `CIFRAS: ${Object.entries(d.metricas).map(([k, v]) => `${k} (${v})`).join(', ')}`,
      'Las fechas van como {desde:"YYYY-MM-DD", hasta:"YYYY-MM-DD"}.',
    ].join('\n');
  }

  private async consultar(q: Consulta, permisos: string[]): Promise<string> {
    const r = await this.datos.consultar(q, permisos);
    if (!r.ok) return r.error ?? 'No se pudo consultar.';
    if (!r.filas?.length) return `Sin resultados. Consulté: ${r.interpretado}.`;

    const fmt = (v: any, dinero?: boolean) =>
      typeof v === 'number'
        ? (dinero
          ? new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(v)
          : new Intl.NumberFormat('es-CO').format(Math.round(v * 100) / 100))
        : String(v ?? '—');

    const cols = r.columnas ?? [];
    const lineas = r.filas.map((f) =>
      '• ' + cols.map((c) => `${c.etiqueta}: ${fmt(f[c.clave], c.dinero)}`).join(' · '));

    return [
      `${r.interpretado}`,
      lineas.join('\n'),
      r.recortado ? `(recortado a ${r.total} filas; afina el filtro para ver el resto)` : '',
      // El modelo tiende a presentar esto como si fuera un reporte oficial. No lo es:
      // es una consulta que ÉL acaba de componer, y quien pregunta tiene que poder
      // ver si se interpretó bien.
      'Al responder, di en una línea qué consultaste exactamente (entidad, filtros y agrupación) para que pueda verificar que entendiste bien.',
    ].filter(Boolean).join('\n');
  }
}
