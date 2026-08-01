"use client";

import { useEffect, useRef } from "react";
import { Icon } from "../Icon";

export type TabDef<K extends string> = {
  key: K;
  label: string;
  /** Icono opcional (lucide) a la izquierda de la etiqueta. */
  icon?: string;
  /** Contador opcional a la derecha (facturas, órdenes…). */
  count?: number;
};

/**
 * Tira de pestañas subrayadas con desplazamiento horizontal.
 *
 * MÓVIL PRIMERO: con 5–9 pestañas, envolverlas (`flex-wrap`) se comía tres o
 * cuatro renglones de una pantalla de 360 px antes de enseñar un solo dato, y
 * repartirlas a partes iguales (`flex-1`) partía las etiquetas largas. Aquí las
 * pestañas conservan su ancho natural y la tira se desliza con el dedo; el
 * indicador de scroll (degradado a la derecha) avisa de que hay más.
 *
 * La pestaña activa se centra sola al cambiar, para que nunca quede escondida
 * fuera de la vista después de navegar con el teclado o al recargar.
 */
export function TabStrip<K extends string>({
  tabs,
  active,
  onChange,
  className = "",
}: {
  tabs: TabDef<K>[];
  active: K;
  onChange: (key: K) => void;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>(`[data-tab="${active}"]`);
    el?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
  }, [active]);

  return (
    <div className={`relative -mx-4 mb-4 shrink-0 sm:mx-0 ${className}`}>
      <div
        ref={ref}
        role="tablist"
        className="no-scrollbar flex snap-x snap-mandatory gap-1 overflow-x-auto border-b border-border-subtle px-4 sm:px-0"
      >
        {tabs.map((t) => {
          const on = t.key === active;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={on}
              data-tab={t.key}
              onClick={() => onChange(t.key)}
              className={`-mb-px flex shrink-0 snap-start items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2.5 text-[13px] font-semibold transition-colors sm:px-3.5 sm:py-2 ${
                on
                  ? "border-brand text-text-primary"
                  : "border-transparent text-text-tertiary hover:text-text-secondary"
              }`}
            >
              {t.icon && <Icon name={t.icon} size={14} className={on ? "text-brand" : ""} />}
              {t.label}
              {t.count != null && (
                <span
                  className={`rounded-full px-1.5 text-[10px] ${
                    on ? "bg-brand-soft text-brand" : "bg-surface-2 text-text-tertiary"
                  }`}
                >
                  {t.count}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {/* Pista visual de que la tira continúa (solo donde puede desbordar). */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-canvas to-transparent sm:hidden"
      />
    </div>
  );
}
