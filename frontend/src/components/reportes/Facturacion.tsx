import { ChartCard, DonutChart, Gauge, TrendStat } from "@/components/charts";
import { cop } from "@/lib/subscribers";
import { nfmt } from "@/lib/reportes";
import { Section } from "./Section";

export function Facturacion({ data }: { data: any }) {
  const facturado = data.facturadoTotal ?? 0;
  const cartera = data.carteraTotal ?? 0;
  const recaudado = Math.max(facturado - cartera, 0);
  const pctRecaudo = facturado > 0 ? (recaudado / facturado) * 100 : 0;
  const pctPagadas = (data.total ?? 0) > 0 ? ((data.pagadas ?? 0) / data.total) * 100 : 0;
  return (
    <>
      <Section>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
          <TrendStat label="Facturas emitidas" value={nfmt(data.total ?? 0)} icon="receipt" hint="En el periodo" />
          <TrendStat label="Total facturado" value={cop(facturado)} icon="banknote" hint="Base de ingreso" />
          <TrendStat label="Facturas pagadas" value={nfmt(data.pagadas ?? 0)} icon="check" tone="success" hint={`${pctPagadas.toFixed(0)}% del total`} />
          <TrendStat label="Cartera pendiente" value={cop(cartera)} icon="alert-triangle" tone="error" hint="Por cobrar" />
          <TrendStat label="Facturas en mora" value={nfmt(data.carteraFacturas ?? 0)} icon="hourglass" tone="error" hint="Vencidas" />
        </div>
      </Section>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard title="Nivel de recaudo" subtitle="Facturado efectivamente cobrado" icon="target">
          <div className="flex flex-col items-center gap-3 sm:flex-row sm:justify-around">
            <Gauge pct={pctRecaudo} label="cobrado" />
            <div className="flex flex-col gap-2 text-[13px]">
              <div className="flex items-center justify-between gap-6"><span className="text-text-secondary">Recaudado</span><span className="font-bold text-success-text">{cop(recaudado)}</span></div>
              <div className="flex items-center justify-between gap-6"><span className="text-text-secondary">Pendiente</span><span className="font-bold text-error-text">{cop(cartera)}</span></div>
              <div className="mt-1 border-t border-border-subtle pt-2 flex items-center justify-between gap-6"><span className="text-text-secondary">Facturado</span><span className="font-bold text-text-primary">{cop(facturado)}</span></div>
            </div>
          </div>
        </ChartCard>
        <ChartCard title="Estado de las facturas" subtitle="Pagadas vs. pendientes de cobro" icon="layers">
          <DonutChart
            centerLabel="facturas"
            centerValue={nfmt(data.total ?? 0)}
            data={[
              { label: "Pagadas", value: data.pagadas ?? 0, color: "var(--color-success)" },
              { label: "En mora / pendientes", value: Math.max((data.total ?? 0) - (data.pagadas ?? 0), 0), color: "var(--color-error)" },
            ]}
          />
        </ChartCard>
      </div>
    </>
  );
}
