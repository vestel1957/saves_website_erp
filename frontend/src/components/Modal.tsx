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
    /*
      MÓVIL PRIMERO: en pantallas pequeñas el diálogo es una hoja anclada abajo
      (a ancho completo, esquinas superiores redondeadas) — el patrón que espera
      el pulgar y que además evita que un formulario largo quede montado sobre el
      teclado. Desde `sm` vuelve a ser el diálogo centrado de siempre.

      El alto usa `dvh` en vez de `vh` porque en móvil la barra de direcciones
      entra y sale: con `vh` el pie del modal (los botones Guardar/Cancelar) se
      quedaba por debajo del borde visible y no había forma de alcanzarlo.
    */
    <div
      className="fixed inset-0 z-[90] flex items-end justify-center overflow-y-auto bg-black/40 backdrop-blur-sm sm:items-center sm:p-4"
      onMouseDown={onClose}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={idTitulo}
        onMouseDown={(e) => e.stopPropagation()}
        className={`flex max-h-[92dvh] w-full flex-col gap-3 overflow-y-auto rounded-t-2xl border border-border-subtle bg-surface p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-2xl sm:my-auto sm:max-h-[calc(100dvh-2rem)] sm:rounded-xl sm:p-5 sm:pb-5 ${maxWidth}`}
      >
        {/* asidero visual de la hoja (solo móvil) */}
        <span aria-hidden className="mx-auto -mt-1 h-1 w-10 shrink-0 rounded-full bg-border-default sm:hidden" />

        <div className="flex items-center justify-between gap-2">
          <span id={idTitulo} className="min-w-0 truncate text-[14px] font-bold text-text-primary">
            {title}
          </span>
          <button
            type="button"
            data-cerrar
            onClick={onClose}
            aria-label="Cerrar"
            className="-mr-1 shrink-0 rounded-md p-2 text-text-tertiary hover:bg-surface-2 hover:text-text-primary sm:p-1"
          >
            <Icon name="x" size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
