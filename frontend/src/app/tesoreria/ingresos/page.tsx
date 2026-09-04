"use client";

import { useState } from "react";
import { PageHeading } from "@/components/ui/PageHeading";
import { LinkMovimientos } from "@/components/cobranzas/LinkMovimientos";
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
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <PageHeading icon="trending-up" title="Ingresos" subtitle="Recaudos y pagos registrados" />
        <div className="flex items-center gap-2">
          <LinkMovimientos />
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

      {/*
        La cajera registra recaudos, pero no vuelve sobre los ya registrados: corregir
        un ingreso es de contabilidad (el backend lo niega igual, `editable` solo decide
        si se pintan los inputs). Se corrige en la propia fila, sin abrir modal.
      */}
      <TxTable
        params={{ type: "INCOME" }}
        refreshKey={refreshKey}
        editable
        empty="No hay ingresos registrados."
      />
    </>
  );
}
