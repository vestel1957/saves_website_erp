"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { Badge } from "@/components/ui/Badge";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { PERM } from "@/lib/auth";

type CronRun = {
  id: string; job: string; ok: boolean; manual: boolean;
  count: number; detail: string | null; userName: string | null;
  startedAt: string; finishedAt: string | null;
};
type WaReminders = {
  enabled: boolean;
  /** false = simulación: calcula a quién se le escribiría y no envía nada. */
  live: boolean;
  cap: number;
  template: string;
  dedupeDias: number;
  deudaMinima: number;
  estados: string[];
};
type CronStatus = {
  enabled: boolean;
  legacySyncEnabled?: boolean;
  legacyWritebackEnabled?: boolean;
  schedules: Record<string, string>;
  waReminders?: WaReminders;
  lastRuns: Record<string, CronRun | null>;
};
type DriftRow = { mysql: number; pgLegacy: number; pgPropias: number; atrasoIds: number };
type Drift = { ok: boolean; error?: string; db?: string; tablas?: Record<string, DriftRow> };

const JOB_LABEL: Record<string, string> = {
  RECURRING_BILLING: "Facturación recurrente",
  CARTERA: "Paso a cartera",
  EXCHANGE_RATE: "Tasa de cambio",
  REMINDERS: "Recordatorios de cartera",
  WA_REMINDERS: "Recordatorios por WhatsApp",
  LEGACY_SYNC: "Sincronización con legacy",
  // Pasada ligera intercalada: sólo transacciones, para que la caja del día no vaya
  // 15 minutos por detrás del legacy. Sólo deja rastro cuando trae algo.
  LEGACY_SYNC_CAJA: "Sincronización de caja (ligera)",
  LEGACY_WRITEBACK: "Retro-sync hacia legacy",
};

export default function AutomatizacionesPage() {
  const { authFetch, can } = useAuth();
  const puedeWhatsapp = can(PERM.WHATSAPP_MANAGE);
  const [status, setStatus] = useState<CronStatus | null>(null);
  const [history, setHistory] = useState<CronRun[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [drift, setDrift] = useState<Drift | null>(null);
  const [driftBusy, setDriftBusy] = useState(false);
  const [cap, setCap] = useState("");

  const load = useCallback(() => {
    void authFetch(`/cron/status`)
      .then((r) => (r.ok ? r.json() : null))
      .then((s: CronStatus | null) => {
        setStatus(s);
        if (s?.waReminders) setCap(String(s.waReminders.cap));
      })
      .catch(() => {});
    void authFetch(`/cron/history?limit=20`).then((r) => (r.ok ? r.json() : [])).then(setHistory).catch(() => {});
  }, [authFetch]);

  useEffect(() => { load(); }, [load]);

  /** Interruptor / modo / tope de los recordatorios por WhatsApp. */
  async function guardarWa(patch: { enabled?: boolean; live?: boolean; cap?: number }) {
    setBusy("wa-config");
    try {
      const res = await authFetch(`/cron/wa-reminders/config`, { method: "PUT", body: JSON.stringify(patch) });
      if (!res.ok) { toast((await res.json().catch(() => ({}))).message ?? "No se pudo guardar", "x"); return; }
      toast(
        patch.live === true ? "Envío REAL activado: la próxima corrida escribe a los clientes."
          : patch.live === false ? "Vuelve a simulación: no se enviará nada."
          : patch.enabled !== undefined ? (patch.enabled ? "Corrida diaria activada (09:00)." : "Corrida diaria desactivada.")
          : "Tope guardado.",
        "check",
      );
      load();
    } catch (e) { toast((e as Error).message, "x"); }
    finally { setBusy(null); }
  }

  async function runWaReminders() {
    setBusy("wa-reminders");
    try {
      const res = await authFetch(`/cron/run/wa-reminders`, { method: "POST", body: JSON.stringify({}) });
      const data = await res.json();
      if (!res.ok || data?.ok === false) { toast(data?.error ?? data?.message ?? "Error al ejecutar", "x"); return; }
      toast(
        data.dryRun
          ? `Simulación: ${data.candidatos} clientes recibirían el recordatorio (no se envió nada).`
          : `Recordatorios enviados: ${data.enviados}${data.fallidos ? ` · fallidos: ${data.fallidos}` : ""}`,
        "check",
      );
      load();
    } catch (e) { toast((e as Error).message, "x"); }
    finally { setBusy(null); }
  }

  async function run(job: "recurring-billing" | "cartera" | "legacy-sync" | "legacy-writeback", body?: object) {
    setBusy(job);
    try {
      const res = await authFetch(`/cron/run/${job}`, { method: "POST", body: body ? JSON.stringify(body) : undefined });
      const data = await res.json();
      if (!res.ok || data?.ok === false) { toast(data?.error ?? data?.message ?? "Error al ejecutar", "x"); return; }
      if (job === "recurring-billing") toast(`Generadas ${data.generated} · omitidas ${data.skipped}`, "check");
      else if (job === "legacy-sync") toast(`Sincronizado: +${data.transactions?.nuevas ?? 0} trans · +${data.recibos?.nuevos ?? 0} recibos · ~${data.invoices?.actualizadas ?? 0} facturas`, "check");
      else if (job === "legacy-writeback") toast(data.dry ? `Plan (seco): ${(data.customers?.insertados ?? 0) + (data.invoices?.insertadas ?? 0) + (data.transactions?.insertadas ?? 0)} filas por empujar` : `Empujado al legacy: +${data.transactions?.insertadas ?? 0} trans · +${data.invoices?.insertadas ?? 0} facturas`, "check");
      // En modo legacy-activo la tarea no escribe (el sync devolvería el estado):
      // se informa a cuántos les daría, para no leer "0 movidos" como "no hay morosos".
      else if (data.soloInforme) toast(`${data.candidatos} abonados deben más de ${data.maxPendientes} facturas. No se movieron: el estado lo manda el legacy.`, "info");
      else toast(`Clientes movidos a cartera: ${data.moved}`, "check");
      load();
    } catch (e) { toast((e as Error).message, "x"); }
    finally { setBusy(null); }
  }

  async function checkDrift() {
    setDriftBusy(true);
    try {
      const res = await authFetch(`/cron/legacy/drift`);
      const data = await res.json();
      if (!res.ok || !data?.ok) { toast(data?.error ?? "No se pudo consultar la deriva", "x"); return; }
      setDrift(data);
    } catch (e) { toast((e as Error).message, "x"); }
    finally { setDriftBusy(false); }
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
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {["RECURRING_BILLING", "CARTERA", "EXCHANGE_RATE", "LEGACY_SYNC", "LEGACY_WRITEBACK"].map((job) => {
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
              {job === "LEGACY_SYNC" && (
                <Button className="mt-3 w-full" variant="secondary" disabled={busy !== null}
                  onClick={() => run("legacy-sync")}>
                  {busy === "legacy-sync" ? "Sincronizando…" : "Sincronizar ahora"}
                </Button>
              )}
              {job === "LEGACY_WRITEBACK" && (
                <>
                  {status?.legacyWritebackEnabled === false && (
                    <p className="mt-1 text-[11px] text-text-tertiary">En seco: solo reporta el plan (activar con <code className="font-mono">LEGACY_WRITEBACK_LIVE=true</code>).</p>
                  )}
                  <Button className="mt-3 w-full" variant="secondary" disabled={busy !== null}
                    onClick={() => run("legacy-writeback")}>
                    {busy === "legacy-writeback" ? "Empujando…" : "Empujar ahora"}
                  </Button>
                </>
              )}
            </div>
          );
        })}
      </div>

      {/* Recordatorios de cartera por WhatsApp: le escribe a clientes reales, así que
          tiene su propio interruptor, su modo simulación y su tope. */}
      {puedeWhatsapp && status?.waReminders && (
        <div className="rounded-xl border border-border-subtle bg-surface p-4">
          <div className="mb-2 flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-[15px] font-semibold text-text-primary">Recordatorios de cartera por WhatsApp</h3>
                <Badge
                  label={status.waReminders.live ? "envío real" : "simulación"}
                  tone={status.waReminders.live ? "success" : "warning"}
                />
                {status.waReminders.enabled
                  ? <Badge label="diario 09:00" tone="success" />
                  : <Badge label="corrida diaria apagada" tone="default" />}
              </div>
              <p className="mt-1 max-w-3xl text-[12px] text-text-tertiary">
                Le escribe al moroso con la plantilla <code className="font-mono">{status.waReminders.template}</code> (nombre y
                deuda). Si responde, lo atiende el bot: puede ver su saldo, pedir el PDF de la factura o hablar con una
                persona. No se le repite antes de {status.waReminders.dedupeDias} días, se omite a quien deba menos de{" "}
                {new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(status.waReminders.deudaMinima)}
                {" "}y a quien esté esperando a una persona.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" disabled={busy !== null} onClick={() => void runWaReminders()}>
                {busy === "wa-reminders"
                  ? "Ejecutando…"
                  : status.waReminders.live ? "Enviar ahora" : "Simular ahora"}
              </Button>
              <Button
                variant={status.waReminders.enabled ? "secondary" : "primary"}
                disabled={busy !== null}
                onClick={() => void guardarWa({ enabled: !status.waReminders!.enabled })}
              >
                {status.waReminders.enabled ? "Apagar corrida diaria" : "Activar corrida diaria"}
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-4 border-t border-border-subtle pt-3">
            <div className="w-40">
              <Field label="Tope por corrida">
                <Input
                  value={cap}
                  onChange={(e) => setCap(e.target.value)}
                  onBlur={() => {
                    const n = Number(cap);
                    if (n && n !== status.waReminders!.cap) void guardarWa({ cap: n });
                  }}
                  inputMode="numeric"
                />
              </Field>
              <p className="mt-1 text-[11px] text-text-tertiary">
                La línea admite 250 clientes distintos cada 24 h, compartidos con las campañas masivas.
              </p>
            </div>
            <div className="flex-1">
              {status.waReminders.live ? (
                <div className="rounded-lg border border-warning-soft bg-warning-soft px-3 py-2 text-[12px] text-warning-text">
                  <b>Envío real activo.</b> Cada corrida le escribe de verdad a hasta {status.waReminders.cap} clientes.
                  <Button className="ml-3" variant="secondary" disabled={busy !== null} onClick={() => void guardarWa({ live: false })}>
                    Volver a simulación
                  </Button>
                </div>
              ) : (
                <div className="rounded-lg border border-border-subtle bg-surface-subtle px-3 py-2 text-[12px] text-text-secondary">
                  En <b>simulación</b>: calcula a quién le escribiría y no envía nada. Corre &quot;Simular ahora&quot; y revisa el
                  detalle antes de activar el envío real.
                  <Button className="ml-3" disabled={busy !== null} onClick={() => void guardarWa({ live: true })}>
                    Activar envío real
                  </Button>
                </div>
              )}
            </div>
          </div>

          {status.lastRuns?.WA_REMINDERS && (
            <p className="mt-3 text-[12px] text-text-secondary">
              Última corrida: <span className="text-text-primary">{fmt(status.lastRuns.WA_REMINDERS.startedAt)}</span>
              {status.lastRuns.WA_REMINDERS.detail && <span className="text-text-tertiary"> — {status.lastRuns.WA_REMINDERS.detail}</span>}
            </p>
          )}
        </div>
      )}

      {/* Deriva legacy ↔ nuevo: ¿los dos sistemas van de la mano? */}
      <div className="rounded-xl border border-border-subtle bg-surface p-4">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div>
            <h3 className="text-[15px] font-semibold text-text-primary">Deriva con el sistema legacy</h3>
            <p className="text-[12px] text-text-tertiary">
              Compara la BD viva del legacy (MySQL) con este sistema, tabla por tabla.
              {status?.legacySyncEnabled === false && <> · <b>Sincronización programada apagada</b> (LEGACY_SYNC_ENABLED)</>}
            </p>
          </div>
          <Button variant="secondary" disabled={driftBusy} onClick={() => void checkDrift()}>
            {driftBusy ? "Consultando…" : "Verificar deriva"}
          </Button>
        </div>
        {drift?.tablas && (
          <DataTable
            columns={[
              { key: "tabla", header: "Tabla", render: (r) => <span className="font-medium text-text-primary">{r.tabla}</span> },
              { key: "mysql", header: "Legacy (MySQL)", render: (r) => r.mysql.toLocaleString("es-CO") },
              { key: "pgLegacy", header: "Aquí (migradas)", render: (r) => r.pgLegacy.toLocaleString("es-CO") },
              { key: "pgPropias", header: "Aquí (propias)", render: (r) => r.pgPropias.toLocaleString("es-CO") },
              { key: "atrasoIds", header: "Atraso", render: (r) => (
                <Badge label={r.atrasoIds === 0 ? "Al día" : `${r.atrasoIds} ids`} tone={r.atrasoIds === 0 ? "success" : "warning"} />
              ) },
            ] satisfies Column<DriftRow & { tabla: string }>[]}
            rows={Object.entries(drift.tablas).map(([tabla, r]) => ({ tabla, ...r }))}
            empty="Sin datos."
          />
        )}
      </div>

      {/* Historial */}
      <div>
        <h3 className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-text-tertiary">Historial de corridas</h3>
        <DataTable
          columns={[
            { key: "job", header: "Tarea", render: (h) => JOB_LABEL[h.job] ?? h.job },
            { key: "startedAt", header: "Cuándo", render: (h) => <span className="text-text-secondary">{fmt(h.startedAt)}</span> },
            { key: "manual", header: "Tipo", render: (h) => (h.manual ? "Manual" : "Programada") },
            { key: "ok", header: "Resultado", render: (h) => <Badge label={h.ok ? "OK" : "Error"} tone={h.ok ? "success" : "error"} /> },
            { key: "detail", header: "Detalle", render: (h) => <span className="text-text-tertiary">{h.detail}</span> },
          ] satisfies Column<CronRun>[]}
          rows={history}
          empty="Sin corridas registradas."
        />
      </div>
    </div>
  );
}
