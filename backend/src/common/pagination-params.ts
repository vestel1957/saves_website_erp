/**
 * Normalización de los parámetros de paginación que llegan por query string.
 *
 * Existían ~34 copias del trío `Math.max(1, Number(page) || 1)` con topes distintos
 * según el archivo. Casi todas aguantan bien la basura (`?page=abc`, negativos,
 * `?pageSize=99999`), pero ninguna contempla **Infinity**: `Number('1e999')` no es
 * NaN, así que `|| 1` no lo atrapa y el valor llegaba a `skip:` de Prisma, que lo
 * rechaza. Antes eso salía como 500 con stack; ahora como 400. Con esto, ni una
 * cosa ni la otra: se acota y se sirve la primera página, que es lo que el usuario
 * esperaba.
 */

export type Paginacion = { page: number; pageSize: number; skip: number; take: number };

export type Direccion = 'asc' | 'desc';

/** Cómo se traduce una columna de la tabla a un `orderBy` de Prisma. */
type Traduccion = string | ((dir: Direccion) => unknown);

/** Convierte a entero acotado; cualquier cosa rara cae en `porDefecto`. */
function enteroAcotado(valor: unknown, porDefecto: number, minimo: number, maximo: number): number {
  // Ausente o vacío = "no me lo mandaron", no "cero". Ojo: `Number('')` y
  // `Number(null)` valen 0, que es finito, así que sin esta guarda un
  // `?pageSize=` vacío acabaría sirviendo 1 elemento por página en vez del
  // tamaño por defecto.
  if (valor === undefined || valor === null || valor === '') return porDefecto;
  const n = Number(valor);
  if (!Number.isFinite(n)) return porDefecto; // NaN, Infinity, -Infinity
  return Math.min(maximo, Math.max(minimo, Math.trunc(n)));
}

/**
 * @param maxPageSize tope de tamaño de página. Alguna vista carga más de la cuenta
 *        a propósito (el grupo de abonados con plan), por eso es parametrizable.
 */
export function paginacion(
  params: { page?: unknown; pageSize?: unknown },
  opciones: { porDefecto?: number; maxPageSize?: number } = {},
): Paginacion {
  const porDefecto = opciones.porDefecto ?? 25;
  const maxPageSize = opciones.maxPageSize ?? 100;
  const page = enteroAcotado(params.page, 1, 1, Number.MAX_SAFE_INTEGER);
  // Un `pageSize` de 0 o negativo no es una petición legítima, es un parámetro que
  // no llegó: los controllers convierten con `Number(...)` antes de llamar aquí, así
  // que un `?pageSize=` vacío se ve como 0 y no como cadena vacía. Acotarlo a 1
  // serviría un elemento por página, que no es lo que nadie pidió.
  const pedido = enteroAcotado(params.pageSize, porDefecto, Number.MIN_SAFE_INTEGER, maxPageSize);
  const pageSize = pedido < 1 ? porDefecto : pedido;
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

/** Dirección pedida; cualquier cosa que no sea `desc` es ascendente. */
export function direccion(valor: unknown): Direccion {
  return String(valor ?? '').toLowerCase() === 'desc' ? 'desc' : 'asc';
}

/** `"abonado.sede.nombre"` → `{ abonado: { sede: { nombre: 'asc' } } }` */
function anidar(ruta: string, dir: Direccion): unknown {
  return ruta
    .split('.')
    .reverse()
    .reduce<unknown>((dentro, parte) => ({ [parte]: dentro }), dir);
}

/**
 * Traduce el orden que pide la tabla a un `orderBy` de Prisma.
 *
 * Va con lista blanca a propósito: el `sortBy` llega de la query string, y
 * pasarlo tal cual a Prisma es abrir la puerta a campos que no existen (500) o
 * a relaciones que no se quieren exponer. Lo que no esté en `permitidas` se
 * ignora en silencio y se sirve el orden por defecto — para el usuario es
 * "esta columna no se ordena", no un error.
 *
 * El desempate importa más de lo que parece: al paginar en el servidor, dos
 * filas con el mismo valor pueden salir en un orden distinto en cada consulta,
 * y entonces una fila aparece en dos páginas y otra en ninguna. Por eso
 * siempre se añade una clave única al final.
 *
 * @param permitidas columna de la tabla → ruta del campo (`"branch.name"`) o
 *        función si hace falta algo más fino (nulos al final, varias claves).
 * @param porDefecto el `orderBy` de siempre, cuando no piden orden.
 * @param opciones.desempate clave única para el orden estable; `null` la quita
 *        (listados sin `id`, p. ej. agrupaciones).
 */
export function orden<T>(
  params: { sortBy?: unknown; sortDir?: unknown },
  permitidas: Record<string, Traduccion>,
  porDefecto: T,
  opciones: { desempate?: unknown } = {},
): T {
  const clave = typeof params.sortBy === 'string' ? params.sortBy.trim() : '';
  const traduccion = clave ? permitidas[clave] : undefined;
  if (!traduccion) return porDefecto;

  const dir = direccion(params.sortDir);
  const resuelto = typeof traduccion === 'string' ? anidar(traduccion, dir) : traduccion(dir);

  const desempate = 'desempate' in opciones ? opciones.desempate : { id: 'asc' };
  const partes = Array.isArray(resuelto) ? resuelto : [resuelto];
  return (desempate ? [...partes, desempate] : partes) as T;
}

/**
 * Igual que `orden()` pero para los listados en SQL crudo, donde no hay
 * `orderBy` de Prisma sino un trozo de `ORDER BY`. La lista blanca guarda el
 * SQL ya escrito (nunca el `sortBy` del usuario) y aquí solo se elige cuál y
 * se le pega la dirección, que está acotada a dos literales.
 *
 * @returns el contenido del `ORDER BY`, ya con el desempate.
 */
export function ordenSql(
  params: { sortBy?: unknown; sortDir?: unknown },
  permitidas: Record<string, string>,
  porDefecto: string,
  opciones: { desempate?: string | null } = {},
): string {
  const clave = typeof params.sortBy === 'string' ? params.sortBy.trim() : '';
  const columna = clave ? permitidas[clave] : undefined;
  if (!columna) return porDefecto;

  const dir = direccion(params.sortDir).toUpperCase();
  const desempate = 'desempate' in opciones ? opciones.desempate : null;
  // NULLS LAST en ambas direcciones: una celda sin dato estorba arriba.
  return `${columna} ${dir} NULLS LAST${desempate ? `, ${desempate}` : ''}`;
}
