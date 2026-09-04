"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Input, Select, Textarea, Field } from "@/components/ui/Field";
import { DataTable } from "@/components/ui/DataTable";
import { Modal } from "@/components/Modal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { PERM } from "@/lib/auth";
import { cop } from "@/lib/subscribers";
import { mensajeDeError } from "@/lib/errores";
import type { CashAccount } from "@/lib/cobranzas";
import { ACCEPT_IMAGEN_PDF } from "@/lib/adjuntos";

type Ejecucion = { id: string; amount: number; transactionId: string | null; executedByName: string | null; executedAt: string };
type PagoFijo = {
  id: string; name: string; category: string; amount: number;
  cashAccountId: number; caja: string; dayOfMonth: number;
  beneficiary: string | null; note: string | null; active: boolean;
  createdByName: string | null; ejecucion: Ejecucion | null;
};

const FORM_VACIO = { name: "", category: "", amount: "", cashAccountId: "", dayOfMonth: "1", beneficiary: "", note: "" };

/**
 * Pagos fijos programados.
 *
 * Contabilidad DEFINE cada pago (arriendo, servicios…) atado a una caja y a un
 * día del mes; la cajera de esa caja REGISTRA la ejecución cuando paga. El
 * registro crea el egreso en efectivo (cae solo a su cierre del día) y el
 * comprobante queda adjunto a esa transacción — el mismo camino del modal de
 * egresos, sin asientos paralelos.
 */
export default function PagosFijosPage() {
  const { loading: authLoading, authFetch, can, isSuperadmin } = useAuth();
  const gestiona = isSuperadmin || can(PERM.AREA_CONTABILIDAD);

  const [d, setD] = useState<{ periodo: string; items: PagoFijo[] } | null>(null);
  const [err, setErr] = useState(false);

  const cargar = useCallback(async () => {
    setErr(false);
    try {
      const r = await authFetch("/treasury/scheduled-payments");
      if (!r.ok) throw new Error(String(r.status));
      setD(await r.json());
    } catch { setErr(true); }
  }, [authFetch]);
  useEffect(() => { if (!authLoading) void cargar(); }, [authLoading, cargar]);

  // ── Crear / editar (contabilidad) ─────────────────────────────────────────
  const [modal, setModal] = useState<PagoFijo | "new" | null>(null);
  const [form, setForm] = useState<typeof FORM_VACIO>(FORM_VACIO);
  const [accounts, setAccounts] = useState<CashAccount[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [aBorrar, setABorrar] = useState<PagoFijo | null>(null);

  useEffect(() => {
    if (!modal || !gestiona) return;
    void authFetch("/treasury/cash-accounts").then((r) => (r.ok ? r.json() : [])).then(setAccounts).catch(() => {});
    void authFetch("/treasury/categories").then((r) => (r.ok ? r.json() : []))
      .then((rows: { name: string }[]) => setCategories(rows.map((c) => c.name))).catch(() => {});
  }, [modal, gestiona, authFetch]);

  function abrirNuevo() { setForm(FORM_VACIO); setModal("new"); }
  function abrirEditar(p: PagoFijo) {
    setForm({
      name: p.name, category: p.category, amount: String(p.amount),
      cashAccountId: String(p.cashAccountId), dayOfMonth: String(p.dayOfMonth),
      beneficiary: p.beneficiary ?? "", note: p.note ?? "",
    });
    setModal(p);
  }

  async function guardar() {
    const editando = modal && modal !== "new";
    const body = {
      name: form.name.trim(), category: form.category,
      amount: Number(form.amount), cashAccountId: Number(form.cashAccountId),
      dayOfMonth: Number(form.dayOfMonth),
      beneficiary: form.beneficiary.trim() || undefined,
      note: form.note.trim() || undefined,
    };
    if (!body.name || !body.category || !(body.amount > 0) || !body.cashAccountId) {
      toast("Nombre, categoría, monto y caja son obligatorios", "alert-triangle");
      return;
    }
    setSaving(true);
    try {
      const res = await authFetch(editando ? `/treasury/scheduled-payments/${(modal as PagoFijo).id}` : "/treasury/scheduled-payments", {
        method: editando ? "PATCH" : "POST",
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.message || "No se pudo guardar");
      toast(editando ? "Pago fijo actualizado" : "Pago fijo creado");
      setModal(null);
      void cargar();
    } catch (e) { toast(mensajeDeError(e), "alert-triangle"); } finally { setSaving(false); }
  }

  async function alternarActivo(p: PagoFijo) {
    try {
      const res = await authFetch(`/treasury/scheduled-payments/${p.id}`, { method: "PATCH", body: JSON.stringify({ active: !p.active }) });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.message || "No se pudo cambiar");
      toast(p.active ? "Pago fijo desactivado" : "Pago fijo activado");
      void cargar();
    } catch (e) { toast(mensajeDeError(e), "alert-triangle"); }
  }

  async function borrar() {
    if (!aBorrar) return;
    try {
      const res = await authFetch(`/treasury/scheduled-payments/${aBorrar.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.message || "No se pudo borrar");
      toast("Pago fijo eliminado");
      setABorrar(null);
      void cargar();
    } catch (e) { toast(mensajeDeError(e), "alert-triangle"); setABorrar(null); }
  }

  // ── Registrar ejecución (cajera) ──────────────────────────────────────────
  const [pagar, setPagar] = useState<PagoFijo | null>(null);
  const [montoPagado, setMontoPagado] = useState("");
  const [comprobante, setComprobante] = useState<File | null>(null);
  const [pagando, setPagando] = useState(false);

  function abrirPagar(p: PagoFijo) { setPagar(p); setMontoPagado(String(p.amount)); setComprobante(null); }

  async function registrarPago() {
    if (!pagar) return;
    const amount = Number(montoPagado);
    if (!(amount > 0)) { toast("El monto debe ser mayor a cero", "alert-triangle"); return; }
    setPagando(true);
    try {
      const res = await authFetch(`/treasury/scheduled-payments/${pagar.id}/execute`, {
        method: "POST",
        body: JSON.stringify({ amount }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message || "No se pudo registrar el pago");
      // El comprobante se adjunta al egreso recién creado, como en el modal de egresos.
      if (comprobante && data?.transactionId) {
        const fd = new FormData();
        fd.append("file", comprobante);
        const up = await authFetch(`/treasury/transactions/${data.transactionId}/attach`, { method: "POST", body: fd });
        if (!up.ok) toast("Pago registrado, pero el comprobante no se pudo subir", "alert-triangle");
      }
      toast(`Pago registrado: ${cop(amount)} — queda en el cierre de hoy`);
      setPagar(null);
      void cargar();
    } catch (e) { toast(mensajeDeError(e), "alert-triangle"); } finally { setPagando(false); }
  }

  if (authLoading || (!d && !err)) return <PageSkeleton />;
  if (err && !d) return <div className="p-6 text-[13px] text-text-secondary">No se pudo cargar. <button className="font-semibold text-brand hover:underline" onClick={() => void cargar()}>Reintentar</button></div>;
  if (!d) return <PageSkeleton />;

  const diaDeHoy = new Date().getDate();

  const columns = [
    {
      key: "name", header: "Pago",
      render: (p: PagoFijo) => (
        <div className="min-w-0">
          <div className={`font-semibold ${p.active ? "text-text-primary" : "text-text-tertiary line-through"}`}>{p.name}</div>
          <div className="text-[11px] text-text-tertiary">{p.category}{p.beneficiary ? ` · ${p.beneficiary}` : ""}</div>
        </div>
      ),
    },
    { key: "caja", header: "Caja", render: (p: PagoFijo) => <span className="text-text-secondary">{p.caja}</span> },
    { key: "dayOfMonth", header: "Día", render: (p: PagoFijo) => <span className="font-mono text-[12px]">{p.dayOfMonth}</span> },
    { key: "amount", header: "Monto", align: "right" as const, render: (p: PagoFijo) => <span className="font-semibold">{cop(p.amount)}</span> },
    {
      key: "estado", header: `Este mes (${d.periodo})`,
      render: (p: PagoFijo) => {
        if (!p.active) return <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-bold uppercase text-text-tertiary">Inactivo</span>;
        if (p.ejecucion) {
          return (
            <div>
              <span className="rounded bg-success-soft px-1.5 py-0.5 text-[10px] font-bold uppercase text-success-text">Pagado</span>
              <div className="mt-0.5 text-[11px] text-text-tertiary">
                {cop(p.ejecucion.amount)} · {new Date(p.ejecucion.executedAt).toLocaleDateString("es-CO", { day: "2-digit", month: "short" })}
                {p.ejecucion.executedByName ? ` · ${p.ejecucion.executedByName}` : ""}
              </div>
            </div>
          );
        }
        const vencido = diaDeHoy > p.dayOfMonth;
        return (
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${vencido ? "bg-error-soft text-error-text" : "bg-warning-soft text-warning-text"}`}>
            {vencido ? "Vencido" : "Pendiente"}
          </span>
        );
      },
    },
    {
      key: "actions", header: "", align: "right" as const,
      render: (p: PagoFijo) => (
        <div className="flex items-center justify-end gap-2">
          {p.active && !p.ejecucion && (
            <Button size="sm" onClick={() => abrirPagar(p)}><Icon name="banknote" size={13} /> Registrar pago</Button>
          )}
          {gestiona && (
            <>
              <button type="button" title="Editar" onClick={() => abrirEditar(p)} className="tap text-text-tertiary hover:text-brand"><Icon name="pencil" size={14} /></button>
              <button type="button" title={p.active ? "Desactivar" : "Activar"} onClick={() => void alternarActivo(p)} className="tap text-text-tertiary hover:text-warning-text">
                <Icon name={p.active ? "pause" : "play"} size={14} />
              </button>
              <button type="button" title="Eliminar" onClick={() => setABorrar(p)} className="tap text-text-tertiary hover:text-error-text"><Icon name="trash" size={14} /></button>
            </>
          )}
        </div>
      ),
    },
  ];

  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <PageHeading
          icon="repeat"
          title="Pagos fijos programados"
          subtitle="Los define contabilidad; la cajera registra cada pago y el egreso cae a su cierre del día"
        />
        {gestiona && (
          <Button size="sm" onClick={abrirNuevo}><Icon name="plus" size={14} /> Nuevo pago fijo</Button>
        )}
      </div>

      <DataTable
        columns={columns}
        rows={d.items}
        empty={gestiona ? "No hay pagos fijos definidos. Crea el primero con “Nuevo pago fijo”." : "No hay pagos fijos asignados a tu caja."}
      />

      {/* Crear / editar (contabilidad) */}
      <Modal open={!!modal} onClose={() => setModal(null)} title={modal === "new" ? "Nuevo pago fijo" : "Editar pago fijo"} maxWidth="max-w-lg">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field label="Nombre" required><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Ej: Arriendo oficina Yopal" autoFocus /></Field>
          </div>
          <Field label="Categoría" required>
            <Select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
              <option value="">— Elegir —</option>
              {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
          </Field>
          <Field label="Monto" required><Input type="number" min={0} value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} placeholder="0" /></Field>
          <Field label="Caja" required hint="La cajera de esta caja es quien registra el pago">
            <Select value={form.cashAccountId} onChange={(e) => setForm({ ...form, cashAccountId: e.target.value })}>
              <option value="">— Elegir —</option>
              {accounts.filter((a) => a.branchLegacy !== 0).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </Select>
          </Field>
          <Field label="Día del mes" required hint="Cuándo corresponde pagarlo">
            <Input type="number" min={1} max={31} value={form.dayOfMonth} onChange={(e) => setForm({ ...form, dayOfMonth: e.target.value })} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Beneficiario"><Input value={form.beneficiary} onChange={(e) => setForm({ ...form, beneficiary: e.target.value })} placeholder="A quién se le paga (opcional)" /></Field>
          </div>
          <div className="sm:col-span-2">
            <Field label="Nota"><Textarea rows={2} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></Field>
          </div>
        </div>
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setModal(null)} disabled={saving}>Cancelar</Button>
          <Button onClick={guardar} disabled={saving}>{saving ? "Guardando…" : "Guardar"}</Button>
        </div>
      </Modal>

      {/* Registrar ejecución (cajera) */}
      <Modal open={!!pagar} onClose={() => setPagar(null)} title={`Registrar pago — ${pagar?.name ?? ""}`} maxWidth="max-w-md">
        <div className="flex flex-col gap-3">
          <p className="text-[12.5px] text-text-secondary">
            Se registra un egreso en <b>efectivo</b> de la caja <b>{pagar?.caja}</b> por el periodo <b>{d.periodo}</b>.
            El movimiento queda en el cierre de caja de hoy.
          </p>
          <Field label="Monto pagado" required hint={pagar && Number(montoPagado) !== pagar.amount ? `Programado: ${cop(pagar.amount)}` : undefined}>
            <Input type="number" min={0} value={montoPagado} onChange={(e) => setMontoPagado(e.target.value)} />
          </Field>
          <Field label="Comprobante" hint="Foto o PDF del recibo. Queda adjunto al egreso.">
            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border-subtle bg-surface-2 px-3 py-1.5 text-[12px] font-medium text-text-secondary hover:border-brand hover:text-text-primary">
              <Icon name="upload" size={14} /> {comprobante ? "Cambiar archivo" : "Adjuntar comprobante"}
              <input type="file" accept={ACCEPT_IMAGEN_PDF} className="hidden" onChange={(e) => setComprobante(e.target.files?.[0] ?? null)} />
            </label>
            {comprobante && (
              <span className="ml-2 inline-flex items-center gap-1 text-[11px] text-text-tertiary">
                <Icon name="file-text" size={12} /> {comprobante.name}
                <button type="button" onClick={() => setComprobante(null)} className="text-error-text hover:underline"><Icon name="x" size={12} /></button>
              </span>
            )}
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setPagar(null)} disabled={pagando}>Cancelar</Button>
            <Button onClick={registrarPago} disabled={pagando}>{pagando ? "Registrando…" : "Registrar pago"}</Button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={!!aBorrar}
        title="Eliminar pago fijo"
        message={<>¿Eliminar <b>{aBorrar?.name}</b>? Solo se puede si nunca se ha ejecutado; si ya tiene pagos, desactívalo.</>}
        confirmLabel="Eliminar"
        onConfirm={borrar}
        onClose={() => setABorrar(null)}
      />
    </>
  );
}
