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
