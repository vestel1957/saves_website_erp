"use client";

import { useCallback, useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Icon } from "@/components/Icon";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import {
  type MikrotikMode,
  type MikrotikActionResult,
  type MikrotikLog,
  MK_ACTION_LABEL,
} from "@/lib/network";

/**
 * Panel de conectividad: corte / reconexión REAL contra el Mikrotik del cliente.
 * Refleja el modo del backend (LIVE vs DRY-RUN) y exige confirmación explícita
 * antes de ejecutar un corte/reconexión cuando el backend está en modo LIVE.
 */
export function MikrotikModal({
  subscriberId,
  subscriberName,
  open,
  onClose,
  onDone,
}: {
  subscriberId: string;
  subscriberName?: string;
  open: boolean;
  onClose: () => void;
  onDone?: () => void;
}) {
  const { authFetch } = useAuth();
  const [mode, setMode] = useState<MikrotikMode | null>(null);
  const [result, setResult] = useState<MikrotikActionResult | null>(null);
  const [history, setHistory] = useState<MikrotikLog[]>([]);
  const [busy, setBusy] = useState<null | "cut" | "reconnect" | "status" | "provision">(null);
  const [confirm, setConfirm] = useState<null | "cut" | "reconnect">(null);

  const loadMeta = useCallback(() => {
    void authFetch(`/network/mikrotik/mode`).then((r) => (r.ok ? r.json() : null)).then(setMode).catch(() => {});
    void authFetch(`/network/subscribers/${subscriberId}/mikrotik-history`)
      .then((r) => (r.ok ? r.json() : []))
      .then(setHistory)
      .catch(() => {});
  }, [authFetch, subscriberId]);

  useEffect(() => {
    if (!open) return;
    setResult(null);
    setConfirm(null);
    loadMeta();
  }, [open, loadMeta]);

  async function run(kind: "cut" | "reconnect" | "status" | "provision") {
    setBusy(kind);
    setResult(null);
    try {
      const path =
        kind === "status"
          ? `/network/subscribers/${subscriberId}/connection`
          : `/network/subscribers/${subscriberId}/${kind}`;
      const res = await authFetch(path, { method: kind === "status" ? "GET" : "POST" });
      const data = (await res.json()) as MikrotikActionResult;
      if (!res.ok) {
        toast((data as any)?.message ?? "Error ejecutando la acción", "x");
        return;
      }
      setResult(data);
      if (kind !== "status") {
        if (data.ok) {
          toast(data.dryRun ? "Simulación completada (dry-run)" : data.message, "check");
          onDone?.();
        } else {
          toast(data.message, "x");
        }
      }
      loadMeta();
    } catch (e) {
      toast((e as Error).message, "x");
    } finally {
      setBusy(null);
      setConfirm(null);
    }
  }

  const live = mode?.live === true;

  return (
    <Modal open={open} onClose={onClose} title="Conectividad — Corte / Reconexión" maxWidth="max-w-2xl">
      <div className="space-y-4">
        {/* Barra de modo */}
        <div
          className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-[13px] ${
            live
              ? "border-error/40 bg-error/10 text-error"
              : "border-border-subtle bg-surface-subtle text-text-secondary"
          }`}
        >
          <Icon name={live ? "zap" : "shield"} size={16} />
          {live ? (
            <span>
              <b>MODO REAL (LIVE):</b> las acciones se ejecutan contra el router de producción.
            </span>
          ) : (
            <span>
              <b>Modo simulación (DRY-RUN):</b> se muestra el plan de comandos sin tocar el router.
              Para operar de verdad, inicia el backend con <code className="font-mono">MIKROTIK_LIVE=true</code>.
            </span>
          )}
        </div>

        {/* Acciones */}
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" disabled={busy !== null} onClick={() => run("status")}>
            <Icon name="activity" size={15} /> {busy === "status" ? "Consultando…" : "Consultar estado"}
          </Button>
          <Button variant="secondary" disabled={busy !== null} onClick={() => run("provision")}>
            <Icon name="file-plus" size={15} /> {busy === "provision" ? "Dando de alta…" : "Dar de alta"}
          </Button>
          <Button
            variant="danger"
            disabled={busy !== null}
            onClick={() => (live ? setConfirm("cut") : run("cut"))}
          >
            <Icon name="wifi-off" size={15} /> Cortar internet
          </Button>
          <Button disabled={busy !== null} onClick={() => (live ? setConfirm("reconnect") : run("reconnect"))}>
            <Icon name="wifi" size={15} /> Reconectar
          </Button>
        </div>

        {/* Confirmación en modo LIVE */}
        {confirm && (
          <div className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-[13px]">
            <p className="mb-2 font-semibold text-text-primary">
              {confirm === "cut" ? "¿Cortar el internet" : "¿Reconectar el internet"} de{" "}
              {subscriberName ?? "este cliente"}? Esta acción es <b>real</b> sobre el router.
            </p>
            <div className="flex gap-2">
              <Button variant={confirm === "cut" ? "danger" : "primary"} disabled={busy !== null} onClick={() => run(confirm)}>
                {busy ? "Ejecutando…" : "Sí, confirmar"}
              </Button>
              <Button variant="ghost" onClick={() => setConfirm(null)}>
                Cancelar
              </Button>
            </div>
          </div>
        )}

        {/* Resultado */}
        {result && (
          <div className="rounded-lg border border-border-subtle bg-surface-subtle p-3">
            <div className="mb-2 flex items-center gap-2">
              <Badge label={MK_ACTION_LABEL[result.action] ?? result.action} tone={result.ok ? "success" : "error"} />
              {result.dryRun && <Badge label="DRY-RUN" tone="warning" />}
              {result.mikrotik && (
                <span className="text-[12px] text-text-tertiary">
                  {result.mikrotik.name} · {result.mikrotik.host} · {result.mikrotik.tech}
                </span>
              )}
            </div>
            <p className="mb-2 text-[13px] text-text-secondary">{result.message}</p>

            {result.live && Object.keys(result.live).length > 0 && (
              <div className="mb-2 grid grid-cols-2 gap-1.5 text-[12px] sm:grid-cols-3">
                <LiveChip label="Secret existe" val={result.live.secretExists} />
                <LiveChip label="Secret activo" val={result.live.secretDisabled === undefined ? undefined : !result.live.secretDisabled} />
                <LiveChip label="Sesión activa" val={result.live.sessionActive} />
                <LiveChip label="En ACTIVOS" val={result.live.inActivos} />
                <LiveChip label="En MOROSOS" val={result.live.inMorosos} invert />
                {result.live.ip ? (
                  <span className="rounded bg-surface px-2 py-1 font-mono text-text-secondary">IP {result.live.ip}</span>
                ) : null}
              </div>
            )}

            {result.steps?.length > 0 && (
              <ol className="space-y-0.5 text-[12px] font-mono text-text-tertiary">
                {result.steps.map((s, i) => (
                  <li key={i} className="flex gap-1.5">
                    <span className="text-text-quaternary">{i + 1}.</span> {s}
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}

        {/* Historial de acciones */}
        <div>
          <h4 className="mb-1.5 text-[12px] font-semibold uppercase tracking-wide text-text-tertiary">
            Historial de acciones
          </h4>
          {history.length === 0 ? (
            <p className="text-[13px] text-text-tertiary">Sin acciones registradas.</p>
          ) : (
            <ul className="max-h-52 space-y-1 overflow-auto">
              {history.map((h) => (
                <li key={h.id} className="flex items-center justify-between gap-2 rounded border border-border-subtle px-2 py-1 text-[12px]">
                  <span className="flex items-center gap-1.5">
                    <Badge label={MK_ACTION_LABEL[h.action] ?? h.action} tone={h.ok ? "success" : "error"} />
                    {h.dryRun && <span className="text-[10px] text-warning">dry</span>}
                    <span className="text-text-tertiary">{h.mikrotikName ?? "—"}</span>
                  </span>
                  <span className="text-text-quaternary">
                    {h.userName ? `${h.userName} · ` : ""}
                    {new Date(h.createdAt).toLocaleString("es-CO", { dateStyle: "short", timeStyle: "short" })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}

function LiveChip({ label, val, invert }: { label: string; val?: boolean; invert?: boolean }) {
  const good = invert ? val === false : val === true;
  const tone = val === undefined ? "text-text-tertiary" : good ? "text-success" : "text-error";
  const mark = val === undefined ? "—" : val ? "sí" : "no";
  return (
    <span className="rounded bg-surface px-2 py-1">
      <span className="text-text-tertiary">{label}: </span>
      <span className={`font-semibold ${tone}`}>{mark}</span>
    </span>
  );
}
