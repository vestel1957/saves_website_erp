"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Input, Select, Textarea, Field } from "@/components/ui/Field";
import { DataTable } from "@/components/ui/DataTable";
import { Pagination } from "@/components/ui/Pagination";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { Modal } from "@/components/Modal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { useOrden } from "@/lib/useOrden";
import { mensajeDeError } from "@/lib/errores";
import { TICKET_PRIORITIES, TICKET_PRIORITY_TONE } from "@/lib/support";

/** Mismo pintado de prioridad que en soporte: un color por nivel. */
const TONO_BADGE: Record<string, string> = {
  error: "bg-error-soft text-error-text",
  warning: "bg-warning-soft text-warning-text",
  info: "bg-info-soft text-info-text",
  success: "bg-success-soft text-success-text",
  default: "bg-surface-2 text-text-secondary",
};

const toLocalInput = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso); const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

export default function AgendaPage() {
  const { authFetch } = useAuth();
  const [loading, setLoading] = useState(true);

  // ── Eventos ───────────────────────────────────────────────────────────────
  const [rows, setRows] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [pages, setPages] = useState(1);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  // ── Stats ─────────────────────────────────────────────────────────────────
  const [stats, setStats] = useState<any>(null);

  // Pagina en el servidor: el orden viaja en la query.
  const orden = useOrden();

  const loadEvents = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ from, to, page: String(page), pageSize: String(pageSize), ...orden.params });
      const url = `/omni/events?${qs}`;
      const d: any = await (await authFetch(url)).json();
      setRows(d.items ?? []);
      setTotal(d.total ?? 0);
      setPages(d.pages ?? 1);
    } finally {
      setLoading(false);
    }
  }, [authFetch, from, to, page, pageSize, orden.clave]);

  const loadStats = useCallback(async () => {
    const d: any = await (await authFetch("/omni/events/stats")).json();
    setStats(d);
  }, [authFetch]);

  useEffect(() => {
    void loadEvents();
  }, [loadEvents]);

  // Cambiar el rango vuelve a la página 1: mantener la página vieja sobre un
  // rango nuevo mostraba una página que ya no existía.
  useEffect(() => { setPage(1); }, [from, to, pageSize, orden.clave]);

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  const [eventModal, setEventModal] = useState<any | "new" | null>(null);
  const [ev, setEv] = useState<any>({ title: "", start: "", end: "", description: "", color: "#6366f1" });
  const [savingEv, setSavingEv] = useState(false);
  const [toDelete, setToDelete] = useState<any>(null);

  function openNew() { setEv({ title: "", start: "", end: "", description: "", color: "#6366f1", priority: "Media" }); setEventModal("new"); }
  function openEdit(r: any) { setEv({ title: r.title ?? "", start: toLocalInput(r.start), end: toLocalInput(r.end), description: r.description ?? "", color: r.color ?? "#6366f1", priority: r.priority ?? "Media" }); setEventModal(r); }

  async function submitEvent() {
    if (!ev.start) { toast("Indica la fecha/hora de inicio", "alert-triangle"); return; }
    setSavingEv(true);
    try {
      const body: any = { title: ev.title || undefined, description: ev.description || undefined, color: ev.color, priority: ev.priority || "Media", start: new Date(ev.start).toISOString(), end: ev.end ? new Date(ev.end).toISOString() : undefined };
      const editing = eventModal && eventModal !== "new";
      const res = await authFetch(editing ? `/omni/events/${eventModal.id}` : "/omni/events", { method: editing ? "PATCH" : "POST", body: JSON.stringify(body) });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.message || "No se pudo guardar");
      toast(editing ? "Evento actualizado" : "Evento creado", "check");
      setEventModal(null); void loadEvents(); void loadStats();
    } catch (e) { toast(mensajeDeError(e), "alert-triangle"); } finally { setSavingEv(false); }
  }

  async function doDeleteEvent() {
    if (!toDelete) return;
    try {
      const res = await authFetch(`/omni/events/${toDelete.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("No se pudo eliminar");
      toast("Evento eliminado", "check"); setToDelete(null); void loadEvents(); void loadStats();
    } catch (e) { toast(mensajeDeError(e), "alert-triangle"); setToDelete(null); }
  }

  const columns = [
    {
      key: "start",
      sortable: true,
      header: "Inicio",
      render: (r: any) =>
        r.start
          ? new Date(r.start).toLocaleString("es-CO", {
              day: "2-digit",
              month: "short",
              hour: r.allDay ? undefined : "2-digit",
              minute: r.allDay ? undefined : "2-digit",
            })
          : "—",
    },
    {
      key: "title",
      sortable: true,
      header: "Título",
      render: (r: any) => (
        <span className="flex items-center gap-2">
          <span
            className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: r.color || "var(--color-brand, #6366f1)" }}
          />
          <span className="font-medium text-text-primary">{r.title || "—"}</span>
        </span>
      ),
    },
    {
      key: "description",
      sortable: true,
      header: "Descripción",
      render: (r: any) => <span className="text-text-secondary">{r.description || "—"}</span>,
    },
    {
      key: "priority",
      header: "Prioridad",
      render: (r: any) => {
        const tono = TICKET_PRIORITY_TONE[r.priority ?? ""] ?? "default";
        return <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${TONO_BADGE[tono]}`}>{r.priority ?? "Media"}</span>;
      },
    },
    {
      key: "orderNo",
      sortable: true,
      header: "Orden",
      render: (r: any) =>
        r.orderNo ? <span className="font-mono text-[12px] text-text-secondary">#{r.orderNo}</span> : "—",
    },
    { key: "assignedBy", header: "Asignó", sortable: true, render: (r: any) => r.assignedBy || "—" },
    { key: "actions", header: "", align: "right" as const, render: (r: any) => (
      <div className="flex justify-end gap-2">
        <button type="button" title="Editar" onClick={() => openEdit(r)} className="tap text-text-tertiary hover:text-brand"><Icon name="pencil" size={14} /></button>
        <button type="button" title="Eliminar" onClick={() => setToDelete(r)} className="tap text-text-tertiary hover:text-error-text"><Icon name="trash" size={14} /></button>
      </div>
    ) },
  ];

  if (loading && rows.length === 0 && !stats) return <PageSkeleton />;

  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <PageHeading icon="calendar-clock" title="Agenda" subtitle="Eventos y programación de órdenes" />
        <div className="flex items-center gap-2">
          <Link href="/ordenes" className="hidden sm:block">
            <Button variant="ghost" size="sm"><Icon name="arrow-left" size={14} /> Órdenes</Button>
          </Link>
          <Button size="sm" onClick={openNew}><Icon name="plus" size={14} /> Nuevo evento</Button>
        </div>
      </div>

      {/* stats */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <div className="flex items-center gap-3 rounded-xl border border-border-subtle bg-surface p-4">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-soft">
            <Icon name="calendar-clock" size={18} className="text-brand" />
          </span>
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">Total eventos</p>
            <p className="text-[18px] font-bold text-text-primary">{stats?.total ?? 0}</p>
          </div>
        </div>
        {stats?.ultimo && (
          <div className="flex items-center gap-3 rounded-xl border border-border-subtle bg-surface p-4">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-2">
              <Icon name="activity" size={18} className="text-text-secondary" />
            </span>
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">Último evento</p>
              <p className="truncate text-[13px] font-semibold text-text-primary">
                {new Date(stats.ultimo).toLocaleDateString("es-CO", { day: "2-digit", month: "short", year: "numeric" })}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Eventos */}
      <div className="flex flex-col gap-4">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setPage(1);
            void loadEvents();
          }}
          className="flex flex-wrap items-end gap-2"
        >
          <Field label="Desde">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="Hasta">
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <Button type="submit" variant="secondary">
            <Icon name="search" size={14} /> Filtrar
          </Button>
        </form>

        <DataTable columns={columns} rows={rows} empty="No hay eventos en el rango seleccionado" sort={orden.sort} onSort={orden.onSort} />

        {total > 0 && (
          <Pagination
            meta={{ page, pageSize, total, pageCount: pages }}
            onPage={setPage}
            onPageSize={(s) => {
              setPageSize(s);
              setPage(1);
            }}
          />
        )}
      </div>

      <Modal open={!!eventModal} onClose={() => setEventModal(null)} title={eventModal === "new" ? "Nuevo evento" : "Editar evento"} maxWidth="max-w-lg">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2"><Field label="Título"><Input value={ev.title} onChange={(e) => setEv({ ...ev, title: e.target.value })} placeholder="Ej: Instalación cliente X" autoFocus /></Field></div>
          <Field label="Inicio" required><Input type="datetime-local" value={ev.start} onChange={(e) => setEv({ ...ev, start: e.target.value })} /></Field>
          <Field label="Fin"><Input type="datetime-local" value={ev.end} onChange={(e) => setEv({ ...ev, end: e.target.value })} /></Field>
          <Field label="Color"><Input type="color" value={ev.color} onChange={(e) => setEv({ ...ev, color: e.target.value })} /></Field>
          <Field label="Prioridad">
            <Select value={ev.priority ?? "Media"} onChange={(e) => setEv({ ...ev, priority: e.target.value })}>
              {TICKET_PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
            </Select>
          </Field>
          <div className="sm:col-span-2"><Field label="Descripción"><Textarea rows={2} value={ev.description} onChange={(e) => setEv({ ...ev, description: e.target.value })} /></Field></div>
        </div>
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setEventModal(null)} disabled={savingEv}>Cancelar</Button>
          <Button onClick={submitEvent} disabled={savingEv}>{savingEv ? "Guardando…" : "Guardar"}</Button>
        </div>
      </Modal>

      <ConfirmDialog
        open={!!toDelete}
        title="Eliminar evento"
        message={<>¿Eliminar el evento <b>{toDelete?.title || "(sin título)"}</b>?</>}
        confirmLabel="Eliminar"
        onConfirm={doDeleteEvent}
        onClose={() => setToDelete(null)}
      />
    </>
  );
}
