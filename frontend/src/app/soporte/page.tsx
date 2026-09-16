"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { DataTable } from "@/components/ui/DataTable";
import { Badge } from "@/components/ui/Badge";
import { Input } from "@/components/ui/Field";
import { MultiSelect } from "@/components/ui/MultiSelect";
import { Button } from "@/components/ui/Button";
import { ListToolbar } from "@/components/ui/ListToolbar";
import { Pagination } from "@/components/ui/Pagination";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { Modal } from "@/components/Modal";
import { NuevaOrdenModal } from "@/components/soporte/NuevaOrdenModal";
import { TecChip } from "@/components/soporte/TecChip";
import { TarjetaOrden } from "@/components/soporte/TarjetaOrden";
import { ChipServicio } from "@/components/soporte/ChipServicio";
import { MisOrdenes } from "@/components/soporte/MisOrdenes";
import { AvisoTurno } from "@/components/soporte/AvisoTurno";
import { useAuth } from "@/context/AuthProvider";
import { esTecnico, puedeEditarOrdenes, type Paged, type TicketRow, type SupportStats, SERVICIO_CONTRATADO, SERVICIOS_CONTRATADOS, TICKET_STATUS_LABEL, TICKET_STATUS_TONE, TICKET_TYPES, TICKET_PRIORITIES, TICKET_PRIORITY_TONE } from "@/lib/support";
import { useRequest } from "@/lib/useRequest";
import { useOrden } from "@/lib/useOrden";
import { ordenDeTexto, useFiltrosEnUrl, useFiltrosRecordados } from "@/lib/useFiltrosUrl";
import { toast } from "@/components/ui/Toast";
import { mensajeDeError, objetoJson } from "@/lib/errores";

/** Un filtro múltiple tal como viaja en la URL: "PENDIENTE,REALIZANDO" → ["PENDIENTE","REALIZANDO"]. */
const listaDeUrl = (crudo?: string): string[] => (crudo ? crudo.split(",").map((v) => v.trim()).filter(Boolean) : []);

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
  // `useFiltrosRecordados` usa `useSearchParams`, que en el App Router exige una
  // frontera de Suspense.
  return (
    <Suspense fallback={<PageSkeleton />}>
      <SoporteGeneral />
    </Suspense>
  );
}

/**
 * Resuelve con qué filtros arranca la lista antes de montarla: los de la URL o,
 * si se entró por el menú, los de la última visita. Va en un componente aparte
 * porque lo recordado sólo se conoce ya en el navegador (ver `useFiltrosRecordados`)
 * y la lista de abajo tiene que nacer con ellos puestos — no cargar primero sin
 * filtros y filtrarse después, que serían dos consultas y un parpadeo.
 */
function SoporteGeneral() {
  const inicial = useFiltrosRecordados();
  if (!inicial) return <PageSkeleton />;
  return <ListaDeOrdenes urlInicial={inicial.valores} recordado={inicial.recordado} />;
}

function ListaDeOrdenes({ urlInicial, recordado }: { urlInicial: Record<string, string>; recordado: boolean }) {
  const { loading: authLoading, authFetch, user, sedeScoped } = useAuth();
  const [stats, setStats] = useState<SupportStats | null>(null);
  const [search, setSearch] = useState(urlInicial.q ?? "");
  // Los filtros de la barra son de selección MÚLTIPLE: son listas, y en la URL (y
  // hacia la API) viajan en el mismo parámetro de siempre separadas por comas.
  const [status, setStatus] = useState(listaDeUrl(urlInicial.estado));
  const [type, setType] = useState(listaDeUrl(urlInicial.detalle));
  // El SERVICIO es el filtro grueso del que cuelga el detalle: 'Reconexion
  // Television', 'Reconexion Television2' y 'Suspension Television' son tres
  // entradas del desplegable de detalles y un solo trabajo para quien reparte.
  const [servicio, setServicio] = useState(listaDeUrl(urlInicial.servicio));
  const [tec, setTec] = useState(listaDeUrl(urlInicial.tec));
  const [priority, setPriority] = useState(listaDeUrl(urlInicial.prioridad));
  const [sede, setSede] = useState(listaDeUrl(urlInicial.sede));
  const [options, setOptions] = useState<{ sedes: { id: string; name: string }[]; types: string[] }>({ sedes: [], types: [] });
  const [from, setFrom] = useState(urlInicial.desde ?? "");
  const [to, setTo] = useState(urlInicial.hasta ?? "");
  const [all, setAll] = useState(urlInicial.todo === "1");
  const [page, setPage] = useState(Number(urlInicial.pag) > 1 ? Number(urlInicial.pag) : 1);
  const [pageSize, setPageSize] = useState(Number(urlInicial.tam) > 0 ? Number(urlInicial.tam) : 25);
  const [nuevaOpen, setNuevaOpen] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [exporting, setExporting] = useState(false);
  const puedeEscribir = puedeEditarOrdenes(user);

  // Los filtros múltiples ya escritos como viajan (coma). Se calculan una vez y se
  // usan tanto en la petición como en las dependencias: un array es nuevo en cada
  // render y compararlo por referencia dispararía la carga sin parar.
  const kStatus = status.join(","), kType = type.join(","), kTec = tec.join(",");
  const kPriority = priority.join(","), kSede = sede.join(","), kServicio = servicio.join(",");

  const reloadStats = useCallback(() => { void authFetch("/support/stats").then(objetoJson).then(setStats).catch(() => {}); }, [authFetch]);
  useEffect(() => { if (!authLoading) reloadStats(); }, [authLoading, reloadStats]);
  useEffect(() => { if (!authLoading) void authFetch("/support/filter-options").then(objetoJson).then(setOptions).catch(() => {}); }, [authLoading, authFetch]);

  // Carga con cancelación: al teclear se aborta la petición en vuelo, para que
  // una respuesta lenta no pise a otra más nueva. Ver lib/useRequest.
  // Pagina en el servidor: el orden viaja en la query.
  const orden = useOrden(ordenDeTexto(urlInicial.ord));

  const { data, cargando: loading, error, refrescar: load } = useRequest<Paged<TicketRow>>(
    () => {
      const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize), ...orden.params });
      if (search.trim()) qs.set("search", search.trim());
      if (kStatus) qs.set("status", kStatus);
      if (kType) qs.set("type", kType);
      if (kServicio) qs.set("servicio", kServicio);
      if (kTec) qs.set("tec", kTec);
      if (kPriority) qs.set("priority", kPriority);
      if (kSede) qs.set("sede", kSede);
      if (all) qs.set("all", "1");
      else { if (from) qs.set("from", from); if (to) qs.set("to", to); }
      return `/support/tickets?${qs}`;
    },
    [page, pageSize, search, kStatus, kType, kServicio, kTec, kPriority, kSede, from, to, all, orden.clave],
    { debounceMs: search ? 350 : 0, saltar: authLoading },
  );

  // Cambiar un filtro manda a la página 1 — pero no en el primer render, que
  // borraría la página que venía en la URL.
  const primerRender = useRef(true);
  useEffect(() => {
    if (primerRender.current) { primerRender.current = false; return; }
    setPage(1);
  }, [search, kStatus, kType, kServicio, kTec, kPriority, kSede, from, to, all, pageSize, orden.clave]);

  // Y de vuelta: lo que está puesto en pantalla se refleja en la dirección.
  useFiltrosEnUrl({
    q: search.trim(), estado: kStatus, detalle: kType, servicio: kServicio, tec: kTec, prioridad: kPriority, sede: kSede,
    desde: all ? "" : from, hasta: all ? "" : to, todo: all ? "1" : "",
    pag: page > 1 ? page : "", tam: pageSize !== 25 ? pageSize : "", ord: orden.clave,
  });

  // Cuenta FILTROS puestos, no valores elegidos: tres estados marcados son un solo
  // filtro de estado, y "Limpiar (7)" no querría decir nada.
  const activeFilters = useMemo(
    () => [search.trim(), from, to].filter(Boolean).length
      + [status, type, servicio, tec, priority, sede].filter((f) => f.length > 0).length
      + (all ? 1 : 0),
    [search, status, type, servicio, tec, priority, sede, from, to, all],
  );
  // El botón "Filtros" abre el modal de fechas → su badge cuenta el periodo.
  const dateFilters = useMemo(
    () => [from, to].filter(Boolean).length + (all ? 1 : 0),
    [from, to, all],
  );
  const clearAll = () => { setSearch(""); setStatus([]); setType([]); setServicio([]); setTec([]); setPriority([]); setSede([]); setFrom(""); setTo(""); setAll(false); };

  /** Descarga el Excel con los MISMOS filtros que están puestos en pantalla. */
  const exportar = async () => {
    setExporting(true);
    try {
      const qs = new URLSearchParams();
      if (search.trim()) qs.set("search", search.trim());
      if (kStatus) qs.set("status", kStatus);
      if (kType) qs.set("type", kType);
      if (kServicio) qs.set("servicio", kServicio);
      if (kTec) qs.set("tec", kTec);
      if (kPriority) qs.set("priority", kPriority);
      if (kSede) qs.set("sede", kSede);
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
          {/* Quien solo consulta se lleva la lista y el Excel; abrir órdenes es
              de quien las trabaja (`support.write`). */}
          {puedeEscribir && <Button size="sm" onClick={() => setNuevaOpen(true)}><Icon name="plus" size={14} /> Nueva orden</Button>}
        </div>
      </div>

      {puedeEscribir && <NuevaOrdenModal open={nuevaOpen} onClose={() => setNuevaOpen(false)} onDone={() => { void load(); reloadStats(); }} />}

      {/* "Una orden a la vez" también aquí: con una orden EMPEZADA encima no se puede
          empezar otra (lo demás de la lista sí se abre y se trabaja, 2026-09-10). Se
          avisa arriba para que el bloqueo no se descubra al pulsar "Empezar". Calla
          solo cuando no hay ninguna empezada — y para casi todo el mundo calla
          siempre: fuera del técnico de campo hace falta `UNA_ORDEN_A_LA_VEZ`. */}
      <div className="mb-2.5">
        <AvisoTurno />
      </div>

      {/* Buscador + filtros + tabla agrupados con poco espacio entre sí */}
      <div className="flex flex-col gap-2.5">
      {/* Barra de filtros al ancho completo de la tabla */}
      <ListToolbar search={search} onSearch={setSearch} searchPlaceholder="Buscar orden, usuario o técnico…">
        <MultiSelect
          label="Estado" todos="Todos los estados" value={status} onChange={setStatus}
          options={Object.entries(TICKET_STATUS_LABEL).map(([value, label]) => ({ value, label }))}
        />
        <MultiSelect
          label="Técnicos" todos="Todos los técnicos" value={tec} onChange={setTec} width={280}
          options={[{ value: "__none__", label: "— Sin asignar —" }, ...(stats?.topTechs ?? []).map((t) => ({ value: t.tec, label: t.tec }))]}
        />
        <MultiSelect
          label="Servicio" todos="Todo servicio" value={servicio} onChange={setServicio}
          options={SERVICIOS_CONTRATADOS.map((s) => ({ value: s, label: SERVICIO_CONTRATADO[s].label }))}
        />
        <MultiSelect
          label="Detalles" todos="Todos los detalles" value={type} onChange={setType} width={280}
          options={TICKET_TYPES.map((t) => ({ value: t, label: t }))}
        />
        {/* Quien está acotado a su sede no elige sede: sus órdenes ya vienen filtradas. */}
        {!sedeScoped && (
          <MultiSelect
            label="Sedes" todos="Todas las sedes" value={sede} onChange={setSede}
            options={options.sedes.map((s) => ({ value: s.id, label: s.name }))}
          />
        )}
        <MultiSelect
          label="Prioridad" todos="Toda prioridad" value={priority} onChange={setPriority}
          options={TICKET_PRIORITIES.map((p) => ({ value: p, label: p }))}
        />
        <button onClick={() => setShowFilters(true)} className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-[12px] font-semibold transition-colors ${dateFilters > 0 ? "border-brand bg-brand-soft text-brand" : "border-border-default bg-surface text-text-secondary hover:bg-surface-2"}`}>
          <Icon name="calendar" size={14} /> Fechas{dateFilters > 0 ? ` (${dateFilters})` : ""}
        </button>
        {activeFilters > 0 && (
          <button onClick={clearAll} className="inline-flex items-center gap-1 rounded-lg border border-border-default px-2.5 py-2 text-[12px] font-semibold text-text-secondary hover:bg-surface-2">
            <Icon name="x" size={13} /> Limpiar ({activeFilters})
          </button>
        )}
      </ListToolbar>

      {/* Al entrar por el menú los filtros vuelven puestos: hay que DECIRLO. Sin
          este renglón, una lista corta (o vacía) parece un sistema roto y no una
          lista filtrada, y el usuario no tiene por qué acordarse de lo que dejó
          puesto la semana pasada. */}
      {recordado && activeFilters > 0 && (
        <p className="-mt-1 flex flex-wrap items-center gap-1.5 text-[12px] text-text-tertiary">
          <Icon name="history" size={13} />
          Se aplicaron los filtros de tu última visita.
          <button onClick={clearAll} className="font-semibold text-brand hover:underline">Ver todas las órdenes</button>
        </p>
      )}

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
          {/* `cardRender`: en móvil la fila se dibuja como tarjeta de orden y no
              como los diez renglones etiqueta/valor que salen de las columnas.
              Ver `TarjetaOrden`. */}
          <DataTable rows={data?.items ?? []} empty="No se encontraron órdenes con estos filtros." rowHref={(r) => `/soporte/${r.id}`} sort={orden.sort} onSort={orden.onSort} cardRender={(r) => <TarjetaOrden r={r} />} columns={[
            { key: "code", header: "N°", sortable: true, render: (r) => (
              // Enlace de verdad: se puede abrir en pestaña nueva, copiar la
              // dirección y ver a dónde lleva antes de pulsar.
              <Link href={`/soporte/${r.id}`} onClick={(e) => e.stopPropagation()} className="font-mono text-text-secondary hover:text-brand hover:underline">{r.code ?? r.legacyId}</Link>
            ) },
            { key: "priority", header: "Prioridad", sortable: true, render: (r) => r.priority ? <Badge label={r.priority} tone={TICKET_PRIORITY_TONE[r.priority] ?? "default"} /> : <span className="text-text-tertiary">—</span> },
            { key: "orden", header: "Orden", sortable: true, render: (r) => (
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-[11px] text-text-tertiary" title={r.subject}>{r.subject || r.type}</span>
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate font-medium text-text-primary">{r.type}</span>
                  <ChipServicio servicio={r.servicio} />
                </span>
              </div>
            ) },
            { key: "description", header: "Descripción", sortable: true, render: (r) => (
              <span className="block max-w-[280px] truncate text-[12px] text-text-secondary" title={r.description ?? undefined}>{r.description || "—"}</span>
            ) },
            { key: "client", header: "Usuario", sortable: true, render: (r) => r.subscriberId ? <Link href={`/clientes/${r.subscriberId}`} className="text-brand hover:underline" onClick={(e) => e.stopPropagation()}>{r.client}</Link> : <span className="text-text-secondary">{r.client ?? "—"}</span> },
            { key: "sede", header: "Sede", sortable: true, render: (r) => <span className="text-[12px] text-text-secondary">{r.sede ?? "—"}</span> },
            { key: "barrio", header: "Barrio", render: (r) => <span className="text-[12px] text-text-secondary">{r.barrio ?? "—"}</span> },
            { key: "tec", header: "Técnico", sortable: true, render: (r) => <TecChip name={r.assigned} /> },
            // La fecha y QUIÉN la generó van juntas: son la misma pregunta ("de
            // dónde salió esta orden") y así no se le añade una columna a una tabla
            // que ya tiene nueve. Las heredadas del legacy que nacieron sin autor no
            // muestran renglón, en vez de un "—" repetido 135.000 veces.
            { key: "created", header: "Creada", sortable: true, render: (r) => (
              <div className="flex min-w-0 flex-col">
                <span className="whitespace-nowrap text-[12px] text-text-secondary">{new Date(r.created).toLocaleDateString("es-CO")}</span>
                {r.generadaPor && <span className="max-w-[140px] truncate text-[11px] text-text-tertiary" title={`Generada por ${r.generadaPor}`}>por {r.generadaPor}</span>}
              </div>
            ) },
            { key: "status", header: "Estado", sortable: true, render: (r) => <Badge label={TICKET_STATUS_LABEL[r.status] ?? r.status} tone={TICKET_STATUS_TONE[r.status] ?? "default"} /> },
          ]} />
          {data && <div className="mt-3"><Pagination meta={{ page: data.page, pageSize: data.pageSize, total: data.total, pageCount: data.pages }} onPage={setPage} onPageSize={setPageSize} /></div>}
        </div>
      )}
      </div>
    </>
  );
}
