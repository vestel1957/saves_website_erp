"use client";

import { Fragment, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Icon } from "@/components/Icon";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/Modal";
import { toast } from "@/components/ui/Toast";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { DataTable } from "@/components/ui/DataTable";
import { DetailHeader } from "@/components/ui/DetailHeader";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { useAuth } from "@/context/AuthProvider";
import { PERM } from "@/lib/auth";
import { INVOICE_STATUS_LABEL, INVOICE_STATUS_TONE, cop } from "@/lib/subscribers";
import { INVOICE_KIND_LABEL, RON_LABEL } from "@/lib/billing";
import { type AvailablePromotion, discountLabel, isFlatDiscount, isBeforeTaxDiscount } from "@/lib/promotions";
import { fmtDate } from "@/lib/format";

/** Descuento que aplicaría la promoción sobre esta factura (estimación en pantalla). */
function descuentoEstimado(p: AvailablePromotion, f: any) {
  const base = isBeforeTaxDiscount(p.discountFormat) ? (f.subtotal ?? f.total) : f.total;
  return isFlatDiscount(p.discountFormat) ? Math.min(Number(p.flatAmount ?? 0), base) : (base * p.percentage) / 100;
}

export default function FacturaDetallePage() {
  const { id } = useParams<{ id: string }>();
  const { loading: authLoading, authFetch, can, isSuperadmin } = useAuth();
  const [f, setF] = useState<any | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [promoOpen, setPromoOpen] = useState(false);
  const [promos, setPromos] = useState<AvailablePromotion[] | null>(null);
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [eMode, setEMode] = useState<{ live: boolean } | null>(null);
  const [emitting, setEmitting] = useState(false);
  const [voidOpen, setVoidOpen] = useState(false);
  const [voidReason, setVoidReason] = useState("");
  const [voiding, setVoiding] = useState(false);
  // Dos confirmaciones distintas conviven en esta pantalla: se distinguen por `kind`.
  const [confirmar, setConfirmar] = useState<
    { kind: "promo"; promo: AvailablePromotion } | { kind: "emitir" } | null
  >(null);

  const canEmit = isSuperadmin || can(PERM.AREA_CONTABILIDAD);

  const loadInvoice = () =>
    authFetch(`/billing/invoices/${id}`)
      .then(async (r) => {
        if (r.ok) return r.json();
        // Un 403 por sede NO es una factura inexistente. Decía "Factura no
        // encontrada" a los 92 (de 138) usuarios acotados por sede cada vez que
        // abrían la factura de un cliente de otra sede, y manda a buscar un
        // problema de datos donde lo que hay es uno de permisos.
        const d = await r.json().catch(() => null);
        throw new Error(
          r.status === 403
            ? (d?.message ?? "No tienes acceso a los datos de esta sede.")
            : "Factura no encontrada.",
        );
      })
      .then((d) => { setF(d); setErr(null); })
      .catch((e) => setErr(e instanceof Error ? e.message : "No se pudo cargar la factura."));

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
      setConfirmar(null);
    }
  }

  /**
   * `formato="rollo"` es el recibo de 80 mm que sale por la impresora de caja (el
   * "Imprimir" del legacy); sin formato, la factura en hoja completa para archivar
   * o mandar por correo.
   */
  async function openPdf(formato?: "rollo") {
    const res = await authFetch(`/billing/invoices/${id}/pdf${formato ? `?formato=${formato}` : ""}`);
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
      setConfirmar(null);
    }
  }

  /**
   * Anula la factura. El backend reversa los pagos con rastro y bloquea si la factura ya
   * fue timbrada ante la DIAN y aún no tiene su nota crédito.
   */
  async function voidInvoice() {
    const reason = voidReason.trim();
    if (reason.length < 3) { toast("Escribe el motivo de la anulación.", "alert-circle"); return; }
    setVoiding(true);
    try {
      const res = await authFetch(`/billing/invoices/${id}/void`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new Error(d?.message || "No se pudo anular la factura");
      toast(d.voidedPayments > 0 ? `Factura anulada. Se reversaron ${d.voidedPayments} pago(s).` : "Factura anulada.", "check");
      setVoidOpen(false);
      setVoidReason("");
      await loadInvoice();
    } catch (e) {
      toast((e as Error).message, "alert-circle");
    } finally {
      setVoiding(false);
    }
  }

  if (authLoading || (!f && !err)) return <PageSkeleton />;
  if (err) return <div className="rounded-xl border border-border-subtle bg-surface p-6 text-[13px] text-text-secondary">{err} <Link href="/facturacion" className="text-brand">Volver</Link></div>;

  return (
    <>
      <DetailHeader
        backHref="/facturacion"
        backLabel="Facturación"
        icon="receipt"
        title={`Factura #${f.tid}`}
        badges={
          <>
            <Badge label={INVOICE_STATUS_LABEL[f.status] ?? f.status} tone={INVOICE_STATUS_TONE[f.status] ?? "default"} />
            {f.ron && <Badge label={RON_LABEL[f.ron] ?? f.ron} tone="default" />}
            <span className="text-[11px] text-text-tertiary">{INVOICE_KIND_LABEL[f.kind] ?? f.kind}</span>
          </>
        }
        subtitle={<>Emitida {fmtDate(f.date)} · Vence {fmtDate(f.dueDate)}{f.branchRef ? ` · ${f.branchRef}` : ""}</>}
        actions={
          <>
            <Button variant="secondary" size="sm" className="w-full sm:w-auto" onClick={() => openPdf("rollo")}>
              <Icon name="receipt" size={14} /> Imprimir recibo (caja)
            </Button>
            <Button variant="secondary" size="sm" className="w-full sm:w-auto" onClick={() => openPdf()}>
              <Icon name="file-text" size={14} /> Factura en hoja
            </Button>
            <Button variant="secondary" size="sm" className="w-full sm:w-auto" onClick={openPromos}>
              <Icon name="gift" size={14} /> Aplicar promoción
            </Button>
            {canEmit && f.status !== "CANCELED" && (
              <Button variant="danger" size="sm" className="w-full sm:w-auto" onClick={() => setVoidOpen(true)}>
                <Icon name="ban" size={14} /> Anular factura
              </Button>
            )}
          </>
        }
        aside={
          <div className="w-full rounded-xl border border-border-subtle bg-surface px-5 py-3 shadow-sm sm:w-auto sm:text-right">
            <div className="text-[11px] text-text-tertiary">Saldo pendiente</div>
            <div className={`text-[22px] font-bold ${f.balance > 0 ? "text-error-text" : "text-success-text"}`}>{cop(f.balance)}</div>
            <div className="text-[10px] text-text-tertiary">Total {cop(f.total)} · Pagado {cop(f.paid)}</div>
          </div>
        }
      />


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
          <ServicioFacturado f={f} />
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
                    <button onClick={() => setConfirmar({ kind: "emitir" })} disabled={emitting}
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
          { key: "date", header: "Fecha", render: (r: any) => fmtDate(r.date) },
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
                        {p.description ? `${p.description} · ` : ""}Descuento estimado {cop(descuentoEstimado(p, f))}
                      </div>
                    </div>
                    <Button onClick={() => setConfirmar({ kind: "promo", promo: p })} disabled={applyingId === p.id}>
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

      {voidOpen && (
        <Modal open onClose={() => setVoidOpen(false)} title={`Anular factura #${f.tid}`}>
          <div className="flex flex-col gap-3">
            <p className="text-[12px] text-text-tertiary">
              La factura quedará anulada y saldrá de la cartera del cliente. Los pagos asociados
              se reversan, quedando registrados como anulados (no se borran).
            </p>
            {f.paid > 0 && (
              <div className="rounded-lg border border-warning-border bg-warning-soft px-3 py-2 text-[12px] text-text-secondary">
                Esta factura tiene {cop(f.paid)} pagados. Al anularla, ese dinero se reversa y saldrá del arqueo de la caja donde se recibió.
              </div>
            )}
            <label className="flex flex-col gap-1">
              <span className="text-[12px] font-medium text-text-secondary">Motivo de la anulación</span>
              <input
                autoFocus
                value={voidReason}
                onChange={(e) => setVoidReason(e.target.value)}
                placeholder="Ej: facturada por error al cliente equivocado"
                className="rounded-lg border border-border-default bg-surface px-3 py-2 text-[13px] text-text-primary"
              />
            </label>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setVoidOpen(false)}>Cancelar</Button>
              <Button variant="danger" onClick={voidInvoice} disabled={voiding || voidReason.trim().length < 3}>
                {voiding ? "Anulando…" : "Anular factura"}
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {confirmar?.kind === "promo" && (
        <ConfirmDialog
          open
          busy={applyingId === confirmar.promo.id}
          onClose={() => setConfirmar(null)}
          onConfirm={() => void applyPromo(confirmar.promo)}
          tone="primary"
          icon="gift"
          title="Aplicar promoción a la factura"
          confirmLabel="Aplicar promoción"
          message={
            <>
              Se generará una nota crédito por el descuento sobre la factura #{f.tid}, y el
              saldo del cliente bajará en ese importe. Queda registrada a tu nombre.
            </>
          }
          detail={<PromoResumen promo={confirmar.promo} f={f} />}
        />
      )}

      {confirmar?.kind === "emitir" && (
        <ConfirmDialog
          open
          busy={emitting}
          onClose={() => setConfirmar(null)}
          onConfirm={() => void emitEinvoice()}
          tone={eMode?.live ? "danger" : "primary"}
          icon="file-signature"
          title={eMode?.live ? "Emitir factura ante la DIAN" : "Probar emisión (dry-run)"}
          confirmLabel={eMode?.live ? "Emitir ante la DIAN" : "Construir payload"}
          // Solo en LIVE se exige teclear el número: en dry-run no sale nada hacia la DIAN.
          requireText={eMode?.live ? String(f.tid) : undefined}
          requireHint={<>Para confirmar, escribe el número de factura <span className="font-mono font-semibold text-text-primary">{f.tid}</span></>}
          message={
            eMode?.live ? (
              <>
                La factura #{f.tid} se timbrará ante la DIAN y quedará con número y CUFE
                oficiales. <b className="text-error-text">Es un acto legal irreversible</b>: para
                deshacerlo hay que emitir una nota crédito.
              </>
            ) : (
              <>
                Estás en <b>modo prueba (dry-run)</b>: solo se construye el payload de la factura
                #{f.tid} para validarlo. No se envía nada a la DIAN ni se timbra.
              </>
            )
          }
          detail={<FacturaResumen f={f} />}
        />
      )}
    </>
  );
}

/**
 * Qué se le está cobrando al cliente, resumido.
 *
 * El snapshot de servicios (`serviceCombo`/`serviceTv`) llega vacío en 5.530
 * facturas — el legacy guarda literalmente "no", y las fijas nunca lo llevan —,
 * así que la tarjeta salía en blanco justo en las que hay que explicar. Cuando
 * no hay snapshot se cae a los conceptos de la propia factura, que es el dato
 * que de verdad se cobra.
 */
function ServicioFacturado({ f }: { f: any }) {
  const combo = f.service?.combo && f.service.combo !== "no" ? f.service.combo : null;
  const tv = f.service?.tv && f.service.tv !== "no" ? f.service.tv : null;
  const puntos = Number(f.service?.puntos ?? 0);
  const items: any[] = f.items ?? [];
  const haySnapshot = Boolean(combo || tv || puntos);

  return (
    <div className="flex flex-col gap-1 text-[12px]">
      {/* El periodo solo existe en las recurrentes; en las fijas el backend manda
          null y se rotula como el cargo puntual que es, sin inventar un mes. */}
      <span className="text-text-secondary">Periodo: <b className="text-text-primary">{f.period ?? "Cargo puntual"}</b></span>
      {haySnapshot ? (
        <>
          {combo && <span className="text-text-secondary">Internet: <b className="text-text-primary">{combo}</b>{f.service.estadoCombo && <> ({f.service.estadoCombo})</>}</span>}
          {tv && <span className="text-text-secondary">TV: <b className="text-text-primary">{tv}</b>{f.service.estadoTv && <> ({f.service.estadoTv})</>}</span>}
          {puntos ? <span className="text-text-secondary">Puntos: {puntos}</span> : null}
        </>
      ) : items.length ? (
        items.map((it) => (
          <span key={it.id} className="text-text-secondary">
            {it.product || it.description || "Concepto"}{it.qty > 1 ? ` ×${it.qty}` : ""} · <b className="text-text-primary">{cop(it.subtotal + it.taxTotal)}</b>
          </span>
        ))
      ) : (
        <span className="text-text-tertiary">Sin conceptos registrados.</span>
      )}
    </div>
  );
}

/** Ficha compacta de la promoción: qué se descuenta y sobre qué factura. */
function PromoResumen({ promo, f }: { promo: AvailablePromotion; f: any }) {
  const filas: [string, React.ReactNode][] = [
    ["Promoción", <span key="a">{promo.name}</span>],
    ["Descuento", <Badge key="b" tone="brand" label={discountLabel(promo)} />],
    ["Factura", <span key="c" className="font-mono">#{f.tid} · {cop(f.total)}</span>],
    ["Nota crédito", <span key="d" className="font-mono font-semibold">{cop(descuentoEstimado(promo, f))}</span>],
  ];
  return <FichaConfirm filas={filas} />;
}

/** Ficha compacta de la factura que se va a timbrar: evita emitir la de al lado. */
function FacturaResumen({ f }: { f: any }) {
  const filas: [string, React.ReactNode][] = [
    ["Factura", <span key="a" className="font-mono">#{f.tid}</span>],
    ["Cliente", <span key="b">{f.subscriber?.name ?? "—"}</span>],
    ["Total", <span key="c" className="font-mono font-semibold">{cop(f.total)}</span>],
    ["Estado", <Badge key="d" label={INVOICE_STATUS_LABEL[f.status] ?? f.status} tone={INVOICE_STATUS_TONE[f.status] ?? "default"} />],
  ];
  return <FichaConfirm filas={filas} />;
}

function FichaConfirm({ filas }: { filas: [string, React.ReactNode][] }) {
  return (
    <div className="rounded-lg border border-border-subtle bg-surface-2 p-2.5">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12px]">
        {filas.map(([k, v]) => (
          <Fragment key={k}>
            <dt className="text-text-tertiary">{k}</dt>
            <dd className="text-right text-text-primary">{v}</dd>
          </Fragment>
        ))}
      </dl>
    </div>
  );
}
