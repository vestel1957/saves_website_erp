"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Input, Select, Field } from "@/components/ui/Field";
import { Badge } from "@/components/ui/Badge";
import { Modal } from "@/components/Modal";
import { DataTable } from "@/components/ui/DataTable";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { cop } from "@/lib/subscribers";
import { mensajeDeError } from "@/lib/errores";

function statusTone(status: string): "default" | "success" | "error" | "warning" {
  if (status === "recibido" || status === "finalizado") return "success";
  if (status === "cancelado" || status === "anulado") return "error";
  if (status === "recibido parcial") return "warning";
  return "default";
}

function fmtDate(d?: string) {
  return d ? new Date(d).toLocaleDateString("es-CO") : "—";
}

export default function OrdenDetallePage() {
  const { loading: authLoading, authFetch } = useAuth();
  const params = useParams();
  const id = String(params?.id ?? "");

  const [order, setOrder] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [receive, setReceive] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const [payAmount, setPayAmount] = useState("");
  const [payMethod, setPayMethod] = useState("Cash");
  const [payCash, setPayCash] = useState("");
  const [cashAccounts, setCashAccounts] = useState<{ id: number; name: string }[]>([]);
  const [paying, setPaying] = useState(false);
  // Notas / retenciones
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteType, setNoteType] = useState("Retencion");
  const [noteRetType, setNoteRetType] = useState("Retefuente Servicios");
  const [noteAmount, setNoteAmount] = useState("");
  const [noteDesc, setNoteDesc] = useState("");
  const [notesaving, setNotesaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authFetch(`/orders/${id}`);
      const d = await res.json();
      setOrder(d);
      const init: Record<string, string> = {};
      for (const it of d?.items ?? []) init[it.id] = String(it.received ?? 0);
      setReceive(init);
    } finally { setLoading(false); }
  }, [authFetch, id]);

  useEffect(() => {
    if (authLoading || !id) return;
    void load();
  }, [authLoading, id, load]);

  const canReceive = useMemo(() => order && order.status !== "recibido" && order.status !== "finalizado", [order]);
  const saldo = useMemo(() => order ? Math.max(0, (order.total ?? 0) - (order.paid ?? 0)) : 0, [order]);

  function openPay() {
    setPayAmount(String(saldo || ""));
    setPayOpen(true);
    void authFetch("/treasury/cash-accounts").then((r) => (r.ok ? r.json() : [])).then((a) => { setCashAccounts(a); if (a[0]) setPayCash(String(a[0].id)); }).catch(() => {});
  }

  async function submitPay() {
    const amount = Number(payAmount) || 0;
    if (amount <= 0) { toast("Ingresa un monto mayor a cero", "alert-triangle"); return; }
    setPaying(true);
    try {
      const res = await authFetch(`/orders/${id}/pay`, {
        method: "POST",
        body: JSON.stringify({ amount, method: payMethod, cashAccountId: payCash ? Number(payCash) : undefined, accountName: cashAccounts.find((c) => String(c.id) === payCash)?.name }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "No se pudo registrar el pago");
      toast(`Pago registrado · saldo ${cop(d.balance)}`, "check");
      setPayOpen(false); void load();
    } catch (e) { toast(mensajeDeError(e), "alert-triangle"); } finally { setPaying(false); }
  }

  function openNote() {
    setNoteType("Retencion"); setNoteRetType("Retefuente Servicios"); setNoteAmount(""); setNoteDesc("");
    setNoteOpen(true);
  }

  async function submitNote() {
    const amount = Number(noteAmount) || 0;
    if (amount <= 0) { toast("Ingresa un monto mayor a cero", "alert-triangle"); return; }
    setNotesaving(true);
    try {
      const body: any = { type: noteType, amount, description: noteDesc || undefined };
      if (noteType === "Retencion") body.retentionType = noteRetType;
      const res = await authFetch(`/orders/${id}/notes`, { method: "POST", body: JSON.stringify(body) });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "No se pudo agregar la nota");
      toast(`Nota aplicada · nuevo total ${cop(d.total)}`, "check");
      setNoteOpen(false); void load();
    } catch (e) { toast(mensajeDeError(e), "alert-triangle"); } finally { setNotesaving(false); }
  }

  async function removeNote(noteId: string) {
    if (!confirm("¿Eliminar esta nota? El total de la orden se ajustará.")) return;
    try {
      const res = await authFetch(`/orders/${id}/notes/${noteId}`, { method: "DELETE" });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "No se pudo eliminar la nota");
      toast(`Nota eliminada · nuevo total ${cop(d.total)}`, "check");
      void load();
    } catch (e) { toast(mensajeDeError(e), "alert-triangle"); }
  }

  const submitReceive = async () => {
    setSaving(true);
    try {
      const items = (order?.items ?? []).map((it: any) => ({ itemId: it.id, received: Number(receive[it.id]) || 0 }));
      const res = await authFetch(`/orders/${id}/receive`, { method: "POST", body: JSON.stringify({ items }) });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "Error");
      toast("Recepción registrada");
      await load();
    } catch (e) {
      toast(mensajeDeError(e, "No se pudo registrar la recepción"), "alert-triangle");
    } finally { setSaving(false); }
  };

  if (authLoading || loading) return <PageSkeleton />;

  if (!order) {
    return (
      <>
        <Link href="/ordenes" className="inline-flex items-center gap-1 text-[13px] font-semibold text-text-secondary hover:text-brand">
          <Icon name="arrow-left" size={15} /> Órdenes
        </Link>
        <div className="rounded-xl border border-dashed border-border-subtle bg-surface p-10 text-center text-[13px] text-text-tertiary">No se encontró la orden.</div>
      </>
    );
  }

  const isCompra = order.kind === "compra";

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageHeading
          icon="receipt"
          title={`Orden ${order.tid}`}
          subtitle={`Creada el ${fmtDate(order.date)}`}
        />
        <div className="flex items-center gap-2">
          <Badge label={isCompra ? "Compra" : "Servicio"} tone={isCompra ? "brand" : "info"} />
          <Badge label={order.status} tone={statusTone(order.status)} />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
          <h2 className="mb-2 text-[11px] font-semibold uppercase text-text-tertiary">Proveedor</h2>
          <p className="text-[14px] font-bold text-text-primary">{order.supplier?.name ?? "—"}</p>
          <p className="text-[12px] text-text-tertiary">NIT {order.supplier?.nit ?? "—"}</p>
          <p className="text-[12px] text-text-tertiary">Tel. {order.supplier?.phone ?? "—"}</p>
        </div>
        <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
          <h2 className="mb-2 text-[11px] font-semibold uppercase text-text-tertiary">Fechas</h2>
          <div className="flex justify-between text-[13px]"><span className="text-text-tertiary">Orden</span><span className="text-text-secondary">{fmtDate(order.date)}</span></div>
          <div className="flex justify-between text-[13px]"><span className="text-text-tertiary">Vence</span><span className="text-text-secondary">{fmtDate(order.dueDate)}</span></div>
          <div className="flex justify-between text-[13px]"><span className="text-text-tertiary">Recibida</span><span className="text-text-secondary">{fmtDate(order.receivedAt)}</span></div>
        </div>
        <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
          <h2 className="mb-2 text-[11px] font-semibold uppercase text-text-tertiary">Totales</h2>
          <div className="flex justify-between text-[13px]"><span className="text-text-tertiary">Subtotal</span><span className="text-text-secondary">{cop(order.subtotal ?? 0)}</span></div>
          <div className="flex justify-between text-[13px]"><span className="text-text-tertiary">IVA</span><span className="text-text-secondary">{cop(order.tax ?? 0)}</span></div>
          {order.discount ? <div className="flex justify-between text-[13px]"><span className="text-text-tertiary">Descuento</span><span className="text-text-secondary">-{cop(order.discount)}</span></div> : null}
          {(order.noteLines ?? []).filter((n: any) => !String(n.type).startsWith("Retención")).map((n: any) => (
            <div key={n.id} className="flex justify-between text-[13px]"><span className="text-text-tertiary">{n.type}</span><span className="text-text-secondary">{n.amount < 0 ? "-" : "+"}{cop(Math.abs(n.amount))}</span></div>
          ))}
          {order.retention > 0 ? <div className="flex justify-between text-[13px]"><span className="text-text-tertiary">Retención ({order.retentionType})</span><span className="text-warning-text">-{cop(order.retention)}</span></div> : null}
          <div className="mt-1 flex justify-between border-t border-border-subtle pt-1 text-[14px] font-bold text-text-primary"><span>Total neto</span><span>{cop(order.total ?? 0)}</span></div>
          <div className="mt-1 flex justify-between text-[13px]"><span className="text-text-tertiary">Pagado</span><span className="text-success-text">{cop(order.paid ?? 0)}</span></div>
          <div className="flex justify-between text-[13px]"><span className="text-text-tertiary">Saldo</span><span className={saldo > 0 ? "font-semibold text-error-text" : "text-text-tertiary"}>{cop(saldo)}</span></div>
          {saldo > 0 && <Button variant="secondary" size="sm" className="mt-2 w-full" onClick={openPay}><Icon name="hand-coins" size={14} /> Registrar pago</Button>}
        </div>
      </div>

      {order.notes ? (
        <div className="rounded-xl border border-border-subtle bg-surface p-4 text-[13px] text-text-secondary shadow-sm">
          <span className="mb-1 block text-[11px] font-semibold uppercase text-text-tertiary">Nota</span>
          {order.notes}
        </div>
      ) : null}

      <div>
        <h2 className="mb-2 text-[13px] font-bold text-text-primary">Ítems</h2>
        <DataTable
          rows={order.items ?? []}
          empty="La orden no tiene ítems."
          columns={[
            { key: "product", header: "Producto", render: (r: any) => <span className="font-medium text-text-primary">{r.product}</span> },
            { key: "qty", header: "Cant.", align: "right", render: (r: any) => r.qty },
            { key: "price", header: "Precio", align: "right", render: (r: any) => cop(r.price) },
            { key: "subtotal", header: "Subtotal", align: "right", render: (r: any) => cop(r.subtotal ?? 0) },
            { key: "received", header: "Recibido", align: "right", render: (r: any) => <span className="text-text-secondary">{r.received ?? 0} / {r.qty}</span> },
          ]}
        />
      </div>

      <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-1.5 text-[13px] font-bold text-text-primary"><Icon name="file-text" size={16} /> Notas y retenciones</h2>
          <Button variant="secondary" size="sm" onClick={openNote}><Icon name="plus" size={14} /> Agregar nota</Button>
        </div>
        {(order.noteLines ?? []).length === 0 ? (
          <p className="text-[12px] text-text-tertiary">Sin notas ni retenciones. Usa «Agregar nota» para registrar una nota crédito/débito o una retención (ReteFuente/ReteICA).</p>
        ) : (
          <div className="flex flex-col gap-2">
            {(order.noteLines ?? []).map((n: any) => (
              <div key={n.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border-subtle px-3 py-2">
                <div className="min-w-0 flex-1">
                  <span className="text-[13px] font-medium text-text-primary">{n.type}</span>
                  {n.description ? <span className="ml-2 text-[12px] text-text-tertiary">{n.description}</span> : null}
                </div>
                <span className={`text-[13px] font-semibold ${n.amount < 0 ? "text-warning-text" : "text-text-secondary"}`}>{n.amount < 0 ? "-" : "+"}{cop(Math.abs(n.amount))}</span>
                <button onClick={() => removeNote(n.id)} className="text-text-tertiary hover:text-error-text" title="Eliminar nota"><Icon name="trash" size={15} /></button>
              </div>
            ))}
          </div>
        )}
      </div>

      {canReceive && (
        <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
          <h2 className="mb-3 flex items-center gap-1.5 text-[13px] font-bold text-text-primary">
            <Icon name="package" size={16} /> Recibir
          </h2>
          <div className="flex flex-col gap-2">
            {(order.items ?? []).map((it: any) => (
              <div key={it.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border-subtle px-3 py-2">
                <span className="min-w-0 flex-1 text-[13px] font-medium text-text-primary">{it.product}</span>
                <span className="text-[12px] text-text-tertiary">de {it.qty}</span>
                <Input
                  type="number"
                  min={0}
                  max={it.qty}
                  className="w-24 text-right"
                  value={receive[it.id] ?? "0"}
                  onChange={(e) => setReceive((prev) => ({ ...prev, [it.id]: e.target.value }))}
                />
              </div>
            ))}
          </div>
          <div className="mt-3 flex justify-end">
            <Button variant="primary" onClick={submitReceive} disabled={saving}>
              <Icon name="check" size={15} /> {saving ? "Registrando…" : "Registrar recepción"}
            </Button>
          </div>
        </div>
      )}

      <Modal open={payOpen} onClose={() => setPayOpen(false)} title="Registrar pago a proveedor" maxWidth="max-w-md">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Monto" required><Input type="number" min={0} value={payAmount} onChange={(e) => setPayAmount(e.target.value)} autoFocus /></Field>
          <Field label="Método"><Select value={payMethod} onChange={(e) => setPayMethod(e.target.value)}><option value="Cash">Efectivo</option><option value="Bank">Consignación</option></Select></Field>
          <div className="sm:col-span-2"><Field label="Caja / cuenta"><Select value={payCash} onChange={(e) => setPayCash(e.target.value)}><option value="">— Sin caja —</option>{cashAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field></div>
        </div>
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setPayOpen(false)} disabled={paying}>Cancelar</Button>
          <Button variant="primary" onClick={submitPay} disabled={paying}>{paying ? "Guardando…" : "Registrar pago"}</Button>
        </div>
      </Modal>

      <Modal open={noteOpen} onClose={() => setNoteOpen(false)} title="Agregar nota / retención" maxWidth="max-w-md">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Tipo" required>
            <Select value={noteType} onChange={(e) => setNoteType(e.target.value)}>
              <option value="Nota Credito">Nota Crédito (descuento)</option>
              <option value="Nota Debito">Nota Débito (aumento)</option>
              <option value="Retencion">Retención</option>
            </Select>
          </Field>
          {noteType === "Retencion" && (
            <Field label="Tipo de retención" required>
              <Select value={noteRetType} onChange={(e) => setNoteRetType(e.target.value)}>
                <option value="Retefuente Servicios">Retefuente Servicios</option>
                <option value="Compras">Compras</option>
                <option value="Personas no declarantes">Personas no declarantes</option>
                <option value="Reteiva">Reteiva</option>
              </Select>
            </Field>
          )}
          <Field label="Monto" required><Input type="number" min={0} value={noteAmount} onChange={(e) => setNoteAmount(e.target.value)} autoFocus /></Field>
          <div className="sm:col-span-2"><Field label="Descripción"><Input value={noteDesc} onChange={(e) => setNoteDesc(e.target.value)} placeholder="Opcional" /></Field></div>
        </div>
        <p className="mt-2 text-[12px] text-text-tertiary">Crédito y retención <strong>restan</strong> del total; débito <strong>suma</strong>. El total no puede quedar por debajo de lo ya pagado.</p>
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setNoteOpen(false)} disabled={notesaving}>Cancelar</Button>
          <Button variant="primary" onClick={submitNote} disabled={notesaving}>{notesaving ? "Guardando…" : "Aplicar nota"}</Button>
        </div>
      </Modal>
    </>
  );
}
