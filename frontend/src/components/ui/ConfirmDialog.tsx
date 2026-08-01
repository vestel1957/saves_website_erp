"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { Icon } from "@/components/Icon";

/**
 * Diálogo de confirmación reutilizable (reemplaza a window.confirm).
 * Controlado por `open`; llama a `onConfirm` al aceptar y `onClose` al cancelar.
 *
 * Para acciones que tocan producción de verdad, `requireText` obliga a teclear
 * un texto exacto (normalmente el serial o el nombre del recurso). Pulsar
 * "Aceptar" por inercia es justo como se borra lo que no se quería borrar.
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
  requireText,
  requireHint,
  detail,
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
  /** Si se indica, hay que teclearlo exactamente para habilitar el botón. */
  requireText?: string;
  /** Texto sobre el campo de confirmación. */
  requireHint?: React.ReactNode;
  /** Bloque secundario (comandos, consecuencias) bajo el mensaje principal. */
  detail?: React.ReactNode;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const danger = tone === "danger";
  const [tecleado, setTecleado] = useState("");

  // Limpiar al abrir: si no, se arrastra lo escrito en la confirmación anterior
  // y el botón aparecería ya habilitado para OTRO recurso.
  useEffect(() => { if (open) setTecleado(""); }, [open]);

  const bloqueado = !!requireText && tecleado.trim() !== requireText.trim();

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

      {detail && <div className="mt-3">{detail}</div>}

      {requireText && (
        <label className="mt-4 block text-[12px] text-text-secondary">
          {requireHint ?? <>Escriba <span className="font-mono font-semibold text-text-primary">{requireText}</span> para confirmar</>}
          <Input
            autoFocus
            value={tecleado}
            onChange={(e) => setTecleado(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !bloqueado && !busy) onConfirm(); }}
            placeholder={requireText}
            className="mt-1 font-mono"
          />
        </label>
      )}

      {/* En móvil los botones se apilan a ancho completo (acción principal
          arriba, cancelar abajo, como una hoja de acciones nativa); desde `sm`
          vuelven a la fila alineada a la derecha. */}
      <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="ghost" onClick={onClose} disabled={busy} className="w-full sm:w-auto">
          {cancelLabel}
        </Button>
        <Button
          variant={danger ? "danger" : "primary"}
          onClick={onConfirm}
          disabled={busy || bloqueado}
          className="w-full sm:w-auto"
        >
          {busy && <Icon name="loader" size={15} className="animate-spin" />}
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
