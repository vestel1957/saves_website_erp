"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/Icon";
import { cop } from "@/lib/subscribers";
import { getPortalToken, clearPortalToken, portalFetch, type PortalMe } from "@/lib/portal";
import { fmtDate } from "@/lib/format";

export default function PortalPage() {
  const router = useRouter();
  const [me, setMe] = useState<PortalMe | null>(null);
  const [loading, setLoading] = useState(true);

  const logout = useCallback(() => { clearPortalToken(); router.replace("/portal/login"); }, [router]);

  const load = useCallback(async () => {
    try {
      const res = await portalFetch("/portal/me");
      if (res.status === 401) return logout();
      const d: PortalMe = await res.json();
      setMe(d);
    } finally { setLoading(false); }
  }, [logout]);

  useEffect(() => {
    if (!getPortalToken()) { router.replace("/portal/login"); return; }
    void load();
  }, [router, load]);

  if (loading) {
    return <div className="flex min-h-screen items-center justify-center text-text-tertiary"><Icon name="loader" size={22} className="animate-spin" /></div>;
  }
  if (!me) return null;

  const sinDeuda = me.debt <= 0;

  return (
    <div className="mx-auto max-w-lg px-4 py-8">
      {/* Encabezado */}
      <div className="mb-6 flex items-center justify-between">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo-vestel.png" alt="Vestel" className="h-9 w-auto" />
        <button onClick={logout} className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-text-tertiary hover:text-error-text">
          <Icon name="log-out" size={14} /> Salir
        </button>
      </div>

      <div className="mb-1 text-[13px] text-text-secondary">Hola,</div>
      <h1 className="text-[19px] font-bold text-text-primary">{me.subscriber.name}</h1>
      <div className="text-[12.5px] text-text-tertiary">Abonado {me.subscriber.abonado}{me.subscriber.address ? ` · ${me.subscriber.address}` : ""}</div>

      {/* Deuda + pago */}
      <div className="mt-6 rounded-2xl border border-border-subtle bg-surface p-6 shadow-sm">
        <div className="text-[12.5px] font-medium text-text-tertiary">Saldo pendiente</div>
        <div className={`mt-1 text-[30px] font-extrabold ${sinDeuda ? "text-success-text" : "text-text-primary"}`}>{cop(me.debt)}</div>

        {sinDeuda ? (
          <div className="mt-4 flex items-center gap-2 rounded-lg bg-success-soft px-3 py-2.5 text-[13px] text-success-text">
            <Icon name="check" size={16} /> Estás al día. ¡Gracias!
          </div>
        ) : (
          <div className="mt-4 flex items-start gap-2 rounded-lg bg-surface-2 px-3 py-2.5 text-[12.5px] text-text-secondary">
            <Icon name="info" size={16} className="mt-0.5 shrink-0" />
            Acércate a nuestros puntos de pago para ponerte al día.
          </div>
        )}
      </div>

      {/* Facturas pendientes */}
      {me.invoices.length > 0 && (
        <div className="mt-6">
          <div className="mb-2 text-[13px] font-bold text-text-primary">Facturas pendientes</div>
          <div className="divide-y divide-border-subtle overflow-hidden rounded-xl border border-border-subtle bg-surface">
            {me.invoices.map((inv) => (
              <div key={inv.id} className="flex items-center justify-between px-4 py-3">
                <div className="leading-tight">
                  <div className="text-[13px] font-semibold text-text-primary">Factura #{inv.tid}</div>
                  <div className="text-[11.5px] text-text-tertiary">Emitida {fmtDate(inv.date)}{inv.dueDate ? ` · vence ${fmtDate(inv.dueDate)}` : ""}</div>
                </div>
                <div className="text-[14px] font-bold text-text-primary">{cop(inv.saldo)}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
