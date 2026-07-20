"use client";

import { useEffect, useId, useRef } from "react";
import { Icon } from "@/components/Icon";

/** Elementos que pueden recibir foco dentro del diálogo. */
const ENFOCABLES =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Modal centrado y reutilizable para formularios de creación.
 * Se cierra con Escape, click en el fondo o el botón ✕.
 *
 * ACCESIBILIDAD: se anuncia como diálogo (`role="dialog"` + `aria-modal`) y se
 * nombra con su título vía `aria-labelledby`. Antes era un `<div>` cualquiera: un
 * lector de pantalla no avisaba de que se hubiera abierto nada y el foco seguía
 * detrás, en la página, así que con el teclado se navegaba por debajo del modal.
 *
 * El foco entra al abrir, queda atrapado dentro mientras está abierto (Tab cicla) y
 * vuelve al elemento que lo abrió al cerrar, que es lo que espera quien no usa ratón.
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  maxWidth = "max-w-lg",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  maxWidth?: string;
}) {
  const idTitulo = useId();
  const panel = useRef<HTMLDivElement>(null);
  const origen = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;

    // A dónde devolver el foco al cerrar.
    origen.current = document.activeElement as HTMLElement | null;

    const enfocables = () =>
      Array.from(panel.current?.querySelectorAll<HTMLElement>(ENFOCABLES) ?? []);

    // Foco al primer control con sentido (el ✕ es el último recurso).
    const primero = enfocables().find((el) => !el.hasAttribute("data-cerrar")) ?? enfocables()[0];
    primero?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      // Trampa de foco: sin esto, tabular saca al usuario del diálogo y lo deja
      // navegando la página de detrás sin poder ver dónde está.
      const lista = enfocables();
      if (lista.length === 0) return;
      const primeroEl = lista[0];
      const ultimo = lista[lista.length - 1];
      if (e.shiftKey && document.activeElement === primeroEl) {
        e.preventDefault();
        ultimo.focus();
      } else if (!e.shiftKey && document.activeElement === ultimo) {
        e.preventDefault();
        primeroEl.focus();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      origen.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[90] flex items-start justify-center overflow-y-auto bg-black/40 p-4 backdrop-blur-sm sm:items-center"
      onMouseDown={onClose}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={idTitulo}
        onMouseDown={(e) => e.stopPropagation()}
        className={`my-auto flex max-h-[calc(100vh-2rem)] w-full ${maxWidth} flex-col gap-3 overflow-y-auto rounded-xl border border-border-subtle bg-surface p-4 shadow-2xl sm:p-5`}
      >
        <div className="flex items-center justify-between gap-2">
          <span id={idTitulo} className="min-w-0 truncate text-[14px] font-bold text-text-primary">
            {title}
          </span>
          <button
            type="button"
            data-cerrar
            onClick={onClose}
            aria-label="Cerrar"
            className="shrink-0 rounded-md p-1 text-text-tertiary hover:bg-surface-2 hover:text-text-primary"
          >
            <Icon name="x" size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
