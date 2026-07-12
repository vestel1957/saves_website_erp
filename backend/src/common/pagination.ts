/**
 * Convención de paginación compartida para los listados del módulo.
 *
 * Es *opt-in*: el controlador solo pagina cuando llega `page` o `pageSize` en la
 * query. Si no llegan, los servicios siguen devolviendo el arreglo completo como
 * antes (así los `<Select>` que cargan catálogos completos no se rompen).
 */

export interface PageQuery {
  page?: string;
  pageSize?: string;
  sortBy?: string;
  sortDir?: string;
}

export interface PageArgs {
  page: number;
  pageSize: number;
  skip: number;
  take: number;
  sortBy?: string;
  sortDir: 'asc' | 'desc';
}

export interface Paginated<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 25;

/** ¿La query pidió paginación? (presencia de page o pageSize) */
export function wantsPagination(q: PageQuery): boolean {
  return q.page !== undefined || q.pageSize !== undefined;
}

/** Normaliza los parámetros de paginación a valores seguros. */
export function parsePage(q: PageQuery): PageArgs {
  const page = Math.max(1, Number.parseInt(q.page ?? '', 10) || 1);
  const rawSize = Number.parseInt(q.pageSize ?? '', 10) || DEFAULT_PAGE_SIZE;
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, rawSize));
  const sortDir: 'asc' | 'desc' = q.sortDir === 'desc' ? 'desc' : 'asc';
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize, sortBy: q.sortBy, sortDir };
}

/** Empaqueta una página de resultados en el sobre estándar. */
export function paginated<T>(data: T[], total: number, args: PageArgs): Paginated<T> {
  return {
    data,
    total,
    page: args.page,
    pageSize: args.pageSize,
    pageCount: Math.max(1, Math.ceil(total / args.pageSize)),
  };
}

/**
 * Resuelve el `orderBy` de Prisma a partir de un mapa blanco de columnas
 * permitidas. Evita pasar campos arbitrarios (inyección / errores de Prisma).
 */
export function resolveOrderBy<T>(
  args: PageArgs,
  allowed: Record<string, (dir: 'asc' | 'desc') => T>,
  fallback: T,
): T {
  if (args.sortBy && allowed[args.sortBy]) return allowed[args.sortBy](args.sortDir);
  return fallback;
}
