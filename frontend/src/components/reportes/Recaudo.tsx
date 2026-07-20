import { ChartCard, DonutChart, HBarList, TrendStat, compactCOP } from "@/components/charts";
import { DataTable } from "@/components/ui/DataTable";
import { cop } from "@/lib/subscribers";
import { nfmt } from "@/lib/reportes";
import { Section } from "./Section";

export function Recaudo({ data }: { data: any }) {
  return (
    <>
      <Section>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <TrendStat label="Total recaudado" value={cop(data.total ?? 0)} icon="banknote" tone="success" hint={`${nfmt(data.count ?? 0)} movimientos`} />
          <TrendStat label="Cajas activas" value={nfmt((data.porCaja ?? []).length)} icon="wallet" hint="Con recaudo en el periodo" />
          <TrendStat label="Métodos de pago" value={nfmt((data.porMetodo ?? []).length)} icon="hand-coins" hint="Canales usados" />
        </div>
      </Section>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard title="Recaudo por método" subtitle="Participación de cada canal de pago" icon="hand-coins">
          <DonutChart
            centerLabel="recaudado"
            centerValue={compactCOP(data.total ?? 0)}
            valueFormat={compactCOP}
            data={(data.porMetodo ?? []).map((r: any) => ({ label: r.metodo, value: r.total }))}
          />
        </ChartCard>
        <ChartCard title="Recaudo por caja" subtitle="Ranking de cajas por monto" icon="wallet">
          <HBarList
            valueFormat={compactCOP}
            rows={(data.porCaja ?? []).map((r: any) => ({ label: r.caja, value: r.total, hint: `${nfmt(r.count)} movimientos` }))}
          />
        </ChartCard>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard title="Detalle por caja" icon="list-tree">
          <DataTable rows={data.porCaja ?? []} empty="Sin datos." columns={[
            { key: "caja", header: "Caja", render: (r: any) => r.caja },
            { key: "n", header: "Mov.", align: "right", render: (r: any) => nfmt(r.count) },
            { key: "t", header: "Total", align: "right", render: (r: any) => <span className="font-semibold">{cop(r.total)}</span> },
          ]} />
        </ChartCard>
        <ChartCard title="Detalle por método" icon="list-tree">
          <DataTable rows={data.porMetodo ?? []} empty="Sin datos." columns={[
            { key: "m", header: "Método", render: (r: any) => r.metodo },
            { key: "n", header: "Mov.", align: "right", render: (r: any) => nfmt(r.count) },
            { key: "t", header: "Total", align: "right", render: (r: any) => <span className="font-semibold">{cop(r.total)}</span> },
          ]} />
        </ChartCard>
      </div>
    </>
  );
}
