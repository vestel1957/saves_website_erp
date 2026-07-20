"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui/Button";
import { Input, Select, Textarea, Field } from "@/components/ui/Field";
import { Icon } from "@/components/Icon";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { INVOICE_KIND_LABEL, INVOICE_RON_LABEL } from "@/lib/subscribers";
import { mensajeDeError } from "@/lib/errores";

const dateInput = (d?: string | null) => (d ? new Date(d).toISOString().slice(0, 10) : "");

export function EditarFacturaModal({
  subscriberId, invoice, open, onClose, onDone,
}: {
  subscriberId: string;
  invoice: any | null;
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const { authFetch } = useAuth();
  const [invoiceDate, setInvoiceDate] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [kind, setKind] = useState("RECURRENTE");
  const [ron, setRon] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !invoice) return;
    setInvoiceDate(dateInput(invoice.date));
    setDueDate(dateInput(invoice.dueDate));
    setKind(invoice.kind ?? "RECURRENTE");
    setRon(invoice.ron ?? "");
    setNotes(invoice.notes ?? "");
  }, [open, invoice]);

  async function submit() {
    if (!invoice) return;
    setSaving(true);
    try {
      const res = await authFetch(`/subscribers/${subscriberId}/invoices/${invoice.id}`, {
        method: "PATCH",
        body: JSON.stringify({ invoiceDate, dueDate, kind, ron: ron || undefined, notes }),
      });
      if (!res.ok) {
        const m = await res.json().catch(() => null);
        throw new Error(Array.isArray(m?.message) ? m.message[0] : m?.message ?? "No se pudo guardar");
      }
      toast(`Factura #${invoice.tid} actualizada`);
      onDone();
      onClose();
    } catch (e) {
      toast(mensajeDeError(e) ?? "Error al guardar", "alert-circle");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={invoice ? `Editar factura #${invoice.tid}` : "Editar factura"} maxWidth="max-w-lg">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Fecha de factura">
          <Input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
        </Field>
        <Field label="Fecha de vencimiento">
          <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </Field>
        <Field label="Tipo de factura">
          <Select value={kind} onChange={(e) => setKind(e.target.value)}>
            {Object.entries(INVOICE_KIND_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </Select>
        </Field>
        <Field label="Estado del cliente">
          <Select value={ron} onChange={(e) => setRon(e.target.value)}>
            <option value="">— Sin estado —</option>
            {Object.entries(INVOICE_RON_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </Select>
        </Field>
      </div>
      <Field label="Notas">
        <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Opcional" />
      </Field>

      <p className="rounded-lg bg-surface-2 px-3 py-2 text-[11px] text-text-tertiary">
        Se editan solo los datos de cabecera. Los montos e ítems no se modifican aquí.
      </p>

      <div className="mt-1 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose} disabled={saving}>Cancelar</Button>
        <Button onClick={submit} disabled={saving}>
          <Icon name={saving ? "loader" : "check"} size={15} className={saving ? "animate-spin" : ""} />
          {saving ? "Guardando…" : "Guardar cambios"}
        </Button>
      </div>
    </Modal>
  );
}
