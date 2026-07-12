"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Icon } from "@/components/Icon";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/Modal";
import { toast } from "@/components/ui/Toast";
import { DataTable } from "@/components/inventory/DataTable";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { useAuth } from "@/context/AuthProvider";
import { PERM } from "@/lib/auth";
import { INVOICE_STATUS_LABEL, INVOICE_STATUS_TONE, cop } from "@/lib/subscribers";
import { INVOICE_KIND_LABEL, RON_LABEL } from "@/lib/billing";
import { type AvailablePromotion, discountLabel, isFlatDiscount, isBeforeTaxDiscount } from "@/lib/promotions";

const fmt = (d: string | null) => (d ? new Date(d).toLocaleDateString("es-CO") : "—");

export default function FacturaDetallePage() {
  const { id } = useParams<{ id: string }>();
  const { loading: authLoading, authFetch, can, isSuperadmin } = useAuth();
  const [f, setF] = useState<any | null>(null);
  const [err, setErr] = useState(false);
  const [promoOpen, setPromoOpen] = useState(false);
  const [promos, setPromos] = useState<AvailablePromotion[] | null>(null);
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [eMode, setEMode] = useState<{ live: boolean } | null>(null);
  const [emitting, setEmitting] = useState(false);

  const canEmit = isSuperadmin || can(PERM.AREA_CONTABILIDAD);

  const loadInvoice = () =>
    authFetch(`/billing/invoices/${id}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setF).catch(() => setErr(true));

  useEffect(() => {
    if (authLoading) return;
    void loadInvoice();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, authFetch, id]);

  function openPromos() {
    setPromoOpen(true);
    setPromos(null);
    void authFetch(`/my-promotions?invoiceId=${id}`).then((r) => (r.ok ? r.json() : [])).then(setPromos).catch(() => setPromos([]));
  }

  async function applyPromo(promo: AvailablePromotion) {
    if (!confirm(`Aplicar "${promo.name}" (${discountLabel(promo)}) a la factura #${f.tid}? Se generará una nota crédito.`)) return;
    setApplyingId(promo.id);
    try {
      const res = await authFetch(`/my-promotions/${promo.id}/apply`, {
        method: "POST",
        body: JSON.stringify({ invoiceId: id }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message || "No se pudo aplicar la promoción");
      toast(`Descuento aplicado: ${cop(data.amount)} (${discountLabel(promo)})`, "check");
      setPromoOpen(false);
      await loadInvoice();
    } catch (e) {
      toast((e as Error).message, "alert-circle");
    } finally {
      setApplyingId(null);
    }
  }

  async function openPdf() {
    const res = await authFetch(`/billing/invoices/${id}/pdf`);
    if (!res.ok) return;
    const url = URL.createObjectURL(await res.blob());
    window.open(url, "_blank");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  // Modo de emisión (LIVE/DRY-RUN) — solo para quien puede emitir.
  useEffect(() => {
    if (authLoading || !canEmit) return;
    void authFetch("/einvoice/mode").then((r) => (r.ok ? r.json() : null)).then(setEMode).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, canEmit]);

  async function emitEinvoice() {
    const live = !!eMode?.live;
    const warn = live
      ? `Vas a EMITIR ante la DIAN la factura #${f.tid}. Es un acto legal e irreversible. ¿Continuar?`
      : `Modo PRUEBA (DRY-RUN): se construirá el payload de la factura #${f.tid} SIN enviarlo a la DIAN. ¿Continuar?`;
    if (!confirm(warn)) return;
    setEmitting(true);
    try {
      const res = await authFetch(`/einvoice/emit/${id}`, { method: "POST" });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new Error(d?.message || "No se pudo emitir la factura electrónica");
      if (d.dryRun) {
        toast(
          d.configReady
            ? "DRY-RUN: payload válido. Active EINVOICE_LIVE y configure la cuenta para emitir de verdad."
            : "DRY-RUN: payload construido, pero la cuenta Siigo aún no está configurada para emitir.",
          "info",
        );
      } else {
        toast(`Factura emitida ante la DIAN: ${d.dianNumber}`, "check");
      }
      await loadInvoice();
    } catch (e) {
      toast((e as Error).message, "alert-circle");
    } finally {
      setEmitting(false);
    }
  }

  if (authLoading || (!f && !err)) return <PageSkeleton />;
  if (err) return <div className="rounded-xl border border-border-subtle bg-surface p-6 text-[13px] text-text-secondary">Factura no encontrada. <Link href="/facturacion" className="text-brand">Volver</Link></div>;

  return (
    <>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/facturacion" className="mb-1 inline-flex items-center gap-1 text-[12px] text-text-tertiary hover:text-text-secondary">
            <Icon name="arrow-left" size={13} /> Facturación
          </Link>
          <div className="flex items-center gap-3">
            <h1 className="text-[20px] font-bold text-text-primary">Factura #{f.tid}</h1>
            <Badge label={INVOICE_STATUS_LABEL[f.status] ?? f.status} tone={INVOICE_STATUS_TONE[f.status] ?? "default"} />
            {f.ron && <Badge label={RON_LABEL[f.ron] ?? f.ron} tone="default" />}
            <span className="text-[11px] text-text-tertiary">{INVOICE_KIND_LABEL[f.kind] ?? f.kind}</span>
          </div>
          <p className="text-[12px] text-text-tertiary">Emitida {fmt(f.date)} · Vence {fmt(f.dueDate)}{f.branchRef ? ` · ${f.branchRef}` : ""}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button onClick={openPdf} className="inline-flex items-center gap-1.5 rounded-lg border border-border-default px-3 py-1.5 text-[12px] font-medium text-text-secondary hover:bg-surface-2">
              <Icon name="file-text" size={14} /> Ver / imprimir PDF
            </button>
            <button onClick={openPromos} className="inline-flex items-center gap-1.5 rounded-lg border border-border-default px-3 py-1.5 text-[12px] font-medium text-text-secondary hover:bg-surface-2">
              <Icon name="gift" size={14} /> Aplicar promoción
            </button>
          </div>
        </div>
        <div className="rounded-xl border border-border-subtle bg-surface px-5 py-3 text-right shadow-sm">
          <div className="text-[11px] text-text-tertiary">Saldo pendiente</div>
          <div className={`text-[22px] font-bold ${f.balance > 0 ? "text-error-text" : "text-success-text"}`}>{cop(f.balance)}</div>
          <div className="text-[10px] text-text-tertiary">Total {cop(f.total)} · Pagado {cop(f.paid)}</div>
        </div>
      </div>

      <div className="mb-4 grid grid-cols-1 gap-3 lg:grid-cols-3">
        {/* Cliente */}
        <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
          <div className="mb-2 flex items-center gap-2 text-[13px] font-bold text-text-primary"><Icon name="user" size={15} className="text-brand" />Cliente</div>
          {f.subscriber ? (
            <>
              <Link href={`/clientes/${f.subscriber.id}`} className="text-[14px] font-semibold text-brand hover:underline">{f.subscriber.name}</Link>
              <p className="text-[12px] text-text-tertiary">Abonado {f.subscriber.abonado}{f.subscriber.docNumber ? ` · ${f.subscriber.docType} ${f.subscriber.docNumber}` : ""}</p>
              <p className="text-[12px] text-text-tertiary">{[f.subscriber.phone, f.subscriber.email, f.subscriber.branch].filter(Boolean).join(" · ")}</p>
            </>
          ) : <p className="text-[12px] text-text-tertiary">Sin cliente asociado.</p>}
        </div>
        {/* Servicio */}
        <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
          <div className="mb-2 flex items-center gap-2 text-[13px] font-bold text-text-primary"><Icon name="activity" size={15} className="text-brand" />Servicio facturado</div>
          <div className="flex flex-col gap-1 text-[12px]">
            {f.service.combo && f.service.combo !== "no" && <span className="text-text-secondary">Internet: <b className="text-text-primary">{f.service.combo}</b>{f.service.estadoCombo && <> ({f.service.estadoCombo})</>}</span>}
            {f.service.tv && f.service.tv !== "no" && <span className="text-text-secondary">TV: <b className="text-text-primary">{f.service.tv}</b>{f.service.estadoTv && <> ({f.service.estadoTv})</>}</span>}
            {f.service.puntos ? <span className="text-text-secondary">Puntos: {f.service.puntos}</span> : null}
          </div>
        </div>
        {/* Facturación electrónica */}
        <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-[13px] font-bold text-text-primary"><Icon name="file-text" size={15} className="text-brand" />Factura electrónica</div>
            {canEmit && eMode && (
              <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold ${eMode.live ? "bg-success-soft text-success-text" : "bg-warning-soft text-warning-text"}`}>
                <Icon name={eMode.live ? "zap" : "flask-conical"} size={11} />{eMode.live ? "LIVE" : "DRY-RUN"}
              </span>
            )}
          </div>
          {(() => {
            const emitida = f.electronic?.find((e: any) => e.type === "FACTURADA" && e.dianNumber);
            if (f.electronic?.length) {
              return (
                <>
                  {f.electronic.map((e: any) => (
                    <div key={e.id} className="text-[12px]">
                      <Badge label={e.type} tone={e.type === "FACTURADA" ? "success" : e.type === "ERROR" ? "error" : "default"} />
                      {e.dianNumber && <span className="ml-2 text-text-secondary">N° DIAN {e.dianNumber}</span>}
                      {e.cufe && <div className="truncate text-[10px] text-text-tertiary">CUFE {e.cufe}</div>}
                    </div>
                  ))}
                  {!emitida && canEmit && (
                    <button onClick={emitEinvoice} disabled={emitting}
                      className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-border-default px-3 py-1.5 text-[12px] font-semibold text-text-secondary hover:bg-surface-2 disabled:opacity-50">
                      <Icon name={emitting ? "loader" : "file-signature"} size={14} className={emitting ? "animate-spin" : ""} /> Reintentar emisión
                    </button>
                  )}
                </>
              );
            }
            return (
              <>
                <p className="text-[12px] text-text-tertiary">{f.eInvoiceFlag ?? "No emitida"}</p>
                {canEmit && (
                  <button onClick={emitEinvoice} disabled={emitting}
                    className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-brand bg-brand-soft px-3 py-1.5 text-[12px] font-semibold text-brand hover:opacity-90 disabled:opacity-50">
                    <Icon name={emitting ? "loader" : "file-signature"} size={14} className={emitting ? "animate-spin" : ""} /> {emitting ? "Emitiendo…" : "Emitir e-factura"}
                  </button>
                )}
              </>
            );
          })()}
        </div>
      </div>

      {/* Ítems */}
      <div className="mb-2 text-[13px] font-bold text-text-primary">Detalle</div>
      <DataTable
        rows={f.items ?? []}
        empty="Sin ítems."
        columns={[
          { key: "product", header: "Concepto", render: (r: any) => <span className="font-medium text-text-primary">{r.product}</span> },
          { key: "qty", header: "Cant.", align: "right", render: (r: any) => r.qty },
          { key: "price", header: "Precio", align: "right", render: (r: any) => cop(r.price) },
          { key: "tax", header: "IVA", align: "right", render: (r: any) => cop(r.taxTotal) },
          { key: "subtotal", header: "Subtotal", align: "right", render: (r: any) => cop(r.subtotal) },
        ]}
      />
      <div className="mt-2 flex justify-end">
        <div className="w-64 rounded-xl border border-border-subtle bg-surface p-3 text-[12px] shadow-sm">
          <div className="flex justify-between py-0.5"><span className="text-text-tertiary">Subtotal</span><span className="font-medium">{cop(f.subtotal)}</span></div>
          <div className="flex justify-between py-0.5"><span className="text-text-tertiary">Descuento</span><span className="font-medium">{cop(f.discount)}</span></div>
          <div className="flex justify-between py-0.5"><span className="text-text-tertiary">IVA</span><span className="font-medium">{cop(f.tax)}</span></div>
          <div className="mt-1 flex justify-between border-t border-border-default pt-1 text-[13px] font-bold"><span>Total</span><span>{cop(f.total)}</span></div>
        </div>
      </div>

      {/* Pagos */}
      <div className="mb-2 mt-4 text-[13px] font-bold text-text-primary">Pagos aplicados</div>
      <DataTable
        rows={f.payments ?? []}
        empty="Sin pagos registrados."
        columns={[
          { key: "date", header: "Fecha", render: (r: any) => fmt(r.date) },
          { key: "amount", header: "Monto", align: "right", render: (r: any) => <span className="font-semibold text-success-text">{cop(r.amount)}</span> },
          { key: "method", header: "Método", render: (r: any) => r.method ?? "—" },
          { key: "cat", header: "Categoría", render: (r: any) => r.category ?? "—" },
          { key: "status", header: "Estado", render: (r: any) => <Badge label={r.status === "ANULADA" ? "Anulada" : "Vigente"} tone={r.status === "ANULADA" ? "error" : "success"} /> },
          { key: "note", header: "Nota", render: (r: any) => <span className="text-text-tertiary">{r.note ?? ""}</span> },
        ]}
      />

      {promoOpen && (
        <Modal open onClose={() => setPromoOpen(false)} title="Aplicar promoción">
          <div className="flex flex-col gap-3">
            <p className="text-[12px] text-text-tertiary">
              Promociones vigentes que tienes autorizadas. Al aplicar una se genera una nota crédito por el porcentaje sobre el total de la factura (#{f.tid}, total {cop(f.total)}).
            </p>
            {!promos ? (
              <p className="text-[13px] text-text-tertiary">Cargando…</p>
            ) : promos.length === 0 ? (
              <p className="text-[13px] text-text-tertiary">No tienes promociones vigentes asignadas.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {promos.map((p) => (
                  <div key={p.id} className="flex items-center justify-between gap-3 rounded-lg border border-border-subtle p-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-[13px] font-semibold text-text-primary">{p.name}</span>
                        <Badge tone="brand" label={discountLabel(p)} />
                        {isBeforeTaxDiscount(p.discountFormat) && <Badge tone="default" label="Antes de imp." />}
                        {p.subscriberStatus ? <Badge tone="warning" label="Por estado del cliente" /> : p.global && <Badge tone="info" label="Global" />}
                      </div>
                      <div className="text-[11px] text-text-tertiary">
                        {p.description ? `${p.description} · ` : ""}Descuento estimado {cop(
                          (() => {
                            const base = isBeforeTaxDiscount(p.discountFormat) ? (f.subtotal ?? f.total) : f.total;
                            return isFlatDiscount(p.discountFormat) ? Math.min(Number(p.flatAmount ?? 0), base) : (base * p.percentage) / 100;
                          })(),
                        )}
                      </div>
                    </div>
                    <Button onClick={() => applyPromo(p)} disabled={applyingId === p.id}>
                      {applyingId === p.id ? "Aplicando…" : "Aplicar"}
                    </Button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex justify-end">
              <Button variant="secondary" onClick={() => setPromoOpen(false)}>Cerrar</Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
