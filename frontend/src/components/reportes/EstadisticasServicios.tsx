import { ChartCard, DonutChart, HBarList, colorAt } from "@/components/charts";
import { DataTable } from "@/components/ui/DataTable";
import { nfmt } from "@/lib/reportes";

export function EstadisticasServicios({ data }: { data: any }) {
  const estados = Object.entries(data.estados ?? {}) as [string, number][];
  const toneFor = (k: string) =>
    k === "ACTIVO" ? "var(--color-success)" : k === "CORTADO" ? "var(--color-error)" : k === "CARTERA" ? "var(--color-warning)" : k === "SUSPENDIDO" ? "var(--color-info)" : undefined;
  const totalBase = estados.reduce((s, [, v]) => s + Number(v), 0);
  const porSede = data.porSede ?? [];
  return (
    <>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard title="Base de clientes por estado" subtitle="Distribución de toda la base" icon="users">
          <DonutChart
            centerLabel="clientes"
            centerValue={nfmt(totalBase)}
            data={estados.map(([k, v], i) => ({ label: k, value: Number(v), color: toneFor(k) ?? colorAt(i) }))}
          />
        </ChartCard>
        <ChartCard title="Clientes por sede" subtitle="Tamaño de cada sede" icon="bar-chart-3">
          <HBarList monochrome rows={porSede.map((r: any) => ({ label: r.sede, value: r.total, hint: `${nfmt(r.activos)} activos · ${nfmt(r.cartera)} en cartera` }))} />
        </ChartCard>
      </div>
      <ChartCard title="Detalle por sede" icon="list-tree">
        <DataTable rows={porSede} empty="Sin datos." columns={[
          { key: "sede", header: "Sede", render: (r: any) => <span className="font-medium text-text-primary">{r.sede}</span> },
          { key: "total", header: "Total", align: "right", render: (r: any) => nfmt(r.total) },
          { key: "act", header: "Activos", align: "right", render: (r: any) => <span className="text-success-text">{nfmt(r.activos)}</span> },
          { key: "cort", header: "Cortados", align: "right", render: (r: any) => <span className="text-error-text">{nfmt(r.cortados)}</span> },
          { key: "cart", header: "Cartera", align: "right", render: (r: any) => <span className="text-warning-text">{nfmt(r.cartera)}</span> },
        ]} />
      </ChartCard>
    </>
  );
}
