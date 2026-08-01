import { isValidElement, type ReactNode } from "react";
import type { Column, SortState } from "./DataTable";

/**
 * Orden de tablas en el cliente, sin configuración por pantalla.
 *
 * La idea: cualquier columna se puede ordenar aunque quien la escribió no haya
 * declarado nada. Para eso hay que sacar de la fila un valor comparable, y se
 * intenta por tres vías, de la más fiable a la más tosca:
 *
 *   1. `sortValue(row)` — la columna dice explícitamente por qué se ordena.
 *   2. `row[sortKey ?? key]` — la clave de la columna es un campo de la fila
 *      (admite rutas anidadas tipo `"plan.nombre"`).
 *   3. El texto que pinta `render(row)` — se recorre el árbol de React y se
 *      juntan las cadenas. Ordena por lo que el usuario está viendo, que es
 *      justo lo que espera al pulsar la cabecera.
 *
 * Luego se compara con tipo: números (incluida la moneda en formato es-CO),
 * fechas dd/mm/aaaa e ISO, y por último texto con collator español. Los vacíos
 * ("—", "", null) caen siempre al final, suba o baje el orden: una celda sin
 * dato no es "la más pequeña", es ruido y molesta arriba.
 */

/** Celdas que no llevan dato: se van al fondo en cualquier dirección. */
const VACIOS = new Set(["", "-", "—", "–", "n/a", "na", "null", "undefined", "sin dato", "sin datos"]);

/** Columnas que no se ordenan solas: botones y casillas de selección. */
const NO_ORDENABLE = /^(sel|select|seleccion|selección|check|checkbox|acciones|accion|acción|actions?|menu|menú|expand|drag)$/i;
const ES_ACCIONES = /accion|action/i;

/** Fechas que se pintan en la interfaz: 30/07/2026, 2026-07-30, con u sin hora. */
const FECHA_DMY = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:[ ,T]+(\d{1,2}):(\d{2}))?/;
const FECHA_ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?/;

const collator = new Intl.Collator("es", { sensitivity: "base", numeric: true });

/**
 * ¿Esta columna se puede ordenar?
 *
 * Con orden local (`local`) la respuesta es sí por defecto: la tabla tiene
 * todas las filas en la mano y puede ordenar cualquier columna. Con orden de
 * servidor sigue siendo opt-in (`sortable: true`), porque ahí la cabecera solo
 * sirve si el endpoint conoce esa clave; pintar una flecha que el backend
 * ignora es peor que no pintarla.
 */
export function esOrdenable<T>(c: Column<T>, local: boolean): boolean {
  if (c.sortable !== undefined) return c.sortable;
  if (!local) return false;
  if (c.card === "footer") return false;
  if (NO_ORDENABLE.test(c.key.trim())) return false;
  if (ES_ACCIONES.test(c.key)) return false;
  return !!c.header;
}

/** Texto plano de una cabecera, para el selector de orden en móvil. */
export function etiquetaDe<T>(c: Column<T>): string {
  return textoDe(c.header).trim() || c.key;
}

export function claveDeOrden<T>(c: Column<T>): string {
  return c.sortKey ?? c.key;
}

/** Lee `a.b.c` sobre un objeto cualquiera sin reventar en el camino. */
function leerRuta(row: unknown, ruta: string): unknown {
  let actual: unknown = row;
  for (const parte of ruta.split(".")) {
    if (actual === null || typeof actual !== "object") return undefined;
    actual = (actual as Record<string, unknown>)[parte];
    if (actual === undefined) return undefined;
  }
  return actual;
}

/** Junta el texto visible de un árbol de React (lo que el usuario lee). */
function textoDe(nodo: ReactNode, profundidad = 0): string {
  if (nodo === null || nodo === undefined || typeof nodo === "boolean") return "";
  if (typeof nodo === "string" || typeof nodo === "number") return String(nodo);
  if (profundidad > 8) return "";
  if (Array.isArray(nodo)) return nodo.map((n) => textoDe(n, profundidad + 1)).join(" ");
  if (isValidElement(nodo)) {
    const props = nodo.props as { children?: ReactNode; title?: string; "aria-label"?: string };
    const hijos = textoDe(props?.children, profundidad + 1);
    // Iconos y demás nodos sin texto: al menos el título accesible ordena algo.
    if (!hijos.trim()) return props?.["aria-label"] ?? props?.title ?? "";
    return hijos;
  }
  return "";
}

/** Valor comparable de una celda, por las tres vías descritas arriba. */
function valorDeCelda<T>(row: T, c: Column<T>): unknown {
  if (c.sortValue) return c.sortValue(row);
  const directo = leerRuta(row, claveDeOrden(c));
  if (directo !== undefined && typeof directo !== "object") return directo;
  if (directo instanceof Date) return directo;
  try {
    return textoDe(c.render(row));
  } catch {
    // Un `render` que asume contexto de React (hooks, portales) puede fallar
    // fuera del árbol; el orden no es motivo para tumbar la tabla.
    return null;
  }
}

/** Número escrito a la colombiana: "$ 1.234.567,89", "12,5 %", "-3.000". */
function comoNumero(texto: string): number | null {
  const limpio = texto.replace(/[\s$%]/g, "").replace(/\.(?=\d{3}\b)/g, "").replace(",", ".");
  if (!/^-?\d+(\.\d+)?$/.test(limpio)) return null;
  const n = Number(limpio);
  return Number.isFinite(n) ? n : null;
}

/** Fecha escrita en la interfaz → milisegundos. */
function comoFecha(texto: string): number | null {
  const dmy = FECHA_DMY.exec(texto);
  if (dmy) {
    const [, d, m, a, hh, mm] = dmy;
    return Date.UTC(+a, +m - 1, +d, hh ? +hh : 0, mm ? +mm : 0);
  }
  const iso = FECHA_ISO.exec(texto);
  if (iso) {
    const [, a, m, d, hh, mm] = iso;
    return Date.UTC(+a, +m - 1, +d, hh ? +hh : 0, mm ? +mm : 0);
  }
  return null;
}

/**
 * Compara dos valores de celda. Devuelve el orden ascendente; los vacíos van
 * al final y se marcan aparte para que no los invierta la dirección.
 */
function comparar(a: unknown, b: unknown): number {
  const va = normalizar(a);
  const vb = normalizar(b);
  if (va === null && vb === null) return 0;
  if (va === null) return Number.POSITIVE_INFINITY; // señal: siempre al final
  if (vb === null) return Number.NEGATIVE_INFINITY;

  if (typeof va === "number" && typeof vb === "number") return va - vb;
  if (typeof va === "boolean" || typeof vb === "boolean") {
    return Number(va === true) - Number(vb === true);
  }

  const ta = String(va);
  const tb = String(vb);

  const na = comoNumero(ta);
  const nb = comoNumero(tb);
  if (na !== null && nb !== null) return na - nb;

  const fa = comoFecha(ta);
  const fb = comoFecha(tb);
  if (fa !== null && fb !== null) return fa - fb;

  return collator.compare(ta, tb);
}

/** Reduce el valor a número, booleano o texto; los vacíos pasan a `null`. */
function normalizar(v: unknown): number | boolean | string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v;
  if (v instanceof Date) return v.getTime();
  const texto = String(v).trim();
  return VACIOS.has(texto.toLowerCase()) ? null : texto;
}

/**
 * Ordena una copia de las filas. Estable: a igualdad de valor se conserva el
 * orden en que llegaron (que suele ser el que decidió el backend).
 */
export function ordenarFilas<T>(rows: T[], columns: Column<T>[], sort: SortState | null | undefined): T[] {
  if (!sort) return rows;
  const col = columns.find((c) => claveDeOrden(c) === sort.by && esOrdenable(c, true));
  if (!col) return rows;

  const signo = sort.dir === "desc" ? -1 : 1;
  const conValor = rows.map((row, i) => ({ row, i, v: valorDeCelda(row, col) }));

  conValor.sort((x, y) => {
    const r = comparar(x.v, y.v);
    // Los vacíos quedan al final en ambas direcciones (ver `comparar`).
    if (r === Number.POSITIVE_INFINITY) return 1;
    if (r === Number.NEGATIVE_INFINITY) return -1;
    return r === 0 ? x.i - y.i : signo * r;
  });

  return conValor.map((e) => e.row);
}

/**
 * Ordena por un valor calculado a mano. Es la misma comparación que usa la
 * tabla (números, moneda es-CO, fechas, texto en español, vacíos al final),
 * expuesta para las tablas escritas en HTML, que no tienen `Column[]`.
 */
export function ordenarPorValor<T>(
  rows: T[],
  valor: (fila: T) => unknown,
  dir: "asc" | "desc",
): T[] {
  const signo = dir === "desc" ? -1 : 1;
  const conValor = rows.map((row, i) => ({ row, i, v: valor(row) }));
  conValor.sort((x, y) => {
    const r = comparar(x.v, y.v);
    if (r === Number.POSITIVE_INFINITY) return 1;
    if (r === Number.NEGATIVE_INFINITY) return -1;
    return r === 0 ? x.i - y.i : signo * r;
  });
  return conValor.map((e) => e.row);
}

/** Siguiente estado al pulsar una cabecera: asc → desc → asc. */
export function alternarOrden(actual: SortState | null | undefined, by: string): SortState {
  if (actual?.by === by) return { by, dir: actual.dir === "asc" ? "desc" : "asc" };
  return { by, dir: "asc" };
}
