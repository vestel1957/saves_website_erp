"use client";

import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

type RenderChildren = (api: { close: () => void }) => ReactNode;

/**
 * Popover genérico: un disparador + contenido flotante que se cierra al
 * hacer click afuera o presionar Esc. El contenido puede ser un nodo o una
 * función que recibe `close` para cerrar desde dentro (ej. al elegir una opción).
 *
 * El panel se monta en un portal con posición fija calculada desde el disparador,
 * así ningún contenedor con `overflow-hidden` lo recorta.
 */
export function Dropdown({
  trigger,
  children,
  align = "right",
  width = 264,
}: {
  trigger: ReactNode;
  children: ReactNode | RenderChildren;
  align?: "left" | "right";
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Calcula la posición del panel a partir del rectángulo del disparador.
  useEffect(() => {
    if (!open) return;
    function place() {
      const el = triggerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const margin = 8;
      let left = align === "right" ? r.right - width : r.left;
      left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
      setPos({ top: r.bottom + 8, left });
    }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, align, width]);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center"
      >
        {trigger}
      </button>

      {open && pos != null && typeof document !== "undefined" &&
        createPortal(
          <div
            ref={panelRef}
            className="fixed z-[100] max-h-[70vh] overflow-y-auto rounded-xl border border-border-subtle bg-surface p-1.5 shadow-xl shadow-black/5"
            style={{ top: pos.top, left: pos.left, width, maxWidth: "calc(100vw - 24px)" }}
          >
            {typeof children === "function"
              ? (children as RenderChildren)({ close: () => setOpen(false) })
              : children}
          </div>,
          document.body,
        )}
    </>
  );
}

/** Fila de menú estándar usada dentro de un Dropdown. */
export function MenuItem({
  children,
  onClick,
  danger = false,
}: {
  children: ReactNode;
  onClick?: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] font-medium transition-colors ${
        danger
          ? "text-error-text hover:bg-error-soft"
          : "text-text-secondary hover:bg-surface-2"
      }`}
    >
      {children}
    </button>
  );
}
