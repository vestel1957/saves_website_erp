"use client";

import Link from "next/link";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { TxTable } from "@/components/cobranzas/TxTable";

export default function AnulacionesPage() {
  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <PageHeading icon="x" title="Anulaciones" subtitle="Transacciones anuladas (reversadas)" />
        <Link href="/tesoreria" className="inline-flex items-center gap-1.5 rounded-lg border border-border-default px-3 py-2 text-[12px] font-semibold text-text-secondary transition-colors hover:bg-surface-2">
          <Icon name="banknote" size={14} /> Movimientos
        </Link>
      </div>

      <TxTable
        params={{ status: "ANULADA" }}
        empty="No hay transacciones anuladas."
        extraColumns={[
          { key: "motivo", header: "Motivo", render: (r) => <span className="text-text-tertiary">{r.note || "—"}</span> },
        ]}
      />
    </>
  );
}
