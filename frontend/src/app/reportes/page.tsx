"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeading } from "@/components/accounting/PageHeading";
import { Icon } from "@/components/Icon";
import { Input, Field } from "@/components/ui/Field";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { useAuth } from "@/context/AuthProvider";
import { REPORTS, datePresets, buildExportDoc } from "@/lib/reportes";
import { ExportMenu } from "@/components/reportes/ExportMenu";
import { Facturacion } from "@/components/reportes/Facturacion";
import { Recaudo } from "@/components/reportes/Recaudo";
import { VentasSede } from "@/components/reportes/VentasSede";
import { IngresosEgresos } from "@/components/reportes/IngresosEgresos";
import { Ordenes } from "@/components/reportes/Ordenes";
import { EstadisticasServicios } from "@/components/reportes/EstadisticasServicios";
import { CortesActivaciones } from "@/components/reportes/CortesActivaciones";
import { Movimientos } from "@/components/reportes/Movimientos";
import { TopDeudores } from "@/components/reportes/TopDeudores";
import { ReporteIva } from "@/components/reportes/ReporteIva";

export default function ReportesPage() {
  const { loading: authLoading, authFetch } = useAuth();
  const [rep, setRep] = useState("facturacion");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  // El reporte de IVA es el único con un eje extra (ventas / compras).
  const [ivaTipo, setIvaTipo] = useState<"ventas" | "compras">("ventas");

  const meta = REPORTS.find((r) => r.key === rep)!;

  const load = useCallback(async () => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (meta.dated) { if (from) qs.set("from", from); if (to) qs.set("to", to); }
    if (rep === "iva") qs.set("tipo", ivaTipo);
    const path = meta.endpoint ?? `/reports/${rep}`;
    try { setData(await (await authFetch(`${path}?${qs}`)).json()); }
    finally { setLoading(false); }
  }, [authFetch, rep, from, to, ivaTipo, meta.dated, meta.endpoint]);

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
          {rep === "iva" && (
            <Field label="Tipo">
              <div className="flex gap-1.5">
                {(["ventas", "compras"] as const).map((t) => (
                  <button key={t} onClick={() => setIvaTipo(t)}
                    className={`rounded-lg border px-3 py-2 text-[12px] font-semibold capitalize transition-colors ${ivaTipo === t ? "border-brand bg-brand-soft text-brand" : "border-border-subtle bg-surface text-text-secondary hover:bg-surface-2"}`}>
                    {t}
                  </button>
                ))}
              </div>
            </Field>
          )}
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
          {rep === "iva" && <ReporteIva data={data} />}
        </div>
      )}
    </>
  );
}
