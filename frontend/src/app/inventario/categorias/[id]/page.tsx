"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Icon } from "@/components/Icon";
import { DetailHeader } from "@/components/ui/DetailHeader";
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
import { useRequest } from "@/lib/useRequest";
import { useOrden } from "@/lib/useOrden";

type Category = { id: string; title: string; extra: string | null; materials: number; value: number };

const COLUMNS = [
  { key: "name", header: "Nombre", sortable: true, render: (r: any) => <span className="font-medium text-text-primary">{r.name}</span> },
  { key: "code", header: "Código", sortable: true, render: (r: any) => <span className="text-text-secondary">{r.code || "—"}</span> },
  { key: "warehouse", header: "Bodega", sortable: true, render: (r: any) => <span className="text-text-secondary">{r.warehouse || "—"}</span> },
  { key: "price", header: "Precio", sortable: true, align: "right" as const, render: (r: any) => <span>{cop(r.price ?? 0)}</span> },
  { key: "qty", header: "Stock", sortable: true, align: "right" as const, render: (r: any) => r.low ? <Badge label={`${r.qty ?? 0} · Bajo`} tone="error" /> : <span>{r.qty ?? 0}</span> },
  { key: "value", header: "Valor", align: "right" as const, render: (r: any) => <span className="font-semibold">{cop(r.value ?? 0)}</span> },
];

export default function CategoriaMaterialesPage() {
  const { id } = useParams<{ id: string }>();
  const { loading: authLoading, authFetch } = useAuth();

  const [cat, setCat] = useState<Category | null>(null);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  // Cabecera: resumen de la categoría (nombre, total y valor).
  const loadCat = useCallback(async () => {
    try {
      const cats: Category[] = await (await authFetch("/inventory/categories")).json();
      setCat(cats.find((c) => c.id === id) ?? null);
    } catch { /* la tabla igual puede cargar */ }
  }, [authFetch, id]);

  // Carga con cancelación. El estado de error lo aporta el propio hook, así que
  // desaparece el `err` local: antes había que acordarse de resetearlo a mano.
  // Pagina en el servidor: el orden viaja en la query.
  const orden = useOrden();

  const { data, cargando: loading, error: err, refrescar: load } = useRequest<any>(
    () => {
      const params = new URLSearchParams({ categoryId: String(id), page: String(page), pageSize: "25", ...orden.params });
      if (search.trim()) params.set("search", search.trim());
      return `/inventory/materials?${params.toString()}`;
    },
    [id, page, search],
    { debounceMs: search ? 300 : 0, saltar: authLoading },
  );

  useEffect(() => { if (!authLoading) void loadCat(); }, [authLoading, loadCat]);

  if (authLoading) return <PageSkeleton />;

  return (
    <div className="space-y-4">
      <DetailHeader
        backHref="/inventario/categorias"
        backLabel="Categorías de material"
        icon="boxes"
        title={cat ? cat.title : "Categoría"}
        subtitle={cat?.extra || "Materiales de esta categoría"}
        actions={
          <Link href={`/inventario?categoryId=${id}`} title="Abrir en el administrador de material" className="w-full sm:w-auto">
            <Button variant="secondary" size="sm" className="w-full sm:w-auto"><Icon name="external-link" size={14} /> Administrar</Button>
          </Link>
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:max-w-md">
        <StatCard label="Total de materiales" value={(cat?.materials ?? data?.total ?? 0).toLocaleString("es-CO")} icon="package" />
        <StatCard label="Valor del inventario" value={cop(cat?.value ?? 0)} icon="dollar-sign" />
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
          <DataTable rows={data?.items ?? []} empty={search ? "Ningún material coincide con la búsqueda." : "Esta categoría no tiene materiales."} columns={COLUMNS} sort={orden.sort} onSort={orden.onSort} />
          {data && data.pages > 1 && (
            <Pagination meta={{ page: data.page, pageSize: data.pageSize, total: data.total, pageCount: data.pages }} onPage={setPage} />
          )}
        </>
      )}
    </div>
  );
}
