"use client";

import { useState } from "react";
import { PageHeading } from "@/components/ui/PageHeading";
import { LinkMovimientos } from "@/components/cobranzas/LinkMovimientos";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { TxTable } from "@/components/cobranzas/TxTable";
import type { TxRow } from "@/lib/treasury";
import dynamic from "next/dynamic";

const EgresoModal = dynamic(() => import("@/components/cobranzas/TesoreriaModals").then((m) => m.EgresoModal), { ssr: false });
const EditarMovimientoModal = dynamic(() => import("@/components/cobranzas/TesoreriaModals").then((m) => m.EditarMovimientoModal), { ssr: false });

export default function EgresosPage() {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<TxRow | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <PageHeading icon="trending-down" title="Egresos" subtitle="Gastos y salidas de caja" />
        <div className="flex items-center gap-2">
          <LinkMovimientos />
          <Button variant="secondary" size="sm" onClick={() => setOpen(true)}><Icon name="trending-down" size={14} /> Registrar egreso</Button>
        </div>
      </div>

      {open && <EgresoModal open={open} onClose={() => setOpen(false)} onDone={() => setRefreshKey((k) => k + 1)} />}
      {editing && <EditarMovimientoModal tx={editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); setRefreshKey((k) => k + 1); }} />}

      <TxTable
        params={{ type: "EXPENSE" }}
        refreshKey={refreshKey}
        empty="No hay egresos registrados."
        rowAction={(r) => r.status !== "ANULADA" ? (
          <button type="button" onClick={() => setEditing(r)} title="Editar movimiento"
            className="inline-flex min-h-8 items-center gap-1 text-[12px] font-medium text-text-secondary hover:text-brand">
            <Icon name="pencil" size={13} /> Editar
          </button>
        ) : null}
      />
    </>
  );
}
