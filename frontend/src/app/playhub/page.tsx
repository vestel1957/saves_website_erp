"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PageHeading } from "@/components/accounting/PageHeading";
import { Pagination } from "@/components/ui/Pagination";
import { useAuth } from "@/context/AuthProvider";

type Row = { id: string; nameS: string | null; externalName: string | null; productId: string | null; productName: string | null; voucher: string | null; syncedAt: string | null; subscriberId: string | null; subscriberName: string | null; abonado: number | null };
type List = { items: Row[]; total: number; page: number; pageSize: number; pages: number; byProduct: { product: string; count: number }[] };

export default function PlayhubPage() {
  const { authFetch } = useAuth();
  const [data, setData] = useState<List | null>(null);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");

  const load = useCallback(() => {
    const qs = new URLSearchParams({ page: String(page), pageSize: "30" });
    if (search) qs.set("search", search);
    void authFetch(`/extras/playhub?${qs.toString()}`).then((r) => (r.ok ? r.json() : null)).then(setData).catch(() => {});
  }, [authFetch, page, search]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [search]);

  const fmt = (s: string | null) => (s ? new Date(s).toLocaleDateString("es-CO") : "—");

  return (
    <div className="space-y-4">
      <PageHeading icon="play" title="PlayHub / IPTV" subtitle="Suscripciones de televisión por streaming (playhub_suscripciones)." />

      {data && data.byProduct.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {data.byProduct.map((b) => (
            <span key={b.product} className="rounded-lg border border-border-subtle bg-surface px-3 py-1.5 text-[12px]">
              <span className="text-text-secondary">{b.product}</span> · <b>{b.count}</b>
            </span>
          ))}
        </div>
      )}

      <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar por usuario, producto o voucher…" className="w-full max-w-md rounded-lg border border-border-default bg-surface px-3 py-2 text-[13px]" />

      <div className="overflow-x-auto rounded-xl border border-border-subtle bg-surface">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-border-subtle text-left text-text-tertiary">
              <th className="py-2 pl-3 pr-3 font-medium">Cliente</th>
              <th className="py-2 pr-3 font-medium">Usuario</th>
              <th className="py-2 pr-3 font-medium">Producto</th>
              <th className="py-2 pr-3 font-medium">Voucher</th>
              <th className="py-2 pr-3 font-medium">Últ. sync</th>
            </tr>
          </thead>
          <tbody>
            {!data ? (
              <tr><td colSpan={5} className="py-6 text-center text-text-tertiary">Cargando…</td></tr>
            ) : data.items.length === 0 ? (
              <tr><td colSpan={5} className="py-6 text-center text-text-tertiary">Sin suscripciones.</td></tr>
            ) : data.items.map((r) => (
              <tr key={r.id} className="border-b border-border-subtle/60">
                <td className="py-1.5 pl-3 pr-3">
                  {r.subscriberId ? <Link href={`/clientes/${r.subscriberId}`} className="text-brand hover:underline">{r.subscriberName ?? "—"}</Link> : (r.subscriberName ?? "—")}
                  {r.abonado != null && <span className="ml-1 text-[11px] text-text-tertiary">#{r.abonado}</span>}
                </td>
                <td className="py-1.5 pr-3 font-mono text-[12px]">{r.nameS ?? "—"}</td>
                <td className="py-1.5 pr-3">{r.productName ?? r.productId ?? "—"}</td>
                <td className="py-1.5 pr-3 text-text-secondary">{r.voucher ?? "—"}</td>
                <td className="py-1.5 pr-3 text-text-tertiary">{fmt(r.syncedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data && data.pages > 1 && <Pagination meta={{ page: data.page, pageSize: data.pageSize, total: data.total, pageCount: data.pages }} onPage={setPage} />}
    </div>
  );
}
