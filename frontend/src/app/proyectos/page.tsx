"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Input, Select, Textarea, Field } from "@/components/ui/Field";
import { Badge } from "@/components/ui/Badge";
import { DataTable } from "@/components/ui/DataTable";
import { Pagination } from "@/components/ui/Pagination";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { Modal } from "@/components/Modal";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { cop } from "@/lib/subscribers";
import { SubscriberPicker, type PickedSub } from "@/components/cobranzas/SubscriberPicker";
import { StatCard } from "@/components/ui/StatCard";
import { useRequest } from "@/lib/useRequest";
import { useOrden } from "@/lib/useOrden";
import { mensajeDeError } from "@/lib/errores";

const STATUS_OPTS = ["Waiting", "Pending", "Progress", "Finished", "Terminated"];
const PRIORITY_OPTS = ["Low", "Medium", "High", "Urgent"];
const STATUS_LABEL: Record<string, string> = {
  Waiting: "En espera", Pending: "Pendiente", Progress: "En progreso", Finished: "Finalizado", Terminated: "Cancelado",
};
const PRIORITY_LABEL: Record<string, string> = {
  Low: "Baja", Medium: "Media", High: "Alta", Urgent: "Urgente",
};

function statusTone(s: string): "default" | "success" | "error" | "warning" | "info" | "brand" {
  if (s === "Finished") return "success";
  if (s === "Progress") return "info";
  if (s === "Terminated" || s === "Waiting") return "warning";
  return "default";
}

function ProgressBar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(100, value || 0));
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 w-24 overflow-hidden rounded-full bg-surface-2"><div className="h-full rounded-full bg-brand" style={{ width: `${pct}%` }} /></div>
      <span className="w-9 shrink-0 text-right text-[11px] font-semibold text-text-secondary">{pct}%</span>
    </div>
  );
}

export default function ProyectosPage() {
  const { loading: authLoading, authFetch } = useAuth();
  const [stats, setStats] = useState<any>(null);

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [sub, setSub] = useState<PickedSub | null>(null);
  const [fStatus, setFStatus] = useState("Waiting");
  const [fPriority, setFPriority] = useState("Medium");
  const [progress, setProgress] = useState("0");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [worth, setWorth] = useState("");
  const [note, setNote] = useState("");

  const loadStats = useCallback(() => {
    void authFetch("/projects/stats").then((r) => r.json()).then(setStats).catch(() => {});
  }, [authFetch]);

  useEffect(() => {
    if (authLoading) return;
    loadStats();
  }, [authLoading, loadStats]);

  // Carga con cancelación: al teclear se aborta la petición en vuelo para que
  // una respuesta lenta no pise a otra más reciente. Ver lib/useRequest.
  // Pagina en el servidor: el orden viaja en la query.
  const orden = useOrden();

  const { data, cargando: loading, error, refrescar: load } = useRequest<any>(
    () => {
      const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize), ...orden.params });
      if (search.trim()) qs.set("search", search.trim());
      if (status) qs.set("status", status);
      return `/projects?${qs}`;
    },
    [page, pageSize, search, status],
    { debounceMs: search ? 350 : 0, saltar: authLoading },
  );

  useEffect(() => { setPage(1); }, [search, status, pageSize, orden.clave]);

  function resetForm() {
    setName(""); setSub(null); setFStatus("Waiting"); setFPriority("Medium");
    setProgress("0"); setStartDate(""); setEndDate(""); setWorth(""); setNote("");
  }

  async function create() {
    if (!name.trim()) { toast("El nombre es obligatorio.", "alert-triangle"); return; }
    setSaving(true);
    try {
      const body: any = {
        name: name.trim(),
        subscriberId: sub?.id,
        status: fStatus,
        priority: fPriority,
        progress: Number(progress) || 0,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
        worth: worth ? Number(worth) : undefined,
        note: note.trim() || undefined,
      };
      const res = await authFetch("/projects", { method: "POST", body: JSON.stringify(body) });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "Error");
      toast("Proyecto creado.");
      setOpen(false);
      resetForm();
      load();
      loadStats();
    } catch (e) {
      toast(mensajeDeError(e, "Error al crear el proyecto."), "alert-triangle");
    } finally {
      setSaving(false);
    }
  }

  if (authLoading) return <PageSkeleton />;

  return (
    <>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <PageHeading icon="layers" title="Proyectos" subtitle="Gestión de proyectos, hitos y tareas" />
        <Button size="sm" onClick={() => setOpen(true)}><Icon name="plus" size={14} /> Nuevo proyecto</Button>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Total" value={(stats?.total ?? 0).toLocaleString("es-CO")} icon="layers" />
        <StatCard label="Presupuesto total" value={cop(stats?.presupuestoTotal ?? 0)} tone="text-success-text" icon="dollar-sign" />
        <StatCard label="En progreso" value={(stats?.enProgreso ?? 0).toLocaleString("es-CO")} icon="activity" />
        <StatCard label="Finalizados" value={(stats?.finalizados ?? 0).toLocaleString("es-CO")} icon="check" />
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px]">
          <Icon name="search" size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
          <Input className="pl-9" placeholder="Buscar proyecto…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-auto">
          <option value="">Estado</option>
          {STATUS_OPTS.map((s) => <option key={s} value={s}>{STATUS_LABEL[s] ?? s}</option>)}
        </Select>
      </div>

      {loading && !data ? <PageSkeleton /> : (
        <>
          <DataTable
            sort={orden.sort}
            onSort={orden.onSort}
            rows={data?.items ?? []}
            empty="No se encontraron proyectos."
            columns={[
              { key: "name", header: "Nombre", sortable: true, render: (r: any) => <Link href={`/proyectos/${r.id}`} className="font-medium text-brand hover:underline">{r.name}</Link> },
              { key: "client", header: "Cliente", sortable: true, render: (r: any) => <span className="text-text-secondary">{r.client || "—"}</span> },
              { key: "status", header: "Estado", sortable: true, render: (r: any) => <Badge label={STATUS_LABEL[r.status] ?? r.status} tone={statusTone(r.status)} /> },
              { key: "priority", header: "Prioridad", sortable: true, render: (r: any) => <span className="text-text-secondary">{PRIORITY_LABEL[r.priority] ?? (r.priority || "—")}</span> },
              { key: "progress", header: "Avance", sortable: true, render: (r: any) => <ProgressBar value={r.progress} /> },
              { key: "worth", header: "Presupuesto", sortable: true, align: "right", render: (r: any) => <span className="font-semibold text-text-primary">{cop(r.worth ?? 0)}</span> },
              { key: "milestones", header: "Hitos", sortable: true, align: "right", render: (r: any) => <span className="text-text-secondary">{r.milestones ?? 0}</span> },
            ]}
          />
          {data && data.pages > 1 && (
            <div className="mt-3"><Pagination meta={{ page: data.page, pageSize: data.pageSize, total: data.total, pageCount: data.pages }} onPage={setPage} onPageSize={setPageSize} /></div>
          )}
        </>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title="Nuevo proyecto">
        <div className="flex flex-col gap-3">
          <Field label="Nombre" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nombre del proyecto" />
          </Field>
          <Field label="Cliente">
            <SubscriberPicker value={sub} onChange={setSub} />
          </Field>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Estado">
              <Select value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
                {STATUS_OPTS.map((s) => <option key={s} value={s}>{STATUS_LABEL[s] ?? s}</option>)}
              </Select>
            </Field>
            <Field label="Prioridad">
              <Select value={fPriority} onChange={(e) => setFPriority(e.target.value)}>
                {PRIORITY_OPTS.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p] ?? p}</option>)}
              </Select>
            </Field>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Avance (%)">
              <Input type="number" min={0} max={100} value={progress} onChange={(e) => setProgress(e.target.value)} />
            </Field>
            <Field label="Presupuesto">
              <Input type="number" min={0} value={worth} onChange={(e) => setWorth(e.target.value)} placeholder="0" />
            </Field>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Fecha inicio">
              <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </Field>
            <Field label="Fecha fin">
              <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </Field>
          </div>
          <Field label="Nota">
            <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Notas del proyecto…" />
          </Field>
          <div className="mt-1 flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setOpen(false)} disabled={saving}>Cancelar</Button>
            <Button size="sm" onClick={create} disabled={saving}>{saving ? "Guardando…" : "Crear proyecto"}</Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
