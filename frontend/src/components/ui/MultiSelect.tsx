"use client";

import { useMemo, useState } from "react";
import { Icon } from "../Icon";
import { Dropdown } from "./Dropdown";

export type OpcionMulti = {
  value: string;
  label: string;
  /**
   * Cuántos registros deja esa opción CON LOS DEMÁS FILTROS PUESTOS. Opcional: sin
   * él la lista se ve como siempre. Con él, el desplegable deja de ser una lista a
   * ciegas —se ve dónde hay algo y dónde no antes de marcar— y un 0 avisa de que
   * esa combinación no existe en vez de dejar la tabla vacía sin explicación.
   */
  count?: number;
};

/**
 * Filtro de listado que admite VARIAS opciones a la vez.
 *
 * Reemplaza al `<Select>` de una sola opción en las barras de filtros: preguntas
 * como "pendientes Y realizando" o "instalaciones Y traslados" no se podían hacer
 * —había que mirar una lista, apuntar, y volver a filtrar— y son justo las que se
 * hacen a diario en soporte.
 *
 * Se ve igual que un `<Select>` cuando no hay nada elegido (mismo alto, mismo
 * borde, misma flecha) para que la barra no cambie de cara, y se enciende en color
 * de marca en cuanto filtra algo, como el botón de "Fechas".
 *
 * El valor es un array de strings; quien lo usa decide cómo viaja a la API (aquí
 * se manda separado por comas). Vacío = sin filtro, que NO es lo mismo que
 * "todas marcadas": marcar todas también es un filtro y así se lo dice al servidor.
 */
export function MultiSelect({
  label,
  todos,
  options,
  value,
  onChange,
  width = 264,
  align = "left",
  buscarDesde = 10,
  className = "",
}: {
  /** Nombre corto del filtro, el que se enseña con el contador ("Estado (3)"). */
  label: string;
  /** Texto de "sin filtro" ("Todos los estados"). */
  todos: string;
  options: OpcionMulti[];
  value: string[];
  onChange: (value: string[]) => void;
  width?: number;
  align?: "left" | "right";
  /** A partir de cuántas opciones aparece el buscador dentro del panel. */
  buscarDesde?: number;
  className?: string;
}) {
  const [query, setQuery] = useState("");
  const elegidas = new Set(value);

  const visibles = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
  }, [options, query]);

  // Con una sola elegida se enseña SU nombre y no "Estado (1)": el caso corriente
  // sigue leyéndose de un vistazo, como con el desplegable de siempre.
  const texto =
    value.length === 0
      ? todos
      : value.length === 1
        ? options.find((o) => o.value === value[0])?.label ?? value[0]
        : `${label} (${value.length})`;

  const alternar = (v: string) =>
    onChange(elegidas.has(v) ? value.filter((x) => x !== v) : [...value, v]);

  const activo = value.length > 0;
  // Ancho al contenido, como los desplegables que reemplaza, pero con tope: una
  // opción larga ("Reconexion Television") partía la barra en un móvil de 320 px.
  const disparador = `max-w-[220px] justify-between gap-2 rounded-lg border px-3 py-2 text-[13px] font-medium shadow-sm transition-colors ${
    activo
      ? "border-brand bg-brand-soft text-brand"
      : "border-border-default bg-surface text-text-primary hover:border-border-strong"
  }`;

  return (
    <Dropdown
      align={align}
      width={width}
      triggerClassName={`${disparador} ${className}`}
      trigger={
        <>
          <span className="truncate">{texto}</span>
          <Icon name="chevron-down" size={14} className="shrink-0 opacity-70" />
        </>
      }
    >
      <div className="flex flex-col">
        {options.length >= buscarDesde && (
          <div className="p-1 pb-1.5">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar…"
              className="w-full rounded-lg border border-border-default bg-surface px-2.5 py-1.5 text-[12.5px] text-text-primary outline-none placeholder:text-text-tertiary focus:border-border-focus"
            />
          </div>
        )}

        <div className="max-h-64 overflow-y-auto">
          {visibles.length === 0 && (
            <p className="px-2.5 py-3 text-center text-[12px] text-text-tertiary">Sin coincidencias.</p>
          )}
          {visibles.map((o) => {
            const marcada = elegidas.has(o.value);
            return (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={marcada}
                onClick={() => alternar(o.value)}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] font-medium text-text-secondary transition-colors hover:bg-surface-2"
              >
                <span
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
                    marcada ? "border-brand bg-brand text-on-brand" : "border-border-strong bg-surface"
                  }`}
                >
                  {marcada && <Icon name="check" size={11} />}
                </span>
                <span className="truncate">{o.label}</span>
                {o.count != null && (
                  <span
                    className={`ml-auto shrink-0 tabular-nums text-[12px] ${
                      o.count === 0 ? "text-text-tertiary opacity-60" : "text-text-tertiary"
                    }`}
                  >
                    {o.count.toLocaleString("es-CO")}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {activo && (
          <div className="mt-1 border-t border-border-subtle pt-1">
            <button
              type="button"
              onClick={() => onChange([])}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12.5px] font-semibold text-text-secondary hover:bg-surface-2"
            >
              <Icon name="x" size={13} /> Quitar {label.toLowerCase()}
            </button>
          </div>
        )}
      </div>
    </Dropdown>
  );
}
