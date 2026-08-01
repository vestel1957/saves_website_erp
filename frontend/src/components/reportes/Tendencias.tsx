import { ChartCard, AreaLineChart, TrendStat, compactCOP } from "@/components/charts";
import { DataTable } from "@/components/ui/DataTable";
import { cop } from "@/lib/subscribers";
import { monthLabel, nfmt } from "@/lib/reportes";
import { Section } from "./Section";

/** ¿La métrica es plata? Mismo criterio que el backend (`ES_DINERO`). */
const ES_DINERO = new Set(["cartera.total", "cartera.mora90", "recaudo.total", "facturacion.monto"]);

/**
 * Tendencias: la memoria histórica de la empresa.
 *
 * Es el único reporte que NO calcula sobre las tablas vivas: lee las fotos diarias
 * de `MetricPoint`. Por eso es el único que puede contestar "cuántos teníamos en
 * enero" — y también el único que a veces tiene que decir que un dato no existe.
 *
 * Ese aviso se muestra de forma prominente y no como nota al pie: una serie que
 * empieza en julio se lee como "arrancamos en julio" si nadie dice que antes
 * sencillamente no se estaba midiendo.
 */
export function Tendencias({ data }: { data: any }) {
  const serie: { fecha: string; valor: number }[] = data?.serie ?? [];
  const c = data?.comparacion;
  const dinero = ES_DINERO.has(data?.metrica);
  const fmt = (v: number | null | undefined) =>
    v == null ? "—" : dinero ? cop(v) : nfmt(Math.round(v));

  const total = serie.reduce((s, p) => s + p.valor, 0);
  // Hay métricas que NO se suman: los estados (cuántos abonados hay) y la base
  // facturable (abonados DISTINTOS por mes — el mismo cliente está en enero y en
  // febrero). En ellas el valor del periodo es el ÚLTIMO medido; sumarlas da un
  // número que no significa nada. Lo decide el backend (`NO_SUMABLES`).
  const esEstado = data?.noSumable === true;
  const valorPeriodo = esEstado ? serie.at(-1)?.valor ?? null : total;

  const variacion = c?.variacionPct;
  const tono = variacion == null ? "default" : variacion >= 0 ? "success" : "error";

  return (
    <>
      {!serie.length && (
        <Section>
          <div className="rounded-lg border border-warning-border bg-warning-surface p-4 text-sm text-warning-text">
            <p className="font-semibold">No hay histórico de este indicador en el periodo elegido.</p>
            <p className="mt-1">
              {data?.reconstruible === false
                ? "Este indicador es una foto diaria: solo existe desde que se empezó a medir y su pasado NO se puede reconstruir, porque el historial de estados del ERP no registró todos los cambios. Para saber cuántos clientes había en una fecha pasada, usa «Base facturable», que sí tiene histórico fiable."
                : "Prueba con otro rango de fechas."}
            </p>
          </div>
        </Section>
      )}

      {!!serie.length && (
        <Section>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <TrendStat
              label={esEstado ? `${data.etiqueta} (último periodo)` : `${data.etiqueta} (periodo)`}
              value={fmt(valorPeriodo)}
              icon="activity"
              hint={`${nfmt(serie.length)} periodo(s) con datos`}
            />
            <TrendStat
              label="Periodo anterior"
              value={fmt(c?.a?.valor)}
              icon="history"
              tone="default"
              hint={c?.a?.valor == null ? "sin datos para comparar" : `${c.a.desde} a ${c.a.hasta}`}
            />
            <TrendStat
              label="Variación"
              value={variacion == null ? "—" : `${variacion > 0 ? "+" : ""}${variacion}%`}
              icon={variacion != null && variacion < 0 ? "trending-down" : "trending-up"}
              tone={tono}
              hint={c?.diferencia == null ? "no comparable" : `${c.diferencia > 0 ? "+" : ""}${fmt(c.diferencia)}`}
            />
          </div>
          {c?.aviso && (
            <p className="mt-3 rounded-md bg-warning-surface px-3 py-2 text-xs text-warning-text">{c.aviso}</p>
          )}
        </Section>
      )}

      {!!serie.length && (
        // Una sola serie: sin leyenda a propósito — el título ya dice qué se está
        // mirando, y una caja con un solo color solo gastaría espacio.
        <ChartCard title={`Evolución · ${data.etiqueta}`} subtitle="Cada punto es un periodo medido" icon="trending-up">
          <AreaLineChart
            yFormat={dinero ? compactCOP : (v: number) => nfmt(Math.round(v))}
            labels={serie.map((p) => (p.fecha.endsWith("-01") ? monthLabel(p.fecha.slice(0, 7)) : p.fecha.slice(5)))}
            series={[{ name: data.etiqueta, color: "var(--color-brand)", points: serie.map((p) => p.valor) }]}
          />
        </ChartCard>
      )}

      {!!serie.length && (
        <ChartCard title="Detalle" icon="list-tree">
          <DataTable
            rows={serie}
            empty="Sin datos."
            columns={[
              {
                key: "f", header: "Periodo",
                render: (r: any) => (r.fecha.endsWith("-01") ? monthLabel(r.fecha.slice(0, 7)) : r.fecha),
              },
              { key: "v", header: data.etiqueta, align: "right", render: (r: any) => <span className="font-semibold">{fmt(r.valor)}</span> },
            ]}
          />
        </ChartCard>
      )}

      <ChartCard title="Desde cuándo hay datos" subtitle="Qué se pudo reconstruir del pasado y qué no" icon="database">
        <DataTable
          rows={data?.cobertura ?? []}
          empty="Todavía no se ha guardado ningún indicador."
          columns={[
            { key: "e", header: "Indicador", render: (r: any) => r.etiqueta },
            { key: "d", header: "Desde", render: (r: any) => r.desde },
            { key: "h", header: "Hasta", render: (r: any) => r.hasta },
            {
              key: "r", header: "Origen",
              render: (r: any) => (
                <span className={r.reconstruible ? "text-success-text" : "text-text-secondary"}>
                  {r.reconstruible ? "Reconstruido de documentos" : "Foto diaria (sin pasado)"}
                </span>
              ),
            },
          ]}
        />
      </ChartCard>
    </>
  );
}
