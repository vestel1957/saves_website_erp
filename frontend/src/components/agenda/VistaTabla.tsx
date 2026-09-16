"use client";

import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { Input, Select, Field } from "@/components/ui/Field";
import { DataTable } from "@/components/ui/DataTable";
import { ListToolbar } from "@/components/ui/ListToolbar";
import { Pagination } from "@/components/ui/Pagination";
import { LoadError } from "@/components/ui/LoadError";
import { useAuth } from "@/context/AuthProvider";
import { useRequest } from "@/lib/useRequest";
import { useOrden } from "@/lib/useOrden";
import { TICKET_PRIORITIES, TICKET_PRIORITY_TONE } from "@/lib/support";
import { TONOS_BADGE as TONO_BADGE } from "@/components/ui/Badge";
import { colorDe, type Evento } from "./calendario";

const fechaCorta = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("es-CO", { day: "2-digit", month: "short", year: "numeric" }) : "—";

/**
 * Los filtros de la vista, en un solo objeto.
 *
 * Van juntos a propósito: son la dependencia de la carga y lo que hay que vaciar
 * al pulsar "Limpiar". Sueltos en cinco `useState` había que acordarse de tocar
 * los cinco en los tres sitios, que es como se quedan filtros huérfanos que la
 * tabla aplica y el botón de limpiar no.
 */
type Filtros = { search: string; from: string; to: string; priority: string; assignedBy: string };
const SIN_FILTROS: Filtros = { search: "", from: "", to: "", priority: "", assignedBy: "" };
const cuantosFiltros = (f: Filtros) => Object.values(f).filter((v) => v.trim() !== "").length;

/** `YYYY-MM-DD` de un `Date`, leído en Colombia — la misma zona que usa el backend. */
const diaISO = (d: Date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

/**
 * Atajos del rango. La agenda arrastra cinco años de eventos: escribir dos fechas a
 * mano para ver "lo de este mes" es el paso que hace que nadie use el filtro.
 */
const ATAJOS: { etiqueta: string; rango: () => { from: string; to: string } }[] = [
  { etiqueta: "Hoy", rango: () => { const h = diaISO(new Date()); return { from: h, to: h }; } },
  {
    etiqueta: "Últimos 7 días",
    rango: () => ({ from: diaISO(new Date(Date.now() - 6 * 86400000)), to: diaISO(new Date()) }),
  },
  {
    etiqueta: "Este mes",
    rango: () => { const h = diaISO(new Date()); return { from: `${h.slice(0, 7)}-01`, to: h }; },
  },
  {
    etiqueta: "Este año",
    rango: () => { const h = diaISO(new Date()); return { from: `${h.slice(0, 4)}-01-01`, to: h }; },
  },
];

/**
 * La agenda como TABLA: buscar, ordenar y paginar sobre los 131.913 eventos.
 *
 * Es la otra mitad del módulo, y no sobra con el calendario al lado: la rejilla
 * responde «qué hay esta semana» y para eso no tiene rival, pero no sabe responder
 * «cuándo fue la última visita a este cliente» ni «cuántos eventos urgentes puso
 * fulano el año pasado». Eso es una consulta sobre todo el histórico, con orden y
 * páginas, y así se lee.
 *
 * Estaba escrita en `app/agenda/page.tsx` antes de que la pantalla tuviera vistas
 * (2026-09-10): se mudó tal cual, quitándole el encabezado y el formulario de evento
 * —que ahora los pone la página y los comparten las cuatro vistas—.
 */
export function VistaTabla({
  recarga,
  onAbrir,
}: {
  /** Cambia cuando se guarda o borra un evento desde el modal compartido. */
  recarga: number;
  onAbrir: (evento: Evento) => void;
}) {
  const { loading: authLoading, authFetch } = useAuth();

  const [filtros, setFiltros] = useState<Filtros>(SIN_FILTROS);
  const set = <K extends keyof Filtros>(k: K, v: Filtros[K]) => setFiltros((f) => ({ ...f, [k]: v }));
  const [panelAbierto, setPanelAbierto] = useState(false);

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  // Pagina en el servidor: el orden viaja en la query.
  const orden = useOrden({ by: "start", dir: "desc" });

  // Los filtros se aplican solos al cambiarlos (con debounce en el buscador, que se
  // teclea letra a letra). No hay botón "Filtrar": una tabla que ya cambió y un botón
  // que sigue ahí hacen dudar de si el filtro llegó a aplicarse.
  const qsFiltros = useMemo(() => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(filtros)) if (v.trim()) qs.set(k, v.trim());
    return qs.toString();
  }, [filtros]);

  const { data, cargando, error, refrescar } = useRequest<any>(
    () => {
      const qs = new URLSearchParams(qsFiltros);
      qs.set("page", String(page));
      qs.set("pageSize", String(pageSize));
      for (const [k, v] of Object.entries(orden.params)) qs.set(k, v);
      return `/omni/events?${qs}`;
    },
    [qsFiltros, page, pageSize, orden.clave, recarga],
    { debounceMs: filtros.search ? 350 : 0, saltar: authLoading },
  );

  // Las cifras de arriba miran EXACTAMENTE los mismos filtros que la tabla.
  const { data: stats } = useRequest<any>(
    () => `/omni/events/stats${qsFiltros ? `?${qsFiltros}` : ""}`,
    [qsFiltros, recarga],
    { debounceMs: filtros.search ? 350 : 0, saltar: authLoading },
  );

  // Opciones de los desplegables: quién aparece de verdad en los eventos.
  const [opciones, setOpciones] = useState<{ asignadores: { id: string; nombre: string; total: number }[]; sinAsignar: number }>({ asignadores: [], sinAsignar: 0 });
  useEffect(() => {
    if (authLoading) return;
    void authFetch("/omni/events/filters")
      .then((r) => r.json())
      .then((o) => setOpciones({ asignadores: o?.asignadores ?? [], sinAsignar: o?.sinAsignar ?? 0 }))
      .catch(() => {});
  }, [authLoading, authFetch]);

  // Cambiar cualquier filtro vuelve a la página 1: mantener la página vieja sobre un
  // resultado nuevo mostraba una página que ya no existía.
  useEffect(() => { setPage(1); }, [qsFiltros, pageSize, orden.clave]);

  const rows: Evento[] = data?.items ?? [];
  const total: number = data?.total ?? 0;
  const activos = cuantosFiltros(filtros);

  // Lo que se ve como chip con el panel cerrado. El buscador no entra: ya se lee
  // escrito en su propia caja, y repetirlo aquí sería contarlo dos veces.
  const chips = [
    filtros.from && { key: "from", etiqueta: `Desde ${filtros.from}`, quitar: () => set("from", "") },
    filtros.to && { key: "to", etiqueta: `Hasta ${filtros.to}`, quitar: () => set("to", "") },
    filtros.priority && { key: "priority", etiqueta: `Prioridad: ${filtros.priority}`, quitar: () => set("priority", "") },
    filtros.assignedBy && {
      key: "assignedBy",
      etiqueta: `Asignó: ${filtros.assignedBy === "sin" ? "sin asignar" : opciones.asignadores.find((a) => a.id === filtros.assignedBy)?.nombre ?? filtros.assignedBy}`,
      quitar: () => set("assignedBy", ""),
    },
  ].filter(Boolean) as { key: string; etiqueta: string; quitar: () => void }[];

  const columns = [
    {
      key: "start",
      sortable: true,
      header: "Inicio",
      render: (r: Evento) =>
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
      render: (r: Evento) => (
        <span className="flex items-center gap-2">
          <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: colorDe(r) }} />
          <span className="font-medium text-text-primary">{r.title || "—"}</span>
        </span>
      ),
    },
    {
      key: "description",
      sortable: true,
      header: "Descripción",
      render: (r: Evento) => <span className="text-text-secondary">{r.description || "—"}</span>,
    },
    {
      key: "priority",
      header: "Prioridad",
      render: (r: Evento) => {
        const tono = TICKET_PRIORITY_TONE[r.priority ?? ""] ?? "default";
        return <span className={`rounded-lg px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${TONO_BADGE[tono]}`}>{r.priority ?? "Media"}</span>;
      },
    },
    {
      key: "orderNo",
      sortable: true,
      header: "Orden",
      render: (r: Evento) =>
        r.orderNo ? <span className="font-mono tabular-nums text-[12px] text-text-secondary">#{r.orderNo}</span> : "—",
    },
    // Sin `sortable`: la columna guarda el id legacy y el nombre se resuelve al
    // salir, así que la flecha ordenaría por unos números que no se ven. Para eso
    // está el filtro "Asignó", que ofrece a la gente por nombre.
    { key: "assignedBy", header: "Asignó", render: (r: Evento) => r.assignedBy || "—" },
    {
      key: "actions",
      header: "",
      align: "right" as const,
      render: (r: Evento) => (
        <div className="flex justify-end">
          <button type="button" title="Abrir" onClick={() => onAbrir(r)} className="tap text-text-tertiary hover:text-brand">
            <Icon name="pencil" size={14} />
          </button>
        </div>
      ),
    },
  ];

  const cifras: { icono: string; etiqueta: string; valor: string }[] = [
    { icono: "calendar-clock", etiqueta: activos ? "Eventos filtrados" : "Total eventos", valor: (stats?.total ?? 0).toLocaleString("es-CO") },
    { icono: "receipt", etiqueta: "Con orden", valor: (stats?.conOrden ?? 0).toLocaleString("es-CO") },
    { icono: "calendar", etiqueta: "Primer evento", valor: fechaCorta(stats?.primero ?? null) },
    { icono: "activity", etiqueta: "Último evento", valor: fechaCorta(stats?.ultimo ?? null) },
  ];

  return (
    <div className="flex flex-col gap-4">
      {/* cifras: siempre sobre lo que está filtrado */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        {cifras.map((c) => (
          <div key={c.etiqueta} className="flex items-center gap-3 rounded-xl border border-border-subtle bg-surface p-4">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-soft">
              <Icon name={c.icono} size={18} className="text-brand" />
            </span>
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">{c.etiqueta}</p>
              <p className="truncate text-[16px] font-bold text-text-primary">{c.valor}</p>
            </div>
          </div>
        ))}
      </div>

      <ListToolbar
        search={filtros.search}
        onSearch={(v) => set("search", v)}
        searchPlaceholder="Buscar por título, descripción o N° de orden…"
        actions={
          data && (
            <span className="whitespace-nowrap text-[12px] text-text-tertiary">
              <span className="font-semibold text-text-secondary">{total.toLocaleString("es-CO")}</span> eventos
            </span>
          )
        }
      >
        <button
          type="button"
          onClick={() => setPanelAbierto((v) => !v)}
          className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-[12px] font-semibold transition-colors ${panelAbierto || chips.length ? "border-brand bg-brand-soft text-brand" : "border-border-default bg-surface text-text-secondary hover:bg-surface-2"}`}
        >
          <Icon name="sliders-horizontal" size={14} /> Filtros
          {chips.length > 0 && <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-brand px-1 text-[10px] font-bold text-on-brand">{chips.length}</span>}
          <Icon name={panelAbierto ? "chevron-up" : "chevron-down"} size={14} />
        </button>
      </ListToolbar>

      {/* Panel de filtros (colapsable), igual que en Facturación. */}
      {panelAbierto && (
        <div className="rounded-xl border border-border-subtle bg-surface-2 p-3">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Field label="Desde">
              <Input type="date" value={filtros.from} max={filtros.to || undefined} onChange={(e) => set("from", e.target.value)} />
            </Field>
            <Field label="Hasta">
              <Input type="date" value={filtros.to} min={filtros.from || undefined} onChange={(e) => set("to", e.target.value)} />
            </Field>
            <Field label="Prioridad">
              <Select value={filtros.priority} onChange={(e) => set("priority", e.target.value)}>
                <option value="">Todas</option>
                {TICKET_PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
              </Select>
            </Field>
            <Field label="Asignó">
              <Select value={filtros.assignedBy} onChange={(e) => set("assignedBy", e.target.value)}>
                <option value="">Todos</option>
                {opciones.asignadores.map((a) => (
                  <option key={a.id} value={a.id}>{a.nombre} ({a.total.toLocaleString("es-CO")})</option>
                ))}
                {opciones.sinAsignar > 0 && <option value="sin">Sin asignar ({opciones.sinAsignar.toLocaleString("es-CO")})</option>}
              </Select>
            </Field>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {ATAJOS.map((a) => (
              <button
                key={a.etiqueta}
                type="button"
                onClick={() => setFiltros((f) => ({ ...f, ...a.rango() }))}
                className="rounded-lg border border-border-default bg-surface px-2.5 py-1.5 text-[12px] font-medium text-text-secondary transition-colors hover:bg-surface-2"
              >
                {a.etiqueta}
              </button>
            ))}
            {activos > 0 && (
              <button
                type="button"
                onClick={() => setFiltros(SIN_FILTROS)}
                className="ml-auto rounded-lg border border-border-default bg-surface px-3 py-1.5 text-[12px] font-semibold text-text-secondary hover:bg-surface-2"
              >
                Limpiar filtros
              </button>
            )}
          </div>
        </div>
      )}

      {/* Con el panel cerrado, los filtros puestos siguen a la vista como chips:
          una tabla recortada sin nada que lo explique es lo que se lee como "no hay datos". */}
      {!panelAbierto && chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {chips.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={c.quitar}
              className="inline-flex items-center gap-1 rounded-full border border-border-subtle bg-surface px-2.5 py-1 text-[11px] font-medium text-text-secondary transition-colors hover:bg-surface-2"
            >
              {c.etiqueta} <Icon name="x" size={12} className="text-text-tertiary" />
            </button>
          ))}
          <button type="button" onClick={() => setFiltros(SIN_FILTROS)} className="px-1 text-[11px] font-semibold text-brand hover:underline">
            Limpiar todo
          </button>
        </div>
      )}

      {/* Un rango invertido o una fecha imposible los rechaza el backend: mostrarlo
          como error es lo que distingue "no hay eventos" de "el filtro está mal". */}
      {error ? (
        <LoadError message={error} onRetry={refrescar} />
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={rows}
            loading={cargando}
            empty={activos ? "Ningún evento coincide con los filtros" : "No hay eventos"}
            sort={orden.sort}
            onSort={orden.onSort}
          />

          {total > 0 && (
            <Pagination
              meta={{ page, pageSize, total, pageCount: data?.pages ?? 1 }}
              onPage={setPage}
              onPageSize={(s) => { setPageSize(s); setPage(1); }}
            />
          )}
        </>
      )}
    </div>
  );
}
