"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeading } from "@/components/ui/PageHeading";
import { Pagination } from "@/components/ui/Pagination";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { ListToolbar } from "@/components/ui/ListToolbar";
import { useAuth } from "@/context/AuthProvider";
import { useOrden } from "@/lib/useOrden";

type Row = {
  id: string; action: string; entity: string; entityId: string | null;
  userName: string | null; userEmail: string | null; ipAddress: string | null; createdAt: string;
};
type List = { items: Row[]; total: number; page: number; pageSize: number; pages: number };

export default function BitacoraPage() {
  const { authFetch } = useAuth();
  const [data, setData] = useState<List | null>(null);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [entity, setEntity] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  // Pagina en el servidor: el orden viaja en la query.
  const orden = useOrden();

  const load = useCallback(() => {
    const qs = new URLSearchParams({ page: String(page), pageSize: "30" , ...orden.params });
    if (search) qs.set("search", search);
    if (entity) qs.set("entity", entity);
    if (from) qs.set("from", from);
    if (to) qs.set("to", to);
    void authFetch(`/activity?${qs.toString()}`).then((r) => (r.ok ? r.json() : null)).then(setData).catch(() => {});
  }, [authFetch, page, search, entity, from, to, orden.clave]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [search, entity, from, to, orden.clave]);

  const fmt = (s: string) => new Date(s).toLocaleString("es-CO", { dateStyle: "short", timeStyle: "medium" });

  const columns: Column<Row>[] = [
    { key: "createdAt", header: "Fecha / hora", sortable: true, render: (r) => <span className="font-mono text-text-secondary">{fmt(r.createdAt)}</span> },
    { key: "userName", header: "Usuario", sortable: true, render: (r) => r.userName ?? <span className="text-text-tertiary">—</span> },
    { key: "action", header: "Acción", sortable: true, render: (r) => <span className="font-mono text-[12px]">{r.action}</span> },
    { key: "entity", header: "Módulo", sortable: true, render: (r) => <span className="text-text-secondary">{r.entity}</span> },
    { key: "ipAddress", header: "IP", sortable: true, render: (r) => <span className="text-text-tertiary">{r.ipAddress ?? "—"}</span> },
  ];

  return (
    <div className="space-y-4">
      <PageHeading icon="history" title="Bitácora / Auditoría" subtitle="Registro de todas las acciones de escritura del sistema (reemplaza historial_crm)." />

      <ListToolbar search={search} onSearch={setSearch} searchPlaceholder="Buscar acción… p.ej. POST /treasury/collect">
        <input value={entity} onChange={(e) => setEntity(e.target.value)} placeholder="Módulo: subscribers, treasury…" className="rounded-lg border border-border-default bg-surface px-3 py-1.5 text-[13px]" />
        <label className="flex items-center gap-1.5 text-[12px] text-text-secondary">
          Desde
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="rounded-lg border border-border-default bg-surface px-2 py-1.5 text-[13px]" />
        </label>
        <label className="flex items-center gap-1.5 text-[12px] text-text-secondary">
          Hasta
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="rounded-lg border border-border-default bg-surface px-2 py-1.5 text-[13px]" />
        </label>
      </ListToolbar>

      <DataTable
        sort={orden.sort}
        onSort={orden.onSort}
        columns={columns}
        rows={data?.items ?? []}
        loading={!data}
        loadingText="Cargando…"
        empty="Sin registros para el filtro."
      />
      {data && data.pages > 1 && (
        <Pagination meta={{ page: data.page, pageSize: data.pageSize, total: data.total, pageCount: data.pages }} onPage={setPage} />
      )}
    </div>
  );
}
