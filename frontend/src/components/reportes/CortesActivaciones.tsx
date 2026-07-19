import { ChartCard, BarChart, TrendStat } from "@/components/charts";
import { nfmt } from "@/lib/reportes";
import { Section } from "./Section";

export function CortesActivaciones({ data }: { data: any }) {
  const rows = [
    { label: "Activaciones", value: data.activaciones ?? 0, color: "var(--color-success)" },
    { label: "Cortes", value: data.cortes ?? 0, color: "var(--color-error)" },
    { label: "Suspensiones", value: data.suspensiones ?? 0, color: "var(--color-warning)" },
    { label: "Retiros", value: data.retiros ?? 0, color: "var(--color-text-tertiary)" },
  ];
  return (
    <>
      <Section>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <TrendStat label="Activaciones" value={nfmt(data.activaciones ?? 0)} icon="zap" tone="success" />
          <TrendStat label="Cortes" value={nfmt(data.cortes ?? 0)} icon="wifi-off" tone="error" />
          <TrendStat label="Suspensiones" value={nfmt(data.suspensiones ?? 0)} icon="history" tone="warning" />
          <TrendStat label="Retiros" value={nfmt(data.retiros ?? 0)} icon="log-out" />
        </div>
      </Section>
      <ChartCard title="Eventos de servicio en el periodo" subtitle="Comparativo de altas, cortes y bajas" icon="activity">
        <BarChart data={rows} />
      </ChartCard>
    </>
  );
}
