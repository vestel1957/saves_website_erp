"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Modal } from "@/components/Modal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Field, Input, Select, Textarea } from "@/components/ui/Field";
import { DataTable } from "@/components/ui/DataTable";
import { Pagination } from "@/components/ui/Pagination";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { fmtDate } from "@/lib/format";
import { StatCard } from "@/components/ui/StatCard";
import { useRequest } from "@/lib/useRequest";
import { useOrden } from "@/lib/useOrden";
import { mensajeDeError } from "@/lib/errores";

type Task = {
  id: string; legacyId: number; name: string | null; status: string; priority: string;
  tdate: string; start: string | null; dueDate: string | null; description: string | null;
  orderId: number | null; author: string | null; assignee: string | null; overdue: boolean;
};

const STATUS_LABEL: Record<string, string> = { DUE: "Pendiente", PROGRESS: "En progreso", DONE: "Hecha" };
const STATUS_TONE: Record<string, "default" | "success" | "error" | "warning" | "info"> = {
  DUE: "warning", PROGRESS: "info", DONE: "success",
};
const PRIORITY_LABEL: Record<string, string> = { LOW: "Baja", MEDIUM: "Media", HIGH: "Alta", URGENT: "Urgente" };
const PRIORITY_TONE: Record<string, "default" | "error" | "warning" | "info"> = {
  LOW: "default", MEDIUM: "info", HIGH: "warning", URGENT: "error",
};

const toDateInput = (d: string | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : "");

/**
 * La descripción del legacy trae HTML crudo (se editaba con un WYSIWYG). No se
 * renderiza como HTML —sería XSS almacenado sobre 28k filas heredadas—: se
 * muestra el texto plano.
 */
const stripHtml = (s: string | null) =>
  (s ?? "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

const emptyForm = { name: "", status: "DUE", priority: "MEDIUM", start: "", dueDate: "", description: "", orderId: "", assigneeId: "" };

export default function TareasPage() {
  const { loading: authLoading, authFetch } = useAuth();
  const [stats, setStats] = useState<any>(null);
  const [assignees, setAssignees] = useState<{ id: number; name: string }[]>([]);

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [priority, setPriority] = useState("");
  const [kind, setKind] = useState("");
  const [mine, setMine] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Task | null>(null);
  const [form, setForm] = useState<any>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [delRow, setDelRow] = useState<Task | null>(null);
  const [deleting, setDeleting] = useState(false);

  const loadStats = useCallback(() => {
    void authFetch("/tasks/stats").then((r) => r.json()).then(setStats).catch(() => {});
  }, [authFetch]);

  useEffect(() => {
    if (authLoading) return;
    loadStats();
    void authFetch("/tasks/assignees").then((r) => r.json()).then(setAssignees).catch(() => {});
  }, [authLoading, authFetch, loadStats]);

  // Carga con cancelación: al teclear se aborta la petición en vuelo para que
  // una respuesta lenta no pise a otra más reciente. Ver lib/useRequest.
  // Pagina en el servidor: el orden viaja en la query.
  const orden = useOrden();

  const { data, cargando: loading, error, refrescar: load } = useRequest<any>(
    () => {
        const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize), ...orden.params });
        if (search.trim()) qs.set("search", search.trim());
        if (status) qs.set("status", status);
        if (priority) qs.set("priority", priority);
        if (kind) qs.set("kind", kind);
        if (mine) qs.set("mine", "true");
      return `/tasks?${qs.toString()}`;
    },
    [page, pageSize, search, status, priority, kind, mine, orden.clave],
    { debounceMs: search ? 350 : 0, saltar: authLoading },
  );

  useEffect(() => { setPage(1); }, [search, status, priority, kind, mine, pageSize, orden.clave]);

  const setF = (k: string, v: string) => setForm((f: any) => ({ ...f, [k]: v }));

  function openNew() { setEditing(null); setForm(emptyForm); setOpen(true); }
  function openEdit(t: Task) {
    setEditing(t);
    setForm({
      name: t.name ?? "", status: t.status, priority: t.priority,
      start: toDateInput(t.start), dueDate: toDateInput(t.dueDate),
      description: stripHtml(t.description), orderId: t.orderId ? String(t.orderId) : "",
      assigneeId: "",
    });
    setOpen(true);
  }

  const submit = useCallback(async () => {
    if (!String(form.name ?? "").trim()) { toast("El nombre de la tarea es obligatorio.", "alert-triangle"); return; }
    if (form.start && form.dueDate && form.start > form.dueDate) {
      toast("La fecha de vencimiento no puede ser anterior a la de inicio.", "alert-triangle");
      return;
    }
    setSaving(true);
    try {
      const body: any = {
        name: String(form.name).trim(),
        status: form.status, priority: form.priority,
        description: String(form.description ?? "").trim() || undefined,
      };
      if (form.start) body.start = form.start;
      if (form.dueDate) body.dueDate = form.dueDate;
      if (String(form.orderId ?? "").trim()) body.orderId = Number(form.orderId);
      if (form.assigneeId) body.assigneeId = Number(form.assigneeId);
      const res = await authFetch(editing ? `/tasks/${editing.id}` : "/tasks", {
        method: editing ? "PATCH" : "POST",
        body: JSON.stringify(body),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new Error(d?.message || "Error");
      toast(editing ? "Tarea actualizada." : "Tarea creada.", "check");
      setOpen(false); setEditing(null); setForm(emptyForm);
      await load(); loadStats();
    } catch (e) {
      toast(mensajeDeError(e, "No se pudo guardar la tarea."), "alert-triangle");
    } finally {
      setSaving(false);
    }
  }, [authFetch, editing, form, load, loadStats]);

  /** Avance rápido de estado desde la tabla, sin abrir el modal. */
  async function quickStatus(t: Task, next: string) {
    try {
      const res = await authFetch(`/tasks/${t.id}`, { method: "PATCH", body: JSON.stringify({ status: next }) });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.message || "Error");
      await load(); loadStats();
    } catch (e) {
      toast(mensajeDeError(e, "No se pudo cambiar el estado."), "alert-triangle");
    }
  }

  async function remove() {
    if (!delRow) return;
    setDeleting(true);
    try {
      const res = await authFetch(`/tasks/${delRow.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.message || "Error");
      toast("Tarea eliminada.", "check");
      setDelRow(null);
      await load(); loadStats();
    } catch (e) {
      toast(mensajeDeError(e, "No se pudo eliminar."), "alert-triangle");
    } finally {
      setDeleting(false);
    }
  }

  if (authLoading) return <PageSkeleton />;

  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <PageHeading
          icon="clipboard-list"
          title="Tareas"
          subtitle={stats ? `${(stats.pendientes ?? 0).toLocaleString("es-CO")} pendientes · ${(stats.vencidas ?? 0).toLocaleString("es-CO")} vencidas` : "Pendientes del equipo"}
        />
        <Button variant="primary" onClick={openNew}><Icon name="plus" size={15} /> Nueva tarea</Button>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Mis tareas abiertas" value={(stats?.mias ?? 0).toLocaleString("es-CO")} icon="user" tone="text-brand" />
        <StatCard label="Pendientes" value={(stats?.pendientes ?? 0).toLocaleString("es-CO")} icon="clock" />
        <StatCard label="Vencidas" value={(stats?.vencidas ?? 0).toLocaleString("es-CO")} icon="alert-triangle" tone="text-error-text" />
        <StatCard label="Hechas" value={(stats?.hechas ?? 0).toLocaleString("es-CO")} icon="check" tone="text-success-text" />
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Icon name="search" size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
          <Input className="pl-9" placeholder="Buscar por texto o N° de orden…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Button variant={mine ? "primary" : "secondary"} onClick={() => setMine((v) => !v)}>
          <Icon name="user" size={14} /> Solo mías
        </Button>
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-auto">
          <option value="">Todos los estados</option>
          {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
        <Select value={priority} onChange={(e) => setPriority(e.target.value)} className="w-auto">
          <option value="">Toda prioridad</option>
          {Object.entries(PRIORITY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
        <Select value={kind} onChange={(e) => setKind(e.target.value)} className="w-auto">
          <option value="">Órdenes y notas</option>
          <option value="orden">Solo de órdenes</option>
          <option value="nota">Solo notas sueltas</option>
        </Select>
      </div>

      {loading && !data ? (
        <PageSkeleton />
      ) : (
        <>
          <DataTable
            sort={orden.sort}
            onSort={orden.onSort}
            rows={data?.items ?? []}
            empty="No hay tareas con esos criterios."
            columns={[
              {
                key: "name", header: "Tarea", sortable: true,
                render: (r: Task) => (
                  <div className="flex flex-col leading-tight">
                    <span className="font-medium text-text-primary">{r.name || "—"}</span>
                    {r.description && <span className="line-clamp-1 text-[11px] text-text-tertiary">{stripHtml(r.description)}</span>}
                  </div>
                ),
              },
              {
                key: "orderId", header: "Orden", sortable: true,
                render: (r: Task) => (r.orderId ? <Badge label={`#${r.orderId}`} tone="default" /> : <span className="text-text-tertiary">Nota</span>),
              },
              { key: "assignee", header: "Responsable", sortable: true, render: (r: Task) => <span className="text-text-secondary">{r.assignee ?? "—"}</span> },
              {
                key: "dueDate", header: "Vence", sortable: true,
                render: (r: Task) => (
                  <span className={r.overdue ? "font-semibold text-error-text" : "text-text-secondary"}>{fmtDate(r.dueDate)}</span>
                ),
              },
              { key: "priority", header: "Prioridad", sortable: true, render: (r: Task) => <Badge label={PRIORITY_LABEL[r.priority] ?? r.priority} tone={PRIORITY_TONE[r.priority] ?? "default"} /> },
              { key: "status", header: "Estado", sortable: true, render: (r: Task) => <Badge label={STATUS_LABEL[r.status] ?? r.status} tone={STATUS_TONE[r.status] ?? "default"} /> },
              {
                key: "acciones", header: "", align: "right" as const,
                render: (r: Task) => (
                  <div className="flex justify-end gap-1">
                    {r.status !== "DONE" && (
                      <button
                        type="button" title="Marcar como hecha"
                        onClick={() => void quickStatus(r, "DONE")}
                        className="tap rounded-md p-1.5 text-text-tertiary hover:bg-success-soft hover:text-success-text"
                      >
                        <Icon name="check" size={15} />
                      </button>
                    )}
                    <button type="button" title="Editar" onClick={() => openEdit(r)} className="tap rounded-md p-1.5 text-text-tertiary hover:bg-surface-2 hover:text-text-primary">
                      <Icon name="pencil" size={15} />
                    </button>
                    <button type="button" title="Eliminar" onClick={() => setDelRow(r)} className="tap rounded-md p-1.5 text-text-tertiary hover:bg-error-soft hover:text-error-text">
                      <Icon name="trash" size={15} />
                    </button>
                  </div>
                ),
              },
            ]}
          />
          {data && data.pages > 1 && (
            <div className="mt-3">
              <Pagination
                meta={{ page: data.page, pageSize: data.pageSize, total: data.total, pageCount: data.pages }}
                onPage={setPage}
                onPageSize={setPageSize}
              />
            </div>
          )}
        </>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title={editing ? "Editar tarea" : "Nueva tarea"} maxWidth="max-w-xl">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field label="Tarea" required>
              <Input value={form.name} onChange={(e) => setF("name", e.target.value)} placeholder="Qué hay que hacer" />
            </Field>
          </div>
          <Field label="Estado">
            <Select value={form.status} onChange={(e) => setF("status", e.target.value)}>
              {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </Field>
          <Field label="Prioridad">
            <Select value={form.priority} onChange={(e) => setF("priority", e.target.value)}>
              {Object.entries(PRIORITY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </Field>
          <Field label="Inicio">
            <Input type="date" value={form.start} onChange={(e) => setF("start", e.target.value)} />
          </Field>
          <Field label="Vence">
            <Input type="date" value={form.dueDate} onChange={(e) => setF("dueDate", e.target.value)} />
          </Field>
          <Field label="N° de orden" hint="Vacío = nota suelta, sin orden asociada">
            <Input type="number" min={0} value={form.orderId} onChange={(e) => setF("orderId", e.target.value)} placeholder="Opcional" />
          </Field>
          <Field label="Responsable" hint={editing ? undefined : "Vacío = tú"}>
            <Select value={form.assigneeId} onChange={(e) => setF("assigneeId", e.target.value)}>
              <option value="">{editing ? "Sin cambios" : "Yo"}</option>
              {assignees.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </Select>
          </Field>
          <div className="sm:col-span-2">
            <Field label="Detalle">
              <Textarea rows={4} value={form.description} onChange={(e) => setF("description", e.target.value)} />
            </Field>
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setOpen(false)} disabled={saving}><Icon name="x" size={15} /> Cancelar</Button>
          <Button variant="primary" onClick={submit} disabled={saving}>
            <Icon name="check" size={15} />
            {saving ? "Guardando…" : editing ? "Guardar cambios" : "Crear tarea"}
          </Button>
        </div>
      </Modal>

      <ConfirmDialog
        open={Boolean(delRow)}
        title="Eliminar tarea"
        message={<>¿Seguro que quieres eliminar <strong>{delRow?.name}</strong>? Esta acción no se puede deshacer.</>}
        confirmLabel="Eliminar"
        busy={deleting}
        onConfirm={remove}
        onClose={() => setDelRow(null)}
      />
    </>
  );
}
