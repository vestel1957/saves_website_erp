"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Select, Textarea } from "@/components/ui/Field";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { SUB_STATUS_LABEL, SUB_STATUS_TONE } from "@/lib/subscribers";
import { fmtDate } from "@/lib/format";

/** Orden de las opciones: los estados de operación diaria primero. */
const STATUS_ORDER = [
  "ACTIVO", "SUSPENDIDO", "INACTIVO", "CORTADO", "CARTERA", "COMPROMISO",
  "INSTALAR", "EXONERADO", "REPORTADO", "EVENTO", "POR_RETIRAR", "RETIRADO", "DEPURADO",
];

/**
 * Cambio manual del estado del abonado (Activo, Suspendido, Inactivo, ...).
 * Es administrativo: NO corta ni reconecta en el router — para eso está el
 * modal de Conexión. El cambio queda en el historial de estados con la nota.
 */
export function CambiarEstadoModal({
  subscriberId,
  current,
  motivoActual,
  open,
  onClose,
  onDone,
}: {
  subscriberId: string;
  current?: string | null;
  /** Por qué está en el estado en que está (lo escribió quien lo cambió la última vez). */
  motivoActual?: { reason: string; author?: string | null; date?: string | null } | null;
  open: boolean;
  onClose: () => void;
  onDone?: () => void;
}) {
  const { authFetch } = useAuth();
  const [status, setStatus] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setStatus("");
    setNote("");
  }, [open]);

  async function apply() {
    if (!status || status === current) return;
    setBusy(true);
    try {
      const res = await authFetch(`/subscribers/${subscriberId}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status, note: note.trim() || undefined }),
      });
      if (!res.ok) {
        const msg = await res.json().catch(() => null);
        throw new Error(msg?.message || "No se pudo cambiar el estado");
      }
      toast(`Estado cambiado a ${SUB_STATUS_LABEL[status] ?? status}`, "check");
      onDone?.();
      onClose();
    } catch (e) {
      toast((e as Error).message, "alert-circle");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Cambiar estado del cliente">
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2 text-[12px] text-text-tertiary">
          Estado actual:
          <Badge label={SUB_STATUS_LABEL[current ?? ""] ?? current ?? "Sin estado"} tone={SUB_STATUS_TONE[current ?? ""] ?? "default"} />
        </div>

        {/* El motivo del cambio ANTERIOR, aquí mismo: es donde se escribió y es
            donde se vuelve a buscar. Sin esto el campo de abajo parecía tragarse
            lo que se escribía. */}
        {motivoActual?.reason && (
          <div className="rounded-lg border border-border-subtle bg-surface-2 p-2.5">
            <div className="text-[11px] uppercase tracking-wide text-text-tertiary">Motivo del último cambio</div>
            <p className="text-[12.5px] leading-snug text-text-primary">{motivoActual.reason}</p>
            {(motivoActual.author || motivoActual.date) && (
              <p className="mt-0.5 text-[11px] text-text-tertiary">
                {[motivoActual.author, motivoActual.date ? fmtDate(motivoActual.date) : null].filter(Boolean).join(" · ")}
              </p>
            )}
          </div>
        )}

        <Select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">— Elegir nuevo estado —</option>
          {STATUS_ORDER.filter((s) => s !== current).map((s) => (
            <option key={s} value={s}>{SUB_STATUS_LABEL[s] ?? s}</option>
          ))}
        </Select>

        <Textarea
          rows={2}
          placeholder="Motivo del cambio (queda junto al estado, en el historial y en las observaciones)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />

        <p className="text-[11px] text-text-tertiary">
          Este cambio es administrativo y queda registrado —con su motivo— en el historial
          de estados y en las observaciones del cliente.
          No corta ni reconecta el servicio en el router — para eso usa la acción de Conexión.
        </p>

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button onClick={apply} disabled={!status || busy}>
            {busy ? "Aplicando…" : "Cambiar estado"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
