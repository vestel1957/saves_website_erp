import { ChartCard, DonutChart, TrendStat } from "@/components/charts";
import { nfmt } from "@/lib/reportes";
import { Section } from "./Section";

export function Movimientos({ data }: { data: any }) {
  const altas = data.altas ?? 0;
  const retiros = data.retiros ?? 0;
  const neto = data.neto ?? 0;
  return (
    <>
      <Section>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <TrendStat label="Altas (nuevos clientes)" value={nfmt(altas)} icon="user-plus" tone="success" />
          <TrendStat label="Retiros" value={nfmt(retiros)} icon="log-out" tone="error" />
          <TrendStat label="Crecimiento neto" value={`${neto >= 0 ? "+" : ""}${nfmt(neto)}`} icon="trending-up" tone={neto >= 0 ? "success" : "error"} hint={neto >= 0 ? "Base en crecimiento" : "Base en contracción"} />
        </div>
      </Section>
      <ChartCard title="Altas vs. retiros" subtitle="Movimiento de la base en el periodo" icon="layers">
        <DonutChart
          centerLabel="neto"
          centerValue={`${neto >= 0 ? "+" : ""}${nfmt(neto)}`}
          data={[
            { label: "Altas", value: altas, color: "var(--color-success)" },
            { label: "Retiros", value: retiros, color: "var(--color-error)" },
          ]}
        />
      </ChartCard>
    </>
  );
}
