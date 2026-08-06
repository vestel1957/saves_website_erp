"use client";

import { useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/Modal";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Input, Select, Field } from "@/components/ui/Field";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { ConceptoPicker } from "@/components/billing/ConceptoPicker";
import { cop } from "@/lib/subscribers";
import { mensajeDeError } from "@/lib/errores";

type Item = { productName?: string; productId?: number; description: string; qty: number; price: number; taxRate: number };
type Kind = "FIJA" | "RECURRENTE";

const KINDS: { value: Kind; label: string }[] = [
  { value: "FIJA", label: "Fija" },
  { value: "RECURRENTE", label: "Recurrente" },
];

const emptyItem = (): Item => ({ description: "", qty: 1, price: 0, taxRate: 0 });
const fecha = (d: string | Date) => new Date(d).toISOString().slice(0, 10);

/**
 * Edición de una factura ya emitida: cambiar el valor de un concepto, corregir la
 * cantidad, agregar conceptos nuevos o quitar los que sobran.
 *
 * Es el equivalente del "Editar factura" del legacy (`invoices/edit`), con dos
 * diferencias que se ven en pantalla:
 *
 *   · Las notas crédito/débito de la factura NO entran al editor. Son documentos
 *     aparte (una promoción aplicada, una retención) y siguen contando en el total;
 *     se listan aparte para que el que edita sepa por qué el total no da la suma
 *     de los conceptos.
 *   · A diferencia de crear —donde el precio lo pone el catálogo—, aquí el precio
 *     SÍ se digita: corregir el valor cobrado es justo para lo que se edita una
 *     factura. Elegir del catálogo sigue trayendo precio e IVA de una vez.
 */
export function EditarFacturaModal({
  open,
  onClose,
  onDone,
  factura,
}: {
  open: boolean;
  onClose: () => void;
  /** Se llama tras guardar para recargar el detalle. */
  onDone?: () => void;
  /** Factura tal como la devuelve GET /billing/invoices/:id. */
  factura: any;
}) {
  const { authFetch } = useAuth();
  const conceptos: any[] = (factura.items ?? []).filter((it: any) => !it.nota);
  const notas: any[] = (factura.items ?? []).filter((it: any) => it.nota);

  const [items, setItems] = useState<Item[]>([]);
  const [invoiceDate, setInvoiceDate] = useState(fecha(factura.date));
  const [dueDate, setDueDate] = useState(fecha(factura.dueDate));
  const [kind, setKind] = useState<Kind>(factura.kind === "FIJA" ? "FIJA" : "RECURRENTE");
  const [notes, setNotes] = useState(factura.notes ?? "");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Cada apertura arranca de los datos vigentes de la factura (puede haberse
  // recargado por detrás: un pago, una promoción aplicada).
  useEffect(() => {
    if (!open) return;
    setItems(
      conceptos.length
        ? conceptos.map((it) => ({
            productName: it.product ?? undefined,
            productId: it.productId || undefined,
            description: it.description || it.product || "",
            qty: it.qty || 1,
            price: it.price,
            taxRate: it.taxRate,
          }))
        : [emptyItem()],
    );
    setInvoiceDate(fecha(factura.date));
    setDueDate(fecha(factura.dueDate));
    setKind(factura.kind === "FIJA" ? "FIJA" : "RECURRENTE");
    setNotes(factura.notes ?? "");
    setReason("");
    setErr(null);
    setSaving(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, factura]);

  const notasSubtotal = useMemo(() => notas.reduce((s, it) => s + (it.subtotal ?? 0), 0), [factura]);

  const totals = useMemo(() => {
    let base = 0, tax = 0;
    for (const it of items) {
      const s = (Number(it.qty) || 0) * (Number(it.price) || 0);
      base += s; tax += (s * (Number(it.taxRate) || 0)) / 100;
    }
    const subtotal = Math.max(0, Math.round(base + notasSubtotal));
    return { conceptos: Math.round(base), subtotal, tax: Math.round(tax), total: Math.max(0, Math.round(subtotal + tax)) };
  }, [items, notasSubtotal]);

  const pagado = factura.paid ?? 0;
  const bajoLoPagado = totals.total < pagado;
  const diferencia = totals.total - (factura.total ?? 0);

  function setItem(i: number, patch: Partial<Item>) {
    setItems((prev) => prev.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));
  }

  async function submit() {
    setErr(null);
    const clean = items.filter((it) => it.description.trim());
    if (!clean.length) { setErr("La factura tiene que quedar con al menos un concepto."); return; }
    if (reason.trim().length < 3) { setErr("Escribe el motivo del cambio: queda en la auditoría de la factura."); return; }
    if (bajoLoPagado) { setErr(`La factura ya tiene ${cop(pagado)} pagados y no puede quedar por debajo de esa cifra.`); return; }
    setSaving(true);
    try {
      const res = await authFetch(`/billing/invoices/${factura.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          invoiceDate, dueDate, kind, notes, reason: reason.trim(),
          items: clean.map((it) => ({
            productName: it.productName ?? it.description,
            productId: it.productId,
            description: it.description,
            qty: Number(it.qty) || 0,
            price: Number(it.price) || 0,
            taxRate: Number(it.taxRate) || 0,
          })),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message || "No se pudo guardar la factura");
      toast(`Factura #${data.tid} actualizada · nuevo total ${cop(data.total)}`, "check");
      onDone?.();
      onClose();
    } catch (e) {
      setErr(mensajeDeError(e));
      setSaving(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={`Editar factura #${factura.tid}`} maxWidth="max-w-5xl">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-4 lg:col-span-2">
          {/* Conceptos */}
          <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
            <div className="mb-2 text-[13px] font-bold text-text-primary">Conceptos</div>
            <p className="mb-2 text-[11px] text-text-tertiary">
              Elige del catálogo para traer precio e IVA, o ajusta el valor a mano.
            </p>
            <div className="flex flex-col gap-2">
              <div className="hidden grid-cols-[1fr_70px_120px_70px_110px_32px] gap-2 px-1 text-[11px] font-semibold text-text-tertiary sm:grid">
                <span>Concepto</span><span className="text-right">Cant.</span><span className="text-right">Precio</span><span className="text-right">IVA %</span><span className="text-right">Subtotal</span><span />
              </div>
              {items.map((it, i) => {
                const sub = (Number(it.qty) || 0) * (Number(it.price) || 0);
                return (
                  <div key={i} className="grid grid-cols-2 gap-2 sm:grid-cols-[1fr_70px_120px_70px_110px_32px]">
                    <ConceptoPicker
                      className="col-span-2 sm:col-span-1"
                      value={it.description}
                      onPick={(p) => setItem(i, { description: p.name, productName: p.name, productId: p.productId, price: p.price, taxRate: p.taxRate })}
                      // Texto libre: sólo cambia la descripción. El precio que ya tenía
                      // la línea se respeta — al editar, lo normal es corregir el valor
                      // de un concepto que ya está, no volver a elegirlo.
                      onText={(t) => setItem(i, { description: t, productName: t })}
                    />
                    <Input type="number" min={0} className="text-right" value={it.qty}
                      onChange={(e) => setItem(i, { qty: Number(e.target.value) })} />
                    <Input type="number" min={0} step={1} className="text-right" value={it.price}
                      onChange={(e) => setItem(i, { price: Number(e.target.value) })} />
                    <Input type="number" min={0} max={100} step={1} className="text-right" value={it.taxRate}
                      onChange={(e) => setItem(i, { taxRate: Number(e.target.value) })} />
                    <div className="flex items-center justify-end text-[12px] font-medium text-text-secondary">{cop(sub)}</div>
                    <button type="button" onClick={() => setItems((p) => p.filter((_, idx) => idx !== i))} disabled={items.length === 1}
                      className="flex items-center justify-center rounded-md text-text-tertiary hover:text-error-text disabled:opacity-30">
                      <Icon name="x" size={16} />
                    </button>
                  </div>
                );
              })}
            </div>
            <button type="button" onClick={() => setItems((p) => [...p, emptyItem()])}
              className="mt-3 inline-flex items-center gap-1 text-[12px] font-semibold text-brand hover:underline">
              <Icon name="plus" size={14} /> Agregar concepto
            </button>
          </div>

          {/* Notas de la factura: no se editan, pero cuentan en el total */}
          {notas.length > 0 && (
            <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
              <div className="mb-1 text-[13px] font-bold text-text-primary">Notas de esta factura</div>
              <p className="mb-2 text-[11px] text-text-tertiary">
                No se tocan al editar (una nota es un documento aparte), pero siguen sumando al total.
                Para deshacerlas se emite la nota contraria.
              </p>
              <div className="flex flex-col gap-1">
                {notas.map((n) => (
                  <div key={n.id} className="flex items-center justify-between gap-3 rounded-lg bg-surface-2 px-3 py-1.5 text-[12px]">
                    <span className="truncate text-text-secondary">{n.product}{n.description && n.description !== n.product ? ` · ${n.description}` : ""}</span>
                    <span className={`font-mono font-semibold ${n.subtotal < 0 ? "text-success-text" : "text-text-primary"}`}>{cop(n.subtotal)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Datos y resumen */}
        <div className="flex flex-col gap-4">
          <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
            <div className="mb-2 text-[13px] font-bold text-text-primary">Datos</div>
            <div className="flex flex-col gap-2">
              <Field label="Tipo de factura">
                <Select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
                  {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
                </Select>
              </Field>
              <Field label="Fecha factura">
                <Input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
              </Field>
              <Field label="Vencimiento">
                <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
              </Field>
              <Field label="Nota de la factura">
                <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Opcional" />
              </Field>
              <Field label="Motivo del cambio" hint="Queda registrado en la auditoría junto con el antes y el después">
                <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ej: se cobró el plan que no era" />
              </Field>
            </div>
          </div>

          <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
            <div className="flex flex-col gap-1.5 text-[13px]">
              <div className="flex justify-between"><span className="text-text-tertiary">Conceptos</span><span className="font-medium">{cop(totals.conceptos)}</span></div>
              {notas.length > 0 && (
                <div className="flex justify-between"><span className="text-text-tertiary">Notas</span><span className="font-medium">{cop(notasSubtotal)}</span></div>
              )}
              <div className="flex justify-between"><span className="text-text-tertiary">Subtotal</span><span className="font-medium">{cop(totals.subtotal)}</span></div>
              <div className="flex justify-between"><span className="text-text-tertiary">IVA</span><span className="font-medium">{cop(totals.tax)}</span></div>
              <div className="mt-1 flex justify-between border-t border-border-subtle pt-2 text-[15px]">
                <span className="font-bold text-text-primary">Total</span>
                <span className="font-bold text-brand">{cop(totals.total)}</span>
              </div>
              <div className="flex justify-between text-[11px] text-text-tertiary">
                <span>Antes {cop(factura.total ?? 0)}</span>
                {diferencia !== 0 && (
                  <span className={diferencia > 0 ? "text-warning-text" : "text-success-text"}>
                    {diferencia > 0 ? "+" : "−"}{cop(Math.abs(diferencia))}
                  </span>
                )}
              </div>
              {pagado > 0 && (
                <div className="flex justify-between text-[11px] text-text-tertiary"><span>Pagado</span><span>{cop(pagado)}</span></div>
              )}
            </div>
          </div>

          {bajoLoPagado && (
            <div className="rounded-lg border border-error-subtle bg-error-soft px-3 py-2 text-[12px] text-error-text">
              El total queda por debajo de los {cop(pagado)} ya pagados. Anule el pago o emita una nota crédito.
            </div>
          )}
          {factura.fromLegacy && (
            <div className="rounded-lg border border-warning-border bg-warning-soft px-3 py-2 text-[12px] text-text-secondary">
              Esta factura vino del sistema anterior. El cambio queda en <b>este</b> sistema: mientras el
              anterior siga activo, allá se seguirá viendo el valor viejo.
            </div>
          )}
          {err && <p className="text-[12px] text-error-text">{err}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>Cancelar</Button>
            <Button onClick={submit} disabled={saving || bajoLoPagado}>{saving ? "Guardando…" : "Guardar cambios"}</Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
