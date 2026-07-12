"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { PageHeading } from "@/components/accounting/PageHeading";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { Badge } from "@/components/ui/Badge";
import { DataTable } from "@/components/inventory/DataTable";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { cop } from "@/lib/subscribers";

function statusTone(s: string): "default" | "success" | "error" | "warning" | "info" | "brand" {
  if (s === "Finished") return "success";
  if (s === "Progress") return "info";
  if (s === "Terminated" || s === "Waiting") return "warning";
  return "default";
}

function taskTone(s: string): "default" | "success" | "error" | "warning" | "info" | "brand" {
  if (s === "Done") return "success";
  if (s === "Progress") return "info";
  if (s === "Due") return "warning";
  return "default";
}

const STATUS_LABEL: Record<string, string> = {
  Waiting: "En espera", Pending: "Pendiente", Progress: "En progreso", Finished: "Finalizado", Terminated: "Cancelado",
};
const PRIORITY_LABEL: Record<string, string> = {
  Low: "Baja", Medium: "Media", High: "Alta", Urgent: "Urgente",
};
const TASK_LABEL: Record<string, string> = {
  Done: "Hecha", Progress: "En progreso", Due: "Pendiente", Waiting: "En espera",
};

function fmtDate(d: any) {
  return d ? new Date(d).toLocaleDateString("es-CO") : "—";
}

function InfoTile({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border-subtle bg-surface px-4 py-3 shadow-sm">
      <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-soft text-brand"><Icon name={icon} size={17} /></span>
      <div className="flex flex-col leading-tight">
        <span className="text-[11px] font-medium text-text-tertiary">{label}</span>
        <span className="text-[15px] font-bold text-text-primary">{value}</span>
      </div>
    </div>
  );
}

export default function ProyectoDetallePage() {
  const params = useParams();
  const id = String(params?.id ?? "");
  const { loading: authLoading, authFetch } = useAuth();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState("0");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await (await authFetch(`/projects/${id}`)).json();
      setData(d);
      setProgress(String(d?.progress ?? 0));
    } finally {
      setLoading(false);
    }
  }, [authFetch, id]);

  useEffect(() => { if (!authLoading && id) void load(); }, [authLoading, id, load]);

  async function updateProgress() {
    setSaving(true);
    try {
      const res = await authFetch(`/projects/${id}`, { method: "PATCH", body: JSON.stringify({ progress: Number(progress) || 0 }) });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "Error");
      toast("Avance actualizado.");
      load();
    } catch (e: any) {
      toast(e?.message || "Error al actualizar el avance.", "alert-triangle");
    } finally {
      setSaving(false);
    }
  }

  if (authLoading || (loading && !data)) return <PageSkeleton />;

  if (!data) {
    return (
      <div className="rounded-xl border border-dashed border-border-subtle bg-surface p-10 text-center text-[13px] text-text-tertiary">
        No se encontró el proyecto.
      </div>
    );
  }

  const pct = Math.max(0, Math.min(100, data.progress || 0));

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <PageHeading icon="layers" title={data.name} subtitle={data.subscriber?.name ? `Cliente: ${data.subscriber.name}` : "Sin cliente asignado"} />
        <div className="flex flex-wrap items-center gap-2">
          <Badge label={STATUS_LABEL[data.status] ?? data.status} tone={statusTone(data.status)} />
          {data.priority && <Badge label={PRIORITY_LABEL[data.priority] ?? data.priority} tone="default" />}
        </div>
      </div>

      <div className="mb-4 rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[13px] font-bold text-text-primary">Avance</span>
          <span className="text-[15px] font-bold text-brand">{pct}%</span>
        </div>
        <div className="mb-3 h-3 w-full overflow-hidden rounded-full bg-surface-2"><div className="h-full rounded-full bg-brand" style={{ width: `${pct}%` }} /></div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-28">
            <Input type="number" min={0} max={100} value={progress} onChange={(e) => setProgress(e.target.value)} />
          </div>
          <Button size="sm" onClick={updateProgress} disabled={saving}>{saving ? "Guardando…" : "Actualizar avance"}</Button>
        </div>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <InfoTile icon="calendar-clock" label="Fecha inicio" value={fmtDate(data.startDate)} />
        <InfoTile icon="calendar-clock" label="Fecha fin" value={fmtDate(data.endDate)} />
        <InfoTile icon="dollar-sign" label="Presupuesto" value={cop(data.worth ?? 0)} />
        <InfoTile icon="user" label="Cliente" value={data.subscriber?.name ?? "—"} />
      </div>

      {data.note && (
        <div className="mb-4 rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
          <div className="mb-1 text-[13px] font-bold text-text-primary">Nota</div>
          <p className="whitespace-pre-wrap text-[13px] text-text-secondary">{data.note}</p>
        </div>
      )}

      <div className="mb-4 rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
        <div className="mb-3 flex items-center gap-2 text-[13px] font-bold text-text-primary"><Icon name="list" size={15} /> Hitos</div>
        {(data.milestones?.length ?? 0) === 0 ? (
          <p className="text-[13px] text-text-tertiary">Sin hitos.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {data.milestones.map((m: any) => (
              <div key={m.id} className="flex items-start gap-3 rounded-lg border border-border-subtle bg-surface-2 px-3 py-2">
                <span className="mt-1 h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: m.color || "var(--brand, #6366f1)" }} />
                <div className="flex flex-col leading-tight">
                  <span className="text-[13px] font-semibold text-text-primary">{m.name}</span>
                  <span className="text-[11px] text-text-tertiary">{fmtDate(m.startDate)} — {fmtDate(m.endDate)}</span>
                  {m.detail && <span className="mt-0.5 text-[12px] text-text-secondary">{m.detail}</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
        <div className="mb-3 flex items-center gap-2 text-[13px] font-bold text-text-primary"><Icon name="check" size={15} /> Tareas</div>
        <DataTable
          rows={data.tasks ?? []}
          empty="Sin tareas."
          columns={[
            { key: "name", header: "Tarea", render: (r: any) => <span className="font-medium text-text-primary">{r.name}</span> },
            { key: "status", header: "Estado", render: (r: any) => <Badge label={TASK_LABEL[r.status] ?? r.status} tone={taskTone(r.status)} /> },
            { key: "start", header: "Inicio", render: (r: any) => fmtDate(r.start) },
            { key: "dueDate", header: "Vence", render: (r: any) => fmtDate(r.dueDate) },
            { key: "priority", header: "Prioridad", render: (r: any) => <span className="text-text-secondary">{PRIORITY_LABEL[r.priority] ?? (r.priority || "—")}</span> },
          ]}
        />
      </div>
    </>
  );
}
