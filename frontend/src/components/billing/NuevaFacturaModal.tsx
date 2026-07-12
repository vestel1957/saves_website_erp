"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/Modal";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Input, Field } from "@/components/ui/Field";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { SubscriberPicker, type PickedSub } from "@/components/cobranzas/SubscriberPicker";
import { cop } from "@/lib/subscribers";

type Item = { productName?: string; description: string; qty: number; price: number; taxRate: number };
const today = () => new Date().toISOString().slice(0, 10);
const emptyItem = (): Item => ({ description: "", qty: 1, price: 0, taxRate: 0 });

/**
 * Creación manual de una factura (o clonando la última del cliente). Reemplaza
 * la antigua vista `/facturacion/nueva`: se abre como modal desde el botón
 * "Nueva factura" de Administrar facturas.
 */
export function NuevaFacturaModal({
  open,
  onClose,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  /** Se llama tras crear con éxito para refrescar el listado. */
  onDone?: () => void;
}) {
  const { authFetch } = useAuth();
  const router = useRouter();
  const [sub, setSub] = useState<PickedSub | null>(null);
  const [items, setItems] = useState<Item[]>([emptyItem()]);
  const [invoiceDate, setInvoiceDate] = useState(today());
  const [dueDate, setDueDate] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Reset al cerrar para que la próxima apertura arranque limpia.
  useEffect(() => {
    if (open) return;
    setSub(null);
    setItems([emptyItem()]);
    setInvoiceDate(today());
    setDueDate("");
    setNotes("");
    setSaving(false);
    setErr(null);
  }, [open]);

  const totals = useMemo(() => {
    let subtotal = 0, tax = 0;
    for (const it of items) {
      const s = (Number(it.qty) || 0) * (Number(it.price) || 0);
      subtotal += s; tax += (s * (Number(it.taxRate) || 0)) / 100;
    }
    return { subtotal: Math.round(subtotal), tax: Math.round(tax), total: Math.round(subtotal + tax) };
  }, [items]);

  function setItem(i: number, patch: Partial<Item>) {
    setItems((prev) => prev.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));
  }

  async function cloneLast() {
    if (!sub) return;
    const r = await authFetch(`/billing/subscribers/${sub.id}/last-invoice`);
    const d = await r.json();
    if (!d.found || !d.items.length) { toast("El cliente no tiene factura previa para clonar", "info"); return; }
    setItems(d.items.map((x: any) => ({ productName: x.productName, description: x.description, qty: x.qty, price: x.price, taxRate: x.taxRate })));
    toast("Ítems clonados de la última factura");
  }

  async function submit() {
    setErr(null);
    if (!sub) { setErr("Selecciona un cliente."); return; }
    const clean = items.filter((it) => it.description.trim() && Number(it.price) >= 0);
    if (!clean.length) { setErr("Agrega al menos un ítem con descripción."); return; }
    setSaving(true);
    try {
      const res = await authFetch(`/billing/invoices`, {
        method: "POST",
        body: JSON.stringify({ subscriberId: sub.id, invoiceDate, dueDate: dueDate || undefined, notes: notes || undefined, items: clean }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || "No se pudo crear la factura");
      toast(`Factura #${data.tid} creada · ${cop(data.total)}`);
      onDone?.();
      router.push(`/facturacion/${data.id}`);
    } catch (e: any) { setErr(e.message); setSaving(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title="Nueva factura" maxWidth="max-w-4xl">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2 flex flex-col gap-4">
          {/* Cliente */}
          <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[13px] font-bold text-text-primary">Cliente</span>
              {sub && <Button variant="secondary" size="sm" onClick={cloneLast}><Icon name="copy" size={13} /> Clonar última factura</Button>}
            </div>
            <SubscriberPicker value={sub} onChange={setSub} />
          </div>

          {/* Ítems */}
          <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
            <div className="mb-2 text-[13px] font-bold text-text-primary">Ítems</div>
            <div className="flex flex-col gap-2">
              <div className="hidden grid-cols-[1fr_70px_110px_70px_110px_32px] gap-2 px-1 text-[11px] font-semibold text-text-tertiary sm:grid">
                <span>Descripción</span><span className="text-right">Cant.</span><span className="text-right">Precio</span><span className="text-right">IVA%</span><span className="text-right">Subtotal</span><span />
              </div>
              {items.map((it, i) => {
                const sub2 = (Number(it.qty) || 0) * (Number(it.price) || 0);
                return (
                  <div key={i} className="grid grid-cols-2 gap-2 sm:grid-cols-[1fr_70px_110px_70px_110px_32px]">
                    <Input className="col-span-2 sm:col-span-1" placeholder="Descripción / servicio" value={it.description} onChange={(e) => setItem(i, { description: e.target.value })} />
                    <Input type="number" min={0} className="text-right" value={it.qty} onChange={(e) => setItem(i, { qty: Number(e.target.value) })} />
                    <Input type="number" min={0} className="text-right" value={it.price} onChange={(e) => setItem(i, { price: Number(e.target.value) })} />
                    <Input type="number" min={0} className="text-right" value={it.taxRate} onChange={(e) => setItem(i, { taxRate: Number(e.target.value) })} />
                    <div className="flex items-center justify-end text-[12px] font-medium text-text-secondary">{cop(sub2)}</div>
                    <button type="button" onClick={() => setItems((p) => p.filter((_, idx) => idx !== i))} disabled={items.length === 1}
                      className="flex items-center justify-center rounded-md text-text-tertiary hover:text-error-text disabled:opacity-30"><Icon name="x" size={16} /></button>
                  </div>
                );
              })}
            </div>
            <button type="button" onClick={() => setItems((p) => [...p, emptyItem()])} className="mt-3 inline-flex items-center gap-1 text-[12px] font-semibold text-brand hover:underline">
              <Icon name="plus" size={14} /> Agregar ítem
            </button>
          </div>
        </div>

        {/* Resumen */}
        <div className="flex flex-col gap-4">
          <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
            <div className="mb-2 text-[13px] font-bold text-text-primary">Datos</div>
            <div className="flex flex-col gap-2">
              <Field label="Fecha factura"><Input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} /></Field>
              <Field label="Vencimiento" hint="Vacío = +30 días"><Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></Field>
              <Field label="Nota"><Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Opcional" /></Field>
            </div>
          </div>
          <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
            <div className="flex flex-col gap-1.5 text-[13px]">
              <div className="flex justify-between"><span className="text-text-tertiary">Subtotal</span><span className="font-medium">{cop(totals.subtotal)}</span></div>
              <div className="flex justify-between"><span className="text-text-tertiary">IVA</span><span className="font-medium">{cop(totals.tax)}</span></div>
              <div className="mt-1 flex justify-between border-t border-border-subtle pt-2 text-[15px]"><span className="font-bold text-text-primary">Total</span><span className="font-bold text-brand">{cop(totals.total)}</span></div>
            </div>
          </div>
          {err && <p className="text-[12px] text-error-text">{err}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>Cancelar</Button>
            <Button onClick={submit} disabled={saving || !sub}>{saving ? "Creando…" : "Crear factura"}</Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
