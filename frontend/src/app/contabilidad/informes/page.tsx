"use client";

import { useEffect, useMemo, useState } from "react";
import { PageHeading } from "@/components/ui/PageHeading";
import { TabBar } from "@/components/accounting/TabBar";
import { TrialBalanceTable } from "@/components/accounting/TrialBalanceTable";
import { StatementSection, TotalRow } from "@/components/accounting/StatementView";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { Select } from "@/components/ui/Field";
import { useAuth } from "@/context/AuthProvider";
import { accountingApi, type FiscalPeriodRow } from "@/lib/accounting";
import type { TrialBalance, IncomeStatement, BalanceSheet } from "@/lib/accounting-types";
import { fullCurrency } from "@/lib/format";

type Tab = "comprobacion" | "resultados" | "balance";

/** 'YYYY-MM-DD' de un ISO, sin pasar por la zona horaria del navegador. */
const dia = (iso: string) => iso.slice(0, 10);

export default function InformesPage() {
  const { authFetch } = useAuth();
  const api = useMemo(() => accountingApi(authFetch), [authFetch]);
  const [tab, setTab] = useState<Tab>("comprobacion");
  const [tb, setTb] = useState<TrialBalance | null>(null);
  const [pyg, setPyg] = useState<IncomeStatement | null>(null);
  const [bs, setBs] = useState<BalanceSheet | null>(null);
  const [loading, setLoading] = useState(true);

  // Periodo del informe. Elegir un mes es lo que hace visible el ARRASTRE: el balance
  // de comprobación gana la columna "saldo anterior" con lo que viene del mes pasado.
  const [periodos, setPeriodos] = useState<FiscalPeriodRow[]>([]);
  const [periodoId, setPeriodoId] = useState("");
  const periodo = periodos.find((p) => p.id === periodoId) ?? null;
  const rango = periodo ? { from: dia(periodo.startDate), to: dia(periodo.endDate) } : undefined;

  useEffect(() => {
    api.getPeriods().then(setPeriodos).catch(() => {});
  }, [api]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        const [a, b, c] = await Promise.all([
          api.getTrialBalance(rango),
          api.getIncomeStatement(rango),
          api.getBalanceSheet(rango),
        ]);
        if (!alive) return;
        setTb(a); setPyg(b); setBs(c);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
    // El rango se deriva del periodo elegido; depender del objeto recargaría en cada render.
  }, [api, periodoId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return <PageSkeleton />;

  const margen = pyg && pyg.totals.totalIncome > 0
    ? (pyg.totals.netIncome / pyg.totals.totalIncome) * 100
    : 0;

  return (
    <div className="flex flex-col gap-4">
      <PageHeading icon="bar-chart-3" title="Balance y estados financieros" subtitle="Comprobación, estado de resultados y balance general" />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="max-w-lg">
          <TabBar<Tab>
            tabs={[
              { key: "comprobacion", label: "Comprobación" },
              { key: "resultados", label: "Estado de resultados" },
              { key: "balance", label: "Balance general" },
            ]}
            active={tab}
            onChange={setTab}
          />
        </div>
        <Select
          value={periodoId}
          onChange={(e) => setPeriodoId(e.target.value)}
          className="h-9 w-auto text-[12.5px]"
          aria-label="Periodo del informe"
        >
          <option value="">Todo el histórico</option>
          {periodos.map((p) => (
            <option key={p.id} value={p.id}>{p.name}{p.status !== "OPEN" ? " (cerrado)" : ""}</option>
          ))}
        </Select>
      </div>

      {/* El balance general es acumulado a la fecha de corte, no "lo del mes": decirlo
          evita leer el mismo selector de dos maneras distintas en dos pestañas. */}
      {periodo && (
        <p className="text-[12px] text-text-tertiary">
          {tab === "balance"
            ? <>Situación acumulada al <b>{dia(periodo.endDate)}</b>, con todo lo arrastrado de los meses anteriores.</>
            : <>Movimientos del {dia(periodo.startDate)} al {dia(periodo.endDate)}
                {tab === "comprobacion" ? <>, con el saldo que cada cuenta trae del mes anterior.</> : "."}</>}
        </p>
      )}

      {tab === "comprobacion" && tb && <TrialBalanceTable data={tb} />}

      {tab === "resultados" && pyg && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {/* Estado (2/3) + resumen sticky con márgenes (1/3). */}
          <div className="flex flex-col gap-3 lg:col-span-2">
            <StatementSection title="Ingresos" lines={pyg.income} total={pyg.totals.totalIncome} />
            <StatementSection title="Costos" lines={pyg.costs} total={pyg.totals.totalCosts} />
            <TotalRow label="Utilidad bruta" value={pyg.totals.grossProfit} tone={pyg.totals.grossProfit >= 0 ? "success" : "error"} />
            <StatementSection title="Gastos" lines={pyg.expenses} total={pyg.totals.totalExpenses} />
            <TotalRow label="Utilidad neta del ejercicio" value={pyg.totals.netIncome} tone={pyg.totals.netIncome >= 0 ? "success" : "error"} />
          </div>
          <aside className="lg:sticky lg:top-4 lg:self-start">
            <div className="flex flex-col gap-3 rounded-xl border border-border-subtle bg-surface p-4">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">Resumen del periodo</p>
              <SummaryLine label="Ingresos" value={pyg.totals.totalIncome} />
              <SummaryLine label="Costos" value={-pyg.totals.totalCosts} />
              <SummaryLine label="Utilidad bruta" value={pyg.totals.grossProfit} strong />
              <SummaryLine label="Gastos" value={-pyg.totals.totalExpenses} />
              <div className="border-t border-border-subtle pt-3">
                <SummaryLine label="Utilidad neta" value={pyg.totals.netIncome} strong
                  tone={pyg.totals.netIncome >= 0 ? "success" : "error"} />
              </div>
              <div className="mt-1 flex items-center justify-between rounded-lg bg-surface-2 px-3 py-2">
                <span className="text-[12px] font-medium text-text-secondary">Margen neto</span>
                <span className={`font-mono text-[15px] font-bold ${margen >= 0 ? "text-success-text" : "text-error-text"}`}>
                  {margen.toFixed(1)}%
                </span>
              </div>
            </div>
          </aside>
        </div>
      )}

      {tab === "balance" && bs && (
        <div className="flex flex-col gap-3">
          {/* Doble columna clásica: Activo | Pasivo + Patrimonio. */}
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <div className="flex flex-col gap-3">
              <StatementSection title="Activo" lines={bs.assets} total={bs.totals.totalAssets} />
              <TotalRow label="Total activo" value={bs.totals.totalAssets} />
            </div>
            <div className="flex flex-col gap-3">
              <StatementSection title="Pasivo" lines={bs.liabilities} total={bs.totals.totalLiabilities} />
              <StatementSection title="Patrimonio" lines={bs.equity} total={bs.totals.totalEquity} />
              <TotalRow label="Pasivo + Patrimonio" value={bs.totals.liabilitiesPlusEquity} />
            </div>
          </div>
          {!bs.balanced && (
            <p className="rounded-xl border border-error-subtle bg-error-soft p-3 text-center text-[12.5px] text-error-text">
              El balance no cuadra: activo ≠ pasivo + patrimonio. Revise los asientos del periodo.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function SummaryLine({ label, value, strong, tone = "default" }: {
  label: string; value: number; strong?: boolean; tone?: "default" | "success" | "error";
}) {
  const cls = tone === "success" ? "text-success-text" : tone === "error" ? "text-error-text" : "text-text-primary";
  return (
    <div className="flex items-center justify-between gap-3">
      <span className={`text-[12.5px] ${strong ? "font-semibold text-text-primary" : "text-text-secondary"}`}>{label}</span>
      <span className={`font-mono text-[13px] ${strong ? "font-bold" : ""} ${cls}`}>{fullCurrency(value)}</span>
    </div>
  );
}
