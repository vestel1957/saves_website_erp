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
    <div className="mb-3 flex shrink-0 flex-wrap items-center gap-2">
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
      {/*
        Los filtros van en UN renglón que se arrastra de lado, no envolviéndose en
        tres. Cinco desplegables a 390 px ocupaban ~150 px de alto: sumados a la
        cabecera de la página, se llegaba al primer registro con la pantalla ya
        gastada. Desde `sm` el envoltorio desaparece (`contents`) y la barra queda
        exactamente como estaba.

        `shrink-0` en los hijos porque en un contenedor que scrollea flexbox
        seguiría estrujándolos hasta hacerlos ilegibles antes de desbordar. Los
        paneles de `MultiSelect` no se recortan: van en un portal con posición
        `fixed`, fuera de esta caja.
      */}
      {children && (
        <div className="flex w-full min-w-0 gap-2 overflow-x-auto pb-0.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&>*]:shrink-0 sm:contents">
          {children}
        </div>
      )}
      {actions && (
        <div className="flex w-full items-center gap-2 [&>*]:flex-1 sm:ml-auto sm:w-auto sm:[&>*]:flex-none">
          {actions}
        </div>
      )}
    </div>
  );
}
