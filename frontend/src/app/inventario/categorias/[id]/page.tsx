"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
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

type Category = { id: string; title: string; extra: string | null; materials: number; value: number };

const COLUMNS = [
  { key: "name", header: "Nombre", render: (r: any) => <span className="font-medium text-text-primary">{r.name}</span> },
  { key: "code", header: "Código", render: (r: any) => <span className="text-text-secondary">{r.code || "—"}</span> },
  { key: "warehouse", header: "Bodega", render: (r: any) => <span className="text-text-secondary">{r.warehouse || "—"}</span> },
  { key: "price", header: "Precio", align: "right" as const, render: (r: any) => <span>{cop(r.price ?? 0)}</span> },
  { key: "qty", header: "Stock", align: "right" as const, render: (r: any) => r.low ? <Badge label={`${r.qty ?? 0} · Bajo`} tone="error" /> : <span>{r.qty ?? 0}</span> },
  { key: "value", header: "Valor", align: "right" as const, render: (r: any) => <span className="font-semibold">{cop(r.value ?? 0)}</span> },
];

function StatCard({ label, value, icon }: { label: string; value: string; icon: string }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border-subtle bg-surface px-4 py-3 shadow-sm">
      <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-soft text-brand"><Icon name={icon} size={17} /></span>
      <div className="flex flex-col leading-tight">
        <span className="text-[11px] font-medium text-text-tertiary">{label}</span>
        <span className="text-[17px] font-bold text-text-primary">{value}</span>
      </div>
    </div>
  );
}

export default function CategoriaMaterialesPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { loading: authLoading, authFetch } = useAuth();

  const [cat, setCat] = useState<Category | null>(null);
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(false);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  // Cabecera: resumen de la categoría (nombre, total y valor).
  const loadCat = useCallback(async () => {
    try {
      const cats: Category[] = await (await authFetch("/inventory/categories")).json();
      setCat(cats.find((c) => c.id === id) ?? null);
    } catch { /* la tabla igual puede cargar */ }
  }, [authFetch, id]);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(false);
    try {
      const params = new URLSearchParams({ categoryId: String(id), page: String(page), pageSize: "25" });
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

  useEffect(() => { if (!authLoading) void loadCat(); }, [authLoading, loadCat]);
  useEffect(() => {
    if (authLoading) return;
    const t = setTimeout(load, search ? 300 : 0);
    return () => clearTimeout(t);
  }, [authLoading, load, search]);

  if (authLoading) return <PageSkeleton />;

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={() => router.back()}
        className="inline-flex items-center gap-1 text-[12px] font-medium text-text-tertiary transition-colors hover:text-text-secondary"
      >
        <Icon name="arrow-left" size={13} /> Volver
      </button>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-[18px] font-bold text-text-primary">
            <Icon name="boxes" size={18} className="text-brand" /> {cat ? cat.title : "Categoría"}
          </h1>
          <p className="mt-0.5 text-[13px] text-text-tertiary">{cat?.extra || "Materiales de esta categoría"}</p>
        </div>
        <Link href={`/inventario?categoryId=${id}`} title="Abrir en el administrador de material">
          <Button variant="secondary" size="sm"><Icon name="external-link" size={14} /> Administrar</Button>
        </Link>
      </div>

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
          <DataTable rows={data?.items ?? []} empty={search ? "Ningún material coincide con la búsqueda." : "Esta categoría no tiene materiales."} columns={COLUMNS} />
          {data && data.pages > 1 && (
            <Pagination meta={{ page: data.page, pageSize: data.pageSize, total: data.total, pageCount: data.pages }} onPage={setPage} />
          )}
        </>
      )}
    </div>
  );
}
