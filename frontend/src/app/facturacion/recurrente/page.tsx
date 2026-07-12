"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PageHeading } from "@/components/accounting/PageHeading";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { Badge } from "@/components/ui/Badge";
import { DataTable } from "@/components/inventory/DataTable";
import { Pagination } from "@/components/ui/Pagination";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { NuevaPlantillaModal } from "@/components/cobranzas/NuevaPlantillaModal";
import { cop } from "@/lib/subscribers";

function StatCard({ label, value, tone = "text-text-primary", icon }: { label: string; value: string; tone?: string; icon: string }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border-subtle bg-surface px-4 py-3 shadow-sm">
      <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-soft text-brand"><Icon name={icon} size={17} /></span>
      <div className="flex flex-col leading-tight">
        <span className="text-[11px] font-medium text-text-tertiary">{label}</span>
        <span className={`text-[17px] font-bold ${tone}`}>{value}</span>
      </div>
    </div>
  );
}

export default function RecurrentePage() {
  const { loading: authLoading, authFetch } = useAuth();
  const [stats, setStats] = useState<any>(null);
  const [data, setData] = useState<any>(null);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const loadStats = useCallback(() => {
    void authFetch("/billing/recurring/stats").then((r) => r.json()).then(setStats).catch(() => {});
  }, [authFetch]);

  const load = useCallback(async () => {
    setLoading(true);
    const qs = new URLSearchParams({ page: String(page), pageSize: "25" });
    if (search.trim()) qs.set("search", search.trim());
    try { setData(await (await authFetch(`/billing/recurring?${qs}`)).json()); }
    finally { setLoading(false); }
  }, [authFetch, page, search]);

  useEffect(() => { if (!authLoading) { loadStats(); } }, [authLoading, loadStats]);
  useEffect(() => { if (!authLoading) { const t = setTimeout(load, search ? 350 : 0); return () => clearTimeout(t); } }, [authLoading, load]);
  useEffect(() => { setPage(1); }, [search]);

  async function run(id: string) {
    setBusy(id);
    try {
      const res = await authFetch(`/billing/recurring/${id}/run`, { method: "POST", body: "{}" });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "Error");
      toast(`Factura #${d.tid} generada · ${cop(d.total)}`);
    } catch (e: any) { toast(e.message, "alert-triangle"); } finally { setBusy(null); }
  }

  async function remove(id: string) {
    if (!confirm("¿Eliminar esta plantilla recurrente?")) return;
    setBusy(id);
    try {
      const res = await authFetch(`/billing/recurring/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("No se pudo eliminar");
      toast("Plantilla eliminada");
      loadStats(); load();
    } catch (e: any) { toast(e.message, "alert-triangle"); } finally { setBusy(null); }
  }

  if (authLoading) return <PageSkeleton />;

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
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
            rows={data?.items ?? []}
            empty="Aún no hay plantillas recurrentes."
            columns={[
              { key: "tid", header: "N°", render: (r: any) => <span className="font-mono text-text-secondary">{r.tid}</span> },
              { key: "sub", header: "Cliente", render: (r: any) => r.subscriberId
                ? <Link href={`/clientes/${r.subscriberId}`} className="font-medium text-text-primary hover:text-brand">{r.subscriber}</Link>
                : <span>{r.subscriber}</span> },
              { key: "rec", header: "Periodicidad", render: (r: any) => <span className="text-text-secondary">{r.rec ?? "—"}</span> },
              { key: "total", header: "Total", align: "right", render: (r: any) => <span className="font-semibold">{cop(r.total)}</span> },
              { key: "estado", header: "Estado", render: (r: any) => <Badge label={r.active ? "Activa" : "Inactiva"} tone={r.active ? "success" : "default"} /> },
              { key: "acciones", header: "", align: "right", render: (r: any) => (
                <div className="flex items-center justify-end gap-1">
                  <button type="button" disabled={busy === r.id} onClick={() => run(r.id)}
                    className="inline-flex items-center gap-1 rounded-md border border-border-default px-2 py-1 text-[11px] font-semibold text-text-secondary hover:bg-surface-2 disabled:opacity-50">
                    <Icon name="file-plus" size={12} /> Generar
                  </button>
                  <button type="button" disabled={busy === r.id} onClick={() => remove(r.id)}
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
    </>
  );
}
