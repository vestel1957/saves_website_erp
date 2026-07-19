import Link from "next/link";
import { ChartCard, HBarList, TrendStat, compactCOP } from "@/components/charts";
import { DataTable } from "@/components/inventory/DataTable";
import { cop } from "@/lib/subscribers";
import { nfmt } from "@/lib/reportes";
import { Section } from "./Section";

export function TopDeudores({ data }: { data: any }) {
  const items = data.items ?? [];
  const totalDeuda = items.reduce((s: number, r: any) => s + (r.balance ?? 0), 0);
  return (
    <>
      <Section>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <TrendStat label="Deuda del top 30" value={cop(totalDeuda)} icon="alert-triangle" tone="error" hint={`${nfmt(items.length)} clientes`} />
          <TrendStat label="Mayor deudor" value={items[0]?.name ?? "—"} icon="user" hint={items[0] ? cop(items[0].balance) : ""} />
          <TrendStat label="Facturas en mora" value={nfmt(items.reduce((s: number, r: any) => s + (r.facturas ?? 0), 0))} icon="receipt" tone="warning" />
        </div>
      </Section>
      <ChartCard title="Top 10 clientes en mora" subtitle="Mayores saldos pendientes" icon="bar-chart-3">
        <HBarList
          monochrome
          accent="var(--color-error)"
          valueFormat={compactCOP}
          rows={items.slice(0, 10).map((r: any) => ({ label: r.name, value: r.balance, hint: `${nfmt(r.facturas)} facturas` }))}
        />
      </ChartCard>
      <ChartCard title="Detalle de cartera" icon="list-tree">
        <DataTable rows={items} empty="Sin datos." columns={[
          { key: "ab", header: "Abonado", render: (r: any) => <span className="font-mono text-text-secondary">{r.abonado}</span> },
          { key: "n", header: "Cliente", render: (r: any) => <Link href={`/clientes/${r.id}`} className="font-medium text-brand hover:underline">{r.name}</Link> },
          { key: "f", header: "Facturas", align: "right", render: (r: any) => nfmt(r.facturas) },
          { key: "b", header: "Deuda", align: "right", render: (r: any) => <span className="font-semibold text-error-text">{cop(r.balance)}</span> },
        ]} />
      </ChartCard>
    </>
  );
}
