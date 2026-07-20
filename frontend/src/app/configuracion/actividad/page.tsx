"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeading } from "@/components/ui/PageHeading";
import { Pagination } from "@/components/ui/Pagination";
import { useAuth } from "@/context/AuthProvider";

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

  const load = useCallback(() => {
    const qs = new URLSearchParams({ page: String(page), pageSize: "30" });
    if (search) qs.set("search", search);
    if (entity) qs.set("entity", entity);
    if (from) qs.set("from", from);
    if (to) qs.set("to", to);
    void authFetch(`/activity?${qs.toString()}`).then((r) => (r.ok ? r.json() : null)).then(setData).catch(() => {});
  }, [authFetch, page, search, entity, from, to]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [search, entity, from, to]);

  const fmt = (s: string) => new Date(s).toLocaleString("es-CO", { dateStyle: "short", timeStyle: "medium" });

  return (
    <div className="space-y-4">
      <PageHeading icon="history" title="Bitácora / Auditoría" subtitle="Registro de todas las acciones de escritura del sistema (reemplaza historial_crm)." />

      <div className="flex flex-wrap items-end gap-2 rounded-xl border border-border-subtle bg-surface p-3">
        <label className="flex-1 text-[12px] text-text-secondary">
          <span className="mb-1 block">Buscar acción</span>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="p.ej. POST /treasury/collect" className="w-full rounded-lg border border-border-default bg-surface px-3 py-1.5 text-[13px]" />
        </label>
        <label className="text-[12px] text-text-secondary">
          <span className="mb-1 block">Módulo</span>
          <input value={entity} onChange={(e) => setEntity(e.target.value)} placeholder="subscribers, treasury…" className="rounded-lg border border-border-default bg-surface px-3 py-1.5 text-[13px]" />
        </label>
        <label className="text-[12px] text-text-secondary">
          <span className="mb-1 block">Desde</span>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="rounded-lg border border-border-default bg-surface px-2 py-1.5 text-[13px]" />
        </label>
        <label className="text-[12px] text-text-secondary">
          <span className="mb-1 block">Hasta</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="rounded-lg border border-border-default bg-surface px-2 py-1.5 text-[13px]" />
        </label>
      </div>

      <div className="overflow-x-auto rounded-xl border border-border-subtle bg-surface">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-border-subtle text-left text-text-tertiary">
              <th className="py-2 pl-3 pr-3 font-medium">Fecha / hora</th>
              <th className="py-2 pr-3 font-medium">Usuario</th>
              <th className="py-2 pr-3 font-medium">Acción</th>
              <th className="py-2 pr-3 font-medium">Módulo</th>
              <th className="py-2 pr-3 font-medium">IP</th>
            </tr>
          </thead>
          <tbody>
            {!data ? (
              <tr><td colSpan={5} className="py-6 text-center text-text-tertiary">Cargando…</td></tr>
            ) : data.items.length === 0 ? (
              <tr><td colSpan={5} className="py-6 text-center text-text-tertiary">Sin registros para el filtro.</td></tr>
            ) : data.items.map((r) => (
              <tr key={r.id} className="border-b border-border-subtle/60">
                <td className="py-1.5 pl-3 pr-3 font-mono text-text-secondary">{fmt(r.createdAt)}</td>
                <td className="py-1.5 pr-3">{r.userName ?? <span className="text-text-tertiary">—</span>}</td>
                <td className="py-1.5 pr-3 font-mono text-[12px]">{r.action}</td>
                <td className="py-1.5 pr-3 text-text-secondary">{r.entity}</td>
                <td className="py-1.5 pr-3 text-text-tertiary">{r.ipAddress ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data && data.pages > 1 && (
        <Pagination meta={{ page: data.page, pageSize: data.pageSize, total: data.total, pageCount: data.pages }} onPage={setPage} />
      )}
    </div>
  );
}
