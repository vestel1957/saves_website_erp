"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { FirmaOtpModal } from "@/components/FirmaOtpModal";
import { toast } from "@/components/ui/Toast";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { useAuth } from "@/context/AuthProvider";
import { cop } from "@/lib/subscribers";
import { mensajeDeError } from "@/lib/errores";

type ActaItem = { id: string; material: string; code: string | null; qty: number; price: number; value: number; received: boolean; receivedAt: string | null };
type ActaDetail = {
  id: string; date: string; from: string | null; to: string | null; observations: string | null; status: string;
  createdBy: string | null; assignedTo: string | null; assignedToId: string | null;
  receivedBy: string | null; receivedAt: string | null; createdAt: string | null;
  units: number; receivedCount: number; itemsTotal: number; receivable: boolean; isReceiver: boolean;
  /** ¿El recibido va con código? Lo manda `signature.otpRequired` en el backend. */
  otpRequired: boolean;
  /** Cómo firmó quien recibió (a qué WhatsApp salió su código) y si le llegó el acta. */
  receivedSignature: string | null; notifiedAt: string | null; notifiedTo: string | null;
  /** Todo marcado pero sin firmar: solo falta su código. */
  faltaFirma: boolean;
  items: ActaItem[];
};

function statusTone(s: string): "default" | "success" | "warning" | "info" | "error" {
  if (s === "Recibida") return "success";
  if (s === "En tránsito") return "info";
  if (s === "Emitida") return "warning";
  return "default";
}
const fmtDate = (v: string | null | undefined) => (v ? new Date(v).toLocaleDateString("es-CO") : "—");

export default function ActaDetallePage() {
  const { id } = useParams<{ id: string }>();
  const { loading: authLoading, authFetch } = useAuth();
  const [detail, setDetail] = useState<ActaDetail | null>(null);
  const [receivingItem, setReceivingItem] = useState<string | null>(null);
  const [receiving, setReceiving] = useState(false);
  // Firma del recibido: la pide y la valida el diálogo común de firma.
  const [firmarOpen, setFirmarOpen] = useState(false);
  const [enviando, setEnviando] = useState(false);

  const load = useCallback(async () => {
    try { setDetail(await (await authFetch(`/inventory/actas/${id}`)).json()); } catch { setDetail(null); }
  }, [authFetch, id]);

  useEffect(() => { if (!authLoading) void load(); }, [authLoading, load]);

  const receiveItem = async (itemId: string) => {
    setReceivingItem(itemId);
    try {
      const res = await authFetch(`/inventory/actas/${id}/items/${itemId}/receive`, { method: "POST" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || "No se pudo recibir el ítem");
      toast("Ítem recibido", "check");
      await load();
    } catch (e) {
      toast(mensajeDeError(e, "No se pudo recibir el ítem"), "alert-triangle");
    } finally {
      setReceivingItem(null);
    }
  };

  /** Pide el código de firma al WhatsApp de quien recibe (lo llama el diálogo). */
  const pedirCodigoFirma = useCallback(async () => {
    const res = await authFetch(`/inventory/actas/${id}/otp`, { method: "POST" });
    const d = await res.json();
    if (!res.ok) throw new Error(d?.message || "No se pudo enviar el código");
    return d;
  }, [authFetch, id]);

  /** Firma el recibido: acredita lo pendiente en el destino y cierra el acta. */
  const firmarRecibido = useCallback(async (code?: string) => {
    const res = await authFetch(`/inventory/actas/${id}/receive`, {
      method: "POST",
      body: JSON.stringify(code ? { code } : {}),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d?.message || "No se pudo recibir el acta");
    toast(code ? "Acta firmada y recibida: stock acreditado en el destino" : "Acta recibida: stock acreditado en el destino", "check");
    await load();
  }, [authFetch, id, load]);

  /** Recibir sin código: el mismo cierre, con el botón directo. */
  const recibirSinCodigo = useCallback(async () => {
    setReceiving(true);
    try { await firmarRecibido(); }
    catch (e) { toast(mensajeDeError(e, "No se pudo recibir el acta"), "alert-triangle"); }
    finally { setReceiving(false); }
  }, [firmarRecibido]);

  /** Abre el acta en PDF (la misma que se manda por WhatsApp). */
  const verPdf = async () => {
    try {
      const res = await authFetch(`/inventory/actas/${id}/pdf`);
      if (!res.ok) throw new Error("No se pudo generar el acta");
      window.open(URL.createObjectURL(new Blob([await res.blob()], { type: "application/pdf" })), "_blank");
    } catch (e) {
      toast(mensajeDeError(e, "No se pudo abrir el acta"), "alert-triangle");
    }
  };

  /** Reenvía el acta en PDF a quien la tiene que firmar. */
  const reenviar = async () => {
    setEnviando(true);
    try {
      const res = await authFetch(`/inventory/actas/${id}/send`, { method: "POST" });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "Error");
      toast(d?.enviado ? `Acta enviada a ${d.a}` : d?.motivo || "No se pudo enviar", d?.enviado ? "check" : "alert-triangle");
      await load();
    } catch (e) {
      toast(mensajeDeError(e, "No se pudo reenviar el acta"), "alert-triangle");
    } finally {
      setEnviando(false);
    }
  };

  if (authLoading || !detail) return <PageSkeleton />;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <PageHeading icon="clipboard-list" title={`Acta de transferencia · ${fmtDate(detail.date)}`} subtitle="Traspaso de material entre bodegas" />
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" onClick={verPdf}>
            <Icon name="file-text" size={14} /> Ver acta (PDF)
          </Button>
          {detail.receivable && (
            <Button variant="ghost" size="sm" disabled={enviando} onClick={reenviar}>
              <Icon name="message-circle" size={14} /> {enviando ? "Enviando…" : "Reenviar por WhatsApp"}
            </Button>
          )}
        </div>
      </div>

      {/* Ruta origen → destino + estado */}
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <Badge label={detail.from ?? "—"} tone="default" />
        <Icon name="arrow-right" size={14} className="text-text-tertiary" />
        <Badge label={detail.to ?? "—"} tone="default" />
        <Badge label={detail.status} tone={statusTone(detail.status)} />
        <span className="ml-1 text-text-tertiary">· {detail.itemsTotal} ítems · {detail.units} unidades</span>
      </div>

      {/* Quién emitió / quién recibe */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex items-start gap-2 rounded-xl border border-border-subtle bg-surface p-3 text-[12px]">
          <Icon name="user" size={15} className="mt-0.5 text-text-tertiary" />
          <span className="min-w-0">
            <span className="block text-[11px] text-text-tertiary">Emitida por</span>
            <span className="font-medium text-text-primary">{detail.createdBy ?? "—"}</span>
            <span className="block text-[11px] text-text-tertiary">{fmtDate(detail.createdAt ?? detail.date)}</span>
          </span>
        </div>
        <div className="flex items-start gap-2 rounded-xl border border-border-subtle bg-surface p-3 text-[12px]">
          <Icon name={detail.status === "Recibida" ? "check" : "hourglass"} size={15} className="mt-0.5 text-text-tertiary" />
          <span className="min-w-0">
            <span className="block text-[11px] text-text-tertiary">{detail.status === "Recibida" ? "Recibida por" : "Designada a"}</span>
            <span className="font-medium text-text-primary">{detail.receivedBy ?? detail.assignedTo ?? (detail.status === "Recibida" ? "—" : "Sin asignar")}</span>
            {detail.receivedAt
              ? <span className="block text-[11px] text-text-tertiary">{fmtDate(detail.receivedAt)}</span>
              : detail.assignedTo && <span className="block text-[11px] text-text-tertiary">Pendiente de recibir</span>}
            {/* Con qué firmó: es la prueba de que estuvo, y va donde está su nombre. */}
            {detail.receivedSignature && (
              <span className="block text-[11px] text-text-tertiary">{detail.receivedSignature}</span>
            )}
            {!detail.receivedAt && (
              <span className="block text-[11px] text-text-tertiary">
                {detail.notifiedAt
                  ? `Acta enviada a su WhatsApp ${detail.notifiedTo ?? ""}`
                  : "El acta no se le pudo enviar por WhatsApp"}
              </span>
            )}
          </span>
        </div>
      </div>

      {detail.observations && (
        <p className="rounded-xl bg-surface-2 px-3 py-2 text-[12.5px] text-text-secondary">{detail.observations}</p>
      )}

      {/* Checklist de materiales */}
      <div className="overflow-hidden rounded-xl border border-border-subtle">
        <div className="flex items-center justify-between gap-2 border-b border-border-subtle bg-surface-2 px-3 py-2 text-[11px] font-semibold text-text-tertiary">
          <span>Materiales {detail.receivable && "· marca cada uno al recibirlo"}</span>
          <span className="text-text-secondary">{detail.receivedCount}/{detail.itemsTotal} recibidos</span>
        </div>
        {detail.items.length > 0 ? (
          detail.items.map((it) => {
            const busy = receivingItem === it.id;
            return (
              <div key={it.id} className={`flex items-center gap-3 border-t border-border-subtle px-3 py-2.5 text-[13px] first:border-t-0 ${it.received ? "bg-success-soft/40" : ""}`}>
                {it.received ? (
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-success text-on-brand" title={`Recibido ${fmtDate(it.receivedAt)}`}>
                    <Icon name="check" size={13} />
                  </span>
                ) : detail.isReceiver ? (
                  <button
                    type="button"
                    onClick={() => receiveItem(it.id)}
                    disabled={busy}
                    title="Marcar como recibido"
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 border-border-default text-text-tertiary transition-colors hover:border-brand hover:text-brand disabled:opacity-50"
                  >
                    {busy ? <Icon name="loader" size={12} className="animate-spin" /> : null}
                  </button>
                ) : (
                  <span className="h-5 w-5 shrink-0 rounded-full border-2 border-border-subtle" />
                )}
                <div className="min-w-0 flex-1">
                  <span className="font-medium text-text-primary">{it.material}</span>
                  {it.code && <span className="ml-2 text-[11px] text-text-tertiary">{it.code}</span>}
                </div>
                <span className="shrink-0 font-mono text-text-secondary">{it.qty}</span>
                <span className="w-24 shrink-0 text-right text-text-secondary">{cop(it.value ?? 0)}</span>
              </div>
            );
          })
        ) : (
          <div className="px-3 py-6 text-center text-[12px] text-text-tertiary">Sin ítems en esta acta.</div>
        )}
      </div>

      {detail.receivable && detail.isReceiver && (
        <div className="rounded-xl bg-info-soft px-3 py-2 text-[12px] text-info-text">
          Marca cada material a medida que lo recibes; al confirmar, el stock <strong>entra a la bodega destino</strong> ({detail.to}).
        </div>
      )}
      {detail.receivable && !detail.isReceiver && detail.assignedTo && (
        <div className="rounded-xl bg-warning-soft px-3 py-2 text-[12px] text-warning-text">
          Solo <strong>{detail.assignedTo}</strong> puede recibir este traspaso.
        </div>
      )}

      {/* Cerrar el acta. Con `otpRequired` va con código; sin él, el recibido es el
          botón y queda sellado con el nombre y la hora de quien pulsó. */}
      {detail.receivable && detail.isReceiver && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border-default bg-surface-2 p-3">
          <p className="text-[12px] text-text-secondary">
            {detail.faltaFirma ? (
              <>Ya marcaste todo el material. Falta <strong>cerrar el acta</strong>.</>
            ) : (
              <>Al recibir se acredita en <strong>{detail.to}</strong> todo lo que quede pendiente y el acta queda cerrada a tu nombre.</>
            )}
          </p>
          <Button
            variant="primary"
            size="sm"
            disabled={receiving || !!receivingItem}
            onClick={() => (detail.otpRequired ? setFirmarOpen(true) : void recibirSinCodigo())}
          >
            <Icon name={detail.otpRequired ? "file-signature" : "check"} size={14} />{" "}
            {receiving ? "Recibiendo…" : detail.otpRequired ? "Firmar y recibir" : "Confirmar recibido"}
          </Button>
        </div>
      )}

      {/* El código llega al WhatsApp de quien recibe; el diálogo es el común del ERP. */}
      <FirmaOtpModal
        open={firmarOpen}
        onClose={() => setFirmarOpen(false)}
        titulo="Firmar el recibido"
        textoBoton="Firmar y recibir"
        queFirma={<>Acta de {detail.from} → <b>{detail.to}</b> · {detail.itemsTotal} ítems · {detail.units} unidades</>}
        solicitar={pedirCodigoFirma}
        firmar={firmarRecibido}
      />

    </div>
  );
}
