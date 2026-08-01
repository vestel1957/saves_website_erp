"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { Input, Field, Select } from "@/components/ui/Field";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { useAuth } from "@/context/AuthProvider";
import { datePresets, buildExportDoc, findReport } from "@/lib/reportes";
import { ExportMenu } from "@/components/reportes/ExportMenu";
import { ReportBody } from "@/components/reportes/ReportBody";

/**
 * Carcasa común de un reporte: encabezado, barra de filtros, exportación y
 * cuerpo. Existe para que las 15 páginas de `/reportes/*` sean tres líneas cada
 * una en vez de 15 copias de la misma lógica de fetch y filtros.
 *
 * Los filtros extra los declara cada reporte en `lib/reportes.ts` y sus opciones
 * salen de la propia respuesta, así que agregar un filtro nuevo no toca este
 * archivo.
 */
export function ReportView({ rep }: { rep: string }) {
  const { loading: authLoading, authFetch } = useAuth();
  const meta = findReport(rep);

  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  /** Valores de los filtros extra, por nombre de parámetro. */
  const [extra, setExtra] = useState<Record<string, string>>({});
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!meta) return;
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams();
    if (meta.dated) {
      if (from) qs.set("from", from);
      if (to) qs.set("to", to);
    }
    for (const [k, v] of Object.entries(extra)) if (v) qs.set(k, v);
    const path = meta.endpoint ?? `/reports/${rep}`;
    try {
      const r = await authFetch(`${path}?${qs}`);
      if (!r.ok) throw new Error(`El servidor respondió ${r.status}`);
      setData(await r.json());
    } catch (e) {
      // Un reporte que falla tiene que decirlo. Dejar el esqueleto girando para
      // siempre es la peor forma de fallar: parece que está cargando.
      setError((e as Error).message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [authFetch, rep, from, to, extra, meta]);

  useEffect(() => {
    if (!authLoading) void load();
  }, [authLoading, load]);

  const exportDoc = useMemo(
    () => (meta ? buildExportDoc(rep, meta.label, data, from, to) : null),
    [rep, meta, data, from, to],
  );

  if (!meta) {
    return <PageHeading icon="alert-triangle" title="Reporte desconocido" subtitle={`No existe un reporte con la clave "${rep}".`} />;
  }

  // Un filtro con una sola opción no filtra nada: ocupa espacio y sugiere que
  // hay algo que elegir. Se muestra solo cuando de verdad hay alternativas.
  const filtros = (meta.filters ?? [])
    .map((f) => ({ ...f, options: f.from(data) }))
    .filter((f) => f.options.length > 1);

  const activos = Object.values(extra).filter(Boolean).length + (from ? 1 : 0) + (to ? 1 : 0);

  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <PageHeading icon={meta.icon} title={meta.label} subtitle={meta.desc} />
        <ExportMenu doc={exportDoc} />
      </div>

      {(meta.dated || filtros.length > 0) && (
        <div className="flex flex-wrap items-end gap-2">
          {meta.dated && (
            <>
              <Field label="Desde"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
              <Field label="Hasta"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
            </>
          )}

          {filtros.map((f) => (
            <Field key={f.param} label={f.label}>
              <Select value={extra[f.param] ?? ""} onChange={(e) => setExtra((s) => ({ ...s, [f.param]: e.target.value }))}>
                <option value="">Todos</option>
                {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </Select>
            </Field>
          ))}

          {meta.dated && (
            <div className="flex flex-wrap gap-1.5 pb-0.5">
              {datePresets().map((p) => (
                <button key={p.label} onClick={() => { setFrom(p.from); setTo(p.to); }}
                  className="rounded-lg border border-border-subtle bg-surface px-2.5 py-2 text-[11px] font-medium text-text-secondary hover:bg-surface-2">
                  {p.label}
                </button>
              ))}
            </div>
          )}

          {activos > 0 && (
            <button onClick={() => { setFrom(""); setTo(""); setExtra({}); }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border-default px-3 py-2 text-[12px] text-text-secondary hover:bg-surface-2">
              <Icon name="x" size={13} /> Limpiar ({activos})
            </button>
          )}
        </div>
      )}

      {error ? (
        <div className="rounded-xl border border-error-border bg-error-soft p-4 text-[13px] text-error-text">
          <div className="mb-1 flex items-center gap-1.5 font-semibold">
            <Icon name="alert-triangle" size={15} /> No se pudo cargar el reporte
          </div>
          {error}
          <button onClick={() => void load()} className="mt-2 block rounded-lg border border-error-border px-3 py-1.5 text-[12px] font-semibold hover:bg-surface">
            Reintentar
          </button>
        </div>
      ) : loading || !data ? (
        <PageSkeleton />
      ) : (
        <div className="flex flex-col gap-6">
          <ReportBody rep={rep} data={data} from={from} to={to} />
        </div>
      )}
    </>
  );
}
