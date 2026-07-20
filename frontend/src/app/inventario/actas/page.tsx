"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PageHeading } from "@/components/accounting/PageHeading";
import { Icon } from "@/components/Icon";
import { Badge } from "@/components/ui/Badge";
import { DataTable } from "@/components/inventory/DataTable";
import { Pagination } from "@/components/ui/Pagination";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { useAuth } from "@/context/AuthProvider";
import { fmtDate } from "@/lib/format";

type Acta = { id: string; date: string; from: string | null; to: string | null; observations: string | null; status: string; items: number };
type ActaList = { items: Acta[]; total: number; page: number; pageSize: number; pages: number };

export default function ActasPage() {
  const { loading: authLoading, authFetch } = useAuth();
  const router = useRouter();
  const [data, setData] = useState<ActaList | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const load = useCallback(async () => {
    const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    setData(await (await authFetch(`/inventory/actas?${qs}`)).json());
  }, [authFetch, page, pageSize]);

  useEffect(() => { if (!authLoading) void load(); }, [authLoading, load]);

  if (authLoading || !data) return <PageSkeleton />;

  return (
    <>
      <div className="mb-4 flex items-center justify-between gap-3">
        <PageHeading icon="clipboard-list" title="Actas de transferencia" subtitle="Traspasos de material entre bodegas" />
        <Link href="/inventario/traspasos" className="inline-flex items-center gap-1.5 rounded-lg border border-border-default px-3 py-2 text-[12px] font-semibold text-text-secondary transition-colors hover:bg-surface-2">
          <Icon name="layers" size={14} /> Nuevo traspaso
        </Link>
      </div>

      <div className="flex flex-col gap-3">
        <DataTable
          autoHeight
          rows={data.items}
          empty="No hay actas registradas."
          onRowClick={(r: Acta) => router.push(`/inventario/actas/${r.id}`)}
          columns={[
            { key: "date", header: "Fecha", render: (r: Acta) => fmtDate(r.date) },
            { key: "from", header: "Origen", render: (r: Acta) => <span className="text-text-secondary">{r.from || "—"}</span> },
            { key: "to", header: "Destino", render: (r: Acta) => <span className="text-text-secondary">{r.to || "—"}</span> },
            { key: "items", header: "Ítems", align: "right", render: (r: Acta) => <Badge label={String(r.items)} tone="info" /> },
            { key: "obs", header: "Observaciones", render: (r: Acta) => <span className="text-text-tertiary">{r.observations || "—"}</span> },
            { key: "status", header: "Estado", render: (r: Acta) => <Badge label={r.status} tone={r.status === "Recibida" ? "success" : "default"} /> },
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
