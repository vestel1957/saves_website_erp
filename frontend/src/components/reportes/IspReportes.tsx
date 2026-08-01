import { ChartCard, AreaLineChart, TrendStat, compactCOP } from "@/components/charts";
import { DataTable } from "@/components/ui/DataTable";
import { cop } from "@/lib/subscribers";
import { monthLabel, nfmt } from "@/lib/reportes";
import { Section } from "./Section";

/**
 * Los cinco reportes propios de un ISP.
 *
 * Viven juntos porque comparten la misma idea: no describen el ERP, describen el
 * NEGOCIO de vender internet. Cada uno lleva su advertencia de lectura al lado del
 * dato y no al pie — son reportes que se malinterpretan solos (un índice de recaudo
 * del 167% parece un error, y no lo es).
 */

const pctTxt = (v: number | null | undefined) => (v == null ? "—" : `${v}%`);

/** De lo que se factura, cuánto entra. */
export function IndiceRecaudo({ data }: { data: any }) {
  const t = data?.totales ?? {};
  const items = data?.items ?? [];
  return (
    <>
      <Section>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <TrendStat label="Facturado" value={cop(t.facturado)} icon="receipt" />
          <TrendStat label="Recaudado" value={cop(t.recaudado)} icon="banknote" tone="success" />
          <TrendStat label="Índice de recaudo" value={pctTxt(t.indice)} icon="percent"
            tone={(t.indice ?? 0) >= 100 ? "success" : "warning"} />
          <TrendStat label="Diferencia" value={cop(t.diferencia)} icon="scale"
            tone={(t.diferencia ?? 0) >= 0 ? "success" : "error"} />
        </div>
        <p className="mt-3 rounded-md bg-surface-2 px-3 py-2 text-xs text-text-secondary">
          El índice <strong>puede pasar del 100% y no es un error</strong>: el recaudo de un mes incluye pagos de
          facturas viejas. Por encima de 100 se está recuperando cartera; varios meses por debajo significa que la
          cartera crece.
        </p>
      </Section>
      <ChartCard title="Facturado contra recaudado" subtitle="Mes a mes" icon="activity">
        <AreaLineChart
          yFormat={compactCOP}
          labels={items.map((r: any) => monthLabel(r.mes))}
          series={[
            { name: "Facturado", color: "var(--color-brand)", points: items.map((r: any) => r.facturado) },
            { name: "Recaudado", color: "var(--color-success)", points: items.map((r: any) => r.recaudado) },
          ]}
        />
      </ChartCard>
      <ChartCard title="Detalle mensual" icon="list-tree">
        <DataTable rows={items} empty="Sin datos." columns={[
          { key: "m", header: "Mes", render: (r: any) => monthLabel(r.mes) },
          { key: "f", header: "Facturado", align: "right", render: (r: any) => cop(r.facturado) },
          { key: "r", header: "Recaudado", align: "right", render: (r: any) => cop(r.recaudado) },
          { key: "d", header: "Diferencia", align: "right", render: (r: any) => (
            <span className={r.diferencia >= 0 ? "text-success-text" : "text-error-text"}>{cop(r.diferencia)}</span>) },
          { key: "i", header: "Índice", align: "right", render: (r: any) => <span className="font-semibold">{pctTxt(r.indice)}</span> },
        ]} />
      </ChartCard>
    </>
  );
}

/** Cuánto deja cada cliente al mes. */
export function Arpu({ data }: { data: any }) {
  const r = data?.resumen ?? {};
  const items = data?.items ?? [];
  return (
    <>
      <Section>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <TrendStat label="ARPU recaudado" value={cop(r.arpuActual)} icon="banknote" tone="success" hint={r.ultimoMes ?? ""} />
          <TrendStat label="ARPU facturado" value={cop(r.arpuFacturadoActual)} icon="receipt" />
          <TrendStat label="Abonados" value={nfmt(r.abonadosActual ?? 0)} icon="users" />
          <TrendStat label="Variación del periodo"
            value={r.variacionPct == null ? "—" : `${r.variacionPct > 0 ? "+" : ""}${r.variacionPct}%`}
            icon={(r.variacionPct ?? 0) < 0 ? "trending-down" : "trending-up"}
            tone={(r.variacionPct ?? 0) < 0 ? "error" : "success"} />
        </div>
        <p className="mt-3 rounded-md bg-surface-2 px-3 py-2 text-xs text-text-secondary">
          El divisor son los abonados <strong>facturados</strong> del mes, no los &quot;activos&quot;: el estado activo
          de un mes pasado no se puede reconstruir de forma fiable, mientras que a quién se le facturó sale de las
          facturas y es auditable.
        </p>
      </Section>
      <ChartCard title="Evolución del ARPU" subtitle="Ingreso medio por abonado" icon="trending-up">
        <AreaLineChart
          yFormat={compactCOP}
          labels={items.map((r2: any) => monthLabel(r2.mes))}
          series={[
            { name: "Recaudado", color: "var(--color-brand)", points: items.map((r2: any) => r2.arpuRecaudado ?? 0) },
            { name: "Facturado", color: "var(--color-brand-2)", points: items.map((r2: any) => r2.arpuFacturado ?? 0) },
          ]}
        />
      </ChartCard>
      <ChartCard title="Detalle mensual" icon="list-tree">
        <DataTable rows={items} empty="Sin datos." columns={[
          { key: "m", header: "Mes", render: (x: any) => monthLabel(x.mes) },
          { key: "a", header: "Abonados", align: "right", render: (x: any) => nfmt(x.abonados) },
          { key: "af", header: "ARPU facturado", align: "right", render: (x: any) => cop(x.arpuFacturado) },
          { key: "ar", header: "ARPU recaudado", align: "right", render: (x: any) => <span className="font-semibold">{cop(x.arpuRecaudado)}</span> },
        ]} />
      </ChartCard>
    </>
  );
}

/** Dónde se puede conectar sin obra. */
export function CapacidadRed({ data }: { data: any }) {
  const r = data?.resumen ?? {};
  return (
    <>
      <Section>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <TrendStat label="Puertos libres" value={nfmt(r.libres ?? 0)} icon="plug" tone="success" />
          <TrendStat label="Puertos ocupados" value={nfmt(r.ocupados ?? 0)} icon="users" />
          <TrendStat label="Ocupación" value={pctTxt(r.ocupacionPct)} icon="percent" />
          <TrendStat label="NAPs llenas" value={nfmt(r.saturadas ?? 0)} icon="alert-triangle"
            tone={(r.saturadas ?? 0) > 0 ? "error" : "success"} hint={`${nfmt(r.casiLlenas ?? 0)} por encima del 90%`} />
        </div>
        {!!r.sinInventario && (
          <p className="mt-3 rounded-md bg-warning-surface px-3 py-2 text-xs text-warning-text">
            {nfmt(r.sinInventario)} NAP(s) no tienen ni un puerto registrado: no se sabe si están llenas o vacías y{" "}
            <strong>no cuentan como disponibles</strong>. Es inventario pendiente, no capacidad.
          </p>
        )}
      </Section>
      <ChartCard title="Puertos libres por sede" subtitle="Dónde hay capacidad para vender" icon="landmark">
        <DataTable rows={data?.porSede ?? []} empty="Sin datos." columns={[
          { key: "s", header: "Sede", render: (x: any) => x.sede },
          { key: "n", header: "NAPs", align: "right", render: (x: any) => nfmt(x.naps) },
          { key: "l", header: "Libres", align: "right", render: (x: any) => <span className="font-semibold text-success-text">{nfmt(x.libres)}</span> },
          { key: "o", header: "Ocupados", align: "right", render: (x: any) => nfmt(x.ocupados) },
          { key: "sa", header: "Llenas", align: "right", render: (x: any) => (
            <span className={x.saturadas > 0 ? "text-error-text" : ""}>{nfmt(x.saturadas)}</span>) },
        ]} />
      </ChartCard>
      <ChartCard title="NAPs llenas o casi llenas" subtitle="Ordenadas por cuántos clientes cuelgan de cada una" icon="alert-triangle">
        <DataTable rows={data?.criticas ?? []} empty="Ninguna NAP está llena ni por encima del 90%." columns={[
          { key: "n", header: "NAP", render: (x: any) => x.nap },
          { key: "s", header: "Sede", render: (x: any) => x.sede },
          { key: "d", header: "Dirección", render: (x: any) => x.direccion ?? "—" },
          { key: "o", header: "Ocupados", align: "right", render: (x: any) => nfmt(x.ocupados) },
          { key: "l", header: "Libres", align: "right", render: (x: any) => (
            <span className={x.libres === 0 ? "font-semibold text-error-text" : "font-semibold"}>{nfmt(x.libres)}</span>) },
        ]} />
      </ChartCard>
    </>
  );
}

/** Quién entra en ciclo de corte y reconexión. */
export function Reincidencia({ data }: { data: any }) {
  const r = data?.resumen ?? {};
  return (
    <>
      <Section>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <TrendStat label="Clientes con reconexión" value={nfmt(r.clientes ?? 0)} icon="users" />
          <TrendStat label="Reconexiones" value={nfmt(r.reconexiones ?? 0)} icon="refresh-cw" />
          <TrendStat label="Crónicos (3 o más)" value={nfmt(r.cronicos ?? 0)} icon="alert-triangle" tone="warning" />
          <TrendStat label="Deuda de los crónicos" value={cop(r.deudaCronicos)} icon="banknote" tone="error" />
        </div>
        <p className="mt-3 rounded-md bg-surface-2 px-3 py-2 text-xs text-text-secondary">
          Un cliente que se corta y reconecta todos los meses es un problema de <strong>cobranza</strong>, no técnico:
          cambiarle el equipo no lo arregla. Por eso al lado va lo que debe.
        </p>
      </Section>
      <ChartCard title="Cuántas veces se les reconectó" subtitle="Distribución sobre TODOS los clientes del periodo" icon="bar-chart">
        <DataTable rows={data?.distribucion ?? []} empty="Sin reconexiones." columns={[
          { key: "v", header: "Reconexiones en el periodo", render: (x: any) => `${x.veces} vez/veces` },
          { key: "c", header: "Clientes", align: "right", render: (x: any) => <span className="font-semibold">{nfmt(x.clientes)}</span> },
        ]} />
      </ChartCard>
      <ChartCard title="Los que más se reconectan" subtitle="Muestra de los 100 primeros — los totales de arriba salen del universo completo" icon="list-tree">
        <DataTable rows={data?.items ?? []} empty="Sin datos." columns={[
          { key: "c", header: "Cliente", render: (x: any) => x.cliente },
          { key: "a", header: "Abonado", align: "right", render: (x: any) => x.abonado ?? "—" },
          { key: "s", header: "Sede", render: (x: any) => x.sede },
          { key: "e", header: "Estado", render: (x: any) => x.estado },
          { key: "r", header: "Reconex.", align: "right", render: (x: any) => <span className="font-semibold">{nfmt(x.reconexiones)}</span> },
          { key: "d", header: "Debe", align: "right", render: (x: any) => (
            <span className={x.deuda > 0 ? "text-error-text" : ""}>{cop(x.deuda)}</span>) },
        ]} />
      </ChartCard>
    </>
  );
}

/** De los que entraron cada año, cuántos siguen. */
export function Permanencia({ data }: { data: any }) {
  const r = data?.resumen ?? {};
  const co = data?.cohortes ?? [];
  return (
    <>
      <Section>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <TrendStat label="Antigüedad media" value={`${Math.round(((r.antiguedadMediaMeses ?? 0) / 12) * 10) / 10} años`} icon="history" />
          <TrendStat label="Cohortes medidas" value={nfmt(r.cohortes ?? 0)} icon="layers" />
          <TrendStat label="Sin fecha de ingreso" value={nfmt(r.sinFechaIngreso ?? 0)} icon="alert-triangle"
            tone={(r.sinFechaIngreso ?? 0) > 0 ? "warning" : "default"} hint="quedan fuera de las cohortes" />
        </div>
        <p className="mt-3 rounded-md bg-surface-2 px-3 py-2 text-xs text-text-secondary">
          Mide <strong>quién sigue hasta hoy</strong>, no cuándo se fue cada uno. Y los años recientes tienen retención
          alta por definición: han tenido menos tiempo para irse — compara años completos con años completos.
        </p>
      </Section>
      <ChartCard title="Retención por año de ingreso" subtitle="De los que entraron, cuántos siguen activos" icon="trending-down">
        <AreaLineChart
          yFormat={(v: number) => `${Math.round(v)}%`}
          labels={co.map((c: any) => c.anio)}
          series={[{ name: "Retención", color: "var(--color-brand)", points: co.map((c: any) => c.retencionPct ?? 0) }]}
        />
      </ChartCard>
      <ChartCard title="Cohortes" icon="list-tree">
        <DataTable rows={co} empty="Sin datos." columns={[
          { key: "a", header: "Año", render: (c: any) => c.anio },
          { key: "i", header: "Entraron", align: "right", render: (c: any) => nfmt(c.ingresaron) },
          { key: "ac", header: "Siguen activos", align: "right", render: (c: any) => nfmt(c.activos) },
          { key: "re", header: "Retirados", align: "right", render: (c: any) => nfmt(c.retirados) },
          { key: "p", header: "Retención", align: "right", render: (c: any) => <span className="font-semibold">{pctTxt(c.retencionPct)}</span> },
        ]} />
      </ChartCard>
      <ChartCard title="Antigüedad de los clientes activos" icon="bar-chart">
        <DataTable rows={data?.antiguedad ?? []} empty="Sin datos." columns={[
          { key: "t", header: "Tramo", render: (a: any) => a.tramo },
          { key: "c", header: "Clientes", align: "right", render: (a: any) => <span className="font-semibold">{nfmt(a.clientes)}</span> },
        ]} />
      </ChartCard>
    </>
  );
}
