"use client";

import { Icon } from "../Icon";
import { Input } from "./Field";

/**
 * Barra estándar de los listados: buscador con icono a la izquierda, filtros
 * (children) al lado y acciones (botones "Nuevo…") pegadas a la derecha.
 * El debounce lo maneja la página (normalmente vía `useRequest`), aquí el
 * input es controlado y ya.
 */
export function ListToolbar({
  search,
  onSearch,
  searchPlaceholder = "Buscar…",
  children,
  actions,
}: {
  /** Valor del buscador. Si es `undefined`, no se muestra buscador. */
  search?: string;
  onSearch?: (value: string) => void;
  searchPlaceholder?: string;
  /** Filtros adicionales (selects, toggles…). */
  children?: React.ReactNode;
  /** Acciones a la derecha (p. ej. botón "Nuevo"). */
  actions?: React.ReactNode;
}) {
  return (
    // MÓVIL PRIMERO: el buscador ocupa el renglón entero (en 360 px competir con
    // los filtros lo dejaba en una rendija) y las acciones bajan a su propia fila
    // repartiéndose el ancho, para que sean botones pulsables y no migajas
    // pegadas al borde. Desde `sm` es la barra de una sola línea de siempre.
    <div className="mb-3 flex flex-wrap items-center gap-2">
      {search !== undefined && onSearch && (
        <div className="relative w-full sm:w-auto sm:min-w-[220px] sm:flex-1">
          <Icon
            name="search"
            size={15}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary"
          />
          <Input
            className="pl-9"
            placeholder={searchPlaceholder}
            value={search}
            onChange={(e) => onSearch(e.target.value)}
          />
        </div>
      )}
      {children}
      {actions && (
        <div className="flex w-full items-center gap-2 [&>*]:flex-1 sm:ml-auto sm:w-auto sm:[&>*]:flex-none">
          {actions}
        </div>
      )}
    </div>
  );
}
