"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { DataTable } from "@/components/ui/DataTable";
import { Badge } from "@/components/ui/Badge";
import { Input, Select } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { ListToolbar } from "@/components/ui/ListToolbar";
import { Pagination } from "@/components/ui/Pagination";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { Modal } from "@/components/Modal";
import { NuevaOrdenModal } from "@/components/soporte/NuevaOrdenModal";
import { TecChip } from "@/components/soporte/TecChip";
import { MisOrdenes } from "@/components/soporte/MisOrdenes";
import { useAuth } from "@/context/AuthProvider";
import { esTecnico, type Paged, type TicketRow, type SupportStats, TICKET_STATUS_LABEL, TICKET_STATUS_TONE, TICKET_TYPES, TICKET_PRIORITIES, TICKET_PRIORITY_TONE } from "@/lib/support";
import { useRequest } from "@/lib/useRequest";
import { useOrden } from "@/lib/useOrden";
import { toast } from "@/components/ui/Toast";
import { mensajeDeError } from "@/lib/errores";

/** Presets de fecha típicos de operación. */
function datePresets(): { label: string; from: string; to: string }[] {
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();
  return [
    { label: "Hoy", from: iso(new Date(y, m, d)), to: iso(new Date(y, m, d)) },
    { label: "7 días", from: iso(new Date(y, m, d - 6)), to: iso(new Date(y, m, d)) },
    { label: "Este mes", from: iso(new Date(y, m, 1)), to: iso(new Date(y, m + 1, 0)) },
  ];
}

/**
 * Soporte tiene DOS pantallas, no una con controles escondidos:
 *  · Técnico de campo → `MisOrdenes`: sus órdenes, sin filtros ni columna de técnico.
 *  · Todos los demás  → la vista general de abajo, con su buscador y sus filtros.
 * El reparto se hace aquí y no dentro, para que ninguna de las dos tenga que ir
 * preguntándose en cada control quién está mirando.
 */
export default function SoportePage() {
  const { user, loading } = useAuth();
  if (loading) return <PageSkeleton />;
  if (esTecnico(user)) return <MisOrdenes />;
  return <SoporteGeneral />;
}

function SoporteGeneral() {
  const router = useRouter();
  const { loading: authLoading, authFetch, user, sedeScoped } = useAuth();
  const [stats, setStats] = useState<SupportStats | null>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [type, setType] = useState("");
  const [tec, setTec] = useState("");
  const [priority, setPriority] = useState("");
  const [sede, setSede] = useState("");
  const [options, setOptions] = useState<{ sedes: { id: string; name: string }[]; types: string[] }>({ sedes: [], types: [] });
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [all, setAll] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [nuevaOpen, setNuevaOpen] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [exporting, setExporting] = useState(false);

  const reloadStats = useCallback(() => { void authFetch("/support/stats").then((r) => r.json()).then(setStats).catch(() => {}); }, [authFetch]);
  useEffect(() => { if (!authLoading) reloadStats(); }, [authLoading, reloadStats]);
  useEffect(() => { if (!authLoading) void authFetch("/support/filter-options").then((r) => r.json()).then(setOptions).catch(() => {}); }, [authLoading, authFetch]);

  // Carga con cancelación: al teclear se aborta la petición en vuelo, para que
  // una respuesta lenta no pise a otra más nueva. Ver lib/useRequest.
  // Pagina en el servidor: el orden viaja en la query.
  const orden = useOrden();

  const { data, cargando: loading, error, refrescar: load } = useRequest<Paged<TicketRow>>(
    () => {
      const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize), ...orden.params });
      if (search.trim()) qs.set("search", search.trim());
      if (status) qs.set("status", status);
      if (type) qs.set("type", type);
      if (tec) qs.set("tec", tec);
      if (priority) qs.set("priority", priority);
      if (sede) qs.set("sede", sede);
      if (all) qs.set("all", "1");
      else { if (from) qs.set("from", from); if (to) qs.set("to", to); }
      return `/support/tickets?${qs}`;
    },
    [page, pageSize, search, status, type, tec, priority, sede, from, to, all, orden.clave],
    { debounceMs: search ? 350 : 0, saltar: authLoading },
  );

  useEffect(() => { setPage(1); }, [search, status, type, tec, priority, sede, from, to, all, pageSize, orden.clave]);

  const activeFilters = useMemo(
    () => [search.trim(), status, type, tec, priority, sede, from, to].filter(Boolean).length + (all ? 1 : 0),
    [search, status, type, tec, priority, sede, from, to, all],
  );
  // El botón "Filtros" abre el modal de fechas → su badge cuenta el periodo.
  const dateFilters = useMemo(
    () => [from, to].filter(Boolean).length + (all ? 1 : 0),
    [from, to, all],
  );
  const clearAll = () => { setSearch(""); setStatus(""); setType(""); setTec(""); setPriority(""); setSede(""); setFrom(""); setTo(""); setAll(false); };

  /** Descarga el Excel con los MISMOS filtros que están puestos en pantalla. */
  const exportar = async () => {
    setExporting(true);
    try {
      const qs = new URLSearchParams();
      if (search.trim()) qs.set("search", search.trim());
      if (status) qs.set("status", status);
      if (type) qs.set("type", type);
      if (tec) qs.set("tec", tec);
      if (priority) qs.set("priority", priority);
      if (sede) qs.set("sede", sede);
      if (all) qs.set("all", "1");
      else { if (from) qs.set("from", from); if (to) qs.set("to", to); }
      const res = await authFetch(`/support/tickets/export.xlsx?${qs.toString()}`);
      if (!res.ok) throw new Error("No se pudo exportar");
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `ordenes-soporte-${new Date().toISOString().slice(0, 10)}.xlsx`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) { toast(mensajeDeError(e), "alert-triangle"); } finally { setExporting(false); }
  };

  if (authLoading) return <PageSkeleton />;

  return (
    <>
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <PageHeading icon="headphones" title="Soporte" subtitle="Órdenes de trabajo, instalaciones, cortes y reconexiones" />
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" onClick={exportar} disabled={exporting}>
            <Icon name={exporting ? "loader" : "download"} size={14} className={exporting ? "animate-spin" : ""} /> {exporting ? "Exportando…" : "Exportar Excel"}
          </Button>
          <Button size="sm" onClick={() => setNuevaOpen(true)}><Icon name="plus" size={14} /> Nueva orden</Button>
        </div>
      </div>

      <NuevaOrdenModal open={nuevaOpen} onClose={() => setNuevaOpen(false)} onDone={() => { void load(); reloadStats(); }} />

      {/* Buscador + filtros + tabla agrupados con poco espacio entre sí */}
      <div className="flex flex-col gap-2.5">
      {/* Barra de filtros al ancho completo de la tabla */}
      <ListToolbar search={search} onSearch={setSearch} searchPlaceholder="Buscar orden, usuario o técnico…">
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-auto">
          <option value="">Todos los estados</option>
          {Object.entries(TICKET_STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
        <Select value={tec} onChange={(e) => setTec(e.target.value)} className="w-auto">
          <option value="">Todos los técnicos</option>
          <option value="__none__">— Sin asignar —</option>
          {(stats?.topTechs ?? []).map((t) => <option key={t.tec} value={t.tec}>{t.tec}</option>)}
        </Select>
        <Select value={type} onChange={(e) => setType(e.target.value)} className="w-auto">
          <option value="">Todos los detalles</option>
          {TICKET_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </Select>
        {/* Quien está acotado a su sede no elige sede: sus órdenes ya vienen filtradas. */}
        {!sedeScoped && (
          <Select value={sede} onChange={(e) => setSede(e.target.value)} className="w-auto">
            <option value="">Todas las sedes</option>
            {options.sedes.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        )}
        <Select value={priority} onChange={(e) => setPriority(e.target.value)} className="w-auto">
          <option value="">Toda prioridad</option>
          {TICKET_PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
        </Select>
        <button onClick={() => setShowFilters(true)} className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-[12px] font-semibold transition-colors ${dateFilters > 0 ? "border-brand bg-brand-soft text-brand" : "border-border-default bg-surface text-text-secondary hover:bg-surface-2"}`}>
          <Icon name="calendar" size={14} /> Fechas{dateFilters > 0 ? ` (${dateFilters})` : ""}
        </button>
        {activeFilters > 0 && (
          <button onClick={clearAll} className="inline-flex items-center gap-1 rounded-lg border border-border-default px-2.5 py-2 text-[12px] font-semibold text-text-secondary hover:bg-surface-2">
            <Icon name="x" size={13} /> Limpiar ({activeFilters})
          </button>
        )}
      </ListToolbar>

      {/* Modal de filtros por fecha */}
      <Modal open={showFilters} onClose={() => setShowFilters(false)} title="Filtrar por fecha" maxWidth="max-w-lg">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[12px] font-medium text-text-tertiary">Periodo:</span>
            <Input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setAll(false); }} disabled={all} className="w-auto" />
            <span className="text-text-tertiary">→</span>
            <Input type="date" value={to} onChange={(e) => { setTo(e.target.value); setAll(false); }} disabled={all} className="w-auto" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {datePresets().map((p) => (
              <button key={p.label} onClick={() => { setFrom(p.from); setTo(p.to); setAll(false); }} className="rounded-lg border border-border-subtle bg-surface px-2.5 py-1.5 text-[12px] font-medium text-text-secondary hover:bg-surface-2">{p.label}</button>
            ))}
            <button onClick={() => setAll((a) => !a)} className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-[12px] font-semibold transition-colors ${all ? "border-brand bg-brand-soft text-brand" : "border-border-subtle bg-surface text-text-secondary hover:bg-surface-2"}`}>
              <Icon name="history" size={13} /> Histórico completo
            </button>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            {dateFilters > 0 && <Button variant="ghost" size="sm" onClick={() => { setFrom(""); setTo(""); setAll(false); }}>Quitar fechas</Button>}
            <Button variant="primary" size="sm" onClick={() => setShowFilters(false)}>Aplicar</Button>
          </div>
        </div>
      </Modal>

      {loading && !data ? <PageSkeleton /> : (
        <div>
          <DataTable rows={data?.items ?? []} empty="No se encontraron órdenes con estos filtros." onRowClick={(r) => router.push(`/soporte/${r.id}`)} sort={orden.sort} onSort={orden.onSort} columns={[
            { key: "code", header: "N°", sortable: true, render: (r) => <span className="font-mono text-text-secondary">{r.code ?? r.legacyId}</span> },
            { key: "priority", header: "Prioridad", sortable: true, render: (r) => r.priority ? <Badge label={r.priority} tone={TICKET_PRIORITY_TONE[r.priority] ?? "default"} /> : <span className="text-text-tertiary">—</span> },
            { key: "orden", header: "Orden", sortable: true, render: (r) => (
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-[11px] text-text-tertiary" title={r.subject}>{r.subject || r.type}</span>
                <span className="truncate font-medium text-text-primary">{r.type}</span>
              </div>
            ) },
            { key: "description", header: "Descripción", sortable: true, render: (r) => (
              <span className="block max-w-[280px] truncate text-[12px] text-text-secondary" title={r.description ?? undefined}>{r.description || "—"}</span>
            ) },
            { key: "client", header: "Usuario", sortable: true, render: (r) => r.subscriberId ? <Link href={`/clientes/${r.subscriberId}`} className="text-brand hover:underline" onClick={(e) => e.stopPropagation()}>{r.client}</Link> : <span className="text-text-secondary">{r.client ?? "—"}</span> },
            { key: "sede", header: "Sede", sortable: true, render: (r) => <span className="text-[12px] text-text-secondary">{r.sede ?? "—"}</span> },
            { key: "barrio", header: "Barrio", render: (r) => <span className="text-[12px] text-text-secondary">{r.barrio ?? "—"}</span> },
            { key: "tec", header: "Técnico", sortable: true, render: (r) => <TecChip name={r.assigned} /> },
            { key: "created", header: "Creada", sortable: true, render: (r) => <span className="whitespace-nowrap text-[12px] text-text-secondary">{new Date(r.created).toLocaleDateString("es-CO")}</span> },
            { key: "status", header: "Estado", sortable: true, render: (r) => <Badge label={TICKET_STATUS_LABEL[r.status] ?? r.status} tone={TICKET_STATUS_TONE[r.status] ?? "default"} /> },
          ]} />
          {data && <div className="mt-3"><Pagination meta={{ page: data.page, pageSize: data.pageSize, total: data.total, pageCount: data.pages }} onPage={setPage} onPageSize={setPageSize} /></div>}
        </div>
      )}
      </div>
    </>
  );
}
