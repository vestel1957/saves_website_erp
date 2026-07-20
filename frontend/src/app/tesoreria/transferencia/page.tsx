"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Input, Select, Field } from "@/components/ui/Field";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { cop } from "@/lib/subscribers";
import type { CashAccount } from "@/lib/cobranzas";

const today = () => new Date().toISOString().slice(0, 10);

type Result = {
  amount: number;
  from: { name: string };
  to: { name: string };
};

export default function TransferenciaPage() {
  const { loading: authLoading, authFetch } = useAuth();
  const [accounts, setAccounts] = useState<CashAccount[]>([]);
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(today());
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [last, setLast] = useState<Result | null>(null);

  useEffect(() => {
    if (authLoading) return;
    void authFetch(`/treasury/cash-accounts`)
      .then((r) => r.json())
      .then((a: CashAccount[]) => setAccounts(a))
      .catch(() => {});
  }, [authLoading, authFetch]);

  const amountNum = Number(amount) || 0;
  const sameAccount = !!fromId && fromId === toId;
  const canSubmit = !!fromId && !!toId && !sameAccount && amountNum > 0 && !saving;

  async function submit() {
    setErr(null);
    if (sameAccount) { setErr("La caja origen y destino no pueden ser la misma."); return; }
    if (amountNum <= 0) { setErr("Ingresa un monto mayor a cero."); return; }
    setSaving(true);
    try {
      const res = await authFetch(`/treasury/transfer`, {
        method: "POST",
        body: JSON.stringify({
          fromCashAccountId: Number(fromId),
          fromAccountName: accounts.find((a) => String(a.id) === fromId)?.name,
          toCashAccountId: Number(toId),
          toAccountName: accounts.find((a) => String(a.id) === toId)?.name,
          amount: amountNum,
          date,
          note: note || undefined,
        }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "No se pudo transferir");
      setLast(d);
      toast(`Transferencia de ${cop(d.amount)} registrada`, "check");
      setAmount("");
      setNote("");
    } catch (e: any) { setErr(e.message); } finally { setSaving(false); }
  }

  if (authLoading) return <PageSkeleton />;

  const fromName = accounts.find((a) => String(a.id) === fromId)?.name;
  const toName = accounts.find((a) => String(a.id) === toId)?.name;

  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <PageHeading icon="arrow-left-right" title="Transferencia entre cajas" />
        <Link href="/tesoreria" className="inline-flex items-center gap-1.5 rounded-lg border border-border-default px-3 py-2 text-[12px] font-semibold text-text-secondary transition-colors hover:bg-surface-2">
          <Icon name="banknote" size={14} /> Movimientos
        </Link>
      </div>

      <div className="mx-auto mt-2 w-full max-w-xl">
        <div className="rounded-2xl border border-border-subtle bg-surface p-5 shadow-sm">
          <div className="mb-4 flex items-center gap-2.5">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand"><Icon name="arrow-left-right" size={18} /></span>
            <div className="leading-tight">
              <div className="text-[14px] font-bold text-text-primary">Mover dinero entre cajas</div>
              <div className="text-[12px] text-text-tertiary">Genera un egreso en la caja origen y un ingreso en la destino.</div>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-[1fr_auto_1fr] sm:items-end">
            <Field label="Desde (origen)" required>
              <Select value={fromId} onChange={(e) => setFromId(e.target.value)}>
                <option value="">— Selecciona —</option>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </Select>
            </Field>
            <div className="hidden pb-2.5 text-text-tertiary sm:block"><Icon name="arrow-right" size={18} /></div>
            <Field label="Hacia (destino)" required>
              <Select value={toId} onChange={(e) => setToId(e.target.value)}>
                <option value="">— Selecciona —</option>
                {accounts.filter((a) => String(a.id) !== fromId).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </Select>
            </Field>
          </div>

          {sameAccount && <p className="mt-1.5 text-[12px] text-error-text">La caja origen y destino deben ser distintas.</p>}

          <div className="mt-3 grid grid-cols-2 gap-2.5">
            <Field label="Monto" required>
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[13px] text-text-tertiary">$</span>
                <Input type="number" min={0} className="pl-6 text-[15px] font-bold" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" />
              </div>
            </Field>
            <Field label="Fecha" required><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          </div>

          <div className="mt-3">
            <Field label="Concepto / nota"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Opcional" /></Field>
          </div>

          {amountNum > 0 && fromName && toName && !sameAccount && (
            <div className="mt-3 rounded-xl border border-border-subtle bg-surface-subtle p-3.5 text-[13px]">
              <div className="flex items-center justify-between py-0.5">
                <span className="text-text-secondary">{fromName}</span>
                <span className="font-semibold text-error-text">− {cop(amountNum)}</span>
              </div>
              <div className="flex items-center justify-between py-0.5">
                <span className="text-text-secondary">{toName}</span>
                <span className="font-semibold text-success-text">+ {cop(amountNum)}</span>
              </div>
            </div>
          )}

          {err && <p className="mt-2 text-[12px] text-error-text">{err}</p>}
          <Button className="mt-3 w-full" onClick={submit} disabled={!canSubmit}>
            {saving ? "Transfiriendo…" : "Transferir"}
          </Button>
        </div>

        {last && (
          <div className="mt-3 flex items-start gap-2 rounded-xl border border-success-soft bg-success-soft px-3.5 py-3 text-[13px] text-success-text">
            <Icon name="check" size={16} className="mt-0.5 shrink-0" />
            <span>Última transferencia: <b>{cop(last.amount)}</b> de <b>{last.from.name}</b> a <b>{last.to.name}</b>.</span>
          </div>
        )}
      </div>
    </>
  );
}
