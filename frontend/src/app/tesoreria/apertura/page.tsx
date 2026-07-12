"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PageHeading } from "@/components/accounting/PageHeading";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Input, Select, Field } from "@/components/ui/Field";
import { DataTable } from "@/components/inventory/DataTable";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { cop } from "@/lib/subscribers";
import type { CashAccount } from "@/lib/cobranzas";

const today = () => new Date().toISOString().slice(0, 10);
const fmt = (d: string | null) => (d ? new Date(d).toLocaleDateString("es-CO") : "—");

type Suggest = {
  fondoFijo: number;
  carryover: number;
  carryoverFrom: string | null;
  base: number;
  existing: { base: number; openedBy: string | null; note: string | null } | null;
};

export default function AperturaPage() {
  const { loading: authLoading, authFetch } = useAuth();
  const [accounts, setAccounts] = useState<CashAccount[]>([]);
  const [cashAccountId, setCashAccountId] = useState("");
  const [date, setDate] = useState(today());
  const [base, setBase] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [data, setData] = useState<any>(null);
  const [suggest, setSuggest] = useState<Suggest | null>(null);
  const [loadingSuggest, setLoadingSuggest] = useState(false);

  const load = useCallback(async () => {
    const r = await authFetch(`/treasury/cash-opens?pageSize=25`);
    setData(await r.json());
  }, [authFetch]);

  useEffect(() => {
    if (authLoading) return;
    void authFetch(`/treasury/cash-accounts`).then((r) => r.json()).then((a: CashAccount[]) => { setAccounts(a); if (a.length) setCashAccountId(String(a[0].id)); }).catch(() => {});
    void load();
  }, [authLoading, authFetch, load]);

  // Al elegir caja/fecha: trae fondo fijo + arrastre y precarga la base sugerida.
  useEffect(() => {
    if (!cashAccountId || !date) { setSuggest(null); return; }
    setLoadingSuggest(true);
    const qs = new URLSearchParams({ cashAccountId, date });
    void authFetch(`/treasury/cash-open-suggest?${qs}`)
      .then((r) => r.json())
      .then((s: Suggest) => {
        setSuggest(s);
        setBase(String(s.existing ? s.existing.base : s.base));
        setNote(s.existing?.note ?? "");
      })
      .catch(() => setSuggest(null))
      .finally(() => setLoadingSuggest(false));
  }, [authFetch, cashAccountId, date]);

  const baseNum = Number(base) || 0;
  const overridden = !!suggest && !suggest.existing && Math.round(baseNum) !== Math.round(suggest.base);

  async function submit() {
    setErr(null);
    if (!cashAccountId) { setErr("Selecciona una caja."); return; }
    setSaving(true);
    try {
      const res = await authFetch(`/treasury/cash-open`, {
        method: "POST",
        body: JSON.stringify({
          cashAccountId: Number(cashAccountId),
          accountName: accounts.find((a) => String(a.id) === cashAccountId)?.name,
          date, base: baseNum, note: note || undefined,
        }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "No se pudo abrir la caja");
      toast(`Caja abierta con base ${cop(d.base)}`, "check");
      void load();
    } catch (e: any) { setErr(e.message); } finally { setSaving(false); }
  }

  if (authLoading) return <PageSkeleton />;

  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <PageHeading icon="key-round" title="Apertura de caja" />
        <Link href="/tesoreria/cierres" className="inline-flex items-center gap-1.5 rounded-lg border border-border-default px-3 py-2 text-[12px] font-semibold text-text-secondary transition-colors hover:bg-surface-2">
          <Icon name="lock" size={14} /> Cierres de caja
        </Link>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-5">
        {/* ---- Abrir caja ---- */}
        <div className="lg:col-span-2">
          <div className="rounded-2xl border border-border-subtle bg-surface p-5 shadow-sm">
            <div className="mb-4 flex items-center gap-2.5">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand"><Icon name="key-round" size={18} /></span>
              <div className="leading-tight">
                <div className="text-[14px] font-bold text-text-primary">Abrir caja</div>
                <div className="text-[12px] text-text-tertiary">Base = fondo fijo + arrastre del día anterior</div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <Field label="Caja" required>
                <Select value={cashAccountId} onChange={(e) => setCashAccountId(e.target.value)}>
                  <option value="">— Selecciona —</option>
                  {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </Select>
              </Field>
              <Field label="Fecha" required><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
            </div>

            {/* Desglose fondo fijo + arrastre */}
            <div className="mt-3 rounded-xl border border-border-subtle bg-surface-subtle p-3.5">
              {suggest?.existing && (
                <div className="mb-3 flex items-start gap-2 rounded-lg bg-warning-soft px-3 py-2 text-[12px] text-warning-text">
                  <Icon name="alert-triangle" size={14} className="mt-0.5 shrink-0" />
                  <span>Esta caja ya fue abierta el {fmt(date)} con base <b>{cop(suggest.existing.base)}</b>{suggest.existing.openedBy ? ` por ${suggest.existing.openedBy}` : ""}. Al guardar se actualizará.</span>
                </div>
              )}
              <div className="flex items-center justify-between py-1 text-[13px]">
                <span className="text-text-secondary">Fondo fijo</span>
                <span className="font-semibold text-text-primary">{cop(suggest?.fondoFijo ?? 0)}</span>
              </div>
              <div className="flex items-center justify-between py-1 text-[13px]">
                <span className="text-text-secondary">
                  Arrastre día anterior
                  {suggest?.carryoverFrom ? <span className="ml-1 text-text-tertiary">· cierre {fmt(suggest.carryoverFrom)}</span> : <span className="ml-1 text-text-tertiary">· sin cierre previo</span>}
                </span>
                <span className={`font-semibold ${(suggest?.carryover ?? 0) > 0 ? "text-success-text" : "text-text-tertiary"}`}>+ {cop(suggest?.carryover ?? 0)}</span>
              </div>
              <div className="my-2 border-t border-border-subtle" />
              <Field label="Base inicial de hoy">
                <div className="relative">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[13px] text-text-tertiary">$</span>
                  <Input type="number" min={0} className="pl-6 text-[15px] font-bold" value={base} onChange={(e) => setBase(e.target.value)} placeholder="0" />
                </div>
              </Field>
              {loadingSuggest && <p className="mt-1 text-[11px] text-text-tertiary">Calculando arrastre…</p>}
              {overridden && (
                <button type="button" onClick={() => suggest && setBase(String(suggest.base))} className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-semibold text-brand hover:underline">
                  <Icon name="history" size={11} /> Restablecer sugerida ({cop(suggest!.base)})
                </button>
              )}
            </div>

            <div className="mt-3">
              <Field label="Nota"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Opcional" /></Field>
            </div>
            {err && <p className="mt-2 text-[12px] text-error-text">{err}</p>}
            <Button className="mt-3 w-full" onClick={submit} disabled={saving || !cashAccountId}>
              {saving ? "Guardando…" : suggest?.existing ? "Actualizar apertura" : "Abrir caja"}
            </Button>
          </div>
        </div>

        {/* ---- Aperturas recientes ---- */}
        <div className="lg:col-span-3">
          <div className="mb-2 text-[13px] font-bold text-text-primary">Aperturas recientes</div>
          <DataTable
            autoHeight
            rows={data?.items ?? []}
            empty="Sin aperturas registradas."
            columns={[
              { key: "date", header: "Fecha", render: (r: any) => fmt(r.date) },
              { key: "caja", header: "Caja", render: (r: any) => r.accountName ?? `Caja ${r.cashAccountId}` },
              { key: "base", header: "Base", align: "right", render: (r: any) => <span className="font-semibold text-text-primary">{cop(r.base)}</span> },
              { key: "by", header: "Abrió", render: (r: any) => <span className="text-text-secondary">{r.openedBy ?? "—"}</span> },
              { key: "note", header: "Nota", render: (r: any) => <span className="text-text-tertiary">{r.note || "—"}</span> },
            ]}
          />
        </div>
      </div>
    </>
  );
}
