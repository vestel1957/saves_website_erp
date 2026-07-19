"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { PageHeading } from "@/components/accounting/PageHeading";
import { Icon } from "@/components/Icon";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { toast } from "@/components/ui/Toast";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { useAuth } from "@/context/AuthProvider";
import { cop } from "@/lib/subscribers";

type ActaItem = { id: string; material: string; code: string | null; qty: number; price: number; value: number; received: boolean; receivedAt: string | null };
type ActaDetail = {
  id: string; date: string; from: string | null; to: string | null; observations: string | null; status: string;
  createdBy: string | null; assignedTo: string | null; assignedToId: string | null;
  receivedBy: string | null; receivedAt: string | null; createdAt: string | null;
  units: number; receivedCount: number; itemsTotal: number; receivable: boolean; isReceiver: boolean;
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
    } catch (e: any) {
      toast(e?.message || "No se pudo recibir el ítem", "alert-triangle");
    } finally {
      setReceivingItem(null);
    }
  };

  const receiveAll = async () => {
    setReceiving(true);
    try {
      const res = await authFetch(`/inventory/actas/${id}/receive`, { method: "POST" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || "No se pudo recibir el acta");
      toast("Acta recibida: stock acreditado en el destino", "check");
      await load();
    } catch (e: any) {
      toast(e?.message || "No se pudo recibir el acta", "alert-triangle");
    } finally {
      setReceiving(false);
    }
  };

  if (authLoading || !detail) return <PageSkeleton />;

  return (
    <div className="flex flex-col gap-4">
      <PageHeading icon="clipboard-list" title={`Acta de transferencia · ${fmtDate(detail.date)}`} subtitle="Traspaso de material entre bodegas" />

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

      {detail.isReceiver && (
        <div className="flex items-center justify-end">
          <Button variant="primary" size="sm" disabled={receiving || !!receivingItem} onClick={receiveAll}>
            <Icon name="check" size={14} /> {receiving ? "Recibiendo…" : "Recibir todo"}
          </Button>
        </div>
      )}
    </div>
  );
}
