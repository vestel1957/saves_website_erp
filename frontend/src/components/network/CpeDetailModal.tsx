"use client";

import { useState } from "react";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/Icon";
import { Badge } from "@/components/ui/Badge";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { informExact, informLabel, informTone, type CpeRow, type TvBatchResult } from "@/lib/genieacs";

function Row({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-border-subtle py-2 last:border-0">
      <span className="shrink-0 text-[11px] font-medium uppercase tracking-wide text-text-tertiary">{label}</span>
      <span className={`min-w-0 break-all text-right text-[13px] text-text-primary ${mono ? "font-mono text-[12px]" : ""}`}>
        {value}
      </span>
    </div>
  );
}

/** Copia al portapapeles con aviso; útil para el deviceId/serial al depurar contra el ACS. */
function CopyValue({ value }: { value: string }) {
  return (
    <button
      type="button"
      title="Copiar"
      onClick={() => {
        void navigator.clipboard?.writeText(value);
        toast("Copiado", "copy");
      }}
      className="inline-flex items-center gap-1 hover:text-brand"
    >
      <span className="min-w-0 break-all">{value}</span>
      <Icon name="copy" size={12} className="shrink-0 text-text-tertiary" />
    </button>
  );
}

/**
 * Detalle de un CPE con sus acciones individuales (refrescar el subárbol CATV,
 * cortar/restaurar la TV de ese solo equipo). Las escrituras respetan el gate
 * DRY-RUN del backend igual que las masivas.
 */
export function CpeDetailModal({
  cpe,
  onClose,
  onChanged,
}: {
  cpe: CpeRow | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { authFetch } = useAuth();
  const [busy, setBusy] = useState<null | "refresh" | "tv">(null);

  if (!cpe) return null;

  const refresh = async () => {
    setBusy("refresh");
    try {
      const r = await authFetch("/network/genieacs/refresh", {
        method: "POST",
        body: JSON.stringify({ deviceId: cpe.id }),
      }).then((x) => x.json());
      toast(r.ok ? "Refresco pedido al CPE (llega en el próximo inform)" : `No se pudo refrescar (HTTP ${r.status})`, r.ok ? "check" : "x");
    } catch (e) {
      toast((e as Error).message, "x");
    } finally {
      setBusy(null);
    }
  };

  const toggleTv = async () => {
    const enable = cpe.tvSuspended;
    setBusy("tv");
    try {
      const endpoint = enable ? "/network/genieacs/restore-tv" : "/network/genieacs/cut-tv";
      const r: TvBatchResult = await authFetch(endpoint, {
        method: "POST",
        body: JSON.stringify({ ids: [cpe.id] }),
      }).then((x) => x.json());
      if (r.dryRun) toast(`DRY-RUN: ${enable ? "alta" : "corte"} planificado (no se tocó el ACS)`, "check");
      else if (r.ok) toast(enable ? "TV restaurada" : "TV cortada", "check");
      else toast(`No se pudo aplicar: ${r.errors?.[0] ?? "error del ACS"}`, "x");
      onChanged();
      onClose();
    } catch (e) {
      toast((e as Error).message, "x");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal open onClose={onClose} title={cpe.pppUser || "CPE sin abonado"} maxWidth="max-w-xl">
      <div className="flex flex-wrap items-center gap-2">
        <Badge label={cpe.tvSuspended ? "TV suspendida" : "TV activa"} tone={cpe.tvSuspended ? "error" : "success"} />
        <Badge label={informLabel(cpe.daysSince)} tone={informTone(cpe.daysSince)} />
        {cpe.alive && <Badge label="En línea" tone="success" />}
      </div>

      <div className="rounded-xl border border-border-subtle bg-surface-2/40 px-3.5 py-1">
        <Row label="Abonado (PPPoE)" value={cpe.pppUser || "—"} />
        <Row label="Marca / Modelo" value={`${cpe.manufacturer || "?"} · ${cpe.model || "?"}`} />
        <Row label="Serial" value={cpe.serial ? <CopyValue value={cpe.serial} /> : "—"} mono />
        <Row label="IP WAN" value={cpe.wanIp ? <CopyValue value={cpe.wanIp} /> : "—"} mono />
        <Row label="Último inform" value={informExact(cpe.lastInform)} />
        <Row label="Device ID" value={<CopyValue value={cpe.id} />} mono />
        <Row
          label="Tags"
          value={
            cpe.tags.length ? (
              <span className="flex flex-wrap justify-end gap-1">
                {cpe.tags.map((t) => (
                  <Badge key={t} label={t} tone={t === "tv-suspendida" ? "error" : "default"} />
                ))}
              </span>
            ) : (
              "—"
            )
          }
        />
      </div>

      <div className="flex flex-wrap justify-end gap-2 pt-1">
        <Button variant="ghost" disabled={!!busy} onClick={refresh} title="Pide al ACS releer el subárbol CATV de este CPE">
          {busy === "refresh" ? <Icon name="loader" size={15} className="mr-1 animate-spin" /> : <Icon name="refresh-cw" size={15} className="mr-1" />}
          Refrescar
        </Button>
        <Button
          variant={cpe.tvSuspended ? "secondary" : "danger"}
          disabled={!!busy}
          onClick={toggleTv}
        >
          {busy === "tv" ? (
            <Icon name="loader" size={15} className="mr-1 animate-spin" />
          ) : (
            <Icon name={cpe.tvSuspended ? "tv" : "ban"} size={15} className="mr-1" />
          )}
          {cpe.tvSuspended ? "Restaurar TV" : "Cortar TV"}
        </Button>
      </div>
    </Modal>
  );
}
