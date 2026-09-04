"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/Modal";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Input, Select, Field } from "@/components/ui/Field";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { SubscriberPicker, type PickedSub } from "@/components/cobranzas/SubscriberPicker";
import { ConceptoPicker } from "@/components/billing/ConceptoPicker";
import { cop } from "@/lib/subscribers";
import { mensajeDeError } from "@/lib/errores";

type Item = { productName?: string; productId?: number; description: string; qty: number; price: number; taxRate: number };

/**
 * Tipo de factura: el `tipo_factura` del legacy (select "Factura" de `newinvoice.php`).
 *
 * Allá el select también listaba Nota Crédito y Nota Débito para roleid > 3; aquí no
 * van: una nota cuelga de una factura existente y se emite desde la factura
 * (Facturación ▸ Notas), no se crea suelta.
 */
type Kind = "FIJA" | "RECURRENTE";
const KINDS: { value: Kind; label: string; hint: string }[] = [
  { value: "FIJA", label: "Fija", hint: "Cargo puntual: instalación, reconexión, traslado, venta de equipo." },
  { value: "RECURRENTE", label: "Recurrente", hint: "Mensualidad del servicio: lleva periodo y sale por mes en el recibo de caja." },
];

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
  fixedSub,
}: {
  open: boolean;
  onClose: () => void;
  /** Se llama tras crear con éxito para refrescar el listado. */
  onDone?: () => void;
  /**
   * Cliente ya decidido: se abre desde SU ficha, así que el selector sobra —y peor,
   * dejarlo abierto invita a facturarle al cliente equivocado teniendo el correcto
   * en pantalla. Con esto el modal enseña a quién se le factura y no deja cambiarlo.
   */
  fixedSub?: PickedSub;
}) {
  const { authFetch } = useAuth();
  const router = useRouter();
  const [sub, setSub] = useState<PickedSub | null>(fixedSub ?? null);
  const [items, setItems] = useState<Item[]>([emptyItem()]);
  const [invoiceDate, setInvoiceDate] = useState(today());
  const [kind, setKind] = useState<Kind>("FIJA");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Reset al cerrar para que la próxima apertura arranque limpia.
  useEffect(() => {
    if (open) return;
    setSub(fixedSub ?? null);
    setItems([emptyItem()]);
    setInvoiceDate(today());
    setKind("FIJA");
    setNotes("");
    setSaving(false);
    setErr(null);
  }, [open, fixedSub]);

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
    setItems(d.items.map((x: any) => ({ productName: x.productName, productId: x.productId, description: x.description, qty: x.qty, price: x.price, taxRate: x.taxRate })));
    toast("Ítems clonados de la última factura");
  }

  async function submit() {
    setErr(null);
    if (!sub) { setErr("Selecciona un cliente."); return; }
    const clean = items.filter((it) => it.description.trim());
    if (!clean.length) { setErr("Agrega al menos un ítem con descripción."); return; }
    // El precio y el IVA ya no se escriben: los pone el producto. Una línea escrita a
    // mano se quedaría en $ 0, así que se bloquea aquí en vez de dejar salir una
    // factura en cero que después hay que anular.
    if (clean.some((it) => !it.productId && !(Number(it.price) > 0))) {
      setErr("Elige cada concepto del catálogo: el precio y el IVA los pone el producto.");
      return;
    }
    setSaving(true);
    try {
      const res = await authFetch(`/billing/invoices`, {
        method: "POST",
        body: JSON.stringify({ subscriberId: sub.id, invoiceDate, kind, notes: notes || undefined, items: clean }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || "No se pudo crear la factura");
      toast(`Factura #${data.tid} creada · ${cop(data.total)}`);
      onDone?.();
      router.push(`/facturacion/${data.id}`);
    } catch (e) { setErr(mensajeDeError(e)); setSaving(false); }
  }

  return (
    // max-w-5xl: con 4xl la columna de descripción se queda sin aire y trunca el
    // concepto elegido, que es justo lo que hay que revisar antes de crear.
    <Modal open={open} onClose={onClose} title="Nueva factura" maxWidth="max-w-5xl">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2 flex flex-col gap-4">
          {/* Cliente */}
          <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[13px] font-bold text-text-primary">Cliente</span>
              {sub && <Button variant="secondary" size="sm" onClick={cloneLast}><Icon name="copy" size={13} /> Clonar última factura</Button>}
            </div>
            {fixedSub ? (
              <div className="flex items-center gap-2 rounded-lg border border-border-subtle bg-surface-2/50 px-3 py-2 text-[13px]">
                <Icon name="user" size={14} className="text-text-tertiary" />
                <span className="font-semibold text-text-primary">{fixedSub.name}</span>
                <span className="font-mono text-text-tertiary">#{fixedSub.abonado}</span>
              </div>
            ) : (
              <SubscriberPicker value={sub} onChange={setSub} />
            )}
          </div>

          {/* Ítems */}
          <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
            <div className="mb-2 text-[13px] font-bold text-text-primary">Ítems</div>
            <p className="mb-2 text-[11px] text-text-tertiary">
              El precio y el IVA los pone el producto: elige el concepto del catálogo.
            </p>
            <div className="flex flex-col gap-2">
              <div className="hidden grid-cols-[1fr_70px_110px_60px_110px_32px] gap-2 px-1 text-[11px] font-semibold text-text-tertiary sm:grid">
                <span>Descripción</span><span className="text-right">Cant.</span><span className="text-right">Precio</span><span className="text-right">IVA</span><span className="text-right">Subtotal</span><span />
              </div>
              {items.map((it, i) => {
                const sub2 = (Number(it.qty) || 0) * (Number(it.price) || 0);
                // Sin producto y sin precio la línea no se puede facturar: se marca en
                // el acto, no al pulsar "Crear factura".
                const sinPrecio = !!it.description.trim() && !it.productId && !(Number(it.price) > 0);
                return (
                  <div key={i} className="grid grid-cols-2 gap-2 sm:grid-cols-[1fr_70px_110px_60px_110px_32px]">
                    <ConceptoPicker
                      className="col-span-2 sm:col-span-1"
                      value={it.description}
                      // Elegir del catálogo trae el precio y el IVA vigentes. Escribir a
                      // mano solo sirve para buscar: la línea queda sin producto y sin
                      // precio, porque ese par ya no se digita.
                      onPick={(p) => setItem(i, { description: p.name, productName: p.name, productId: p.productId, price: p.price, taxRate: p.taxRate })}
                      onText={(t) => setItem(i, { description: t, productName: undefined, productId: undefined, price: 0, taxRate: 0 })}
                    />
                    <Input type="number" min={0} className="text-right" value={it.qty} onChange={(e) => setItem(i, { qty: Number(e.target.value) })} />
                    <div className={`flex items-center justify-end text-[12px] ${sinPrecio ? "text-error-text" : "font-medium text-text-secondary"}`}>
                      {sinPrecio ? "Elige del catálogo" : cop(it.price)}
                    </div>
                    <div className="flex items-center justify-end text-[12px] text-text-tertiary">
                      {it.taxRate > 0 ? `${it.taxRate}%` : "—"}
                    </div>
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
              <Field label="Tipo de factura" hint={KINDS.find((k) => k.value === kind)?.hint}>
                <Select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
                  {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
                </Select>
              </Field>
              {/* El vencimiento ya no se elige: lo pone el día de corte configurado
                  (`billing.dueDay`), igual para todas las facturas. */}
              <Field label="Fecha factura" hint="El vencimiento lo pone el día de corte configurado">
                <Input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
              </Field>
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
