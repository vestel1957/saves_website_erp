"use client";

import { useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui/Button";
import { Input, Select, Field } from "@/components/ui/Field";
import { Badge } from "@/components/ui/Badge";
import { Icon } from "@/components/Icon";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { cop } from "@/lib/subscribers";
import {
  type Debt, type CashAccount, PAY_METHODS, BANKS, isBankMethod, previewCascade,
} from "@/lib/cobranzas";
import { mensajeDeError } from "@/lib/errores";

const today = () => new Date().toISOString().slice(0, 10);

export function RegistrarPagoModal({
  subscriberId, open, onClose, onDone,
}: {
  subscriberId: string;
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const { authFetch } = useAuth();
  const [debt, setDebt] = useState<Debt | null>(null);
  const [accounts, setAccounts] = useState<CashAccount[]>([]);
  const [amount, setAmount] = useState<string>("");
  const [method, setMethod] = useState("Cash");
  const [bank, setBank] = useState(BANKS[0]);
  const [cashAccountId, setCashAccountId] = useState<string>("");
  const [date, setDate] = useState(today());
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDebt(null); setErr(null); setAmount(""); setNote(""); setMethod("Cash");
    void authFetch(`/treasury/subscribers/${subscriberId}/debt`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("No se pudo cargar la deuda"))))
      .then(setDebt).catch((e) => setErr(mensajeDeError(e)));
    void authFetch(`/treasury/cash-accounts`)
      .then((r) => (r.ok ? r.json() : []))
      .then((a: CashAccount[]) => { setAccounts(a); if (a.length) setCashAccountId(String(a[0].id)); })
      .catch(() => {});
  }, [open, subscriberId, authFetch]);

  const amountNum = Number(amount) || 0;
  const preview = useMemo(
    () => (debt ? previewCascade(debt.invoices, amountNum) : []),
    [debt, amountNum],
  );
  const totalPreview = preview.reduce((s, p) => s + p.applied, 0);
  const excedente = Math.max(0, Math.round((amountNum - (debt?.totalDebt ?? 0)) * 100) / 100);

  async function submit() {
    setErr(null);
    if (amountNum <= 0) { setErr("Ingresa un monto mayor a cero."); return; }
    if (method === "Balance" && amountNum > (debt?.balance ?? 0)) {
      setErr("El saldo a favor del cliente no alcanza para ese monto."); return;
    }
    setSaving(true);
    try {
      const res = await authFetch(`/treasury/collect`, {
        method: "POST",
        body: JSON.stringify({
          subscriberId, amount: amountNum, method,
          cashAccountId: cashAccountId ? Number(cashAccountId) : undefined,
          accountName: accounts.find((a) => String(a.id) === cashAccountId)?.name,
          bankName: isBankMethod(method) ? bank : undefined,
          date, note: note || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || "No se pudo registrar el pago");
      toast(`Recaudo registrado: ${cop(data.totalApplied)} (${data.applied.length} factura(s))`);
      // Abrir el recibo de caja en una pestaña nueva.
      if (data.receiptId) {
        try {
          const pdf = await authFetch(`/treasury/receipts/${data.receiptId}/pdf`);
          if (pdf.ok) {
            const url = URL.createObjectURL(await pdf.blob());
            window.open(url, "_blank");
            setTimeout(() => URL.revokeObjectURL(url), 60_000);
          }
        } catch { /* el recibo es opcional; no bloquea el flujo */ }
      }
      onDone();
      onClose();
    } catch (e) {
      setErr(mensajeDeError(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Registrar pago" maxWidth="max-w-2xl">
      {!debt && !err && <div className="py-6 text-center text-[13px] text-text-tertiary">Cargando deuda…</div>}
      {debt && (
        <div className="flex flex-col gap-3">
          {/* Resumen deuda */}
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface-2 px-3 py-2">
            <span className="text-[13px] font-semibold text-text-primary">{debt.name}</span>
            <div className="flex gap-4 text-right">
              <div><div className="text-[10px] text-text-tertiary">Deuda total</div><div className="text-[14px] font-bold text-error-text">{cop(debt.totalDebt)}</div></div>
              <div><div className="text-[10px] text-text-tertiary">Saldo a favor</div><div className="text-[14px] font-bold text-text-primary">{cop(debt.balance)}</div></div>
            </div>
          </div>

          {debt.invoices.length === 0 ? (
            <div className="rounded-lg border border-border-subtle bg-surface p-4 text-center text-[13px] text-text-tertiary">
              El cliente no tiene facturas pendientes.
            </div>
          ) : (
            <>
              {/* Formulario */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Monto a recaudar" required>
                  <Input type="number" min={0} inputMode="numeric" value={amount}
                    onChange={(e) => setAmount(e.target.value)} placeholder="0" autoFocus />
                </Field>
                <Field label="Método de pago" required>
                  <Select value={method} onChange={(e) => setMethod(e.target.value)}>
                    {PAY_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                  </Select>
                </Field>
                {isBankMethod(method) && (
                  <Field label="Banco">
                    <Select value={bank} onChange={(e) => setBank(e.target.value)}>
                      {BANKS.map((b) => <option key={b} value={b}>{b}</option>)}
                    </Select>
                  </Field>
                )}
                <Field label="Caja / cuenta">
                  <Select value={cashAccountId} onChange={(e) => setCashAccountId(e.target.value)}>
                    <option value="">— Sin caja —</option>
                    {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </Select>
                </Field>
                <Field label="Fecha">
                  <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
                </Field>
                <Field label="Nota (opcional)">
                  <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Referencia…" />
                </Field>
              </div>

              {/* Preview cascada */}
              <div>
                <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold text-text-tertiary">
                  <Icon name="list" size={13} /> Aplicación en cascada
                </div>
                <div className="max-h-40 overflow-y-auto rounded-lg border border-border-subtle">
                  {debt.invoices.map((inv) => {
                    const p = preview.find((x) => x.tid === inv.tid);
                    return (
                      <div key={inv.id} className="flex items-center justify-between gap-2 border-b border-border-subtle px-3 py-1.5 text-[12px] last:border-0">
                        <span className="font-mono text-text-secondary">#{inv.tid}</span>
                        <span className="text-text-tertiary">saldo {cop(inv.balance)}</span>
                        {p ? (
                          <Badge label={`+${cop(p.applied)}${p.willBePaid ? " · saldada" : " · parcial"}`} tone={p.willBePaid ? "success" : "warning"} />
                        ) : (
                          <span className="text-[11px] text-text-tertiary">—</span>
                        )}
                      </div>
                    );
                  })}
                </div>
                {excedente > 0 && (
                  <p className="mt-1 text-[11px] text-warning-text">
                    Excedente de {cop(excedente)} se cargará como saldo adelantado en la última factura.
                  </p>
                )}
                <p className="mt-1 text-[11px] text-text-tertiary">Total a aplicar: <span className="font-semibold text-text-primary">{cop(totalPreview)}</span></p>
              </div>
            </>
          )}

          {err && <p className="text-[12px] text-error-text">{err}</p>}

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" onClick={onClose} disabled={saving}>Cancelar</Button>
            <Button onClick={submit} disabled={saving || debt.invoices.length === 0 || amountNum <= 0}>
              {saving ? "Registrando…" : "Registrar pago"}
            </Button>
          </div>
        </div>
      )}
      {err && !debt && <p className="py-4 text-center text-[12px] text-error-text">{err}</p>}
    </Modal>
  );
}
