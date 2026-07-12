import { Icon } from "../Icon";

export type SortState = { by: string; dir: "asc" | "desc" };

export type Column<T> = {
  key: string;
  header: React.ReactNode;
  align?: "left" | "right" | "center";
  render: (row: T) => React.ReactNode;
  /** Si la columna se puede ordenar en el servidor. Requiere `sort`/`onSort`. */
  sortable?: boolean;
  /** Clave de orden que entiende el backend (por defecto, `key`). */
  sortKey?: string;
};

function SortArrow({ active, dir }: { active: boolean; dir?: "asc" | "desc" }) {
  if (!active) return <Icon name="chevrons-up-down" size={13} className="text-text-tertiary opacity-50" />;
  return <Icon name={dir === "desc" ? "arrow-down" : "arrow-up"} size={13} className="text-brand" />;
}

export function DataTable<T>({
  columns,
  rows,
  empty = "Sin registros.",
  onRowClick,
  sort,
  onSort,
  fill = false,
  autoHeight = false,
}: {
  columns: Column<T>[];
  rows: T[];
  empty?: string;
  onRowClick?: (row: T) => void;
  /** Estado de orden actual (columna + dirección). */
  sort?: SortState;
  /** Llamado con la `sortKey` de la columna al hacer click en un encabezado ordenable. */
  onSort?: (sortKey: string) => void;
  /**
   * Si `true`, la tabla llena el alto disponible del contenedor flex padre
   * (`flex-1 min-h-0`) en lugar de usar una altura fija. El padre debe ser una
   * columna flex con alto acotado. Útil en páginas con mucha cabecera.
   */
  fill?: boolean;
  /**
   * Si `true`, la tabla se renderiza a su alto natural (sin tope ni scroll
   * vertical propio): scrollea la PÁGINA, no la tabla. El encabezado queda
   * pegado (`sticky`) al scroll del contenedor de la vista. Solo scroll
   * horizontal para tablas anchas.
   */
  autoHeight?: boolean;
}) {
  if (!rows.length) {
    return (
      <div className="rounded-xl border border-dashed border-border-subtle bg-surface p-10 text-center text-[13px] text-text-tertiary">
        {empty}
      </div>
    );
  }
  const alignClass = (a?: string) =>
    a === "right" ? "text-right" : a === "center" ? "text-center" : "text-left";
  const justifyClass = (a?: string) =>
    a === "right" ? "justify-end" : a === "center" ? "justify-center" : "justify-start";

  return (
    <>
      {/* Tabla — desde sm hacia arriba. Header fijo dentro del scroll (tabla o página según modo). */}
      <div className={`hidden rounded-xl border border-border-subtle bg-surface sm:block ${
        fill ? "min-h-0 flex-1 overflow-auto"
          : autoHeight ? "overflow-x-auto"
          : "max-h-[calc(100vh-280px)] overflow-auto"
      }`}>
        <table className="w-full text-[13px]">
          <thead className="sticky top-0 z-10">
            <tr className="border-b border-border-subtle bg-surface-2">
              {columns.map((c) => {
                const sortKey = c.sortKey ?? c.key;
                const canSort = !!(c.sortable && onSort);
                const active = sort?.by === sortKey;
                return (
                  <th
                    key={c.key}
                    aria-sort={active ? (sort?.dir === "desc" ? "descending" : "ascending") : undefined}
                    className={`bg-surface-2 px-4 py-2.5 font-semibold text-text-secondary ${alignClass(c.align)}`}
                  >
                    {canSort ? (
                      <button
                        type="button"
                        onClick={() => onSort!(sortKey)}
                        className={`inline-flex cursor-pointer items-center gap-1 ${justifyClass(c.align)} transition-colors hover:text-text-primary ${active ? "text-text-primary" : ""}`}
                      >
                        {c.header}
                        <SortArrow active={active} dir={active ? sort?.dir : undefined} />
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
            {rows.map((row, i) => (
              <tr
                key={i}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={`border-b border-border-subtle last:border-0 odd:bg-surface even:bg-surface-2/40 hover:bg-surface-2 ${onRowClick ? "cursor-pointer" : ""}`}
              >
                {columns.map((c) => (
                  <td key={c.key} className={`px-4 py-2.5 text-text-primary ${alignClass(c.align)}`}>
                    {c.render(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Cards — solo móvil (< sm). Cada fila se apila como etiqueta/valor. */}
      <div className="flex flex-col gap-2.5 sm:hidden">
        {rows.map((row, i) => (
          <div
            key={i}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
            className={`rounded-xl border border-border-subtle bg-surface px-3.5 py-1 ${onRowClick ? "cursor-pointer active:bg-surface-2" : ""}`}
          >
            {columns.map((c) => (
              <div
                key={c.key}
                className="flex items-start justify-between gap-3 border-b border-border-subtle py-2 last:border-0"
              >
                {c.header && (
                  <span className="shrink-0 text-[11px] font-medium uppercase tracking-wide text-text-tertiary">
                    {c.header}
                  </span>
                )}
                <span
                  className={`min-w-0 text-[13px] text-text-primary ${
                    c.header ? "text-right" : "flex-1"
                  }`}
                >
                  {c.render(row)}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}

// Reexportado desde el componente canónico para mantener compatibilidad con
// los imports existentes (`@/components/inventory/DataTable`).
export { Badge } from "../ui/Badge";
// AuthNotice vive en su propio módulo (client) para poder mostrar el skeleton
// mientras la sesión carga; se reexporta aquí por compatibilidad de imports.
export { AuthNotice } from "./AuthNotice";
