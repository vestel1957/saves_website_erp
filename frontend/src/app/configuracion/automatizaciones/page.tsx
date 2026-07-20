"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";

type CronRun = {
  id: string; job: string; ok: boolean; manual: boolean;
  count: number; detail: string | null; userName: string | null;
  startedAt: string; finishedAt: string | null;
};
type CronStatus = {
  enabled: boolean;
  schedules: Record<string, string>;
  lastRuns: Record<string, CronRun | null>;
};

const JOB_LABEL: Record<string, string> = {
  RECURRING_BILLING: "Facturación recurrente",
  CARTERA: "Paso a cartera",
  EXCHANGE_RATE: "Tasa de cambio",
};

export default function AutomatizacionesPage() {
  const { authFetch } = useAuth();
  const [status, setStatus] = useState<CronStatus | null>(null);
  const [history, setHistory] = useState<CronRun[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    void authFetch(`/cron/status`).then((r) => (r.ok ? r.json() : null)).then(setStatus).catch(() => {});
    void authFetch(`/cron/history?limit=20`).then((r) => (r.ok ? r.json() : [])).then(setHistory).catch(() => {});
  }, [authFetch]);

  useEffect(() => { load(); }, [load]);

  async function run(job: "recurring-billing" | "cartera", body?: object) {
    setBusy(job);
    try {
      const res = await authFetch(`/cron/run/${job}`, { method: "POST", body: body ? JSON.stringify(body) : undefined });
      const data = await res.json();
      if (!res.ok) { toast(data?.message ?? "Error al ejecutar", "x"); return; }
      if (job === "recurring-billing") toast(`Generadas ${data.generated} · omitidas ${data.skipped}`, "check");
      else toast(`Clientes movidos a cartera: ${data.moved}`, "check");
      load();
    } catch (e) { toast((e as Error).message, "x"); }
    finally { setBusy(null); }
  }

  const fmt = (s: string | null) => s ? new Date(s).toLocaleString("es-CO", { dateStyle: "medium", timeStyle: "short" }) : "—";

  return (
    <div className="space-y-5">
      <PageHeading icon="calendar-clock" title="Automatizaciones" subtitle="Cronjobs de facturación y cartera (migrado de Cronjob.php)." />

      {/* Estado global del scheduler */}
      <div className={`flex items-center gap-2 rounded-lg border px-4 py-3 text-[13px] ${status?.enabled ? "border-success-soft bg-success-soft text-success-text" : "border-border-subtle bg-surface-subtle text-text-secondary"}`}>
        <Icon name={status?.enabled ? "check" : "clock"} size={16} />
        {status?.enabled
          ? <span>Las tareas programadas están <b>activas</b> y correrán en su horario.</span>
          : <span>Tareas programadas <b>en pausa</b> (arranca el backend con <code className="font-mono">CRONS_ENABLED=true</code>). El disparo manual siempre funciona.</span>}
      </div>

      {/* Tarjetas por tarea */}
      <div className="grid gap-4 md:grid-cols-3">
        {["RECURRING_BILLING", "CARTERA", "EXCHANGE_RATE"].map((job) => {
          const last = status?.lastRuns?.[job] ?? null;
          return (
            <div key={job} className="rounded-xl border border-border-subtle bg-surface p-4">
              <div className="mb-1 flex items-center justify-between gap-2">
                <h3 className="text-[15px] font-semibold text-text-primary">{JOB_LABEL[job]}</h3>
                {last && <Badge label={last.ok ? "OK" : "Error"} tone={last.ok ? "success" : "error"} />}
              </div>
              <p className="text-[12px] text-text-tertiary">{status?.schedules?.[job]}</p>
              <div className="mt-3 space-y-0.5 text-[12px] text-text-secondary">
                <div>Última corrida: <span className="text-text-primary">{fmt(last?.startedAt ?? null)}</span></div>
                {last?.detail && <div className="text-text-tertiary">{last.detail}</div>}
              </div>
              {job === "RECURRING_BILLING" && (
                <Button className="mt-3 w-full" variant="secondary" disabled={busy !== null}
                  onClick={() => run("recurring-billing", { limit: 2000 })}>
                  {busy === "recurring-billing" ? "Generando…" : "Generar ahora"}
                </Button>
              )}
              {job === "CARTERA" && (
                <Button className="mt-3 w-full" variant="secondary" disabled={busy !== null}
                  onClick={() => run("cartera")}>
                  {busy === "cartera" ? "Procesando…" : "Ejecutar ahora"}
                </Button>
              )}
              {job === "EXCHANGE_RATE" && (
                <p className="mt-3 text-[12px] italic text-text-tertiary">Sin acción (operación en COP).</p>
              )}
            </div>
          );
        })}
      </div>

      {/* Historial */}
      <div className="rounded-xl border border-border-subtle bg-surface p-4">
        <h3 className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-text-tertiary">Historial de corridas</h3>
        {history.length === 0 ? (
          <p className="text-[13px] text-text-tertiary">Sin corridas registradas.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-border-subtle text-left text-text-tertiary">
                  <th className="py-1.5 pr-3 font-medium">Tarea</th>
                  <th className="py-1.5 pr-3 font-medium">Cuándo</th>
                  <th className="py-1.5 pr-3 font-medium">Tipo</th>
                  <th className="py-1.5 pr-3 font-medium">Resultado</th>
                  <th className="py-1.5 pr-3 font-medium">Detalle</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id} className="border-b border-border-subtle/60">
                    <td className="py-1.5 pr-3">{JOB_LABEL[h.job] ?? h.job}</td>
                    <td className="py-1.5 pr-3 text-text-secondary">{fmt(h.startedAt)}</td>
                    <td className="py-1.5 pr-3">{h.manual ? "Manual" : "Programada"}</td>
                    <td className="py-1.5 pr-3"><Badge label={h.ok ? "OK" : "Error"} tone={h.ok ? "success" : "error"} /></td>
                    <td className="py-1.5 pr-3 text-text-tertiary">{h.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
