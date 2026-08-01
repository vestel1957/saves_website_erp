"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { Badge } from "@/components/ui/Badge";
import { DataTable } from "@/components/ui/DataTable";
import { Pagination } from "@/components/ui/Pagination";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { useAuth } from "@/context/AuthProvider";
import { useOrden } from "@/lib/useOrden";
import { fmtDate } from "@/lib/format";

type Acta = { id: string; date: string; from: string | null; to: string | null; observations: string | null; status: string; items: number };
type ActaList = { items: Acta[]; total: number; page: number; pageSize: number; pages: number };

export default function ActasPage() {
  const { loading: authLoading, authFetch } = useAuth();
  const router = useRouter();
  const [data, setData] = useState<ActaList | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  // Pagina en el servidor: el orden viaja en la query.
  const orden = useOrden();

  const load = useCallback(async () => {
    const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize), ...orden.params });
    setData(await (await authFetch(`/inventory/actas?${qs}`)).json());
  }, [authFetch, page, pageSize, orden.clave]);

  useEffect(() => { if (!authLoading) void load(); }, [authLoading, load]);

  if (authLoading || !data) return <PageSkeleton />;

  return (
    <>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <PageHeading icon="clipboard-list" title="Actas de transferencia" subtitle="Traspasos de material entre bodegas" />
        <Link href="/inventario/traspasos" className="inline-flex items-center gap-1.5 rounded-lg border border-border-default px-3 py-2 text-[12px] font-semibold text-text-secondary transition-colors hover:bg-surface-2">
          <Icon name="layers" size={14} /> Nuevo traspaso
        </Link>
      </div>

      <div className="flex flex-col gap-3">
        <DataTable
          sort={orden.sort}
          onSort={orden.onSort}
          rows={data.items}
          empty="No hay actas registradas."
          onRowClick={(r: Acta) => router.push(`/inventario/actas/${r.id}`)}
          columns={[
            { key: "date", header: "Fecha", sortable: true, render: (r: Acta) => fmtDate(r.date) },
            { key: "from", header: "Origen", sortable: true, render: (r: Acta) => <span className="text-text-secondary">{r.from || "—"}</span> },
            { key: "to", header: "Destino", sortable: true, render: (r: Acta) => <span className="text-text-secondary">{r.to || "—"}</span> },
            { key: "items", header: "Ítems", sortable: true, align: "right", render: (r: Acta) => <Badge label={String(r.items)} tone="info" /> },
            { key: "obs", header: "Observaciones", sortable: true, render: (r: Acta) => <span className="text-text-tertiary">{r.observations || "—"}</span> },
            { key: "status", header: "Estado", sortable: true, render: (r: Acta) => <Badge label={r.status} tone={r.status === "Recibida" ? "success" : "default"} /> },
            { key: "go", header: "", align: "right", render: () => (
                <span className="inline-flex items-center gap-1 text-[12px] font-semibold text-text-tertiary">Ver <Icon name="chevron-right" size={14} /></span>
              ) },
          ]}
        />
        {data.pages > 1 && (
          <Pagination meta={{ page: data.page, pageSize: data.pageSize, total: data.total, pageCount: data.pages }} onPage={setPage} onPageSize={setPageSize} />
        )}
      </div>
    </>
  );
}
