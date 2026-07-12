"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { PageHeading } from "@/components/accounting/PageHeading";
import { DataTable } from "@/components/inventory/DataTable";
import { Input, Select } from "@/components/ui/Field";
import { Pagination } from "@/components/ui/Pagination";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { useAuth } from "@/context/AuthProvider";
import { cop } from "@/lib/subscribers";
import {
  type CashCloseList,
  type CashCloseSummary,
  type CashCloseTotals,
  type CashAccountOpt,
} from "@/lib/treasury";

type ViewMode = "detail" | "day" | "week" | "month";

const VIEWS: { key: ViewMode; label: string }[] = [
  { key: "detail", label: "Detalle" },
  { key: "day", label: "Día" },
  { key: "week", label: "Semana" },
  { key: "month", label: "Mes" },
];

// --- Helpers de fecha (YYYY-MM-DD en horario local) ---
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
function preset(kind: "hoy" | "semana" | "mes" | "año"): { from: string; to: string } {
  const now = new Date();
  const to = iso(now);
  if (kind === "hoy") return { from: to, to };
  if (kind === "semana") {
    const d = new Date(now);
    const dow = (d.getDay() + 6) % 7; // lunes = 0
    d.setDate(d.getDate() - dow);
    return { from: iso(d), to };
  }
  if (kind === "mes") return { from: iso(new Date(now.getFullYear(), now.getMonth(), 1)), to };
  return { from: `${now.getFullYear()}-01-01`, to };
}

function MiniStat({ label, value, tone = "text-text-primary", icon }: { label: string; value: string; tone?: string; icon: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <Icon name={icon} size={15} className={tone} />
      <span className="text-[11px] font-medium text-text-tertiary">{label}</span>
      <span className={`text-[14px] font-bold ${tone}`}>{value}</span>
    </span>
  );
}

function periodLabel(dateStr: string, group: "day" | "week" | "month"): string {
  const d = new Date(dateStr);
  if (group === "month") return d.toLocaleDateString("es-CO", { month: "long", year: "numeric" });
  if (group === "week") {
    const end = new Date(d);
    end.setDate(end.getDate() + 6);
    return `Sem. ${d.toLocaleDateString("es-CO", { day: "2-digit", month: "short" })} – ${end.toLocaleDateString("es-CO", { day: "2-digit", month: "short" })}`;
  }
  return d.toLocaleDateString("es-CO", { weekday: "short", day: "2-digit", month: "short", year: "numeric" });
}

export default function CierresPage() {
  const { loading: authLoading, authFetch } = useAuth();
  const [view, setView] = useState<ViewMode>("detail");
  const [accounts, setAccounts] = useState<CashAccountOpt[]>([]);
  const [cashAccountId, setCashAccountId] = useState("");
  const [from, setFrom] = useState(preset("año").from);
  const [to, setTo] = useState(preset("año").to);
  const [page, setPage] = useState(1);

  const [list, setList] = useState<CashCloseList | null>(null);
  const [summary, setSummary] = useState<CashCloseSummary | null>(null);
  const [loading, setLoading] = useState(true);

  const accById = useMemo(() => new Map(accounts.map((a) => [a.id, a.name])), [accounts]);

  useEffect(() => {
    if (authLoading) return;
    void authFetch("/treasury/cash-accounts").then((r) => (r.ok ? r.json() : [])).then(setAccounts).catch(() => {});
  }, [authLoading, authFetch]);

  const qs = useCallback(() => {
    const p = new URLSearchParams();
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    if (cashAccountId) p.set("cashAccountId", cashAccountId);
    return p;
  }, [from, to, cashAccountId]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (view === "detail") {
        const p = qs();
        p.set("page", String(page));
        p.set("pageSize", "25");
        setList(await (await authFetch(`/treasury/cash-closes?${p}`)).json());
      } else {
        const p = qs();
        p.set("group", view);
        setSummary(await (await authFetch(`/treasury/cash-closes/summary?${p}`)).json());
      }
    } finally {
      setLoading(false);
    }
  }, [authFetch, view, page, qs]);

  useEffect(() => { if (!authLoading) void load(); }, [authLoading, load]);
  useEffect(() => { setPage(1); }, [from, to, cashAccountId, view]);

  function applyPreset(kind: "hoy" | "semana" | "mes" | "año") {
    const r = preset(kind);
    setFrom(r.from);
    setTo(r.to);
  }

  // Totales del conjunto filtrado (detalle -> del backend; agregado -> suma de buckets).
  const totals: CashCloseTotals | null = useMemo(() => {
    if (view === "detail") return list?.totals ?? null;
    if (!summary) return null;
    return summary.items.reduce<CashCloseTotals>(
      (acc, r) => ({
        count: acc.count + r.count,
        base: acc.base + r.base, sales: acc.sales + r.sales, expenses: acc.expenses + r.expenses,
        deposited: acc.deposited + r.deposited, surplus: acc.surplus + r.surplus,
      }),
      { count: 0, base: 0, sales: 0, expenses: 0, deposited: 0, surplus: 0 },
    );
  }, [view, list, summary]);

  async function openPdf(id: string) {
    const res = await authFetch(`/treasury/cash-closes/${id}/pdf`);
    if (!res.ok) return;
    const url = URL.createObjectURL(await res.blob());
    window.open(url, "_blank");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  if (authLoading) return <PageSkeleton />;

  return (
    <>
      <div className="mb-4 flex items-center justify-between gap-3">
        <PageHeading icon="lock" title="Cierres de caja" subtitle="Filtra y consolida por día, semana o mes" />
        {/* Toggle de agrupación */}
        <div className="inline-flex rounded-lg border border-border-default bg-surface p-0.5">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              onClick={() => setView(v.key)}
              className={`rounded-md px-3 py-1.5 text-[12px] font-semibold transition-colors ${view === v.key ? "bg-brand text-on-brand" : "text-text-secondary hover:bg-surface-2"}`}
            >
              {v.label}
            </button>
          ))}
        </div>
      </div>

      {/* Barra de filtros */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-lg border border-border-default bg-surface p-0.5">
          {([["hoy", "Hoy"], ["semana", "Semana"], ["mes", "Mes"], ["año", "Año"]] as const).map(([k, l]) => (
            <button key={k} onClick={() => applyPreset(k)} className="rounded-md px-2.5 py-1.5 text-[12px] font-medium text-text-secondary hover:bg-surface-2">
              {l}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-auto" />
          <span className="text-text-tertiary">–</span>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-auto" />
        </div>
        <Select value={cashAccountId} onChange={(e) => setCashAccountId(e.target.value)} className="w-auto">
          <option value="">Todas las cajas</option>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </Select>
      </div>

      {/* Resumen del conjunto filtrado */}
      <div className="mb-3 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-border-subtle bg-surface px-4 py-2.5 shadow-sm">
        <MiniStat icon="lock" label="Cierres" value={(totals?.count ?? 0).toLocaleString("es-CO")} tone="text-text-secondary" />
        <span className="hidden h-6 w-px bg-border-subtle sm:block" />
        <MiniStat icon="wallet" label="Base" value={cop(totals?.base ?? 0)} />
        <MiniStat icon="trending-up" label="Ventas" value={cop(totals?.sales ?? 0)} tone="text-success-text" />
        <MiniStat icon="trending-down" label="Egresos" value={cop(totals?.expenses ?? 0)} tone="text-error-text" />
        <MiniStat icon="banknote" label="Consignado" value={cop(totals?.deposited ?? 0)} />
        <MiniStat icon="scale" label="Excedente" value={cop(totals?.surplus ?? 0)} tone={(totals?.surplus ?? 0) >= 0 ? "text-text-primary" : "text-error-text"} />
      </div>

      {loading && !list && !summary ? (
        <PageSkeleton />
      ) : view === "detail" ? (
        <div className="flex flex-col gap-3">
          <DataTable
            autoHeight
            rows={list?.items ?? []}
            empty="No hay cierres de caja en este rango."
            columns={[
              { key: "caja", header: "Caja", render: (r) => <span className="text-text-secondary">{accById.get(r.cashAccountId) ?? `Caja #${r.cashAccountId}`}</span> },
              { key: "date", header: "Fecha", render: (r) => (r.date ? new Date(r.date).toLocaleDateString("es-CO") : "—") },
              { key: "base", header: "Base", align: "right", render: (r) => cop(r.base) },
              { key: "sales", header: "Ventas", align: "right", render: (r) => <span className="text-success-text">{cop(r.sales)}</span> },
              { key: "exp", header: "Egresos", align: "right", render: (r) => <span className="text-error-text">{cop(r.expenses)}</span> },
              { key: "dep", header: "Consignado", align: "right", render: (r) => cop(r.deposited) },
              { key: "sur", header: "Excedente", align: "right", render: (r) => <span className="font-semibold">{cop(r.surplus)}</span> },
              { key: "pdf", header: "", align: "right", render: (r) => (
                <button onClick={() => void openPdf(r.id)} title="Ver PDF" className="inline-flex items-center gap-1 rounded-md border border-border-default px-2 py-1 text-[12px] text-text-secondary hover:bg-surface-2">
                  <Icon name="file-text" size={13} /> PDF
                </button>
              ) },
            ]}
          />
          {list && list.pages > 1 && (
            <Pagination meta={{ page: list.page, pageSize: list.pageSize, total: list.total, pageCount: list.pages }} onPage={setPage} />
          )}
        </div>
      ) : (
        <DataTable
          autoHeight
          rows={summary?.items ?? []}
          empty="No hay cierres de caja en este rango."
          columns={[
            { key: "period", header: "Período", render: (r) => <span className="font-medium capitalize text-text-primary">{periodLabel(r.period, view)}</span> },
            { key: "count", header: "Cierres", align: "right", render: (r) => <span className="text-text-secondary">{r.count.toLocaleString("es-CO")}</span> },
            { key: "base", header: "Base", align: "right", render: (r) => cop(r.base) },
            { key: "sales", header: "Ventas", align: "right", render: (r) => <span className="text-success-text">{cop(r.sales)}</span> },
            { key: "exp", header: "Egresos", align: "right", render: (r) => <span className="text-error-text">{cop(r.expenses)}</span> },
            { key: "dep", header: "Consignado", align: "right", render: (r) => cop(r.deposited) },
            { key: "sur", header: "Excedente", align: "right", render: (r) => <span className="font-semibold">{cop(r.surplus)}</span> },
          ]}
        />
      )}
    </>
  );
}
