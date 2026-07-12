"use client";

import { useEffect } from "react";
import { Icon } from "@/components/Icon";

/**
 * Modal centrado y reutilizable para formularios de creación.
 * Se cierra con la tecla Escape, click en el fondo o el botón ✕.
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
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[90] flex items-start justify-center overflow-y-auto bg-black/40 p-4 backdrop-blur-sm sm:items-center"
      onMouseDown={onClose}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className={`my-auto flex max-h-[calc(100vh-2rem)] w-full ${maxWidth} flex-col gap-3 overflow-y-auto rounded-xl border border-border-subtle bg-surface p-4 shadow-2xl sm:p-5`}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="min-w-0 truncate text-[14px] font-bold text-text-primary">{title}</span>
          <button
            type="button"
            onClick={onClose}
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
