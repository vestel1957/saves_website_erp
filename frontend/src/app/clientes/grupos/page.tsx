"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { Badge } from "@/components/ui/Badge";
import { PagedTable } from "@/components/ui/PagedTable";
import { ListToolbar } from "@/components/ui/ListToolbar";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { LoadError } from "@/components/ui/LoadError";
import { Button } from "@/components/ui/Button";
import { exportReportExcel } from "@/lib/report-export";
import { useAuth } from "@/context/AuthProvider";

type BranchStat = { id: string; name: string; total: number; activos: number; cortados: number; cartera: number };

export default function GruposClientesPage() {
  const { loading: authLoading, authFetch } = useAuth();
  const [branches, setBranches] = useState<BranchStat[] | null>(null);
  const [err, setErr] = useState(false);
  const [search, setSearch] = useState("");

  const load = useCallback(() => {
    setErr(false);
    void authFetch("/subscribers/branches-stats")
      .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
      .then(setBranches)
      .catch(() => setErr(true));
  }, [authFetch]);
  useEffect(() => { if (!authLoading) load(); }, [authLoading, load]);

  if (authLoading) return <PageSkeleton />;

  const shown = (branches ?? []).filter((b) => b.name.toLowerCase().includes(search.trim().toLowerCase()));

  /** Excel de lo que se está viendo (respeta la búsqueda). */
  const exportar = () =>
    exportReportExcel({
      title: "Grupos de clientes",
      subtitle: search.trim() ? `Sedes que coinciden con \u201c${search.trim()}\u201d` : "Abonados agrupados por sede",
      tables: [{
        columns: [
          { label: "Sede" },
          { label: "Abonados", align: "right" },
          { label: "Activos", align: "right" },
          { label: "Cortados", align: "right" },
          { label: "Cartera", align: "right" },
        ],
        rows: shown.map((b) => ({ cells: [b.name, b.total, b.activos, b.cortados, b.cartera] })),
      }],
    });

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <PageHeading icon="users-round" title="Grupos de clientes" subtitle="Abonados agrupados por sede" />
        <Button size="sm" variant="secondary" onClick={exportar} disabled={!shown.length}>
          <Icon name="download" size={14} /> Exportar Excel
        </Button>
      </div>

      <ListToolbar search={search} onSearch={setSearch} searchPlaceholder="Buscar sede…" />

      {err && !branches ? (
        <LoadError message="No se pudieron cargar las sedes." onRetry={load} />
      ) : !branches ? (
        <PageSkeleton />
      ) : (
        <PagedTable
          conTodos
          rows={shown}
          empty={search ? "Ninguna sede coincide con la búsqueda." : "No hay sedes registradas."}
          rowHref={(b: BranchStat) => `/clientes/grupos/${b.id}`}
          columns={[
            { key: "name", header: "Sede", render: (b: BranchStat) => (
              <span className="inline-flex items-center gap-2">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand"><Icon name="warehouse" size={14} /></span>
                <span className="font-medium text-text-primary">{b.name}</span>
              </span>
            ) },
            { key: "total", header: "Abonados", align: "right", render: (b: BranchStat) => <span className="font-mono font-semibold text-text-primary">{b.total.toLocaleString("es-CO")}</span> },
            { key: "activos", header: "Activos", align: "right", render: (b: BranchStat) => <Badge tone="success" label={b.activos.toLocaleString("es-CO")} /> },
            { key: "cortados", header: "Cortados", align: "right", render: (b: BranchStat) => b.cortados > 0 ? <Badge tone="error" label={b.cortados.toLocaleString("es-CO")} /> : <span className="text-text-tertiary">—</span> },
            { key: "cartera", header: "Cartera", align: "right", render: (b: BranchStat) => b.cartera > 0 ? <Badge tone="warning" label={b.cartera.toLocaleString("es-CO")} /> : <span className="text-text-tertiary">—</span> },
            { key: "go", header: "", align: "right", render: (b: BranchStat) => (
              <Link href={`/clientes/grupos/${b.id}`} onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1 rounded-lg border border-border-default px-3 py-1.5 text-[12px] font-semibold text-text-secondary transition-colors hover:bg-surface-2">Ver abonados →</Link>
            ) },
          ]}
        />
      )}
    </div>
  );
}
