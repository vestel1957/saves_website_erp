"use client";

import { useState } from "react";
import { PageHeading } from "@/components/ui/PageHeading";
import { LinkMovimientos } from "@/components/cobranzas/LinkMovimientos";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { TxTable } from "@/components/cobranzas/TxTable";
import dynamic from "next/dynamic";

const EgresoModal = dynamic(() => import("@/components/cobranzas/TesoreriaModals").then((m) => m.EgresoModal), { ssr: false });

export default function EgresosPage() {
  const [open, setOpen] = useState(false);
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

      {/* Registrar el egreso sí; corregirle el monto o la fecha después, solo contabilidad (ver ingresos). */}
      <TxTable
        params={{ type: "EXPENSE" }}
        refreshKey={refreshKey}
        editable
        empty="No hay egresos registrados."
      />
    </>
  );
}
