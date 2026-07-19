"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { PageHeading } from "@/components/accounting/PageHeading";
import { StatCard } from "@/components/accounting/StatCard";
import { ChartCard } from "@/components/charts/ChartCard";
import { AreaLineChart } from "@/components/charts/AreaLineChart";
import { DonutChart } from "@/components/charts/DonutChart";
import { Icon } from "@/components/Icon";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { useAuth } from "@/context/AuthProvider";
import { accountingApi, type MonthlySummary } from "@/lib/accounting";
import type { TrialBalance, CashFlow, IncomeStatement } from "@/lib/accounting-types";
import { fullCurrency, compactCurrency } from "@/lib/format";

const LINKS = [
  { href: "/contabilidad/plan-de-cuentas", label: "Plan de cuentas", icon: "list-tree", desc: "Estructura PUC del negocio" },
  { href: "/contabilidad/libros", label: "Libro diario y mayor", icon: "book-open", desc: "Asientos y movimientos por cuenta" },
  { href: "/contabilidad/informes", label: "Balance y estados", icon: "bar-chart-3", desc: "Comprobación, resultados y balance general" },
  { href: "/contabilidad/mapeo-cuentas", label: "Mapeo de cuentas", icon: "settings", desc: "Cuentas para la contabilización automática" },
];

/** "2026-07" → "Jul" (etiqueta corta de mes para el eje del gráfico). */
const MESES = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
function shortMonth(ym: string): string {
  const m = Number(ym.slice(5, 7));
  return MESES[m - 1] ?? ym;
}

export default function ContabilidadPage() {
  const { authFetch } = useAuth();
  const api = useMemo(() => accountingApi(authFetch), [authFetch]);
  const [tb, setTb] = useState<TrialBalance | null>(null);
  const [cf, setCf] = useState<CashFlow | null>(null);
  const [pyg, setPyg] = useState<IncomeStatement | null>(null);
  const [ms, setMs] = useState<MonthlySummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        // monthly-summary puede venir vacío (sin asientos): no debe tumbar el dashboard.
        const [a, b, c, d] = await Promise.all([
          api.getTrialBalance(),
          api.getCashFlow(),
          api.getIncomeStatement(),
          api.getMonthlySummary(6).catch(() => null),
        ]);
        if (!alive) return;
        setTb(a); setCf(b); setPyg(c); setMs(d);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [api]);

  if (loading) return <PageSkeleton />;

  const utilidad = pyg?.totals.netIncome ?? 0;
  const ingresoMes = ms?.income.at(-1) ?? 0;
  const labels = ms?.months.map(shortMonth) ?? [];
  // Distribución del ingreso: en qué se convierte cada peso facturado.
  const distSlices = pyg
    ? [
        { label: "Costos", value: pyg.totals.totalCosts },
        { label: "Gastos", value: pyg.totals.totalExpenses },
        { label: pyg.totals.netIncome >= 0 ? "Utilidad" : "Pérdida", value: Math.abs(pyg.totals.netIncome) },
      ].filter((s) => s.value > 0)
    : [];

  return (
    <div className="flex flex-col gap-5">
      <PageHeading icon="calculator" title="Contabilidad" subtitle="Partida doble · Plan Único de Cuentas (Colombia)" />

      {/* KPIs — fila de indicadores a todo lo ancho. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Utilidad del ejercicio" value={fullCurrency(utilidad)} icon="trending-up"
          tone={utilidad >= 0 ? "success" : "error"} hint="Ingresos − costos − gastos" />
        <StatCard label="Disponible (caja y bancos)" value={fullCurrency(cf?.closing ?? 0)} icon="wallet" hint="Saldo de efectivo" />
        <StatCard label="Ingresos del mes" value={fullCurrency(ingresoMes)} icon="calendar" hint="Facturación del mes en curso" />
        <StatCard label="Balance de comprobación" value={tb?.balanced ? "Cuadrado" : "Descuadrado"} icon="scale"
          tone={tb?.balanced ? "success" : "error"} hint={`${tb?.rows.length ?? 0} cuentas con movimiento`} />
      </div>

      {/* Gráficos — ingresos/egresos (2/3) + cartera por cobrar (1/3). */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <ChartCard
          title="Ingresos vs. egresos"
          subtitle="Últimos 6 meses"
          icon="bar-chart-3"
          className="lg:col-span-2"
          action={
            <div className="flex items-center gap-3 text-[11px] font-medium text-text-tertiary">
              <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-[var(--color-success)]" /> Ingresos</span>
              <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-[var(--color-brand-red)]" /> Egresos</span>
            </div>
          }
        >
          {ms && labels.length ? (
            <AreaLineChart
              labels={labels}
              yFormat={compactCurrency}
              series={[
                { name: "Ingresos", color: "var(--color-success)", points: ms.income },
                { name: "Egresos", color: "var(--color-brand-red)", points: ms.expenses },
              ]}
            />
          ) : (
            <EmptyChart text="Sin movimientos en el periodo." />
          )}
        </ChartCard>

        <ChartCard title="Distribución del ingreso" subtitle="A dónde va cada peso facturado" icon="hand-coins">
          {distSlices.length ? (
            <div className="flex flex-col items-center gap-4">
              <DonutChart
                data={distSlices}
                centerLabel="Ingresos"
                centerValue={compactCurrency(pyg?.totals.totalIncome ?? 0)}
                valueFormat={fullCurrency}
              />
              <ul className="w-full flex-col gap-1.5 text-[12px]">
                {distSlices.map((s) => (
                  <li key={s.label} className="flex items-center justify-between py-0.5">
                    <span className="text-text-secondary">{s.label}</span>
                    <span className="font-mono font-medium text-text-primary">{fullCurrency(s.value)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <EmptyChart text="Sin ingresos registrados en el periodo." />
          )}
        </ChartCard>
      </div>

      {/* Accesos del módulo — 4 tarjetas a lo ancho. */}
      <div>
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">Explorar</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href}
              className="flex items-start gap-3 rounded-xl border border-border-subtle bg-surface p-4 transition-colors hover:border-brand hover:bg-surface-2">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-soft">
                <Icon name={l.icon} size={18} className="text-brand" />
              </span>
              <div className="min-w-0">
                <p className="text-[14px] font-semibold text-text-primary">{l.label}</p>
                <p className="text-[12.5px] text-text-tertiary">{l.desc}</p>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

function EmptyChart({ text }: { text: string }) {
  return (
    <div className="flex min-h-[200px] items-center justify-center rounded-lg border border-dashed border-border-subtle p-6 text-center text-[12.5px] text-text-tertiary">
      {text}
    </div>
  );
}
