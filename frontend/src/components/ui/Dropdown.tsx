"use client";

import {
  useEffect,
  useLayoutEffect,
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
  triggerClassName = "",
}: {
  trigger: ReactNode;
  children: ReactNode | RenderChildren;
  align?: "left" | "right";
  width?: number;
  /** Para que el disparador pueda ocupar la fila entera en móvil, como los botones. */
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Calcula la posición del panel a partir del rectángulo del disparador.
  //
  // Se mide el panel YA montado (por eso `useLayoutEffect` y no `useEffect`: el
  // reposicionamiento ocurre antes de que el navegador pinte, así no se ve
  // saltar). Si abajo no cabe pero arriba sí, se abre hacia arriba — sin esto un
  // disparador al pie de la pantalla, como el bloque de usuario del sidebar,
  // desplegaba su menú fuera de la ventana.
  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const el = triggerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const margin = 8;
      let left = align === "right" ? r.right - width : r.left;
      left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));

      const alto = panelRef.current?.offsetHeight ?? 0;
      const espacioAbajo = window.innerHeight - r.bottom - margin;
      const haciaArriba = alto > 0 && espacioAbajo < alto && r.top - margin > espacioAbajo;
      let top = haciaArriba ? r.top - alto - margin : r.bottom + margin;
      if (alto > 0) top = Math.max(margin, Math.min(top, window.innerHeight - alto - margin));
      setPos({ top, left });
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
    // En CAPTURA: dentro de un `Modal` el panel corta el `mousedown` y en fase de
    // burbuja nunca llegaría a `document` — el desplegable no se cerraría al pulsar
    // fuera de él.
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center ${triggerClassName}`}
      >
        {trigger}
      </button>

      {/* El panel se monta ANTES de conocer su posición (invisible) porque hay
          que medir su altura para decidir si abre hacia abajo o hacia arriba. */}
      {open && typeof document !== "undefined" &&
        createPortal(
          <div
            ref={panelRef}
            className="fixed z-[100] max-h-[70vh] overflow-y-auto rounded-xl border border-border-subtle bg-surface p-1.5 shadow-xl shadow-black/5"
            style={{
              top: pos?.top ?? 0,
              left: pos?.left ?? 0,
              width,
              maxWidth: "calc(100vw - 24px)",
              visibility: pos ? "visible" : "hidden",
            }}
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

/**
 * Fila de menú estándar usada dentro de un Dropdown.
 *
 * Con `href` se pinta como enlace de verdad (WhatsApp, teléfono, mapas): así se
 * puede abrir en otra pestaña o copiar la dirección, cosa que un botón con
 * `window.open` no permite. `disabled` es para la opción que existe pero hoy no se
 * puede usar —el cliente sin celular no tiene WhatsApp—: se enseña apagada en vez
 * de desaparecer, para que nadie la busque creyendo que se perdió.
 */
export function MenuItem({
  children,
  onClick,
  href,
  title,
  disabled = false,
  danger = false,
}: {
  children: ReactNode;
  onClick?: () => void;
  href?: string | null;
  title?: string;
  disabled?: boolean;
  danger?: boolean;
}) {
  const base = "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] font-medium transition-colors";
  const cls = disabled
    ? `${base} cursor-not-allowed text-text-tertiary opacity-60`
    : danger
      ? `${base} text-error-text hover:bg-error-soft`
      : `${base} text-text-secondary hover:bg-surface-2`;

  if (href && !disabled) {
    return (
      <a
        href={href}
        title={title}
        target={href.startsWith("http") ? "_blank" : undefined}
        rel="noreferrer"
        onClick={onClick}
        className={cls}
      >
        {children}
      </a>
    );
  }
  return (
    <button type="button" title={title} disabled={disabled} onClick={disabled ? undefined : onClick} className={cls}>
      {children}
    </button>
  );
}
