import type { ToolContext, Toolset } from '@s4gk/wa-agent';

/**
 * Une varios toolsets en uno solo (un `AgentDefinition` acepta uno). Enruta cada
 * llamada al toolset que la DECLARA para el usuario actual: como `definitions` ya
 * filtra por permiso, una herramienta que este usuario no puede ver tampoco se
 * puede ejecutar aunque el modelo se invente su nombre. Es la segunda barrera; la
 * primera es el `ctx.can` dentro de cada herramienta.
 */
export function combineToolsets(...sets: Toolset[]): Toolset {
  return {
    definitions: (ctx) => sets.flatMap((s) => s.definitions(ctx)),
    async execute(name, input, ctx) {
      const owner = sets.find((s) => s.definitions(ctx).some((d) => d.name === name));
      if (!owner) return `Herramienta no disponible: ${name}`;
      return owner.execute(name, input, ctx);
    },
  };
}

/** ¿Tiene ALGUNA de estas áreas/permisos? (las áreas del ERP son OR, como el AreaGuard). */
export function canAny(ctx: ToolContext, permissions: string[]): boolean {
  return permissions.some((p) => ctx.can(p));
}

/**
 * Declara herramientas solo si el usuario pasa el gate. Mantiene el prompt corto y
 * evita que el modelo ofrezca lo que luego va a rechazar.
 */
export function gated(ok: boolean, defs: Array<Record<string, unknown>>): any[] {
  return ok ? (defs as any[]) : [];
}

/** Pesos colombianos sin decimales. */
export function cop(n: number | null | undefined): string {
  return new Intl.NumberFormat('es-CO', {
    style: 'currency', currency: 'COP', maximumFractionDigits: 0,
  }).format(Number(n) || 0);
}

/** Fecha corta legible (es-CO), tolerante a null. */
export function fecha(d: Date | string | null | undefined): string {
  if (!d) return '—';
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString('es-CO');
}

/**
 * Convierte el error de un servicio del ERP en texto para el modelo. Los servicios
 * lanzan HttpException con mensajes ya redactados para humanos ("El cliente no tiene
 * usuario PPPoE"), que son exactamente lo que el agente debe explicar.
 */
export function toolError(e: unknown): string {
  const msg = (e as { response?: { message?: string }; message?: string })?.response?.message
    ?? (e as Error)?.message
    ?? 'Error desconocido';
  return `No se pudo completar: ${Array.isArray(msg) ? msg.join('; ') : msg}`;
}

/** Envuelve un handler para que un fallo del ERP no rompa la conversación. */
export async function safe(fn: () => Promise<string>): Promise<string> {
  try {
    return await fn();
  } catch (e) {
    return toolError(e);
  }
}
