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
import { EditarMovimientoModal } from "@/components/cobranzas/TesoreriaModals";
import { useAuth } from "@/context/AuthProvider";
import { PERM } from "@/lib/auth";
import type { TxRow } from "@/lib/treasury";

export default function IngresosPage() {
  const { can, isSuperadmin } = useAuth();
  // La cajera registra recaudos, pero no vuelve sobre los ya registrados: corregir
  // un ingreso es de contabilidad (el backend lo niega igual, esto es la UI).
  const puedeEditar = isSuperadmin || can(PERM.AREA_CONTABILIDAD);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [picked, setPicked] = useState<PickedSub | null>(null);
  const [editing, setEditing] = useState<TxRow | null>(null);
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

      {editing && (
        <EditarMovimientoModal
          tx={editing}
          onClose={() => setEditing(null)}
          onDone={() => { setEditing(null); setRefreshKey((k) => k + 1); }}
        />
      )}

      <TxTable
        params={{ type: "INCOME" }}
        refreshKey={refreshKey}
        empty="No hay ingresos registrados."
        rowAction={(r) => puedeEditar && r.status !== "ANULADA" ? (
          <button type="button" onClick={() => setEditing(r)} title="Editar movimiento"
            className="inline-flex min-h-8 items-center gap-1 text-[12px] font-medium text-text-secondary hover:text-brand">
            <Icon name="pencil" size={13} /> Editar
          </button>
        ) : null}
      />
    </>
  );
}
