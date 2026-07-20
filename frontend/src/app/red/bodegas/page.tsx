"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { DataTable } from "@/components/ui/DataTable";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { useAuth } from "@/context/AuthProvider";

type Warehouse = { id: string; name: string; description?: string | null; equipment?: number };

export default function BodegaEquiposPage() {
  const router = useRouter();
  const { loading: authLoading, authFetch } = useAuth();
  const [rows, setRows] = useState<Warehouse[] | null>(null);

  useEffect(() => {
    if (authLoading) return;
    void authFetch("/network/equipment-warehouses")
      .then((r) => r.json())
      .then((list: Warehouse[]) => setRows(list))
      .catch(() => setRows([]));
  }, [authLoading, authFetch]);

  if (authLoading || !rows) return <PageSkeleton />;
  const totalEquipos = rows.reduce((s, w) => s + (w.equipment ?? 0), 0);

  return (
    <div className="flex flex-col gap-4">
      <PageHeading icon="boxes" title="Bodegas de equipos" subtitle="Almacenes de equipos por sede — abre una para ver su contenido" />

      <div className="flex items-center gap-3 rounded-xl border border-border-subtle bg-surface px-4 py-3 shadow-sm">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-soft text-brand"><Icon name="boxes" size={17} /></span>
        <div>
          <div className="text-[11px] text-text-tertiary">Total equipos en bodega</div>
          <div className="text-[18px] font-bold text-text-primary">{totalEquipos.toLocaleString("es-CO")}</div>
        </div>
        <div className="ml-4 border-l border-border-subtle pl-4">
          <div className="text-[11px] text-text-tertiary">Bodegas</div>
          <div className="text-[18px] font-bold text-text-primary">{rows.length}</div>
        </div>
      </div>

      {/* Tabla de bodegas: al dar click en una fila se abre su vista de equipos. */}
      <DataTable
        rows={rows}
        empty="Sin bodegas."
        onRowClick={(w: Warehouse) => router.push(`/red/bodegas/${w.id}`)}
        columns={[
          { key: "name", header: "Bodega", render: (w: Warehouse) => (
              <span className="flex items-center gap-2 font-medium text-text-primary">
                <Icon name="warehouse" size={15} className="text-text-tertiary" />{w.name}
              </span>
            ) },
          { key: "desc", header: "Descripción", render: (w: Warehouse) => <span className="text-text-secondary">{w.description || "—"}</span> },
          { key: "eq", header: "Equipos", align: "right", render: (w: Warehouse) => <span className="font-semibold">{(w.equipment ?? 0).toLocaleString("es-CO")}</span> },
          { key: "go", header: "", align: "right", render: () => (
              <span className="inline-flex items-center gap-1 text-[12px] font-semibold text-text-tertiary">
                Ver equipos <Icon name="chevron-right" size={14} />
              </span>
            ) },
        ]}
      />
    </div>
  );
}
