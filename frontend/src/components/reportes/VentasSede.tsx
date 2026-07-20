import { ChartCard, BarChart, TrendStat, compactCOP } from "@/components/charts";
import { DataTable } from "@/components/ui/DataTable";
import { cop } from "@/lib/subscribers";
import { nfmt } from "@/lib/reportes";
import { Section } from "./Section";

export function VentasSede({ data }: { data: any }) {
  const items = data.items ?? [];
  const total = items.reduce((s: number, r: any) => s + (r.total ?? 0), 0);
  return (
    <>
      <Section>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <TrendStat label="Total facturado" value={cop(total)} icon="banknote" hint={`${nfmt(items.length)} sedes`} />
          <TrendStat label="Facturas" value={nfmt(items.reduce((s: number, r: any) => s + (r.facturas ?? 0), 0))} icon="receipt" hint="Emitidas en el periodo" />
          <TrendStat label="Sede líder" value={items[0]?.sede ?? "—"} icon="target" tone="success" hint={items[0] ? cop(items[0].total) : ""} />
        </div>
      </Section>
      <ChartCard title="Facturación por sede" subtitle="Total facturado en el periodo" icon="bar-chart-3">
        <BarChart yFormat={compactCOP} data={items.map((r: any) => ({ label: r.sede, value: r.total }))} />
      </ChartCard>
      <ChartCard title="Detalle por sede" icon="list-tree">
        <DataTable rows={items} empty="Sin datos." columns={[
          { key: "sede", header: "Sede", render: (r: any) => <span className="font-medium text-text-primary">{r.sede}</span> },
          { key: "f", header: "Facturas", align: "right", render: (r: any) => nfmt(r.facturas ?? 0) },
          { key: "t", header: "Total facturado", align: "right", render: (r: any) => <span className="font-semibold">{cop(r.total)}</span> },
        ]} />
      </ChartCard>
    </>
  );
}
