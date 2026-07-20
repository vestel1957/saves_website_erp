"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui/Button";
import { Input, Select, Field } from "@/components/ui/Field";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { cop } from "@/lib/subscribers";
import { mensajeDeError } from "@/lib/errores";

/**
 * Aplica una nota crédito (rebaja) o débito (recargo) sobre una factura.
 * Se abre desde el botón "Nueva nota" del listado de notas.
 */
export function NuevaNotaModal({
  open,
  onClose,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  /** Se llama tras aplicar con éxito para refrescar el listado. */
  onDone?: () => void;
}) {
  const { authFetch } = useAuth();
  const [tid, setTid] = useState("");
  const [type, setType] = useState<"CREDITO" | "DEBITO">("CREDITO");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [retentionType, setRetentionType] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Reset al cerrar para que la próxima apertura arranque limpia.
  useEffect(() => {
    if (open) return;
    setTid(""); setType("CREDITO"); setAmount(""); setDescription(""); setRetentionType(""); setErr(null); setSaving(false);
  }, [open]);

  async function submit() {
    setErr(null);
    const n = Number(tid);
    if (!Number.isFinite(n) || n <= 0) { setErr("Ingresa el número de factura."); return; }
    if ((Number(amount) || 0) <= 0) { setErr("Ingresa un monto válido."); return; }
    setSaving(true);
    try {
      // Resolver la factura por su número (tid).
      const rf = await authFetch(`/billing/invoices?search=${n}&pageSize=1`);
      const df = await rf.json();
      const inv = df.items?.find((x: any) => x.tid === n) ?? df.items?.[0];
      if (!inv) throw new Error(`No existe la factura #${n}`);
      const res = await authFetch(`/billing/invoices/${inv.id}/notes`, {
        method: "POST",
        body: JSON.stringify({
          type, amount: Number(amount), description: description || undefined,
          retentionType: retentionType || undefined,
        }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "No se pudo crear la nota");
      toast(`Nota ${type === "CREDITO" ? "crédito" : "débito"} aplicada · nuevo total ${cop(d.newTotal)}`);
      onClose();
      onDone?.();
    } catch (e) { setErr(mensajeDeError(e)); } finally { setSaving(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title="Aplicar nota crédito / débito">
      <div className="flex flex-col gap-2.5">
        <Field label="N° de factura" required>
          <Input type="number" min={1} value={tid} onChange={(e) => setTid(e.target.value)} placeholder="Ej: 454434" />
        </Field>
        <Field label="Tipo" required>
          <Select value={type} onChange={(e) => setType(e.target.value as any)}>
            <option value="CREDITO">Nota crédito (rebaja)</option>
            <option value="DEBITO">Nota débito (recargo)</option>
          </Select>
        </Field>
        {/* Retención: paridad legacy — se captura aquí (no al facturar) y el valor lo
            digita el usuario en "Monto"; el sistema no lo calcula. */}
        <Field label="¿Tiene retención? ¿Qué tipo?">
          <Select value={retentionType} onChange={(e) => setRetentionType(e.target.value)}>
            <option value="">- Seleccionar -</option>
            <option value="Retefuente Servicios">Retefuente Servicios</option>
            <option value="Compras">Compras</option>
            <option value="Personas no declarantes">Personas no declarantes</option>
            <option value="Reteiva">Reteiva</option>
          </Select>
        </Field>
        <Field label="Monto" required>
          <Input type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" />
        </Field>
        <Field label="Descripción">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Motivo" />
        </Field>
        {err && <p className="text-[12px] text-error-text">{err}</p>}
        <div className="mt-1 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancelar</Button>
          <Button onClick={submit} disabled={saving}>{saving ? "Aplicando…" : "Aplicar nota"}</Button>
        </div>
      </div>
    </Modal>
  );
}
