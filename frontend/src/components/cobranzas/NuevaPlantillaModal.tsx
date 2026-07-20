"use client";

import { useMemo, useState } from "react";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui/Button";
import { Input, Select, Field } from "@/components/ui/Field";
import { Icon } from "@/components/Icon";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { SubscriberPicker, type PickedSub } from "@/components/cobranzas/SubscriberPicker";
import { cop } from "@/lib/subscribers";
import { mensajeDeError } from "@/lib/errores";

type Item = { description: string; qty: number; price: number; taxRate: number };
const emptyItem = (): Item => ({ description: "", qty: 1, price: 0, taxRate: 0 });

const PERIODS = ["1 month", "2 months", "3 months", "6 months", "1 year", "15 days", "1 day"];

export function NuevaPlantillaModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const { authFetch } = useAuth();
  const [sub, setSub] = useState<PickedSub | null>(null);
  const [rec, setRec] = useState("1 month");
  const [items, setItems] = useState<Item[]>([emptyItem()]);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const total = useMemo(() => Math.round(items.reduce((s, it) => {
    const sub2 = (Number(it.qty) || 0) * (Number(it.price) || 0);
    return s + sub2 + (sub2 * (Number(it.taxRate) || 0)) / 100;
  }, 0)), [items]);

  function setItem(i: number, patch: Partial<Item>) {
    setItems((prev) => prev.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));
  }

  async function submit() {
    setErr(null);
    if (!sub) { setErr("Selecciona un cliente."); return; }
    const clean = items.filter((it) => it.description.trim());
    if (!clean.length) { setErr("Agrega al menos un ítem."); return; }
    setSaving(true);
    try {
      const res = await authFetch(`/billing/recurring`, {
        method: "POST",
        body: JSON.stringify({ subscriberId: sub.id, rec, notes: notes || undefined, items: clean }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "No se pudo crear la plantilla");
      toast(`Plantilla #${d.tid} creada · ${cop(d.total)}`);
      setSub(null); setItems([emptyItem()]); setNotes("");
      onDone(); onClose();
    } catch (e) { setErr(mensajeDeError(e)); } finally { setSaving(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title="Nueva plantilla recurrente" maxWidth="max-w-2xl">
      <div className="flex flex-col gap-3">
        <Field label="Cliente" required><SubscriberPicker value={sub} onChange={setSub} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Periodicidad">
            <Select value={rec} onChange={(e) => setRec(e.target.value)}>{PERIODS.map((p) => <option key={p} value={p}>{p}</option>)}</Select>
          </Field>
          <Field label="Nota"><Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Opcional" /></Field>
        </div>

        <div>
          <div className="mb-1 text-[11px] font-semibold text-text-tertiary">Ítems</div>
          <div className="flex flex-col gap-2">
            {items.map((it, i) => (
              <div key={i} className="grid grid-cols-2 gap-2 sm:grid-cols-[1fr_60px_100px_60px_32px]">
                <Input className="col-span-2 sm:col-span-1" placeholder="Descripción" value={it.description} onChange={(e) => setItem(i, { description: e.target.value })} />
                <Input type="number" min={0} className="text-right" value={it.qty} onChange={(e) => setItem(i, { qty: Number(e.target.value) })} title="Cantidad" />
                <Input type="number" min={0} className="text-right" value={it.price} onChange={(e) => setItem(i, { price: Number(e.target.value) })} title="Precio" />
                <Input type="number" min={0} className="text-right" value={it.taxRate} onChange={(e) => setItem(i, { taxRate: Number(e.target.value) })} title="IVA %" />
                <button type="button" onClick={() => setItems((p) => p.filter((_, idx) => idx !== i))} disabled={items.length === 1}
                  className="flex items-center justify-center text-text-tertiary hover:text-error-text disabled:opacity-30"><Icon name="x" size={16} /></button>
              </div>
            ))}
          </div>
          <button type="button" onClick={() => setItems((p) => [...p, emptyItem()])} className="mt-2 inline-flex items-center gap-1 text-[12px] font-semibold text-brand hover:underline">
            <Icon name="plus" size={14} /> Agregar ítem
          </button>
        </div>

        <div className="flex items-center justify-between border-t border-border-subtle pt-2 text-[14px]">
          <span className="font-bold text-text-primary">Total recurrente</span>
          <span className="font-bold text-brand">{cop(total)}</span>
        </div>
        {err && <p className="text-[12px] text-error-text">{err}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancelar</Button>
          <Button onClick={submit} disabled={saving || !sub}>{saving ? "Creando…" : "Crear plantilla"}</Button>
        </div>
      </div>
    </Modal>
  );
}
