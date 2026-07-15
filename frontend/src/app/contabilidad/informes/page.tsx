"use client";

import { useEffect, useMemo, useState } from "react";
import { PageHeading } from "@/components/accounting/PageHeading";
import { TabBar } from "@/components/accounting/TabBar";
import { TrialBalanceTable } from "@/components/accounting/TrialBalanceTable";
import { StatementSection, TotalRow } from "@/components/accounting/StatementView";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { useAuth } from "@/context/AuthProvider";
import { accountingApi } from "@/lib/accounting";
import type { TrialBalance, IncomeStatement, BalanceSheet } from "@/lib/accounting-types";

type Tab = "comprobacion" | "resultados" | "balance";

export default function InformesPage() {
  const { authFetch } = useAuth();
  const api = useMemo(() => accountingApi(authFetch), [authFetch]);
  const [tab, setTab] = useState<Tab>("comprobacion");
  const [tb, setTb] = useState<TrialBalance | null>(null);
  const [pyg, setPyg] = useState<IncomeStatement | null>(null);
  const [bs, setBs] = useState<BalanceSheet | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [a, b, c] = await Promise.all([api.getTrialBalance(), api.getIncomeStatement(), api.getBalanceSheet()]);
        if (!alive) return;
        setTb(a); setPyg(b); setBs(c);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [api]);

  if (loading) return <PageSkeleton />;

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeading icon="bar-chart-3" title="Balance y estados financieros" subtitle="Comprobación, estado de resultados y balance general" />

      <div className="mb-4 max-w-lg">
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

      {tab === "comprobacion" && tb && <TrialBalanceTable data={tb} />}

      {tab === "resultados" && pyg && (
        <div className="flex flex-col gap-3">
          <StatementSection title="Ingresos" lines={pyg.income} total={pyg.totals.totalIncome} />
          <StatementSection title="Costos" lines={pyg.costs} total={pyg.totals.totalCosts} />
          <TotalRow label="Utilidad bruta" value={pyg.totals.grossProfit} tone={pyg.totals.grossProfit >= 0 ? "success" : "error"} />
          <StatementSection title="Gastos" lines={pyg.expenses} total={pyg.totals.totalExpenses} />
          <TotalRow label="Utilidad neta del ejercicio" value={pyg.totals.netIncome} tone={pyg.totals.netIncome >= 0 ? "success" : "error"} />
        </div>
      )}

      {tab === "balance" && bs && (
        <div className="flex flex-col gap-3">
          <StatementSection title="Activo" lines={bs.assets} total={bs.totals.totalAssets} />
          <StatementSection title="Pasivo" lines={bs.liabilities} total={bs.totals.totalLiabilities} />
          <StatementSection title="Patrimonio" lines={bs.equity} total={bs.totals.totalEquity} />
          <TotalRow label="Pasivo + Patrimonio" value={bs.totals.liabilitiesPlusEquity} />
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
