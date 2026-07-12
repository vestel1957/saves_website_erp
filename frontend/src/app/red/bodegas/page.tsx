"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PageHeading } from "@/components/accounting/PageHeading";
import { Icon } from "@/components/Icon";
import { DataTable } from "@/components/inventory/DataTable";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { useAuth } from "@/context/AuthProvider";

export default function BodegaEquiposPage() {
  const { loading: authLoading, authFetch } = useAuth();
  const [rows, setRows] = useState<any[] | null>(null);

  useEffect(() => {
    if (authLoading) return;
    void authFetch("/network/equipment-warehouses").then((r) => r.json()).then(setRows).catch(() => setRows([]));
  }, [authLoading, authFetch]);

  if (authLoading || !rows) return <PageSkeleton />;
  const totalEquipos = rows.reduce((s, w) => s + (w.equipment ?? 0), 0);

  return (
    <>
      <PageHeading icon="boxes" title="Bodegas de equipos" subtitle="Almacenes de equipos por sede" />

      <div className="mb-4 flex items-center gap-3 rounded-xl border border-border-subtle bg-surface px-4 py-3 shadow-sm">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-soft text-brand"><Icon name="boxes" size={17} /></span>
        <div><div className="text-[11px] text-text-tertiary">Total equipos en bodega</div><div className="text-[18px] font-bold text-text-primary">{totalEquipos.toLocaleString("es-CO")}</div></div>
      </div>

      <DataTable
        rows={rows}
        empty="Sin bodegas."
        columns={[
          { key: "name", header: "Bodega", render: (r: any) => <span className="font-medium text-text-primary">{r.name}</span> },
          { key: "desc", header: "Descripción", render: (r: any) => <span className="text-text-secondary">{r.description || "—"}</span> },
          { key: "eq", header: "Equipos", align: "right", render: (r: any) => <span className="font-semibold">{(r.equipment ?? 0).toLocaleString("es-CO")}</span> },
        ]}
      />
    </>
  );
}
