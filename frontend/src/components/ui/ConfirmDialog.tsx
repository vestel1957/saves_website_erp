"use client";

import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/Icon";

/**
 * Diálogo de confirmación reutilizable (reemplaza a window.confirm).
 * Controlado por `open`; llama a `onConfirm` al aceptar y `onClose` al cancelar.
 */
export function ConfirmDialog({
  open,
  title = "Confirmar acción",
  message,
  confirmLabel = "Confirmar",
  cancelLabel = "Cancelar",
  tone = "danger",
  icon,
  busy = false,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title?: string;
  message: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "danger" | "primary";
  icon?: string;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const danger = tone === "danger";
  return (
    <Modal open={open} onClose={onClose} title={title} maxWidth="max-w-md">
      <div className="flex gap-3">
        <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${danger ? "bg-error-soft text-error-text" : "bg-brand-soft text-brand"}`}>
          <Icon name={icon ?? (danger ? "alert-triangle" : "alert-circle")} size={20} />
        </span>
        {/* min-w-0: sin esto el item flex no baja de su ancho de contenido y un
            mensaje con texto largo sin espacios desborda el modal en vez de cortarse. */}
        <div className="min-w-0 flex-1 text-[13px] text-text-secondary">{message}</div>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={busy}>{cancelLabel}</Button>
        <Button variant={danger ? "danger" : "primary"} onClick={onConfirm} disabled={busy}>
          {busy && <Icon name="loader" size={15} className="animate-spin" />}
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
