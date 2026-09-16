"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
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
import { useValidacion, requerido } from "@/lib/useValidacion";
import { useAuth } from "@/context/AuthProvider";
import { fmtDate } from "@/lib/format";
import { StatCard } from "@/components/ui/StatCard";
import { useRequest } from "@/lib/useRequest";
import { useOrden } from "@/lib/useOrden";
import { listaJson, mensajeDeError, objetoJson } from "@/lib/errores";
import { ACCEPT_ADJUNTO } from "@/lib/adjuntos";

type Task = {
  id: string; legacyId: number; name: string | null; status: string; priority: string;
  tdate: string; start: string | null; dueDate: string | null; description: string | null;
  orderId: number | null; author: string | null; authorSource: string | null;
  assignee: string | null; overdue: boolean;
  /** Cuántos adjuntos lleva (el listado sólo trae el número, no los ficheros). */
  files?: number;
  /** Cuántos renglones de seguimiento tiene documentados. */
  notes?: number;
};

/** Un adjunto ya guardado, tal como lo devuelve `/tasks/:id/files`. */
type Adjunto = { id: string; name: string; size: number; by: string | null; at: string };

/** Tamaño legible de un adjunto (una planilla suele ir en KB, un escaneo en MB). */
const fmtPeso = (b: number) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

const STATUS_LABEL: Record<string, string> = { DUE: "Pendiente", PROGRESS: "En progreso", DONE: "Hecha" };
const STATUS_TONE: Record<string, "default" | "success" | "error" | "warning" | "info"> = {
  DUE: "warning", PROGRESS: "info", DONE: "success",
};
const PRIORITY_LABEL: Record<string, string> = { LOW: "Baja", MEDIUM: "Media", HIGH: "Alta", URGENT: "Urgente" };
const PRIORITY_TONE: Record<string, "default" | "error" | "warning" | "info"> = {
  LOW: "default", MEDIUM: "info", HIGH: "warning", URGENT: "error",
};

/**
 * De dónde salió la tarea. Se dice sólo cuando NO la creó un funcionario desde aquí:
 * "Sistema" o "Bot" a secas se confundirían con el nombre de una persona, y el
 * histórico del legacy conviene marcarlo para que nadie lo lea como creado en nexus.
 */
const SOURCE_LABEL: Record<string, string> = { CHATBOT: "bot", SISTEMA: "automático", LEGACY: "sistema anterior" };

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

  // Adjuntos del modal. Dos listas porque hay dos momentos distintos:
  //  · `adjuntos`  — los que YA están guardados (sólo al editar): se suben, se bajan
  //    y se borran contra el servidor en el acto.
  //  · `porSubir`  — los que se eligieron en una tarea que todavía NO existe. Sin id
  //    de tarea no hay a dónde subirlos, así que esperan en memoria y viajan justo
  //    después de crearla (el mismo «crear -> adjuntar» del egreso y de la compra).
  const [adjuntos, setAdjuntos] = useState<Adjunto[]>([]);
  const [porSubir, setPorSubir] = useState<File[]>([]);
  const [subiendo, setSubiendo] = useState(false);

  const loadStats = useCallback(() => {
    void authFetch("/tasks/stats").then(objetoJson).then(setStats).catch(() => {});
  }, [authFetch]);

  useEffect(() => {
    if (authLoading) return;
    loadStats();
    void authFetch("/tasks/assignees").then(listaJson<{ id: number; name: string }>).then(setAssignees).catch(() => {});
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

  function openNew() { v.limpiar(); setEditing(null); setForm(emptyForm); setAdjuntos([]); setPorSubir([]); setOpen(true); }
  function openEdit(t: Task) {
    v.limpiar();
    setEditing(t);
    setForm({
      name: t.name ?? "", status: t.status, priority: t.priority,
      start: toDateInput(t.start), dueDate: toDateInput(t.dueDate),
      description: stripHtml(t.description), orderId: t.orderId ? String(t.orderId) : "",
      assigneeId: "",
    });
    setAdjuntos([]); setPorSubir([]);
    void cargarAdjuntos(t.id);
    setOpen(true);
  }

  // ---------------------------------------------------------------- //
  //  Adjuntos: la planilla de Excel, el PDF, la foto del pendiente     //
  // ---------------------------------------------------------------- //

  const cargarAdjuntos = useCallback(async (taskId: string) => {
    try {
      setAdjuntos(await authFetch(`/tasks/${taskId}/files`).then(listaJson<Adjunto>));
    } catch {
      // Que no se puedan listar los adjuntos no debe impedir editar la tarea.
      setAdjuntos([]);
    }
  }, [authFetch]);

  /** Sube UN fichero a una tarea que ya existe. Devuelve si lo consiguió. */
  const subirAdjunto = useCallback(async (taskId: string, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    const res = await authFetch(`/tasks/${taskId}/files`, { method: "POST", body: fd });
    const d = await res.json().catch(() => null);
    if (!res.ok) throw new Error(d?.message || `No se pudo subir ${file.name}`);
    return d as Adjunto;
  }, [authFetch]);

  /**
   * Al elegir ficheros: si la tarea ya existe se suben ya; si se está creando,
   * quedan en cola y suben cuando la tarea tenga id.
   */
  const elegirAdjuntos = useCallback(async (elegidos: File[]) => {
    if (!elegidos.length) return;
    if (!editing) { setPorSubir((v) => [...v, ...elegidos]); return; }
    setSubiendo(true);
    try {
      for (const f of elegidos) await subirAdjunto(editing.id, f);
      toast(elegidos.length === 1 ? "Archivo adjuntado." : `${elegidos.length} archivos adjuntados.`, "check");
      await cargarAdjuntos(editing.id);
      await load();
    } catch (e) {
      toast(mensajeDeError(e, "No se pudo adjuntar el archivo."), "alert-triangle");
      await cargarAdjuntos(editing.id);
    } finally {
      setSubiendo(false);
    }
  }, [cargarAdjuntos, editing, load, subirAdjunto]);

  /** Abre el adjunto. Se baja por fetch (la API pide cabecera de sesión) y se
   *  muestra desde un blob, igual que en órdenes de compra. */
  const verAdjunto = useCallback(async (taskId: string, f: Adjunto) => {
    try {
      const res = await authFetch(`/tasks/${taskId}/files/${f.id}/download`);
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.message || "No se pudo descargar");
      const url = URL.createObjectURL(await res.blob());
      // El Excel no se puede "ver" en el navegador: se baja con su nombre real.
      const a = document.createElement("a");
      a.href = url; a.download = f.name; a.rel = "noopener";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (e) {
      toast(mensajeDeError(e, "No se pudo abrir el archivo."), "alert-triangle");
    }
  }, [authFetch]);

  const borrarAdjunto = useCallback(async (taskId: string, f: Adjunto) => {
    try {
      const res = await authFetch(`/tasks/${taskId}/files/${f.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.message || "No se pudo eliminar");
      setAdjuntos((v) => v.filter((x) => x.id !== f.id));
      await load();
    } catch (e) {
      toast(mensajeDeError(e, "No se pudo eliminar el adjunto."), "alert-triangle");
    }
  }, [authFetch, load]);

  const v = useValidacion(
    { name: form.name, start: form.start, dueDate: form.dueDate },
    {
      name: requerido("El nombre de la tarea es obligatorio."),
      // Regla cruzada: la lee del propio formulario, así el aviso sale bajo
      // «Vence» —que es la fecha que hay que mover— y no en un toast suelto.
      dueDate: (valor, f) =>
        f.start && valor && String(f.start) > String(valor)
          ? "No puede ser anterior a la fecha de inicio."
          : undefined,
    },
  );

  const submit = useCallback(async () => {
    if (!v.revisar()) return;
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

      // Los adjuntos elegidos antes de que la tarea existiera suben ahora, con el id
      // recién creado. Si alguno falla NO se deshace la tarea: ya está guardada, así
      // que se avisa de cuáles quedaron fuera para poder reintentar desde el editar.
      const fallidos: string[] = [];
      if (!editing && porSubir.length && d?.id) {
        setSubiendo(true);
        for (const f of porSubir) {
          try { await subirAdjunto(d.id, f); } catch { fallidos.push(f.name); }
        }
        setSubiendo(false);
      }
      if (fallidos.length) toast(`Tarea creada, pero no se pudo adjuntar: ${fallidos.join(", ")}`, "alert-triangle");
      else toast(editing ? "Tarea actualizada." : "Tarea creada.", "check");

      setOpen(false); setEditing(null); setForm(emptyForm); setAdjuntos([]); setPorSubir([]);
      await load(); loadStats();
    } catch (e) {
      toast(mensajeDeError(e, "No se pudo guardar la tarea."), "alert-triangle");
    } finally {
      setSaving(false);
    }
  }, [v, authFetch, editing, form, load, loadStats, porSubir, subirAdjunto]);

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
                    <span className="flex items-center gap-1.5 font-medium text-text-primary">
                      {/* El nombre abre la ficha: ahí está el seguimiento, que es
                          donde se documenta lo que se hizo. El lápiz sigue abriendo
                          el modal de siempre para corregir los datos de la tarea. */}
                      <Link href={`/tareas/${r.id}`} className="truncate hover:text-brand hover:underline">
                        {r.name || "—"}
                      </Link>
                      {!!r.files && (
                        <span className="inline-flex items-center gap-0.5 text-[11px] font-normal text-text-tertiary" title={`${r.files} adjunto(s)`}>
                          <Icon name="paperclip" size={12} />{r.files}
                        </span>
                      )}
                      {!!r.notes && (
                        <span className="inline-flex items-center gap-0.5 text-[11px] font-normal text-text-tertiary" title={`${r.notes} entrada(s) de seguimiento`}>
                          <Icon name="message-square" size={12} />{r.notes}
                        </span>
                      )}
                    </span>
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
                key: "author", header: "Creada por", sortable: true,
                render: (r: Task) => (
                  <div className="flex flex-col leading-tight">
                    <span className="text-text-secondary">{r.author ?? "—"}</span>
                    {r.authorSource && SOURCE_LABEL[r.authorSource] && (
                      <span className="text-[11px] text-text-tertiary">{SOURCE_LABEL[r.authorSource]}</span>
                    )}
                  </div>
                ),
              },
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
                    <Link href={`/tareas/${r.id}`} title="Abrir y documentar" className="tap rounded-md p-1.5 text-text-tertiary hover:bg-surface-2 hover:text-text-primary">
                      <Icon name="message-square" size={15} />
                    </Link>
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
            <Field label="Tarea" required error={v.error("name")}>
              <Input value={form.name} onChange={(e) => setF("name", e.target.value)} placeholder="Qué hay que hacer" {...v.campo("name")} />
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
          <Field label="Vence" error={v.error("dueDate")}>
            <Input type="date" value={form.dueDate} onChange={(e) => setF("dueDate", e.target.value)} {...v.campo("dueDate")} />
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

          {/* Adjuntos: la planilla de Excel que hay que trabajar, la cotización, la
              foto de lo pendiente. Al crear se acumulan y suben al guardar. */}
          <div className="sm:col-span-2">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[12px] font-semibold text-text-secondary">Adjuntos</span>
              <label className={`inline-flex cursor-pointer items-center gap-1 rounded-lg border border-border-default px-2.5 py-1 text-[12px] font-semibold text-text-secondary hover:bg-surface-2 ${subiendo ? "pointer-events-none opacity-60" : ""}`}>
                <Icon name={subiendo ? "loader" : "paperclip"} size={13} className={subiendo ? "animate-spin" : ""} />
                {subiendo ? "Subiendo…" : "Adjuntar archivo"}
                <input
                  type="file" className="hidden" multiple accept={ACCEPT_ADJUNTO}
                  onChange={(e) => { void elegirAdjuntos(Array.from(e.target.files ?? [])); e.target.value = ""; }}
                />
              </label>
            </div>

            {adjuntos.length === 0 && porSubir.length === 0 ? (
              <p className="text-[11px] text-text-tertiary">
                Excel, CSV, PDF, Word, imágenes o ZIP (hasta 20 MB cada uno).
              </p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {adjuntos.map((f) => (
                  <div key={f.id} className="flex items-center gap-2 rounded-lg border border-border-subtle px-2.5 py-1.5">
                    <Icon name="paperclip" size={13} className="shrink-0 text-text-tertiary" />
                    <button
                      type="button"
                      onClick={() => editing && void verAdjunto(editing.id, f)}
                      className="min-w-0 flex-1 truncate text-left text-[12px] font-medium text-brand hover:underline"
                    >
                      {f.name}
                    </button>
                    <span className="shrink-0 text-[11px] text-text-tertiary">{fmtPeso(f.size)}</span>
                    <button
                      type="button" title="Quitar adjunto"
                      onClick={() => editing && void borrarAdjunto(editing.id, f)}
                      className="tap shrink-0 rounded p-1 text-text-tertiary hover:bg-error-soft hover:text-error-text"
                    >
                      <Icon name="trash" size={13} />
                    </button>
                  </div>
                ))}
                {/* Los que todavía no existen en el servidor: se distinguen para que
                    nadie crea que ya están guardados si cierra el modal sin crear. */}
                {porSubir.map((f, i) => (
                  <div key={`${f.name}-${i}`} className="flex items-center gap-2 rounded-lg border border-dashed border-border-default px-2.5 py-1.5">
                    <Icon name="paperclip" size={13} className="shrink-0 text-text-tertiary" />
                    <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-text-primary">{f.name}</span>
                    <span className="shrink-0 text-[11px] text-text-tertiary">{fmtPeso(f.size)} · se sube al guardar</span>
                    <button
                      type="button" title="Quitar de la lista"
                      onClick={() => setPorSubir((v) => v.filter((_, j) => j !== i))}
                      className="tap shrink-0 rounded p-1 text-text-tertiary hover:bg-error-soft hover:text-error-text"
                    >
                      <Icon name="x" size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        {editing && (
          <div className="mt-3 flex items-center gap-1.5 text-[12px] text-text-tertiary">
            <Icon name="user" size={13} />
            Creada por <span className="font-medium text-text-secondary">{editing.author ?? "autor desconocido"}</span>
            {editing.authorSource && SOURCE_LABEL[editing.authorSource] && ` (${SOURCE_LABEL[editing.authorSource]})`}
            {" · "}{fmtDate(editing.tdate)}
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setOpen(false)} disabled={saving}><Icon name="x" size={15} /> Cancelar</Button>
          <Button variant="primary" onClick={submit} disabled={saving || subiendo}>
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
