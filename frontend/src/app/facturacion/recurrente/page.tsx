"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { Badge } from "@/components/ui/Badge";
import { DataTable } from "@/components/ui/DataTable";
import { Pagination } from "@/components/ui/Pagination";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { toast } from "@/components/ui/Toast";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useAuth } from "@/context/AuthProvider";
import { NuevaPlantillaModal } from "@/components/cobranzas/NuevaPlantillaModal";
import { cop } from "@/lib/subscribers";
import { StatCard } from "@/components/ui/StatCard";
import { useRequest } from "@/lib/useRequest";
import { useOrden } from "@/lib/useOrden";
import { mensajeDeError } from "@/lib/errores";

export default function RecurrentePage() {
  const { loading: authLoading, authFetch } = useAuth();
  const [stats, setStats] = useState<any>(null);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmar, setConfirmar] = useState<any | null>(null);

  const loadStats = useCallback(() => {
    void authFetch("/billing/recurring/stats").then((r) => r.json()).then(setStats).catch(() => {});
  }, [authFetch]);

  // Carga con cancelación: al teclear se aborta la petición en vuelo para que
  // una respuesta lenta no pise a otra más reciente. Ver lib/useRequest.
  // Pagina en el servidor: el orden viaja en la query.
  const orden = useOrden();

  const { data, cargando: loading, error, refrescar: load } = useRequest<any>(
    () => {
      const qs = new URLSearchParams({ page: String(page), pageSize: "25", ...orden.params });
      if (search.trim()) qs.set("search", search.trim());
      return `/billing/recurring?${qs}`;
    },
    [page, search],
    { debounceMs: search ? 350 : 0, saltar: authLoading },
  );

  useEffect(() => { if (!authLoading) { loadStats(); } }, [authLoading, loadStats]);
  useEffect(() => { setPage(1); }, [search, orden.clave]);

  async function run(id: string) {
    setBusy(id);
    try {
      const res = await authFetch(`/billing/recurring/${id}/run`, { method: "POST", body: "{}" });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "Error");
      toast(`Factura #${d.tid} generada · ${cop(d.total)}`);
    } catch (e) { toast(mensajeDeError(e), "alert-triangle"); } finally { setBusy(null); }
  }

  async function remove(id: string) {
    setBusy(id);
    try {
      const res = await authFetch(`/billing/recurring/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("No se pudo eliminar");
      toast("Plantilla eliminada");
      loadStats(); load();
    } catch (e) { toast(mensajeDeError(e), "alert-triangle"); } finally { setBusy(null); setConfirmar(null); }
  }

  if (authLoading) return <PageSkeleton />;

  return (
    <>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <PageHeading icon="calendar-clock" title="Reciclaje de ventas" subtitle="Plantillas de facturación recurrente" />
        <Button onClick={() => setOpen(true)}><Icon name="plus" size={15} /> Nueva plantilla</Button>
      </div>

      <NuevaPlantillaModal open={open} onClose={() => setOpen(false)} onDone={() => { loadStats(); load(); }} />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Plantillas" value={(stats?.total ?? 0).toLocaleString("es-CO")} icon="calendar-clock" />
        <StatCard label="Activas" value={(stats?.active ?? 0).toLocaleString("es-CO")} tone="text-success-text" icon="check" />
        <StatCard label="Inactivas" value={(stats?.inactive ?? 0).toLocaleString("es-CO")} icon="x" />
        <StatCard label="Valor recurrente" value={cop(stats?.valorRecurrente ?? 0)} tone="text-brand" icon="banknote" />
      </div>

      <div className="mb-3 relative max-w-md">
        <Icon name="search" size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
        <Input className="pl-9" placeholder="Buscar por cliente o N° de plantilla…" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      {loading && !data ? <PageSkeleton /> : (
        <>
          <DataTable
            sort={orden.sort}
            onSort={orden.onSort}
            rows={data?.items ?? []}
            empty="Aún no hay plantillas recurrentes."
            columns={[
              { key: "tid", header: "N°", sortable: true, render: (r: any) => <span className="font-mono text-text-secondary">{r.tid}</span> },
              { key: "sub", header: "Cliente", sortable: true, render: (r: any) => r.subscriberId
                ? <Link href={`/clientes/${r.subscriberId}`} className="font-medium text-text-primary hover:text-brand">{r.subscriber}</Link>
                : <span>{r.subscriber}</span> },
              { key: "rec", header: "Periodicidad", sortable: true, render: (r: any) => <span className="text-text-secondary">{r.rec ?? "—"}</span> },
              { key: "total", header: "Total", sortable: true, align: "right", render: (r: any) => <span className="font-semibold">{cop(r.total)}</span> },
              { key: "estado", header: "Estado", sortable: true, render: (r: any) => <Badge label={r.active ? "Activa" : "Inactiva"} tone={r.active ? "success" : "default"} /> },
              { key: "acciones", header: "", align: "right", render: (r: any) => (
                <div className="flex items-center justify-end gap-1">
                  <button type="button" disabled={busy === r.id} onClick={() => run(r.id)}
                    className="inline-flex items-center gap-1 rounded-md border border-border-default px-2 py-1 text-[11px] font-semibold text-text-secondary hover:bg-surface-2 disabled:opacity-50">
                    <Icon name="file-plus" size={12} /> Generar
                  </button>
                  <button type="button" disabled={busy === r.id} onClick={() => setConfirmar(r)}
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold text-error-text hover:bg-error-soft disabled:opacity-50">
                    <Icon name="x" size={12} /> Eliminar
                  </button>
                </div>
              ) },
            ]}
          />
          {data && data.pages > 1 && (
            <div className="mt-3"><Pagination meta={{ page: data.page, pageSize: data.pageSize, total: data.total, pageCount: data.pages }} onPage={setPage} /></div>
          )}
        </>
      )}

      {confirmar && (
        <ConfirmDialog
          open
          busy={busy === confirmar.id}
          onClose={() => setConfirmar(null)}
          onConfirm={() => void remove(confirmar.id)}
          tone="danger"
          icon="trash"
          title="Eliminar plantilla recurrente"
          confirmLabel="Eliminar plantilla"
          message={
            <>
              La plantilla deja de generar facturas: al cliente no se le volverá a cobrar
              esta mensualidad de forma automática. Las facturas ya generadas no se tocan.
            </>
          }
          detail={<PlantillaResumen p={confirmar} />}
        />
      )}
    </>
  );
}

/**
 * Ficha compacta de la plantilla dentro de la confirmación: el listado tiene
 * varias filas parecidas y conviene ver a cuál se le corta el cobro.
 */
function PlantillaResumen({ p }: { p: any }) {
  const filas: [string, React.ReactNode][] = [
    ["N°", <span key="a" className="font-mono">{p.tid}</span>],
    ["Cliente", <span key="b">{p.subscriber ?? "—"}</span>],
    ["Periodicidad", <span key="c">{p.rec ?? "—"}</span>],
    ["Total", <span key="d" className="font-mono font-semibold">{cop(p.total)}</span>],
    ["Estado", <Badge key="e" label={p.active ? "Activa" : "Inactiva"} tone={p.active ? "success" : "default"} />],
  ];
  return (
    <div className="rounded-lg border border-border-subtle bg-surface-2 p-2.5">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12px]">
        {filas.map(([k, v]) => (
          <Fragment key={k}>
            <dt className="text-text-tertiary">{k}</dt>
            <dd className="text-right text-text-primary">{v}</dd>
          </Fragment>
        ))}
      </dl>
    </div>
  );
}
