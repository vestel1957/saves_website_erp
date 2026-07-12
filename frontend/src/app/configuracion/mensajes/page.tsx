"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeading } from "@/components/accounting/PageHeading";
import { Pagination } from "@/components/ui/Pagination";
import { useAuth } from "@/context/AuthProvider";

type Row = { id: string; campaignName: string | null; recipientUserId: number | null; body: string; createdAt: string };
type List = { items: Row[]; total: number; page: number; pageSize: number; pages: number };

export default function MensajesPage() {
  const { authFetch } = useAuth();
  const [data, setData] = useState<List | null>(null);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");

  const load = useCallback(() => {
    const qs = new URLSearchParams({ page: String(page), pageSize: "30" });
    if (search) qs.set("search", search);
    void authFetch(`/extras/messages?${qs.toString()}`).then((r) => (r.ok ? r.json() : null)).then(setData).catch(() => {});
  }, [authFetch, page, search]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [search]);

  return (
    <div className="space-y-4">
      <PageHeading icon="message-square" title="Mensajería" subtitle="Bitácora de mensajes/campañas del sistema (tabla mensajes)." />
      <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar por campaña o contenido…" className="w-full max-w-md rounded-lg border border-border-default bg-surface px-3 py-2 text-[13px]" />
      <div className="space-y-2">
        {!data ? (
          <p className="text-[13px] text-text-tertiary">Cargando…</p>
        ) : data.items.length === 0 ? (
          <p className="text-[13px] text-text-tertiary">Sin mensajes para el filtro.</p>
        ) : data.items.map((m) => (
          <div key={m.id} className="rounded-xl border border-border-subtle bg-surface p-3">
            <div className="mb-1 flex items-center justify-between gap-2 text-[12px] text-text-tertiary">
              <span className="font-medium text-text-secondary">{m.campaignName ?? "—"}</span>
              <span>{new Date(m.createdAt).toLocaleString("es-CO", { dateStyle: "short", timeStyle: "short" })}</span>
            </div>
            <p className="text-[13px] text-text-primary">{m.body}</p>
          </div>
        ))}
      </div>
      {data && data.pages > 1 && <Pagination meta={{ page: data.page, pageSize: data.pageSize, total: data.total, pageCount: data.pages }} onPage={setPage} />}
    </div>
  );
}
