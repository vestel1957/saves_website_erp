"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { PageHeading } from "@/components/accounting/PageHeading";
import { Icon } from "@/components/Icon";
import { Input, Field } from "@/components/ui/Field";
import { DataTable } from "@/components/inventory/DataTable";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import {
  ChartCard,
  AreaLineChart,
  BarChart,
  DonutChart,
  HBarList,
  Gauge,
  TrendStat,
  compactCOP,
  colorAt,
} from "@/components/charts";
import { exportReportPDF, exportReportExcel, type ReportDoc } from "@/lib/report-export";
import { useAuth } from "@/context/AuthProvider";
import { cop } from "@/lib/subscribers";

const nfmt = (n: number) => (n ?? 0).toLocaleString("es-CO");
const MONTHS = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
const monthLabel = (m: string) => {
  const [y, mm] = (m || "-").split("-");
  return `${MONTHS[Number(mm) - 1] ?? mm} ${(y || "").slice(2)}`;
};

const REPORTS: { key: string; label: string; icon: string; dated: boolean; endpoint?: string }[] = [
  { key: "facturacion", label: "Resumen de facturación", icon: "receipt", dated: false, endpoint: "/billing/stats" },
  { key: "recaudo", label: "Recaudo", icon: "banknote", dated: true },
  { key: "ventas-sede", label: "Ventas por sede", icon: "receipt", dated: true },
  { key: "ingresos-egresos", label: "Ingresos y egresos", icon: "trending-up", dated: false },
  { key: "ordenes", label: "Órdenes de servicio", icon: "headphones", dated: true },
  { key: "top-deudores", label: "Cartera / deudores", icon: "alert-triangle", dated: false },
  { key: "estadisticas-servicios", label: "Estado de clientes", icon: "users", dated: false },
  { key: "cortes-activaciones", label: "Cortes y activaciones", icon: "activity", dated: true },
  { key: "movimientos", label: "Altas y retiros", icon: "trending-up", dated: true },
];

/** Marco de sección con un título discreto sobre una grilla de tarjetas. */
function Section({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      {title && <h2 className="text-[13px] font-bold uppercase tracking-wide text-text-tertiary">{title}</h2>}
      {children}
    </div>
  );
}

/** Presets de rango de fecha típicos de gerencia. */
function datePresets(): { label: string; from: string; to: string }[] {
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  return [
    { label: "Este mes", from: iso(new Date(y, m, 1)), to: iso(new Date(y, m + 1, 0)) },
    { label: "Mes anterior", from: iso(new Date(y, m - 1, 1)), to: iso(new Date(y, m, 0)) },
    { label: "Este año", from: iso(new Date(y, 0, 1)), to: iso(new Date(y, 11, 31)) },
  ];
}

/* ------------------------------------------------------------------ */
/*  Construcción del documento exportable (PDF / Excel) por reporte     */
/* ------------------------------------------------------------------ */
function buildExportDoc(rep: string, label: string, data: any, from: string, to: string): ReportDoc | null {
  if (!data) return null;
  const periodo = from || to ? `Periodo: ${from || "inicio"} → ${to || "hoy"}` : "Histórico";
  const doc: ReportDoc = { title: `Reporte · ${label}`, subtitle: periodo, tables: [] };

  switch (rep) {
    case "facturacion":
      doc.tables.push({
        columns: [{ label: "Indicador" }, { label: "Valor", align: "right", money: false }],
        rows: [
          { cells: ["Facturas emitidas", data.total ?? 0] },
          { cells: ["Total facturado", data.facturadoTotal ?? 0], bold: true },
          { cells: ["Facturas pagadas", data.pagadas ?? 0] },
          { cells: ["Cartera pendiente", data.carteraTotal ?? 0] },
          { cells: ["Facturas en mora", data.carteraFacturas ?? 0] },
        ],
      });
      break;
    case "recaudo":
      doc.tables.push({
        heading: "Por caja",
        columns: [{ label: "Caja" }, { label: "Mov.", align: "right" }, { label: "Total", align: "right", money: true }],
        rows: (data.porCaja ?? []).map((r: any) => ({ cells: [r.caja, r.count, r.total] })),
      });
      doc.tables.push({
        heading: "Por método",
        columns: [{ label: "Método" }, { label: "Mov.", align: "right" }, { label: "Total", align: "right", money: true }],
        rows: (data.porMetodo ?? []).map((r: any) => ({ cells: [r.metodo, r.count, r.total] })),
      });
      break;
    case "ventas-sede":
      doc.tables.push({
        columns: [{ label: "Sede" }, { label: "Facturas", align: "right" }, { label: "Total facturado", align: "right", money: true }],
        rows: (data.items ?? []).map((r: any) => ({ cells: [r.sede, r.facturas, r.total] })),
      });
      break;
    case "ingresos-egresos":
      doc.tables.push({
        columns: [
          { label: "Mes" },
          { label: "Ingresos", align: "right", money: true },
          { label: "Egresos", align: "right", money: true },
          { label: "Balance", align: "right", money: true },
        ],
        rows: (data.items ?? []).map((r: any) => ({ cells: [monthLabel(r.month), r.income, r.expense, r.balance] })),
      });
      break;
    case "ordenes":
      doc.tables.push({
        heading: "Por estado",
        columns: [{ label: "Estado" }, { label: "Cantidad", align: "right" }],
        rows: (data.porEstado ?? []).map((r: any) => ({ cells: [r.estado, r.count] })),
      });
      doc.tables.push({
        heading: "Por tipo",
        columns: [{ label: "Tipo" }, { label: "Cantidad", align: "right" }],
        rows: (data.porTipo ?? []).map((r: any) => ({ cells: [r.tipo, r.count] })),
      });
      doc.tables.push({
        heading: "Por técnico",
        columns: [{ label: "Técnico" }, { label: "Cantidad", align: "right" }],
        rows: (data.porTecnico ?? []).map((r: any) => ({ cells: [r.tecnico, r.count] })),
      });
      break;
    case "estadisticas-servicios":
      doc.tables.push({
        heading: "Base por sede",
        columns: [
          { label: "Sede" },
          { label: "Total", align: "right" },
          { label: "Activos", align: "right" },
          { label: "Cortados", align: "right" },
          { label: "Cartera", align: "right" },
        ],
        rows: (data.porSede ?? []).map((r: any) => ({ cells: [r.sede, r.total, r.activos, r.cortados, r.cartera] })),
      });
      break;
    case "cortes-activaciones":
      doc.tables.push({
        columns: [{ label: "Evento" }, { label: "Cantidad", align: "right" }],
        rows: [
          { cells: ["Activaciones", data.activaciones ?? 0] },
          { cells: ["Cortes", data.cortes ?? 0] },
          { cells: ["Suspensiones", data.suspensiones ?? 0] },
          { cells: ["Retiros", data.retiros ?? 0] },
        ],
      });
      break;
    case "movimientos":
      doc.tables.push({
        columns: [{ label: "Movimiento" }, { label: "Cantidad", align: "right" }],
        rows: [
          { cells: ["Altas (nuevos)", data.altas ?? 0] },
          { cells: ["Retiros", data.retiros ?? 0] },
          { cells: ["Neto", data.neto ?? 0], bold: true },
        ],
      });
      break;
    case "top-deudores":
      doc.tables.push({
        columns: [
          { label: "Abonado" },
          { label: "Cliente" },
          { label: "Facturas", align: "right" },
          { label: "Deuda", align: "right", money: true },
        ],
        rows: (data.items ?? []).map((r: any) => ({ cells: [r.abonado, r.name, r.facturas, r.balance] })),
      });
      break;
    default:
      return null;
  }
  return doc;
}

/* Menú de exportación (PDF / Excel). */
function ExportMenu({ doc }: { doc: ReportDoc | null }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);
  const disabled = !doc || doc.tables.every((t) => t.rows.length === 0);
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        className="inline-flex items-center gap-1.5 rounded-lg border border-border-default bg-surface px-3 py-2 text-[12px] font-semibold text-text-secondary shadow-sm transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Icon name="download" size={14} /> Exportar <Icon name="chevron-down" size={13} />
      </button>
      {open && doc && (
        <div className="absolute right-0 z-20 mt-1 w-40 overflow-hidden rounded-lg border border-border-subtle bg-surface py-1 shadow-lg">
          <button onClick={() => { exportReportPDF(doc); setOpen(false); }} className="flex w-full items-center gap-2 px-3 py-2 text-[12px] text-text-secondary hover:bg-surface-2">
            <Icon name="file-text" size={14} /> PDF (imprimir)
          </button>
          <button onClick={() => { exportReportExcel(doc); setOpen(false); }} className="flex w-full items-center gap-2 px-3 py-2 text-[12px] text-text-secondary hover:bg-surface-2">
            <Icon name="file-spreadsheet" size={14} /> Excel (.xls)
          </button>
        </div>
      )}
    </div>
  );
}

export default function ReportesPage() {
  const { loading: authLoading, authFetch } = useAuth();
  const [rep, setRep] = useState("facturacion");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const meta = REPORTS.find((r) => r.key === rep)!;

  const load = useCallback(async () => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (meta.dated) { if (from) qs.set("from", from); if (to) qs.set("to", to); }
    const path = meta.endpoint ?? `/reports/${rep}`;
    try { setData(await (await authFetch(`${path}?${qs}`)).json()); }
    finally { setLoading(false); }
  }, [authFetch, rep, from, to, meta.dated, meta.endpoint]);

  useEffect(() => { if (!authLoading) void load(); }, [authLoading, load]);

  const exportDoc = useMemo(() => buildExportDoc(rep, meta.label, data, from, to), [rep, meta.label, data, from, to]);

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeading icon="file-spreadsheet" title="Reportes de gerencia" subtitle="Recaudo, cartera, ventas y operación · con gráficos y cifras exactas" />
        <ExportMenu doc={exportDoc} />
      </div>

      {/* Selector de reporte */}
      <div className="flex flex-wrap gap-2">
        {REPORTS.map((r) => (
          <button key={r.key} onClick={() => setRep(r.key)}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-[12px] font-semibold transition-colors ${rep === r.key ? "border-brand bg-brand-soft text-brand" : "border-border-subtle bg-surface text-text-secondary hover:bg-surface-2"}`}>
            <Icon name={r.icon} size={14} /> {r.label}
          </button>
        ))}
      </div>

      {/* Filtros de fecha + presets */}
      {meta.dated && (
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Desde"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="Hasta"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
          <div className="flex flex-wrap gap-1.5 pb-0.5">
            {datePresets().map((p) => (
              <button key={p.label} onClick={() => { setFrom(p.from); setTo(p.to); }}
                className="rounded-lg border border-border-subtle bg-surface px-2.5 py-2 text-[11px] font-medium text-text-secondary hover:bg-surface-2">
                {p.label}
              </button>
            ))}
          </div>
          {(from || to) && <button onClick={() => { setFrom(""); setTo(""); }} className="rounded-lg border border-border-default px-3 py-2 text-[12px] text-text-secondary hover:bg-surface-2">Limpiar</button>}
        </div>
      )}

      {loading || !data ? <PageSkeleton /> : (
        <div className="flex flex-col gap-6">
          {rep === "facturacion" && <Facturacion data={data} />}
          {rep === "recaudo" && <Recaudo data={data} />}
          {rep === "ventas-sede" && <VentasSede data={data} />}
          {rep === "ingresos-egresos" && <IngresosEgresos data={data} />}
          {rep === "ordenes" && <Ordenes data={data} />}
          {rep === "estadisticas-servicios" && <EstadisticasServicios data={data} />}
          {rep === "cortes-activaciones" && <CortesActivaciones data={data} />}
          {rep === "movimientos" && <Movimientos data={data} />}
          {rep === "top-deudores" && <TopDeudores data={data} />}
        </div>
      )}
    </>
  );
}

/* =================================================================== */
/*  Secciones por reporte                                               */
/* =================================================================== */

function Facturacion({ data }: { data: any }) {
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

function Recaudo({ data }: { data: any }) {
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

function VentasSede({ data }: { data: any }) {
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

function IngresosEgresos({ data }: { data: any }) {
  const items = data.items ?? [];
  const totalIn = items.reduce((s: number, r: any) => s + (r.income ?? 0), 0);
  const totalOut = items.reduce((s: number, r: any) => s + (r.expense ?? 0), 0);
  const balance = totalIn - totalOut;
  return (
    <>
      <Section>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <TrendStat label="Ingresos (periodo)" value={cop(totalIn)} icon="trending-up" tone="success" hint={`${nfmt(items.length)} meses`} />
          <TrendStat label="Egresos (periodo)" value={cop(totalOut)} icon="trending-down" tone="error" hint="Gastos y costos" />
          <TrendStat label="Balance neto" value={cop(balance)} icon="scale" tone={balance >= 0 ? "success" : "error"} hint={balance >= 0 ? "Superávit" : "Déficit"} />
        </div>
      </Section>
      <ChartCard
        title="Ingresos vs. egresos por mes"
        subtitle="Flujo de caja de los últimos meses"
        icon="activity"
        action={
          <span className="flex gap-3 text-[11px]">
            <span className="flex items-center gap-1"><span className="h-[3px] w-4 rounded-full" style={{ background: "var(--color-brand)" }} /> Ingresos</span>
            <span className="flex items-center gap-1"><span className="h-[3px] w-4 rounded-full" style={{ background: "var(--color-error)" }} /> Egresos</span>
          </span>
        }
      >
        <AreaLineChart
          yFormat={compactCOP}
          labels={items.map((r: any) => monthLabel(r.month))}
          series={[
            { name: "Ingresos", color: "var(--color-brand)", points: items.map((r: any) => r.income ?? 0) },
            { name: "Egresos", color: "var(--color-error)", points: items.map((r: any) => r.expense ?? 0) },
          ]}
        />
      </ChartCard>
      <ChartCard title="Detalle mensual" icon="list-tree">
        <DataTable rows={items} empty="Sin datos." columns={[
          { key: "m", header: "Mes", render: (r: any) => monthLabel(r.month) },
          { key: "i", header: "Ingresos", align: "right", render: (r: any) => <span className="text-success-text">{cop(r.income)}</span> },
          { key: "e", header: "Egresos", align: "right", render: (r: any) => <span className="text-error-text">{cop(r.expense)}</span> },
          { key: "b", header: "Balance", align: "right", render: (r: any) => <span className={`font-semibold ${r.balance >= 0 ? "text-text-primary" : "text-error-text"}`}>{cop(r.balance)}</span> },
        ]} />
      </ChartCard>
    </>
  );
}

function Ordenes({ data }: { data: any }) {
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

function EstadisticasServicios({ data }: { data: any }) {
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

function CortesActivaciones({ data }: { data: any }) {
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

function Movimientos({ data }: { data: any }) {
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

function TopDeudores({ data }: { data: any }) {
  const items = data.items ?? [];
  const totalDeuda = items.reduce((s: number, r: any) => s + (r.balance ?? 0), 0);
  return (
    <>
      <Section>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <TrendStat label="Deuda del top 30" value={cop(totalDeuda)} icon="alert-triangle" tone="error" hint={`${nfmt(items.length)} clientes`} />
          <TrendStat label="Mayor deudor" value={items[0]?.name ?? "—"} icon="user" hint={items[0] ? cop(items[0].balance) : ""} />
          <TrendStat label="Facturas en mora" value={nfmt(items.reduce((s: number, r: any) => s + (r.facturas ?? 0), 0))} icon="receipt" tone="warning" />
        </div>
      </Section>
      <ChartCard title="Top 10 clientes en mora" subtitle="Mayores saldos pendientes" icon="bar-chart-3">
        <HBarList
          monochrome
          accent="var(--color-error)"
          valueFormat={compactCOP}
          rows={items.slice(0, 10).map((r: any) => ({ label: r.name, value: r.balance, hint: `${nfmt(r.facturas)} facturas` }))}
        />
      </ChartCard>
      <ChartCard title="Detalle de cartera" icon="list-tree">
        <DataTable rows={items} empty="Sin datos." columns={[
          { key: "ab", header: "Abonado", render: (r: any) => <span className="font-mono text-text-secondary">{r.abonado}</span> },
          { key: "n", header: "Cliente", render: (r: any) => <Link href={`/clientes/${r.id}`} className="font-medium text-brand hover:underline">{r.name}</Link> },
          { key: "f", header: "Facturas", align: "right", render: (r: any) => nfmt(r.facturas) },
          { key: "b", header: "Deuda", align: "right", render: (r: any) => <span className="font-semibold text-error-text">{cop(r.balance)}</span> },
        ]} />
      </ChartCard>
    </>
  );
}
