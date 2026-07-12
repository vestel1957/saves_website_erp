"use client";

import { useState } from "react";
import Link from "next/link";
import { PageHeading } from "@/components/accounting/PageHeading";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/Modal";
import { TxTable } from "@/components/cobranzas/TxTable";
import { SubscriberPicker, type PickedSub } from "@/components/cobranzas/SubscriberPicker";
import { RegistrarPagoModal } from "@/components/cobranzas/RegistrarPagoModal";

export default function IngresosPage() {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [picked, setPicked] = useState<PickedSub | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <PageHeading icon="trending-up" title="Ingresos" subtitle="Recaudos y pagos registrados" />
        <div className="flex items-center gap-2">
          <Link href="/tesoreria" className="inline-flex items-center gap-1.5 rounded-lg border border-border-default px-3 py-2 text-[12px] font-semibold text-text-secondary transition-colors hover:bg-surface-2">
            <Icon name="banknote" size={14} /> Movimientos
          </Link>
          <Button size="sm" onClick={() => setPickerOpen(true)}><Icon name="plus" size={14} /> Registrar recaudo</Button>
        </div>
      </div>

      {/* Paso 1: elegir cliente */}
      <Modal open={pickerOpen} onClose={() => setPickerOpen(false)} title="Registrar recaudo" maxWidth="max-w-lg">
        <p className="mb-2 text-[13px] text-text-secondary">Elige el cliente al que se le aplicará el pago.</p>
        <SubscriberPicker
          value={null}
          onChange={(s) => { if (s) { setPicked(s); setPickerOpen(false); } }}
        />
      </Modal>

      {/* Paso 2: registrar el pago sobre su deuda */}
      {picked && (
        <RegistrarPagoModal
          subscriberId={picked.id}
          open={!!picked}
          onClose={() => setPicked(null)}
          onDone={() => { setPicked(null); setRefreshKey((k) => k + 1); }}
        />
      )}

      <TxTable params={{ type: "INCOME" }} refreshKey={refreshKey} empty="No hay ingresos registrados." />
    </>
  );
}
