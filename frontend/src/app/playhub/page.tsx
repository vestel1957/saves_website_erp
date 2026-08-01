"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PageHeading } from "@/components/ui/PageHeading";
import { Pagination } from "@/components/ui/Pagination";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { ListToolbar } from "@/components/ui/ListToolbar";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/Icon";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { useOrden } from "@/lib/useOrden";
import { fmtDate } from "@/lib/format";
import { mensajeDeError } from "@/lib/errores";

type Row = { id: string; nameS: string | null; externalName: string | null; productId: string | null; productName: string | null; voucher: string | null; syncedAt: string | null; subscriberId: string | null; subscriberName: string | null; abonado: number | null };
type List = { items: Row[]; total: number; page: number; pageSize: number; pages: number; byProduct: { product: string; count: number }[] };

export default function PlayhubPage() {
  const { authFetch } = useAuth();
  const [data, setData] = useState<List | null>(null);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [syncing, setSyncing] = useState(false);

  // Pagina en el servidor: el orden viaja en la query.
  const orden = useOrden();

  const load = useCallback(() => {
    const qs = new URLSearchParams({ page: String(page), pageSize: "30" , ...orden.params });
    if (search) qs.set("search", search);
    void authFetch(`/extras/playhub?${qs.toString()}`).then((r) => (r.ok ? r.json() : null)).then(setData).catch(() => {});
  }, [authFetch, page, search, orden.clave]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [search, orden.clave]);

  async function syncAll() {
    setSyncing(true);
    try {
      const res = await authFetch(`/playhub/sync-all`, { method: "POST" });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "No se pudo sincronizar");
      toast(`Sincronizados ${d.synced}/${d.total} clientes${d.failed ? ` · ${d.failed} con error` : ""}`, "check");
      load();
    } catch (e) { toast(mensajeDeError(e), "alert-triangle"); } finally { setSyncing(false); }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <PageHeading icon="tv" title="PlayHub / IPTV" subtitle="Suscripciones de televisión por streaming." />
        <Button size="sm" variant="secondary" onClick={syncAll} disabled={syncing}><Icon name={syncing ? "loader" : "refresh-cw"} size={14} className={syncing ? "animate-spin" : ""} /> {syncing ? "Sincronizando…" : "Sincronizar todo"}</Button>
      </div>

      {data && data.byProduct.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {data.byProduct.map((b) => (
            <span key={b.product} className="rounded-lg border border-border-subtle bg-surface px-3 py-1.5 text-[12px]">
              <span className="text-text-secondary">{b.product}</span> · <b>{b.count}</b>
            </span>
          ))}
        </div>
      )}

      <div>
        <ListToolbar search={search} onSearch={setSearch} searchPlaceholder="Buscar por usuario, producto o voucher…" />
        <DataTable
        sort={orden.sort}
        onSort={orden.onSort}
          columns={[
            {
              key: "cliente", header: "Cliente", sortable: true,
              render: (r) => (
                <>
                  {r.subscriberId ? <Link href={`/clientes/${r.subscriberId}`} className="text-brand hover:underline">{r.subscriberName ?? "—"}</Link> : (r.subscriberName ?? "—")}
                  {r.abonado != null && <span className="ml-1 text-[11px] text-text-tertiary">#{r.abonado}</span>}
                </>
              ),
            },
            { key: "nameS", header: "Usuario", sortable: true, render: (r) => <span className="font-mono text-[12px]">{r.nameS ?? "—"}</span> },
            { key: "producto", header: "Producto", sortable: true, render: (r) => r.productName ?? r.productId ?? "—" },
            { key: "voucher", header: "Voucher", sortable: true, render: (r) => <span className="text-text-secondary">{r.voucher ?? "—"}</span> },
            { key: "syncedAt", header: "Últ. sync", sortable: true, render: (r) => <span className="text-text-tertiary">{fmtDate(r.syncedAt)}</span> },
          ] satisfies Column<Row>[]}
          rows={data?.items ?? []}
          loading={!data}
          loadingText="Cargando…"
          empty="Sin suscripciones."
        />
      </div>
      {data && data.pages > 1 && <Pagination meta={{ page: data.page, pageSize: data.pageSize, total: data.total, pageCount: data.pages }} onPage={setPage} />}
    </div>
  );
}
