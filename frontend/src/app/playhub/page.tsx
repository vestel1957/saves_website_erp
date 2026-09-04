"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { PageHeading } from "@/components/ui/PageHeading";
import { Pagination } from "@/components/ui/Pagination";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { ListToolbar } from "@/components/ui/ListToolbar";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Icon } from "@/components/Icon";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { useOrden } from "@/lib/useOrden";
import { fmtDate } from "@/lib/format";
import { mensajeDeError } from "@/lib/errores";

/**
 * Reporte "Clientes PlayHub": una fila POR CLIENTE con las apps que tiene, igual
 * que el listado del legacy. Se listan también las cuentas que no llegan al mínimo
 * de Megas —marcadas en rojo—: son suscripciones a limpiar, no a esconder.
 */
type Row = {
  id: string; subscriberId: string | null; subscriberName: string | null; abonado: number | null;
  docNumber: string | null; nameS: string | null; sede: string | null; apps: string[];
  total: number; syncedAt: string | null; planInternet: string | null; planTv: string | null;
  megas: number; elegible: boolean;
};
type List = {
  items: Row[]; total: number; page: number; pageSize: number; pages: number;
  apps: number; appsNoElegibles: number; minMegas: number; byProduct: { product: string; count: number }[];
};
type Estado = {
  running: boolean; total: number; hechos: number; conSuscripcion: number;
  sinSuscripcion: number; errores: number; detalle: string[]; finishedAt: string | null;
};

export default function PlayhubPage() {
  const { authFetch } = useAuth();
  const [data, setData] = useState<List | null>(null);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [estado, setEstado] = useState<Estado | null>(null);
  const corriendo = useRef(false);

  const orden = useOrden();

  const load = useCallback(() => {
    const qs = new URLSearchParams({ page: String(page), pageSize: "30", ...orden.params });
    if (search) qs.set("search", search);
    void authFetch(`/extras/playhub?${qs.toString()}`).then((r) => (r.ok ? r.json() : null)).then(setData).catch(() => {});
  }, [authFetch, page, search, orden.clave]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [search, orden.clave]);

  // La barrida contra PlayHub son ~15.000 consultas (una por cliente con email):
  // corre en el servidor y aquí sólo se sigue el progreso.
  const verEstado = useCallback(async () => {
    try {
      const r = await authFetch("/playhub/sync-status");
      if (!r.ok) return;
      const st: Estado = await r.json();
      setEstado(st);
      if (!st.running && corriendo.current) {
        corriendo.current = false;
        toast(`Sincronización terminada · ${st.conSuscripcion} con suscripción, ${st.sinSuscripcion} sin${st.errores ? ` · ${st.errores} con error` : ""}`, "check");
        load();
      }
      corriendo.current = st.running;
    } catch { /* la pantalla sigue viva aunque falle un sondeo */ }
  }, [authFetch, load]);

  useEffect(() => { void verEstado(); }, [verEstado]);
  useEffect(() => {
    if (!estado?.running) return;
    const t = setInterval(() => { void verEstado(); }, 3000);
    return () => clearInterval(t);
  }, [estado?.running, verEstado]);

  async function syncAll() {
    try {
      const res = await authFetch(`/playhub/sync-all`, { method: "POST" });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "No se pudo sincronizar");
      corriendo.current = true;
      setEstado({ ...d, running: true });
      toast(d.yaEnCurso ? "Ya hay una sincronización en curso" : `Sincronizando ${d.total} clientes con PlayHub…`, "refresh-cw");
    } catch (e) { toast(mensajeDeError(e), "alert-triangle"); }
  }

  const pct = estado && estado.total > 0 ? Math.round((estado.hechos / estado.total) * 100) : 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <PageHeading icon="tv" title="PlayHub / IPTV" subtitle="Cuentas y apps de streaming contratadas por los abonados." />
        <Button size="sm" variant="secondary" onClick={syncAll} disabled={!!estado?.running}>
          <Icon name={estado?.running ? "loader" : "refresh-cw"} size={14} className={estado?.running ? "animate-spin" : ""} />
          {estado?.running ? `Sincronizando… ${pct}%` : "Sincronizar con PlayHub"}
        </Button>
      </div>

      {estado?.running && (
        <div className="rounded-xl border border-border-subtle bg-surface p-3">
          <div className="mb-2 flex items-center justify-between text-[12px] text-text-secondary">
            <span>{estado.hechos.toLocaleString("es-CO")} de {estado.total.toLocaleString("es-CO")} clientes consultados</span>
            <span>{estado.conSuscripcion} con suscripción · {estado.errores} con error</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
            <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {data && (
          <>
            <span className="rounded-lg border border-border-subtle bg-surface px-3 py-1.5 text-[12px]">
              <span className="text-text-secondary">Cuentas</span> · <b>{data.total}</b>
            </span>
            <span className="rounded-lg border border-border-subtle bg-surface px-3 py-1.5 text-[12px]">
              <span className="text-text-secondary">Apps en uso</span> · <b>{data.apps}</b>
            </span>
            {data.appsNoElegibles > 0 && (
              <span className="rounded-lg border border-error-line bg-error-soft px-3 py-1.5 text-[12px] text-error-text">
                <span>Apps sin plan de {data.minMegas} Megas</span> · <b>{data.appsNoElegibles}</b>
              </span>
            )}
          </>
        )}
        {data?.byProduct.map((b) => (
          <span key={b.product} className="rounded-lg border border-border-subtle bg-surface px-3 py-1.5 text-[12px]">
            <span className="text-text-secondary">{b.product}</span> · <b>{b.count}</b>
          </span>
        ))}
      </div>

      <div>
        <ListToolbar search={search} onSearch={setSearch} searchPlaceholder="Buscar por cliente, usuario, documento, app o sede…" />
        <DataTable
          sort={orden.sort}
          onSort={orden.onSort}
          columns={[
            {
              key: "cliente", header: "Cliente", sortable: true,
              render: (r) => (
                <>
                  {r.subscriberId
                    ? <Link href={`/clientes/${r.subscriberId}`} className="text-brand hover:underline">{r.subscriberName ?? "—"}</Link>
                    : <span className="text-text-secondary">{r.subscriberName ?? "—"}</span>}
                  {r.abonado != null && <span className="ml-1 text-[11px] text-text-tertiary">#{r.abonado}</span>}
                  {!r.subscriberId && <span className="ml-2 inline-block"><Badge label="Externo" /></span>}
                </>
              ),
            },
            { key: "nameS", header: "Usuario", sortable: true, render: (r) => <span className="font-mono text-[12px]">{r.nameS ?? "—"}</span> },
            { key: "sede", header: "Sede", render: (r) => r.sede ?? "—" },
            {
              key: "plan", header: "Plan de internet",
              render: (r) => (
                <span className={r.elegible ? undefined : "text-error-text"}>{r.planInternet ?? "—"}</span>
              ),
            },
            {
              key: "apps", header: "Apps", sortable: true,
              render: (r) => (
                r.total === 0
                  ? <span className="text-text-tertiary">Solo cuenta</span>
                  : <span className="text-[12px]">{r.apps.join(" · ")}</span>
              ),
            },
            { key: "syncedAt", header: "Últ. sync", sortable: true, render: (r) => <span className="text-text-tertiary">{fmtDate(r.syncedAt)}</span> },
          ] satisfies Column<Row>[]}
          rows={data?.items ?? []}
          loading={!data}
          loadingText="Cargando…"
          empty="Sin cuentas de PlayHub. Usa «Sincronizar con PlayHub» para traerlas."
        />
      </div>
      {data && data.pages > 1 && <Pagination meta={{ page: data.page, pageSize: data.pageSize, total: data.total, pageCount: data.pages }} onPage={setPage} />}
    </div>
  );
}
