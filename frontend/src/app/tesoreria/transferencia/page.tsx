"use client";

import { useEffect, useState } from "react";
import { PageHeading } from "@/components/ui/PageHeading";
import { LinkMovimientos } from "@/components/cobranzas/LinkMovimientos";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Input, Select, Field } from "@/components/ui/Field";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { cop } from "@/lib/subscribers";
import type { CashAccount } from "@/lib/cobranzas";
import { mensajeDeError } from "@/lib/errores";
import { useMiCaja } from "@/lib/useMiCaja";
import { ACCEPT_IMAGEN_PDF } from "@/lib/adjuntos";

const today = () => new Date().toISOString().slice(0, 10);

type Result = {
  amount: number;
  from: { name: string; transactionId?: string };
  to: { name: string; transactionId?: string };
  /** Nombre del comprobante que quedó adjunto (null = no se subió ninguno). */
  comprobante?: string | null;
};

export default function TransferenciaPage() {
  const { loading: authLoading, authFetch } = useAuth();
  // La cajera transfiere DESDE su caja (típicamente a un banco al cuadrar el día):
  // el origen se le fija y el backend además exige que ella sea parte del traslado.
  const { bloqueada, sinCaja } = useMiCaja();
  const [accounts, setAccounts] = useState<CashAccount[]>([]);
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(today());
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | null>(null);
  // El <input type="file"> es no controlado: para vaciarlo tras registrar hay que
  // remontarlo, y por eso lleva `key`.
  const [fileKey, setFileKey] = useState(0);
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

  useEffect(() => { if (bloqueada) setFromId(String(bloqueada.id)); }, [bloqueada]);

  const amountNum = Number(amount) || 0;
  const sameAccount = !!fromId && fromId === toId;
  const canSubmit = !!fromId && !!toId && !sameAccount && amountNum > 0 && !saving;

  /** Sube el comprobante a un movimiento del traslado. Devuelve si quedó adjunto. */
  async function adjuntar(txId: string | undefined, f: File): Promise<boolean> {
    if (!txId) return false;
    try {
      const fd = new FormData();
      fd.append("file", f);
      const r = await authFetch(`/treasury/transactions/${txId}/attach`, { method: "POST", body: fd });
      return r.ok;
    } catch { return false; }
  }

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
      // El soporte se sube DESPUÉS, contra los movimientos que acaba de crear el
      // traslado (crear -> adjuntar, igual que el egreso). Va en las DOS patas para
      // que se vea desde el cierre de la caja origen y desde los movimientos de la
      // destino; si la destino no la alcanza quien transfiere (otra sede), basta con
      // que su propia pata lo lleve.
      let comprobante: string | null = null;
      if (file) {
        const nombre = file.name;
        const [origen] = await Promise.all([
          adjuntar(d?.from?.transactionId, file),
          adjuntar(d?.to?.transactionId, file),
        ]);
        if (origen) comprobante = nombre;
        else toast("Transferencia registrada, pero el comprobante no se pudo subir", "alert-triangle");
      }
      setLast({ ...d, comprobante });
      toast(`Transferencia de ${cop(d.amount)} registrada`, "check");
      setAmount("");
      setNote("");
      setFile(null);
      setFileKey((k) => k + 1);
    } catch (e) { setErr(mensajeDeError(e)); } finally { setSaving(false); }
  }

  if (authLoading) return <PageSkeleton />;

  const fromName = accounts.find((a) => String(a.id) === fromId)?.name;
  const toName = accounts.find((a) => String(a.id) === toId)?.name;

  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <PageHeading icon="arrow-left-right" title="Transferencia entre cajas" />
        <LinkMovimientos />
      </div>

      <div className="mx-auto mt-2 w-full max-w-xl">
        {sinCaja && (
          <div className="mb-3 flex items-start gap-2 rounded-xl border border-warning-subtle bg-warning-soft px-3.5 py-3 text-[13px] text-warning-text">
            <Icon name="alert-triangle" size={16} className="mt-0.5 shrink-0" />
            <span>No tienes una caja asignada, así que no puedes transferir. Pídele a administración que te asigne la de tu sede.</span>
          </div>
        )}
        <div className="rounded-2xl border border-border-subtle bg-surface p-5 shadow-sm">
          <div className="mb-4 flex items-center gap-2.5">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand"><Icon name="arrow-left-right" size={18} /></span>
            <div className="leading-tight">
              <div className="text-[14px] font-bold text-text-primary">Mover dinero entre cajas</div>
              <div className="text-[12px] text-text-tertiary">Genera un egreso en la caja origen y un ingreso en la destino.</div>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-[1fr_auto_1fr] sm:items-end">
            <Field label="Desde (origen)" required hint={bloqueada ? "Tu caja" : undefined}>
              <Select value={fromId} onChange={(e) => setFromId(e.target.value)} disabled={!!bloqueada}>
                <option value="">— Selecciona —</option>
                {(bloqueada ? accounts.filter((a) => a.id === bloqueada.id) : accounts)
                  .map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
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

          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2.5">
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

          <div className="mt-3">
            <Field label="Comprobante (opcional)" hint="Foto o PDF del soporte de la consignación o el traslado.">
              <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border-subtle bg-surface-2 px-3 py-1.5 text-[12px] font-medium text-text-secondary hover:border-brand hover:text-text-primary">
                <Icon name="upload" size={14} /> {file ? "Cambiar archivo" : "Adjuntar comprobante"}
                <input key={fileKey} type="file" accept={ACCEPT_IMAGEN_PDF} className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              </label>
              {file && (
                <span className="ml-2 inline-flex items-center gap-1 text-[11px] text-text-tertiary">
                  <Icon name="file-text" size={12} /> {file.name}
                  <button type="button" onClick={() => { setFile(null); setFileKey((k) => k + 1); }} className="text-error-text hover:underline"><Icon name="x" size={12} /></button>
                </span>
              )}
            </Field>
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
            {saving ? (file ? "Transfiriendo y subiendo…" : "Transfiriendo…") : "Transferir"}
          </Button>
        </div>

        {last && (
          <div className="mt-3 flex items-start gap-2 rounded-xl border border-success-soft bg-success-soft px-3.5 py-3 text-[13px] text-success-text">
            <Icon name="check" size={16} className="mt-0.5 shrink-0" />
            <span>
              Última transferencia: <b>{cop(last.amount)}</b> de <b>{last.from.name}</b> a <b>{last.to.name}</b>.
              {last.comprobante && <> Comprobante <b>{last.comprobante}</b> adjunto; se ve en Movimientos y en el cierre.</>}
            </span>
          </div>
        )}
      </div>
    </>
  );
}
