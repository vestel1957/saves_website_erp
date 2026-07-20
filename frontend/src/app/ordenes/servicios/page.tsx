"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { Badge } from "@/components/ui/Badge";
import { DataTable } from "@/components/ui/DataTable";
import { Pagination } from "@/components/ui/Pagination";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { OrdersFilterButton, EMPTY_FILTERS, countActiveFilters, type OrderFilters } from "@/components/orders/OrdersFilterButton";
import { useAuth } from "@/context/AuthProvider";
import { cop } from "@/lib/subscribers";
import { useRequest } from "@/lib/useRequest";

function statusTone(status: string): "default" | "success" | "error" | "warning" {
  if (status === "recibido" || status === "finalizado") return "success";
  if (status === "cancelado" || status === "anulado") return "error";
  if (status === "recibido parcial") return "warning";
  return "default";
}

export default function OrdenesServiciosPage() {
  const { loading: authLoading, authFetch } = useAuth();

  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<OrderFilters>(EMPTY_FILTERS);
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([]);
  const [branches, setBranches] = useState<{ name: string }[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  useEffect(() => {
    if (authLoading) return;
    void authFetch("/orders/categories").then((r) => r.json()).then((c) => setCategories(Array.isArray(c) ? c : [])).catch(() => {});
    void authFetch("/orders/branches").then((r) => r.json()).then((b) => setBranches(Array.isArray(b) ? b : [])).catch(() => {});
  }, [authLoading, authFetch]);

  // Carga con cancelación: al teclear se aborta la petición en vuelo para que
  // una respuesta lenta no pise a otra más reciente. Ver lib/useRequest.
  const { data, cargando: loading, error, refrescar: load } = useRequest<any>(
    () => {
      const qs = new URLSearchParams({ kind: "servicio", page: String(page), pageSize: String(pageSize) });
      if (search.trim()) qs.set("search", search.trim());
      if (filters.status) qs.set("status", filters.status);
      if (filters.category) qs.set("category", filters.category);
      if (filters.branch) qs.set("branch", filters.branch);
      if (filters.supplier) qs.set("supplier", filters.supplier);
      if (filters.minTotal) qs.set("minTotal", filters.minTotal);
      if (filters.maxTotal) qs.set("maxTotal", filters.maxTotal);
      if (filters.from) qs.set("from", filters.from);
      if (filters.to) qs.set("to", filters.to);
      return `/orders?${qs.toString()}`;
    },
    [page, pageSize, search, filters],
    { debounceMs: search ? 350 : 0, saltar: authLoading },
  );

  useEffect(() => { setPage(1); }, [search, filters, pageSize]);

  if (authLoading) return <PageSkeleton />;

  const activeFilters = countActiveFilters(filters);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <PageHeading
          icon="wrench"
          title="Órdenes de servicio"
          subtitle="Servicios contratados a proveedores"
        />
        <Link href="/ordenes/nueva">
          <Button variant="primary"><Icon name="plus" size={15} /> Nueva orden</Button>
        </Link>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative w-[220px] flex-1 sm:max-w-[280px]">
          <Icon name="search" size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
          <Input className="pl-9" placeholder="Buscar por N°, proveedor…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <OrdersFilterButton value={filters} onChange={setFilters} categories={categories} branches={branches} />
        {activeFilters > 0 && (
          <button
            type="button"
            onClick={() => setFilters(EMPTY_FILTERS)}
            className="inline-flex items-center gap-1 rounded-lg px-2.5 py-2 text-[13px] font-medium text-text-secondary hover:bg-surface-2"
          >
            <Icon name="x" size={14} /> Limpiar
          </button>
        )}
      </div>

      {loading && !data ? <PageSkeleton /> : (
        <>
          <DataTable
            rows={data?.items ?? []}
            empty="No se encontraron órdenes de servicio."
            columns={[
              { key: "tid", header: "N°", render: (r: any) => <Link href={`/ordenes/${r.id}`} className="font-mono font-medium text-brand hover:underline">{r.tid}</Link> },
              { key: "supplier", header: "Proveedor", render: (r: any) => <span className="font-medium text-text-primary">{r.supplier}</span> },
              { key: "branchRef", header: "Sede", render: (r: any) => (r.branchRef ? <Badge label={r.branchRef} tone="info" /> : <span className="text-text-tertiary">—</span>) },
              { key: "date", header: "Fecha", render: (r: any) => (r.date ? new Date(r.date).toLocaleDateString("es-CO") : "—") },
              { key: "total", header: "Total", align: "right", render: (r: any) => cop(r.total) },
              { key: "status", header: "Estado", render: (r: any) => <Badge label={r.status} tone={statusTone(r.status)} /> },
              { key: "itemsCount", header: "Ítems", align: "right", render: (r: any) => <span className="text-text-secondary">{r.itemsCount}</span> },
            ]}
          />
          {data && data.pages > 1 && (
            <div className="mt-3">
              <Pagination meta={{ page: data.page, pageSize: data.pageSize, total: data.total, pageCount: data.pages }} onPage={setPage} onPageSize={setPageSize} />
            </div>
          )}
        </>
      )}
    </>
  );
}
