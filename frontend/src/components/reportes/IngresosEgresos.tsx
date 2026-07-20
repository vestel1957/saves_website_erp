import { ChartCard, AreaLineChart, TrendStat, compactCOP } from "@/components/charts";
import { DataTable } from "@/components/ui/DataTable";
import { cop } from "@/lib/subscribers";
import { monthLabel, nfmt } from "@/lib/reportes";
import { Section } from "./Section";

export function IngresosEgresos({ data }: { data: any }) {
  const items = data.items ?? [];
  const totalIn = items.reduce((s: number, r: any) => s + (r.income ?? 0), 0);
  const totalOut = items.reduce((s: number, r: any) => s + (r.expense ?? 0), 0);
  const balance = totalIn - totalOut;
  return (
    <>
      <Section>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <TrendStat label="Ingresos (periodo)" value={cop(totalIn)} icon="trending-up" tone="success" hint={`${nfmt(items.length)} meses`} />
          <TrendStat label="Egresos (periodo)" value={cop(totalOut)} icon="trending-down" tone="error" hint="Gastos y costos" />
          <TrendStat label="Balance neto" value={cop(balance)} icon="scale" tone={balance >= 0 ? "success" : "error"} hint={balance >= 0 ? "Superávit" : "Déficit"} />
        </div>
      </Section>
      <ChartCard
        title="Ingresos vs. egresos por mes"
        subtitle="Flujo de caja de los últimos meses"
        icon="activity"
        action={
          <span className="flex gap-3 text-[11px]">
            <span className="flex items-center gap-1"><span className="h-[3px] w-4 rounded-full" style={{ background: "var(--color-brand)" }} /> Ingresos</span>
            <span className="flex items-center gap-1"><span className="h-[3px] w-4 rounded-full" style={{ background: "var(--color-error)" }} /> Egresos</span>
          </span>
        }
      >
        <AreaLineChart
          yFormat={compactCOP}
          labels={items.map((r: any) => monthLabel(r.month))}
          series={[
            { name: "Ingresos", color: "var(--color-brand)", points: items.map((r: any) => r.income ?? 0) },
            { name: "Egresos", color: "var(--color-error)", points: items.map((r: any) => r.expense ?? 0) },
          ]}
        />
      </ChartCard>
      <ChartCard title="Detalle mensual" icon="list-tree">
        <DataTable rows={items} empty="Sin datos." columns={[
          { key: "m", header: "Mes", render: (r: any) => monthLabel(r.month) },
          { key: "i", header: "Ingresos", align: "right", render: (r: any) => <span className="text-success-text">{cop(r.income)}</span> },
          { key: "e", header: "Egresos", align: "right", render: (r: any) => <span className="text-error-text">{cop(r.expense)}</span> },
          { key: "b", header: "Balance", align: "right", render: (r: any) => <span className={`font-semibold ${r.balance >= 0 ? "text-text-primary" : "text-error-text"}`}>{cop(r.balance)}</span> },
        ]} />
      </ChartCard>
    </>
  );
}
