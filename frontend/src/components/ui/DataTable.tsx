"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "../Icon";
import { alternarOrden, claveDeOrden, esOrdenable, etiquetaDe, ordenarFilas } from "./table-sort";

export type SortState = { by: string; dir: "asc" | "desc" };

export type Column<T> = {
  key: string;
  header: React.ReactNode;
  align?: "left" | "right" | "center";
  render: (row: T) => React.ReactNode;
  /**
   * Fuerza si la columna se puede ordenar. Por omisión, la tabla ordena sola
   * cualquier columna con dato (todas menos acciones y casillas); ponlo en
   * `false` para una columna concreta. Con orden de servidor (`onSort`) sigue
   * siendo opt-in: solo se ordenan las que lo declaren `true`.
   */
  sortable?: boolean;
  /** Clave de orden que entiende el backend (por defecto, `key`). */
  sortKey?: string;
  /**
   * De dónde sale el valor por el que se ordena. Solo hace falta cuando lo que
   * se pinta no sirve para comparar: un badge de estado que debe seguir el
   * orden del flujo, una fecha ya formateada en texto raro, un total calculado.
   * Sin esto se usa `row[sortKey ?? key]` y, si no existe, el texto visible.
   */
  sortValue?: (row: T) => string | number | boolean | Date | null | undefined;
  /**
   * Papel de la columna en la tarjeta de móvil (< sm). Por defecto se deduce:
   * la primera columna es el título y la de acciones el pie; el resto son filas
   * etiqueta/valor. Úsalo para forzar otro reparto o esconder una columna
   * secundaria en pantallas pequeñas.
   */
  card?: "title" | "row" | "footer" | "hidden";
};

/** Columnas cuyo contenido son botones: en la tarjeta van al pie, sin etiqueta. */
const ES_ACCIONES = /accion|action/i;

function papelEnTarjeta<T>(c: Column<T>, i: number): NonNullable<Column<T>["card"]> {
  if (c.card) return c.card;
  if (i === 0) return "title";
  if (ES_ACCIONES.test(c.key)) return "footer";
  return "row";
}

function SortArrow({ active, dir }: { active: boolean; dir?: "asc" | "desc" }) {
  if (!active) return <Icon name="chevrons-up-down" size={13} className="text-text-tertiary opacity-50" />;
  return <Icon name={dir === "desc" ? "arrow-down" : "arrow-up"} size={13} className="text-brand" />;
}

export function DataTable<T>({
  columns,
  rows,
  empty = "Sin registros.",
  loading = false,
  loadingText = "Cargando…",
  onRowClick,
  rowHref,
  sort,
  onSort,
  fill = false,
  sortableByDefault,
  cardRender,
}: {
  columns: Column<T>[];
  rows: T[];
  empty?: string;
  /**
   * Si `true` y aún no hay filas, ocupa el lugar de la tabla con un indicador
   * de carga en vez del mensaje de vacío: el aviso aparece donde van a salir
   * los datos, no en la cabecera de la página.
   */
  loading?: boolean;
  /** Texto del indicador de carga (p. ej. "Consultando la OLT por SSH…"). */
  loadingText?: string;
  onRowClick?: (row: T) => void;
  /**
   * A dónde lleva la fila. Con esto la fila se comporta como un enlace de
   * verdad: **ctrl/⌘+clic y el botón central abren en una pestaña nueva** y el
   * listado se queda intacto detrás, con sus filtros y su página. El clic
   * normal navega igual que siempre (sin recargar).
   *
   * Si además se pasa `onRowClick`, manda ese para el clic normal (filas que
   * abren un panel en vez de navegar).
   */
  rowHref?: (row: T) => string;
  /** Estado de orden actual (columna + dirección). Solo con `onSort`. */
  sort?: SortState;
  /**
   * Llamado con la `sortKey` de la columna al pulsar una cabecera ordenable.
   * Pásalo solo si el orden lo resuelve el servidor (listados paginados en
   * backend, donde la tabla no tiene todas las filas). Si no lo pasas, la
   * tabla ordena sola las filas que recibió.
   */
  onSort?: (sortKey: string) => void;
  /**
   * Si `true`, la tabla llena el alto disponible del contenedor flex padre
   * (`flex-1 min-h-0`) con scroll interno. Reservado para tableros/paneles;
   * los listados usan el modo por defecto (alto natural, scrollea la página).
   */
  fill?: boolean;
  /**
   * Si las columnas son ordenables sin declararlo. Por omisión, sí cuando la
   * tabla ordena sola y no cuando el orden va por `onSort` (ahí depende de que
   * el endpoint conozca la clave). Lo usa `PagedTable`, que sí tiene todas las
   * filas aunque delegue el click.
   */
  sortableByDefault?: boolean;
  /**
   * Tarjeta a medida para móvil (< sm). Sin esto, la tarjeta se arma sola con las
   * columnas (titular + una fila etiqueta/valor por columna), que sirve para una
   * tabla de cuatro o cinco columnas y se vuelve un muro en cuanto hay más: la
   * lista de órdenes son diez columnas, o sea diez renglones y 355 px por tarjeta
   * —una orden por pantalla—, cuando lo que se busca en el móvil son cuatro datos.
   *
   * El listado sigue declarando sus `columns` (la tabla de escritorio, el orden y
   * el Excel salen de ahí); esto sólo cambia CÓMO se dibuja la misma fila en
   * pantalla estrecha. Quien lo use se encarga del interior de la tarjeta: la caja,
   * el borde y el clic los sigue poniendo la tabla.
   */
  cardRender?: (row: T) => React.ReactNode;
}) {
  const router = useRouter();

  /**
   * Clic en una fila. Un `<tr>` no puede envolverse en `<a>` (el HTML no lo
   * permite dentro de la tabla), así que las teclas de "abrir aparte" se
   * atienden a mano: sin esto, ctrl+clic navegaba en la misma pestaña y el
   * usuario perdía los filtros que tenía puestos.
   */
  const clicEnFila = (row: T) => (e: React.MouseEvent) => {
    // Un clic sobre un enlace, un botón o un control DENTRO de la fila es suyo y
    // no de la fila. Sin esto, un ctrl+clic sobre el enlace de la primera columna
    // abría DOS pestañas (la del enlace y la que abre la fila), y un botón de
    // acción del pie de la tarjeta navegaba además al detalle.
    if ((e.target as HTMLElement)?.closest?.("a,button,input,select,textarea,label")) return;
    const href = rowHref?.(row);
    const aparte = e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1;
    if (href && aparte) {
      e.preventDefault();
      window.open(href, "_blank", "noopener,noreferrer");
      return;
    }
    if (e.button === 1) return; // botón central sin destino: no hace nada
    if (onRowClick) onRowClick(row);
    else if (href) router.push(href);
  };
  const filaPulsable = (row: T) => !!onRowClick || !!rowHref?.(row);

  // Sin `onSort`, la tabla se ordena a sí misma: la cabecera funciona en todos
  // los listados sin que cada pantalla tenga que cablear nada.
  const local = !onSort;
  const auto = sortableByDefault ?? local;
  const [ordenLocal, setOrdenLocal] = useState<SortState | null>(null);
  const orden = local ? ordenLocal : sort;

  const ordenables = useMemo(
    () => new Set(columns.filter((c) => esOrdenable(c, auto)).map(claveDeOrden)),
    [columns, auto],
  );

  const pulsarOrden = (clave: string) => {
    if (local) setOrdenLocal((s) => alternarOrden(s, clave));
    else onSort!(clave);
  };

  const filas = useMemo(
    () => (local ? ordenarFilas(rows, columns, ordenLocal) : rows),
    [local, rows, columns, ordenLocal],
  );

  if (!rows.length) {
    return (
      <div className="shrink-0 rounded-xl border border-dashed border-border-subtle bg-surface p-12 text-center">
        {loading ? (
          <span className="inline-flex items-center gap-2 text-[13px] text-text-tertiary">
            <Icon name="loader" size={15} className="animate-spin" />
            {loadingText}
          </span>
        ) : (
          <div className="flex flex-col items-center gap-2">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-2 text-text-tertiary">
              <Icon name="inbox" size={18} />
            </span>
            <span className="text-[13px] text-text-tertiary">{empty}</span>
          </div>
        )}
      </div>
    );
  }
  const alignClass = (a?: string) =>
    a === "right" ? "text-right" : a === "center" ? "text-center" : "text-left";
  const justifyClass = (a?: string) =>
    a === "right" ? "justify-end" : a === "center" ? "justify-center" : "justify-start";

  return (
    <>
      {/*
        Tabla — desde sm hacia arriba. Por defecto alto natural (scrollea la página);
        `fill` = scroll interno.

        `shrink-0` NO es decorativo: las pantallas cuelgan de un `<main class="flex
        flex-col">` de alto fijo, y ahí flexbox ENCOGE a los hijos cuando el contenido
        no cabe en vez de dejar que se desborde. La tabla quedaba aplastada (33 px: se
        veía la cabecera y las filas caían fuera de la caja, recortadas por el
        overflow) y parecía que la factura no cargaba sus ítems.
      */}
      <div className={`hidden rounded-xl border border-border-subtle bg-surface shadow-sm sm:block ${
        fill ? "min-h-0 flex-1 overflow-auto" : "shrink-0 overflow-x-auto"
      }`}>
        <table className="w-full text-[13px]">
          <thead className="sticky top-0 z-10">
            <tr className="border-b-2 border-border-default bg-surface-2">
              {columns.map((c) => {
                const sortKey = claveDeOrden(c);
                const canSort = ordenables.has(sortKey);
                const active = canSort && orden?.by === sortKey;
                return (
                  <th
                    key={c.key}
                    aria-sort={active ? (orden?.dir === "desc" ? "descending" : "ascending") : undefined}
                    className={`whitespace-nowrap bg-surface-2 px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-text-secondary ${alignClass(c.align)}`}
                  >
                    {canSort ? (
                      <button
                        type="button"
                        onClick={() => pulsarOrden(sortKey)}
                        title={`Ordenar por ${etiquetaDe(c)}`}
                        className={`group inline-flex cursor-pointer items-center gap-1 uppercase tracking-wider ${justifyClass(c.align)} transition-colors hover:text-text-primary ${active ? "text-text-primary" : ""}`}
                      >
                        {c.header}
                        <SortArrow active={!!active} dir={active ? orden?.dir : undefined} />
                      </button>
                    ) : (
                      c.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {filas.map((row, i) => (
              <tr
                key={i}
                onClick={filaPulsable(row) ? clicEnFila(row) : undefined}
                onAuxClick={rowHref ? clicEnFila(row) : undefined}
                className={`border-b border-border-subtle last:border-0 odd:bg-surface even:bg-surface-2/60 transition-colors hover:bg-brand-soft/30 ${filaPulsable(row) ? "cursor-pointer" : ""}`}
              >
                {columns.map((c) => (
                  <td key={c.key} className={`px-4 py-3 text-text-primary ${alignClass(c.align)}`}>
                    {c.render(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/*
        Cards — solo móvil (< sm). La tarjeta tiene jerarquía en vez de ser una
        lista plana de etiqueta/valor: la primera columna hace de titular (sin
        etiqueta, a ancho completo) y los botones de la columna "Acciones" bajan
        al pie, donde caben y se pueden pulsar. Antes esos botones se apretaban
        contra el borde derecho, tras su etiqueta, y quedaban impulsables.
      */}
      <div className="flex shrink-0 flex-col gap-2.5 sm:hidden">
        {/*
          En móvil no hay cabecera que pulsar: las columnas se vuelven filas de
          la tarjeta. Este selector es el equivalente — misma lista de columnas
          ordenables, mismo estado.
        */}
        {ordenables.size > 0 && (
          <div className="flex items-center gap-2 rounded-xl border border-border-subtle bg-surface-2 px-2.5 py-2">
            <Icon name="chevrons-up-down" size={14} className="shrink-0 text-text-tertiary" />
            <select
              value={orden && ordenables.has(orden.by) ? orden.by : ""}
              onChange={(e) => {
                const v = e.target.value;
                if (v && v !== orden?.by) pulsarOrden(v);
              }}
              aria-label="Ordenar por"
              className="min-w-0 flex-1 cursor-pointer bg-transparent text-[13px] font-medium text-text-primary outline-none"
            >
              {/* Igual que en la cabecera: se elige columna, no se "desordena". */}
              <option value="" disabled>Ordenar por…</option>
              {columns
                .filter((c) => ordenables.has(claveDeOrden(c)))
                .map((c) => (
                  <option key={c.key} value={claveDeOrden(c)}>
                    {etiquetaDe(c)}
                  </option>
                ))}
            </select>
            {orden && ordenables.has(orden.by) && (
              <button
                type="button"
                onClick={() => pulsarOrden(orden.by)}
                aria-label={orden.dir === "desc" ? "Orden descendente" : "Orden ascendente"}
                className="flex shrink-0 items-center gap-1 rounded-lg border border-border-subtle bg-surface px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-text-secondary active:bg-surface-2"
              >
                <Icon name={orden.dir === "desc" ? "arrow-down" : "arrow-up"} size={12} />
                {orden.dir === "desc" ? "Mayor" : "Menor"}
              </button>
            )}
          </div>
        )}
        {filas.map((row, i) => {
          const titulo = columns.filter((c, j) => papelEnTarjeta(c, j) === "title");
          const filas = columns.filter((c, j) => papelEnTarjeta(c, j) === "row");
          const pie = columns.filter((c, j) => papelEnTarjeta(c, j) === "footer");
          // Con tarjeta a medida la caja no lleva relleno propio: lo pone ella, que
          // es quien sabe cómo se reparte por dentro.
          if (cardRender) {
            return (
              <div
                key={i}
                onClick={filaPulsable(row) ? clicEnFila(row) : undefined}
                onAuxClick={rowHref ? clicEnFila(row) : undefined}
                className={`overflow-hidden rounded-xl border border-border-subtle bg-surface shadow-sm ${filaPulsable(row) ? "cursor-pointer active:bg-surface-2" : ""}`}
              >
                {cardRender(row)}
              </div>
            );
          }
          return (
            <div
              key={i}
              onClick={filaPulsable(row) ? clicEnFila(row) : undefined}
              onAuxClick={rowHref ? clicEnFila(row) : undefined}
              className={`rounded-xl border border-border-subtle bg-surface px-3.5 py-1 shadow-sm ${filaPulsable(row) ? "cursor-pointer active:bg-surface-2" : ""}`}
            >
              {titulo.map((c) => (
                <div
                  key={c.key}
                  className="border-b border-border-subtle py-2.5 text-[14px] font-semibold text-text-primary last:border-0"
                >
                  {c.render(row)}
                </div>
              ))}

              {filas.map((c) => (
                <div
                  key={c.key}
                  className="flex items-start justify-between gap-3 border-b border-border-subtle py-2 last:border-0"
                >
                  {c.header && (
                    <span className="max-w-[45%] shrink-0 text-[11px] font-medium uppercase leading-tight tracking-wide text-text-tertiary">
                      {c.header}
                    </span>
                  )}
                  <span
                    className={`min-w-0 break-words text-[13px] text-text-primary ${
                      c.header ? "text-right" : "flex-1"
                    }`}
                  >
                    {c.render(row)}
                  </span>
                </div>
              ))}

              {pie.map((c) => (
                <div
                  key={c.key}
                  className="flex flex-wrap items-center justify-end gap-1.5 border-t border-border-subtle py-2"
                >
                  {c.render(row)}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </>
  );
}

// Reexportado desde el componente canónico para mantener compatibilidad con
// los imports existentes (`@/components/ui/DataTable`).
export { Badge } from "../ui/Badge";
// AuthNotice vive en su propio módulo (client) para poder mostrar el skeleton
// mientras la sesión carga; se reexporta aquí por compatibilidad de imports.
export { AuthNotice } from "./AuthNotice";
