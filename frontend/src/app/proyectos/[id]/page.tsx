"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Field, Input, Textarea } from "@/components/ui/Field";
import { Badge } from "@/components/ui/Badge";
import { Modal } from "@/components/Modal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { DataTable } from "@/components/ui/DataTable";
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

/** Fecha ISO del backend → `yyyy-mm-dd` que espera <input type="date">. */
const toDateInput = (d: any) => (d ? new Date(d).toISOString().slice(0, 10) : "");

const emptyMilestone = { name: "", startDate: "", endDate: "", detail: "", color: "#6366f1" };

/**
 * Alta y edición de hitos. El backend reemplaza el hito completo en PATCH
 * (no hace merge parcial), así que el formulario siempre envía todos los campos.
 */
function HitoModal({
  projectId, hito, open, onClose, onSaved,
}: { projectId: string; hito: any | null; open: boolean; onClose: () => void; onSaved: () => void }) {
  const { authFetch } = useAuth();
  const [form, setForm] = useState<any>(emptyMilestone);
  const [saving, setSaving] = useState(false);
  const editing = Boolean(hito);

  useEffect(() => {
    if (!open) return;
    setForm(hito
      ? { name: hito.name ?? "", startDate: toDateInput(hito.startDate), endDate: toDateInput(hito.endDate), detail: hito.detail ?? "", color: hito.color || "#6366f1" }
      : emptyMilestone);
  }, [open, hito]);

  const setF = (k: string, v: string) => setForm((f: any) => ({ ...f, [k]: v }));

  const submit = useCallback(async () => {
    if (!String(form.name ?? "").trim()) { toast("El nombre del hito es obligatorio.", "alert-triangle"); return; }
    if (form.startDate && form.endDate && form.startDate > form.endDate) {
      toast("La fecha de fin no puede ser anterior a la de inicio.", "alert-triangle");
      return;
    }
    setSaving(true);
    try {
      const body: any = { name: String(form.name).trim(), color: form.color || undefined };
      for (const k of ["startDate", "endDate", "detail"]) if (String(form[k] ?? "").trim()) body[k] = String(form[k]).trim();
      const res = await authFetch(
        editing ? `/projects/milestones/${hito.id}` : `/projects/${projectId}/milestones`,
        { method: editing ? "PATCH" : "POST", body: JSON.stringify(body) },
      );
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new Error(d?.message || "Error");
      toast(editing ? "Hito actualizado." : "Hito creado.", "check");
      onSaved();
      onClose();
    } catch (e: any) {
      toast(e?.message || "No se pudo guardar el hito.", "alert-triangle");
    } finally {
      setSaving(false);
    }
  }, [authFetch, editing, form, hito, projectId, onSaved, onClose]);

  return (
    <Modal open={open} onClose={onClose} title={editing ? "Editar hito" : "Nuevo hito"}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Field label="Nombre" required>
            <Input value={form.name} onChange={(e) => setF("name", e.target.value)} placeholder="Nombre del hito" />
          </Field>
        </div>
        <Field label="Fecha de inicio">
          <Input type="date" value={form.startDate} onChange={(e) => setF("startDate", e.target.value)} />
        </Field>
        <Field label="Fecha de fin">
          <Input type="date" value={form.endDate} onChange={(e) => setF("endDate", e.target.value)} />
        </Field>
        <Field label="Color">
          <Input type="color" className="h-9 p-1" value={form.color} onChange={(e) => setF("color", e.target.value)} />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Detalle">
            <Textarea rows={3} value={form.detail} onChange={(e) => setF("detail", e.target.value)} />
          </Field>
        </div>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose} disabled={saving}>
          <Icon name="x" size={15} />
          Cancelar
        </Button>
        <Button variant="primary" onClick={submit} disabled={saving}>
          <Icon name="check" size={15} />
          {saving ? "Guardando…" : editing ? "Guardar cambios" : "Crear hito"}
        </Button>
      </div>
    </Modal>
  );
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
  const [openHito, setOpenHito] = useState(false);
  const [editHito, setEditHito] = useState<any>(null);
  const [delHito, setDelHito] = useState<any>(null);
  const [deleting, setDeleting] = useState(false);

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

  async function removeHito() {
    if (!delHito) return;
    setDeleting(true);
    try {
      const res = await authFetch(`/projects/milestones/${delHito.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.message || "Error");
      toast("Hito eliminado.", "check");
      setDelHito(null);
      load();
    } catch (e: any) {
      toast(e?.message || "No se pudo eliminar el hito.", "alert-triangle");
    } finally {
      setDeleting(false);
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
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-[13px] font-bold text-text-primary"><Icon name="list" size={15} /> Hitos</div>
          <Button size="sm" variant="secondary" onClick={() => { setEditHito(null); setOpenHito(true); }}>
            <Icon name="plus" size={14} />
            Nuevo hito
          </Button>
        </div>
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
                <div className="ml-auto flex shrink-0 items-center gap-1">
                  <Button size="sm" variant="ghost" aria-label="Editar hito" onClick={() => { setEditHito(m); setOpenHito(true); }}>
                    <Icon name="pencil" size={14} />
                  </Button>
                  <Button size="sm" variant="ghost" aria-label="Eliminar hito" onClick={() => setDelHito(m)}>
                    <Icon name="trash" size={14} className="text-error-text" />
                  </Button>
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

      <HitoModal projectId={id} hito={editHito} open={openHito} onClose={() => setOpenHito(false)} onSaved={load} />
      <ConfirmDialog
        open={Boolean(delHito)}
        title="Eliminar hito"
        message={<>¿Seguro que quieres eliminar el hito <strong>{delHito?.name}</strong>? Esta acción no se puede deshacer.</>}
        confirmLabel="Eliminar"
        busy={deleting}
        onConfirm={removeHito}
        onClose={() => setDelHito(null)}
      />
    </>
  );
}
