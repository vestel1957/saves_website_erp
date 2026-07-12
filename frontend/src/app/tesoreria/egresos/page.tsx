"use client";

import { useState } from "react";
import Link from "next/link";
import { PageHeading } from "@/components/accounting/PageHeading";
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
      <div className="flex items-center justify-between gap-3">
        <PageHeading icon="trending-down" title="Egresos" subtitle="Gastos y salidas de caja" />
        <div className="flex items-center gap-2">
          <Link href="/tesoreria" className="inline-flex items-center gap-1.5 rounded-lg border border-border-default px-3 py-2 text-[12px] font-semibold text-text-secondary transition-colors hover:bg-surface-2">
            <Icon name="banknote" size={14} /> Movimientos
          </Link>
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
            className="inline-flex items-center gap-1 text-[12px] font-medium text-text-secondary hover:text-brand">
            <Icon name="pencil" size={13} /> Editar
          </button>
        ) : null}
      />
    </>
  );
}
