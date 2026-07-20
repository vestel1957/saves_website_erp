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
import { Pagination } from "@/components/ui/Pagination";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { Modal } from "@/components/Modal";
import { NuevaOrdenModal } from "@/components/soporte/NuevaOrdenModal";
import { useAuth } from "@/context/AuthProvider";
import { type Paged, type TicketRow, type SupportStats, TICKET_STATUS_LABEL, TICKET_STATUS_TONE, TICKET_TYPES, TICKET_PRIORITIES, TICKET_PRIORITY_TONE } from "@/lib/support";

/** Chip de técnico: inicial en círculo + nombre. Da identidad visual a la columna. */
function TecChip({ name }: { name: string | null }) {
  if (!name || !name.trim()) return <span className="text-[12px] text-text-tertiary">Sin asignar</span>;
  const initials = name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  // Color estable derivado del nombre (matiz determinístico).
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white" style={{ background: `hsl(${h} 55% 45%)` }}>{initials}</span>
      <span className="truncate text-[12px] font-medium text-text-primary">{name}</span>
    </span>
  );
}

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

export default function SoportePage() {
  const router = useRouter();
  const { loading: authLoading, authFetch } = useAuth();
  const [stats, setStats] = useState<SupportStats | null>(null);
  const [data, setData] = useState<Paged<TicketRow> | null>(null);
  const [loading, setLoading] = useState(true);
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

  const reloadStats = useCallback(() => { void authFetch("/support/stats").then((r) => r.json()).then(setStats).catch(() => {}); }, [authFetch]);
  useEffect(() => { if (!authLoading) reloadStats(); }, [authLoading, reloadStats]);
  useEffect(() => { if (!authLoading) void authFetch("/support/filter-options").then((r) => r.json()).then(setOptions).catch(() => {}); }, [authLoading, authFetch]);

  const load = useCallback(async () => {
    setLoading(true);
    const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (search.trim()) qs.set("search", search.trim());
    if (status) qs.set("status", status);
    if (type) qs.set("type", type);
    if (tec) qs.set("tec", tec);
    if (priority) qs.set("priority", priority);
    if (sede) qs.set("sede", sede);
    if (all) qs.set("all", "1");
    else { if (from) qs.set("from", from); if (to) qs.set("to", to); }
    try { setData(await (await authFetch(`/support/tickets?${qs}`)).json()); } finally { setLoading(false); }
  }, [authFetch, page, pageSize, search, status, type, tec, priority, sede, from, to, all]);

  useEffect(() => { if (!authLoading) { const t = setTimeout(load, search ? 350 : 0); return () => clearTimeout(t); } }, [authLoading, load]);
  useEffect(() => { setPage(1); }, [search, status, type, tec, priority, sede, from, to, all, pageSize]);

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

  if (authLoading) return <PageSkeleton />;

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <PageHeading icon="headphones" title="Soporte" subtitle="Órdenes de trabajo, instalaciones, cortes y reconexiones" />
        <Button size="sm" onClick={() => setNuevaOpen(true)}><Icon name="plus" size={14} /> Nueva orden</Button>
      </div>

      <NuevaOrdenModal open={nuevaOpen} onClose={() => setNuevaOpen(false)} onDone={() => { void load(); reloadStats(); }} />

      {/* Buscador + filtros + tabla agrupados con poco espacio entre sí */}
      <div className="flex flex-col gap-2.5">
      {/* Barra de filtros al ancho completo de la tabla */}
      <div className="flex w-full flex-wrap items-center gap-2">
        <div className="relative min-w-[240px] flex-1">
          <Icon name="search" size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
          <Input className="pl-9" placeholder="Buscar orden, usuario o técnico…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
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
        <Select value={sede} onChange={(e) => setSede(e.target.value)} className="w-auto">
          <option value="">Todas las sedes</option>
          {options.sedes.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
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
      </div>

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
          <div className="mb-2 flex items-center justify-between gap-2 text-[12px] text-text-tertiary">
            <span>{(data?.total ?? 0).toLocaleString("es-CO")} órdenes {all ? "(histórico completo)" : from || to ? "en el periodo" : `de ${new Date().getFullYear()}`}</span>
            <span className="flex items-center gap-1.5">Ver
              <Select value={String(pageSize)} onChange={(e) => setPageSize(Number(e.target.value))} className="w-auto py-1 text-[12px]">
                {[25, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}
              </Select>
            </span>
          </div>
          <DataTable autoHeight rows={data?.items ?? []} empty="No se encontraron órdenes con estos filtros." onRowClick={(r) => router.push(`/soporte/${r.id}`)} columns={[
            { key: "code", header: "N°", render: (r) => <span className="font-mono text-text-secondary">{r.code ?? r.legacyId}</span> },
            { key: "priority", header: "Prioridad", render: (r) => r.priority ? <Badge label={r.priority} tone={TICKET_PRIORITY_TONE[r.priority] ?? "default"} /> : <span className="text-text-tertiary">—</span> },
            { key: "orden", header: "Orden", render: (r) => (
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-[11px] text-text-tertiary" title={r.subject}>{r.subject || r.type}</span>
                <span className="truncate font-medium text-text-primary">{r.type}</span>
              </div>
            ) },
            { key: "description", header: "Descripción", render: (r) => (
              <span className="block max-w-[280px] truncate text-[12px] text-text-secondary" title={r.description ?? undefined}>{r.description || "—"}</span>
            ) },
            { key: "client", header: "Usuario", render: (r) => r.subscriberId ? <Link href={`/clientes/${r.subscriberId}`} className="text-brand hover:underline" onClick={(e) => e.stopPropagation()}>{r.client}</Link> : <span className="text-text-secondary">{r.client ?? "—"}</span> },
            { key: "sede", header: "Sede", render: (r) => <span className="text-[12px] text-text-secondary">{r.sede ?? "—"}</span> },
            { key: "barrio", header: "Barrio", render: (r) => <span className="text-[12px] text-text-secondary">{r.barrio ?? "—"}</span> },
            { key: "tec", header: "Técnico", render: (r) => <TecChip name={r.assigned} /> },
            { key: "created", header: "Creada", render: (r) => <span className="whitespace-nowrap text-[12px] text-text-secondary">{new Date(r.created).toLocaleDateString("es-CO")}</span> },
            { key: "status", header: "Estado", render: (r) => <Badge label={TICKET_STATUS_LABEL[r.status] ?? r.status} tone={TICKET_STATUS_TONE[r.status] ?? "default"} /> },
          ]} />
          {data && data.pages > 1 && <div className="mt-3"><Pagination meta={{ page: data.page, pageSize: data.pageSize, total: data.total, pageCount: data.pages }} onPage={setPage} onPageSize={setPageSize} /></div>}
        </div>
      )}
      </div>
    </>
  );
}
