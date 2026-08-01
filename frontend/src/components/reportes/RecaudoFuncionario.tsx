import { ChartCard, HBarList, TrendStat, AreaLineChart, compactCOP } from "@/components/charts";
import { DataTable } from "@/components/ui/DataTable";
import { cop } from "@/lib/subscribers";
import { nfmt } from "@/lib/reportes";
import { Section } from "./Section";

export function RecaudoFuncionario({ data }: { data: any }) {
  const funcionarios = data.funcionarios ?? [];
  const diario = data.diario ?? [];
  const top = funcionarios[0];

  return (
    <>
      <Section>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <TrendStat label="Recaudado en el periodo" value={cop(data.total ?? 0)} icon="banknote" tone="success"
            hint={`${nfmt(data.movimientos ?? 0)} movimientos`} />
          <TrendStat label="Funcionarios que recaudaron" value={nfmt(funcionarios.length)} icon="contact" />
          <TrendStat label="Mayor recaudo" value={top?.nombre ?? "—"} icon="user"
            hint={top ? `${cop(top.total)} · ${top.participacion}% del total` : ""} />
          <TrendStat label="Ticket promedio" value={cop(data.movimientos ? Math.round((data.total ?? 0) / data.movimientos) : 0)} icon="receipt"
            hint="Valor medio por movimiento" />
        </div>
      </Section>

      {diario.length > 1 && (
        <ChartCard title="Recaudo día a día" subtitle="Ingresos vigentes del periodo" icon="trending-up">
          <AreaLineChart
            series={[{ name: "Recaudo", points: diario.map((d: any) => d.total) }]}
            labels={diario.map((d: any) => new Date(d.dia).toLocaleDateString("es-CO", { day: "2-digit", month: "short" }))}
            yFormat={compactCOP}
          />
        </ChartCard>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard title="Recaudo por funcionario" subtitle="Quién movió cuánta plata" icon="contact">
          <HBarList valueFormat={compactCOP}
            rows={funcionarios.slice(0, 12).map((f: any) => ({ label: f.nombre, value: f.total, hint: `${nfmt(f.movimientos)} mov.` }))} />
        </ChartCard>
        <ChartCard title="Por método de pago" subtitle="Cómo paga la gente" icon="wallet">
          <HBarList monochrome valueFormat={compactCOP}
            rows={(data.porMetodo ?? []).map((m: any) => ({ label: m.metodo, value: m.total, hint: `${nfmt(m.movimientos)} mov.` }))} />
        </ChartCard>
      </div>

      <ChartCard title="Detalle por funcionario" icon="list-tree">
        <DataTable rows={funcionarios} empty="Nadie recaudó en este periodo." columns={[
          { key: "n", header: "Funcionario", render: (r: any) => (
            <span className="font-medium text-text-primary">{r.nombre}</span>
          ) },
          { key: "m", header: "Movimientos", align: "right", render: (r: any) => nfmt(r.movimientos) },
          { key: "t", header: "Total recaudado", align: "right", render: (r: any) => <span className="font-semibold text-success-text">{cop(r.total)}</span> },
          { key: "p", header: "Promedio", align: "right", render: (r: any) => cop(r.promedio) },
          { key: "pa", header: "Participación", align: "right", render: (r: any) => `${r.participacion}%` },
        ]} />
      </ChartCard>

      <ChartCard title="Por caja" subtitle="Dónde entró la plata" icon="landmark">
        <DataTable rows={data.porCaja ?? []} empty="Sin cajas con movimiento." columns={[
          { key: "c", header: "Caja", render: (r: any) => r.caja },
          { key: "m", header: "Movimientos", align: "right", render: (r: any) => nfmt(r.movimientos) },
          { key: "t", header: "Total", align: "right", render: (r: any) => cop(r.total) },
        ]} />
      </ChartCard>
    </>
  );
}
