"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeading } from "@/components/accounting/PageHeading";
import { Icon } from "@/components/Icon";
import { Modal } from "@/components/Modal";
import { SubscriberPicker, type PickedSub } from "@/components/cobranzas/SubscriberPicker";
import { RegistrarPagoModal } from "@/components/cobranzas/RegistrarPagoModal";
import dynamic from "next/dynamic";

const EgresoModal = dynamic(() => import("@/components/cobranzas/TesoreriaModals").then((m) => m.EgresoModal), { ssr: false });
const IngresoLibreModal = dynamic(() => import("@/components/cobranzas/TesoreriaModals").then((m) => m.IngresoLibreModal), { ssr: false });

function OptionCard({ icon, tone, title, desc, onClick }: {
  icon: string; tone: string; title: string; desc: string; onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-start gap-3.5 rounded-2xl border border-border-subtle bg-surface p-5 text-left shadow-sm transition-colors hover:border-brand hover:bg-surface-2"
    >
      <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${tone}`}><Icon name={icon} size={20} /></span>
      <span className="leading-tight">
        <span className="block text-[15px] font-bold text-text-primary">{title}</span>
        <span className="mt-0.5 block text-[12.5px] text-text-tertiary">{desc}</span>
      </span>
    </button>
  );
}

export default function NuevaTransaccionPage() {
  const router = useRouter();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [picked, setPicked] = useState<PickedSub | null>(null);
  const [egresoOpen, setEgresoOpen] = useState(false);
  const [ingresoLibreOpen, setIngresoLibreOpen] = useState(false);

  return (
    <>
      <PageHeading icon="plus" title="Nueva transacción" subtitle="Registra un ingreso (recaudo) o un egreso de caja" />

      <div className="grid max-w-4xl grid-cols-1 gap-4 sm:grid-cols-3">
        <OptionCard
          icon="trending-up"
          tone="bg-success-soft text-success-text"
          title="Ingreso / Recaudo"
          desc="Aplica un pago a la deuda de un cliente."
          onClick={() => setPickerOpen(true)}
        />
        <OptionCard
          icon="hand-coins"
          tone="bg-info-soft text-info-text"
          title="Ingreso libre"
          desc="Ingreso por otro concepto, sin factura."
          onClick={() => setIngresoLibreOpen(true)}
        />
        <OptionCard
          icon="trending-down"
          tone="bg-error-soft text-error-text"
          title="Egreso / Gasto"
          desc="Registra una salida de dinero de la caja."
          onClick={() => setEgresoOpen(true)}
        />
      </div>

      {/* Ingreso: elegir cliente → registrar pago */}
      <Modal open={pickerOpen} onClose={() => setPickerOpen(false)} title="Registrar recaudo" maxWidth="max-w-lg">
        <p className="mb-2 text-[13px] text-text-secondary">Elige el cliente al que se le aplicará el pago.</p>
        <SubscriberPicker value={null} onChange={(s) => { if (s) { setPicked(s); setPickerOpen(false); } }} />
      </Modal>
      {picked && (
        <RegistrarPagoModal
          subscriberId={picked.id}
          open={!!picked}
          onClose={() => setPicked(null)}
          onDone={() => { setPicked(null); router.push("/tesoreria/ingresos"); }}
        />
      )}

      {/* Ingreso libre */}
      {ingresoLibreOpen && <IngresoLibreModal open={ingresoLibreOpen} onClose={() => setIngresoLibreOpen(false)} onDone={() => router.push("/tesoreria/ingresos")} />}

      {/* Egreso */}
      {egresoOpen && <EgresoModal open={egresoOpen} onClose={() => setEgresoOpen(false)} onDone={() => router.push("/tesoreria/egresos")} />}
    </>
  );
}
