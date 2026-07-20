"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { Badge } from "@/components/ui/Badge";
import { DataTable } from "@/components/ui/DataTable";
import { Pagination } from "@/components/ui/Pagination";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { LoadError } from "@/components/ui/LoadError";
import { useAuth } from "@/context/AuthProvider";
import { cop } from "@/lib/subscribers";
import { StatCard } from "@/components/ui/StatCard";

type Warehouse = { id: string; title: string; extra: string | null; technicianRef: string | null; materials: number; value: number };

const COLUMNS = [
  { key: "name", header: "Nombre", render: (r: any) => <span className="font-medium text-text-primary">{r.name}</span> },
  { key: "code", header: "Código", render: (r: any) => <span className="text-text-secondary">{r.code || "—"}</span> },
  { key: "category", header: "Categoría", render: (r: any) => <span className="text-text-secondary">{r.category || "—"}</span> },
  { key: "price", header: "Precio", align: "right" as const, render: (r: any) => <span>{cop(r.price ?? 0)}</span> },
  { key: "qty", header: "Stock", align: "right" as const, render: (r: any) => r.low ? <Badge label={`${r.qty ?? 0} · Bajo`} tone="error" /> : <span>{r.qty ?? 0}</span> },
  { key: "value", header: "Valor", align: "right" as const, render: (r: any) => <span className="font-semibold">{cop(r.value ?? 0)}</span> },
];

export default function BodegaMaterialesPage() {
  const { id } = useParams<{ id: string }>();
  const { loading: authLoading, authFetch } = useAuth();

  const [wh, setWh] = useState<Warehouse | null>(null);
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(false);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  // Cabecera: resumen de la bodega (nombre, total y valor).
  const loadWh = useCallback(async () => {
    try {
      const list: Warehouse[] = await (await authFetch("/inventory/warehouses")).json();
      setWh(list.find((w) => w.id === id) ?? null);
    } catch { /* la tabla igual puede cargar */ }
  }, [authFetch, id]);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(false);
    try {
      const params = new URLSearchParams({ warehouseId: String(id), page: String(page), pageSize: "25" });
      if (search.trim()) params.set("search", search.trim());
      const r = await authFetch(`/inventory/materials?${params.toString()}`);
      if (!r.ok) throw new Error();
      setData(await r.json());
    } catch {
      setErr(true);
    } finally {
      setLoading(false);
    }
  }, [authFetch, id, page, search]);

  useEffect(() => { if (!authLoading) void loadWh(); }, [authLoading, loadWh]);
  useEffect(() => {
    if (authLoading) return;
    const t = setTimeout(load, search ? 300 : 0);
    return () => clearTimeout(t);
  }, [authLoading, load, search]);

  if (authLoading) return <PageSkeleton />;

  return (
    <div className="space-y-4">
      <PageHeading icon="warehouse" title="Volver" />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-[18px] font-bold text-text-primary">
            <Icon name="warehouse" size={18} className="text-brand" /> {wh ? wh.title : "Bodega"}
          </h1>
          <p className="mt-0.5 text-[13px] text-text-tertiary">{wh?.extra || "Inventario de esta bodega"}</p>
        </div>
        <Link href={`/inventario?warehouseId=${id}`} title="Abrir en el administrador de material">
          <Button variant="secondary" size="sm"><Icon name="external-link" size={14} /> Administrar</Button>
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:max-w-md">
        <StatCard label="Total de materiales" value={(wh?.materials ?? data?.total ?? 0).toLocaleString("es-CO")} icon="package" />
        <StatCard label="Valor del inventario" value={cop(wh?.value ?? 0)} icon="dollar-sign" />
      </div>

      <div className="relative max-w-md">
        <Icon name="search" size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
        <Input
          className="pl-9"
          placeholder="Buscar material por nombre o código…"
          value={search}
          onChange={(e) => { setPage(1); setSearch(e.target.value); }}
        />
      </div>

      {err && !data ? (
        <LoadError message="No se pudieron cargar los materiales." onRetry={load} />
      ) : loading && !data ? (
        <PageSkeleton />
      ) : (
        <>
          <DataTable rows={data?.items ?? []} empty={search ? "Ningún material coincide con la búsqueda." : "Esta bodega no tiene materiales."} columns={COLUMNS} />
          {data && data.pages > 1 && (
            <Pagination meta={{ page: data.page, pageSize: data.pageSize, total: data.total, pageCount: data.pages }} onPage={setPage} />
          )}
        </>
      )}
    </div>
  );
}
