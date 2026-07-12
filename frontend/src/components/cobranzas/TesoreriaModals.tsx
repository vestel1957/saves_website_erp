"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Input, Select, Textarea, Field } from "@/components/ui/Field";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { cop } from "@/lib/subscribers";
import { type CashAccount, PAY_METHODS, BANKS, EXPENSE_CATEGORIES } from "@/lib/cobranzas";

const today = () => new Date().toISOString().slice(0, 10);

function useCashAccounts(open: boolean) {
  const { authFetch } = useAuth();
  const [accounts, setAccounts] = useState<CashAccount[]>([]);
  useEffect(() => {
    if (!open) return;
    void authFetch(`/treasury/cash-accounts`).then((r) => (r.ok ? r.json() : [])).then(setAccounts).catch(() => {});
  }, [open, authFetch]);
  return accounts;
}

/** Registrar un egreso/gasto de caja. */
export function EgresoModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const { authFetch } = useAuth();
  const accounts = useCashAccounts(open);
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState(EXPENSE_CATEGORIES[0]);
  const [method, setMethod] = useState("Cash");
  const [bank, setBank] = useState(BANKS[0]);
  const [cashAccountId, setCashAccountId] = useState("");
  const [payerName, setPayerName] = useState("");
  const [date, setDate] = useState(today());
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { if (open) { setAmount(""); setNote(""); setPayerName(""); setFile(null); setErr(null); } }, [open]);
  useEffect(() => { if (accounts.length && !cashAccountId) setCashAccountId(String(accounts[0].id)); }, [accounts, cashAccountId]);

  async function submit() {
    setErr(null);
    const amt = Number(amount) || 0;
    if (amt <= 0) { setErr("Ingresa un monto mayor a cero."); return; }
    setSaving(true);
    try {
      const res = await authFetch(`/treasury/expenses`, {
        method: "POST",
        body: JSON.stringify({
          amount: amt, category, method,
          cashAccountId: cashAccountId ? Number(cashAccountId) : undefined,
          accountName: accounts.find((a) => String(a.id) === cashAccountId)?.name,
          bankName: method === "Bank" ? bank : undefined,
          payerName: payerName || undefined, date, note: note || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || "No se pudo registrar el egreso");
      // Adjuntar el comprobante al movimiento recién creado (si se seleccionó uno).
      if (file && data?.id) {
        const fd = new FormData();
        fd.append("file", file);
        const up = await authFetch(`/treasury/transactions/${data.id}/attach`, { method: "POST", body: fd });
        if (!up.ok) toast("Egreso guardado, pero el comprobante no se pudo subir", "alert-triangle");
      }
      toast(`Egreso registrado: ${cop(amt)}`);
      onDone(); onClose();
    } catch (e: any) { setErr(e.message); } finally { setSaving(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title="Registrar egreso" maxWidth="max-w-xl">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Monto" required><Input type="number" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" autoFocus /></Field>
        <Field label="Categoría" required>
          <Select value={category} onChange={(e) => setCategory(e.target.value)}>{EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</Select>
        </Field>
        <Field label="Método"><Select value={method} onChange={(e) => setMethod(e.target.value)}>{PAY_METHODS.filter((m) => m.value !== "Balance").map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}</Select></Field>
        {method === "Bank" && <Field label="Banco"><Select value={bank} onChange={(e) => setBank(e.target.value)}>{BANKS.map((b) => <option key={b} value={b}>{b}</option>)}</Select></Field>}
        <Field label="Caja / cuenta"><Select value={cashAccountId} onChange={(e) => setCashAccountId(e.target.value)}><option value="">— Sin caja —</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
        <Field label="Beneficiario"><Input value={payerName} onChange={(e) => setPayerName(e.target.value)} placeholder="A quién se paga" /></Field>
        <Field label="Fecha"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <div className="sm:col-span-2"><Field label="Nota"><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field></div>
        <div className="sm:col-span-2">
          <Field label="Comprobante (opcional)" hint="Foto o PDF de la factura, recibo o soporte de transferencia.">
            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border-subtle bg-surface-2 px-3 py-1.5 text-[12px] font-medium text-text-secondary hover:border-brand hover:text-text-primary">
              <Icon name="upload" size={14} /> {file ? "Cambiar archivo" : "Adjuntar comprobante"}
              <input type="file" accept="image/*,application/pdf" className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </label>
            {file && <span className="ml-2 inline-flex items-center gap-1 text-[11px] text-text-tertiary"><Icon name="file-text" size={12} /> {file.name}<button type="button" onClick={() => setFile(null)} className="text-error-text hover:underline"><Icon name="x" size={12} /></button></span>}
          </Field>
        </div>
      </div>
      {err && <p className="mt-2 text-[12px] text-error-text">{err}</p>}
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose} disabled={saving}>Cancelar</Button>
        <Button onClick={submit} disabled={saving}>{saving ? "Guardando…" : "Registrar egreso"}</Button>
      </div>
    </Modal>
  );
}

/** Cierre de caja (arqueo). */
export function CierreCajaModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const { authFetch } = useAuth();
  const accounts = useCashAccounts(open);
  const [cashAccountId, setCashAccountId] = useState("");
  const [date, setDate] = useState(today());
  const [base, setBase] = useState("");
  const [deposited, setDeposited] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<any>(null);

  useEffect(() => { if (open) { setBase(""); setDeposited(""); setErr(null); setResult(null); } }, [open]);
  useEffect(() => { if (accounts.length && !cashAccountId) setCashAccountId(String(accounts[0].id)); }, [accounts, cashAccountId]);

  async function submit() {
    setErr(null);
    if (!cashAccountId) { setErr("Selecciona una caja."); return; }
    setSaving(true);
    try {
      const res = await authFetch(`/treasury/cash-close`, {
        method: "POST",
        body: JSON.stringify({ cashAccountId: Number(cashAccountId), date, base: Number(base) || 0, deposited: Number(deposited) || 0 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || "No se pudo cerrar la caja");
      setResult(data);
      toast(`Cierre registrado · excedente ${cop(data.surplus)}`);
      onDone();
    } catch (e: any) { setErr(e.message); } finally { setSaving(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title="Cierre de caja" maxWidth="max-w-lg">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Caja" required><Select value={cashAccountId} onChange={(e) => setCashAccountId(e.target.value)}><option value="">— Selecciona —</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
        <Field label="Fecha" required><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Base inicial" hint="Efectivo con que abrió"><Input type="number" min={0} value={base} onChange={(e) => setBase(e.target.value)} placeholder="0" /></Field>
        <Field label="Consignado" hint="Lo depositado al banco"><Input type="number" min={0} value={deposited} onChange={(e) => setDeposited(e.target.value)} placeholder="0" /></Field>
      </div>
      {err && <p className="mt-2 text-[12px] text-error-text">{err}</p>}
      {result && (
        <div className="mt-3 rounded-lg border border-border-subtle bg-surface-2 p-3 text-[12px]">
          <div className="mb-1 font-bold text-text-primary">Arqueo del día</div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            <span className="text-text-tertiary">Arrastre día anterior</span><span className="text-right font-medium">{cop(result.carryover ?? 0)}</span>
            <span className="text-text-tertiary">Ventas (ingresos)</span><span className="text-right font-medium text-success-text">+ {cop(result.sales)}</span>
            <span className="text-text-tertiary">Egresos</span><span className="text-right font-medium text-error-text">− {cop(result.expenses)}</span>
            <span className="text-text-tertiary">Consignado</span><span className="text-right font-medium text-error-text">− {cop(result.deposited)}</span>
            <span className="col-span-2 my-0.5 border-t border-border-subtle" />
            <span className="font-semibold text-text-primary">Excedente (arrastra a mañana)</span><span className="text-right font-bold text-text-primary">{cop(result.surplus)}</span>
          </div>
          <p className="mt-2 text-[11px] text-text-tertiary">El fondo fijo ({cop(result.fondoFijo ?? 0)}) permanece en la caja y no entra al excedente.</p>
        </div>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose} disabled={saving}>{result ? "Cerrar" : "Cancelar"}</Button>
        {!result && <Button onClick={submit} disabled={saving}>{saving ? "Calculando…" : "Cerrar caja"}</Button>}
      </div>
    </Modal>
  );
}

/** Anular una transacción. */
export function AnularModal({ tx, onClose, onDone }: { tx: { id: string; payer: string; amount: number } | null; onClose: () => void; onDone: () => void }) {
  const { authFetch } = useAuth();
  const [reason, setReason] = useState("");
  const [detail, setDetail] = useState("Anulado de Cierre");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { if (tx) { setReason(""); setDetail("Anulado de Cierre"); setErr(null); } }, [tx]);

  async function submit() {
    setErr(null);
    if (reason.trim().length < 3) { setErr("Escribe el motivo de la anulación."); return; }
    setSaving(true);
    try {
      const res = await authFetch(`/treasury/transactions/${tx!.id}/void`, {
        method: "POST", body: JSON.stringify({ reason: reason.trim(), detail }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || "No se pudo anular");
      toast("Transacción anulada");
      onDone(); onClose();
    } catch (e: any) { setErr(e.message); } finally { setSaving(false); }
  }

  return (
    <Modal open={!!tx} onClose={onClose} title="Anular transacción" maxWidth="max-w-md">
      {tx && (
        <div className="flex flex-col gap-3">
          <p className="text-[12px] text-text-secondary">
            Vas a anular el movimiento de <span className="font-semibold">{tx.payer}</span> por{" "}
            <span className="font-semibold">{cop(tx.amount)}</span>. Esto revierte el saldo de la factura asociada.
          </p>
          <Field label="Motivo" required><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ej: Pago duplicado" autoFocus /></Field>
          <Field label="Detalle"><Select value={detail} onChange={(e) => setDetail(e.target.value)}><option>Anulado de Cierre</option><option>Anulado de otros Cierres</option></Select></Field>
          {err && <p className="text-[12px] text-error-text">{err}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose} disabled={saving}>Cancelar</Button>
            <Button variant="danger" onClick={submit} disabled={saving}>{saving ? "Anulando…" : "Anular"}</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
