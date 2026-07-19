import { ChartCard, DonutChart, HBarList } from "@/components/charts";
import { nfmt } from "@/lib/reportes";

export function Ordenes({ data }: { data: any }) {
  const porEstado = data.porEstado ?? [];
  const porTipo = data.porTipo ?? [];
  const porTecnico = data.porTecnico ?? [];
  const total = porEstado.reduce((s: number, r: any) => s + (r.count ?? 0), 0);
  return (
    <>
      <ChartCard title="Órdenes por estado" subtitle={`${nfmt(total)} órdenes en el periodo`} icon="layers">
        <DonutChart centerLabel="órdenes" centerValue={nfmt(total)} data={porEstado.map((r: any) => ({ label: r.estado, value: r.count }))} />
      </ChartCard>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard title="Por tipo de orden" subtitle="Motivos más frecuentes" icon="list">
          <HBarList rows={porTipo.map((r: any) => ({ label: r.tipo, value: r.count }))} />
        </ChartCard>
        <ChartCard title="Carga por técnico" subtitle="Órdenes asignadas" icon="users">
          <HBarList monochrome rows={porTecnico.map((r: any) => ({ label: r.tecnico, value: r.count }))} />
        </ChartCard>
      </div>
    </>
  );
}
