"use client";

import { useEffect, useState } from "react";
import { objetoJson } from "@/lib/errores";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { DataTable } from "@/components/ui/DataTable";
import { Badge } from "@/components/ui/Badge";
import { Pagination } from "@/components/ui/Pagination";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { LoadError } from "@/components/ui/LoadError";
import { ListToolbar } from "@/components/ui/ListToolbar";
import { Input, Select } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/Modal";
import { TecChip } from "@/components/soporte/TecChip";
import { AvisoTurno } from "@/components/soporte/AvisoTurno";
import { useAuth } from "@/context/AuthProvider";
import { useRequest } from "@/lib/useRequest";
import { useOrden } from "@/lib/useOrden";
import {
  type Paged, type TicketRow, type SupportStats,
  TICKET_STATUS_LABEL, TICKET_STATUS_TONE, TICKET_PRIORITY_TONE,
  TICKET_TYPES, TICKET_PRIORITIES,
} from "@/lib/support";

/** Atajos de periodo. `created` es una columna `date`, así que "hasta hoy" incluye hoy. */
function atajosDeFecha(): { label: string; from: string; to: string }[] {
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();
  return [
    { label: "Hoy", from: iso(new Date(y, m, d)), to: iso(new Date(y, m, d)) },
    { label: "7 días", from: iso(new Date(y, m, d - 6)), to: iso(new Date(y, m, d)) },
    { label: "Este mes", from: iso(new Date(y, m, 1)), to: iso(new Date(y, m + 1, 0)) },
    { label: "Este año", from: `${y}-01-01`, to: iso(new Date(y, m, d)) },
  ];
}

/**
 * La bandeja del técnico: SUS órdenes y nada más.
 *
 * Es una vista aparte de `/soporte` (la del resto de la empresa) y no la misma
 * pantalla con los controles escondidos. La razón es que el técnico dijo ver "todas
 * las órdenes": el backend ya le devolvía sólo las suyas —928 de 928 comprobadas—
 * pero la pantalla seguía teniendo cara de listado general (buscador, selector de
 * técnico, de sede, de fechas) y ninguna señal de que lo de abajo fuera suyo. Una
 * lista que no se puede filtrar y que dice cuántas son a tu nombre no deja lugar a
 * esa duda.
 *
 * Sin selectores a propósito: no hay filtro de técnico (sólo hay uno posible), ni de
 * sede (las suyas son de su sede), ni de fechas (se muestran TODAS las suyas, sin el
 * corte por año que sí tiene la vista general — a él no se le esconde su historia).
 * Ordenar por una columna sí se deja: ordenar no es filtrar, y "las más viejas
 * primero" es una pregunta legítima de quien va a ponerse al día.
 *
 * El BUSCADOR sí está (2026-08-03, a pedido): con cientos de órdenes a su nombre,
 * paginar hasta encontrar la del cliente que le acaba de llamar no es viable. Busca
 * DENTRO de las suyas y no puede sacarlo de ahí: el alcance va en `where.AND` del
 * servicio y el texto sólo alimenta el `OR` de la búsqueda, así que teclear no
 * destapa órdenes de otro técnico.
 *
 * El alcance real no lo pone esta pantalla: lo impone `SupportService.tickets`
 * (`soloMisOrdenes`), que además cierra el detalle por URL. Aquí no se manda ningún
 * parámetro de alcance — si esta vista se equivocara, seguiría sin ver nada ajeno.
 */
export function MisOrdenes() {
  const router = useRouter();
  const { loading: authLoading, authFetch } = useAuth();
  const [stats, setStats] = useState<SupportStats | null>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [type, setType] = useState("");
  const [priority, setPriority] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [showFechas, setShowFechas] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const orden = useOrden();

  const filtrosFecha = (from ? 1 : 0) + (to ? 1 : 0);
  const filtrosActivos = filtrosFecha + [search, status, type, priority].filter(Boolean).length;
  const limpiarTodo = () => {
    setSearch(""); setStatus(""); setType(""); setPriority(""); setFrom(""); setTo("");
  };

  const { data, cargando, error, refrescar: load } = useRequest<Paged<TicketRow>>(
    () => {
      const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize), ...orden.params });
      if (search.trim()) qs.set("search", search.trim());
      if (status) qs.set("status", status);
      if (type) qs.set("type", type);
      if (priority) qs.set("priority", priority);
      if (from) qs.set("from", from);
      if (to) qs.set("to", to);
      // Sin periodo elegido = TODO su histórico. La vista general recorta al año en
      // curso porque barre 314.000 órdenes; las de una sola persona caben enteras.
      // `all=1` y las fechas son excluyentes en el servidor (`scopeDate` ignora el
      // rango si `all` viene puesto), así que sólo se manda cuando no hay fechas.
      if (!from && !to) qs.set("all", "1");
      return `/support/tickets?${qs.toString()}`;
    },
    [page, pageSize, orden.clave, search, status, type, priority, from, to],
    // Al teclear se espera un poco y se cancela la petición en vuelo, para que una
    // respuesta lenta no pise a otra más nueva (mismo criterio que /soporte).
    { saltar: authLoading, debounceMs: search ? 350 : 0 },
  );

  const cargarStats = () => { void authFetch("/support/stats").then(objetoJson).then(setStats).catch(() => {}); };
  useEffect(() => { if (!authLoading) cargarStats(); }, [authLoading]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setPage(1); }, [pageSize, orden.clave, search, status, type, priority, from, to]);

  if (authLoading) return <PageSkeleton />;

  const st = stats?.status ?? {};
  const abiertas = (st.PENDIENTE ?? 0) + (st.REALIZANDO ?? 0);

  const Contador = ({ label, value, icon, tono }: { label: string; value: number; icon: string; tono: string }) => (
    <div className="flex items-center gap-2.5 rounded-xl border border-border-subtle bg-surface px-3 py-2.5">
      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${tono}`}><Icon name={icon} size={15} /></span>
      <div className="min-w-0">
        <div className="text-[16px] font-bold leading-none text-text-primary">{value.toLocaleString("es-CO")}</div>
        <div className="truncate text-[10.5px] text-text-tertiary">{label}</div>
      </div>
    </div>
  );

  return (
    <>
      {/* Sin botón de "Nueva orden" (2026-07-31): el técnico atiende órdenes, no las
          abre. El backend lo repite por su cuenta en `createTicket`. */}
      <div className="mb-4">
        <PageHeading
          icon="clipboard-check"
          title="Mis órdenes de trabajo"
          subtitle="Todo lo que está a tu nombre. Lo que te toca ahora está en «Mi agenda»."
        />
      </div>

      {/* Con visita en turno, esta lista es historial y no un menú donde elegir. Se
          avisa aquí arriba para que el bloqueo no se descubra chocando con él. */}
      <div className="mb-2.5">
        <AvisoTurno />
      </div>

      {/* Cuántas son y cómo están. Es también la prueba de que la lista es suya: el
          total de aquí y el de la tabla son el mismo número. */}
      <div className="mb-2.5 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <Contador label="Por atender" value={abiertas} icon="hourglass" tono="bg-warning-soft text-warning-text" />
        <Contador label="En curso" value={st.REALIZANDO ?? 0} icon="loader" tono="bg-info-soft text-info-text" />
        <Contador label="Resueltas" value={st.RESUELTO ?? 0} icon="check" tono="bg-success-soft text-success-text" />
        <Contador label="A tu nombre (total)" value={stats?.total ?? 0} icon="clipboard-list" tono="bg-surface-2 text-text-secondary" />
      </div>

      {/* Buscar y filtrar entre las SUYAS. Ni el texto ni los filtros amplían el
          alcance (ver la cabecera del archivo); por eso el marcador dice "tus
          órdenes" y no "órdenes". Siguen sin estar los filtros que no le sirven a
          él: técnico (sólo hay uno posible) y sede (las suyas son de su sede). */}
      <ListToolbar
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Buscar en tus órdenes: n° de orden, cliente, nº de abonado o asunto…"
      >
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-auto">
          <option value="">Todos los estados</option>
          {Object.entries(TICKET_STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
        <Select value={priority} onChange={(e) => setPriority(e.target.value)} className="w-auto">
          <option value="">Toda prioridad</option>
          {TICKET_PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
        </Select>
        <Select value={type} onChange={(e) => setType(e.target.value)} className="w-auto">
          <option value="">Todos los detalles</option>
          {TICKET_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </Select>
        <button
          onClick={() => setShowFechas(true)}
          className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-[12px] font-semibold transition-colors ${filtrosFecha > 0 ? "border-brand bg-brand-soft text-brand" : "border-border-default bg-surface text-text-secondary hover:bg-surface-2"}`}
        >
          <Icon name="calendar" size={14} /> Fechas{filtrosFecha > 0 ? ` (${filtrosFecha})` : ""}
        </button>
        {filtrosActivos > 0 && (
          <button
            onClick={limpiarTodo}
            className="inline-flex items-center gap-1 rounded-lg border border-border-default px-2.5 py-2 text-[12px] font-semibold text-text-secondary hover:bg-surface-2"
          >
            <Icon name="x" size={13} /> Limpiar ({filtrosActivos})
          </button>
        )}
      </ListToolbar>

      {/* Periodo aparte, en un diálogo: en el móvil del técnico dos campos de fecha
          más en la barra la parten en cuatro renglones. Sin fechas = todo su
          histórico, así que aquí no hace falta el interruptor de "histórico
          completo" que sí tiene la vista general. */}
      <Modal open={showFechas} onClose={() => setShowFechas(false)} title="Filtrar por fecha" maxWidth="max-w-lg">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[12px] font-medium text-text-tertiary">Periodo:</span>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-auto" />
            <span className="text-text-tertiary">→</span>
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-auto" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {atajosDeFecha().map((p) => (
              <button
                key={p.label}
                onClick={() => { setFrom(p.from); setTo(p.to); }}
                className="rounded-lg border border-border-subtle bg-surface px-2.5 py-1.5 text-[12px] font-medium text-text-secondary hover:bg-surface-2"
              >
                {p.label}
              </button>
            ))}
          </div>
          <p className="text-[12px] text-text-tertiary">Sin fechas se muestran todas tus órdenes, desde la primera.</p>
          <div className="flex justify-end gap-2 pt-1">
            {filtrosFecha > 0 && (
              <Button variant="ghost" size="sm" onClick={() => { setFrom(""); setTo(""); }}>Quitar fechas</Button>
            )}
            <Button variant="primary" size="sm" onClick={() => setShowFechas(false)}>Aplicar</Button>
          </div>
        </div>
      </Modal>

      {filtrosActivos > 0 && data && (
        <p className="mb-2 text-[12px] text-text-tertiary">
          {data.total.toLocaleString("es-CO")}{" "}
          {data.total === 1 ? "orden tuya coincide" : "órdenes tuyas coinciden"}
          {search.trim() ? ` con “${search.trim()}”` : " con estos filtros"}.
        </p>
      )}

      {error && !data ? (
        <LoadError message="No se pudieron cargar tus órdenes." onRetry={load} />
      ) : cargando && !data ? (
        <PageSkeleton />
      ) : (
        <>
          <DataTable
            rows={data?.items ?? []}
            empty={filtrosActivos > 0
              ? "Ninguna de tus órdenes coincide con esos filtros."
              : "No tienes órdenes de trabajo asignadas."}
            onRowClick={(r) => router.push(`/soporte/${r.id}`)}
            sort={orden.sort}
            onSort={orden.onSort}
            columns={[
              { key: "code", header: "N°", sortable: true, render: (r) => <span className="font-mono text-text-secondary">{r.code ?? r.legacyId}</span> },
              { key: "priority", header: "Prioridad", sortable: true, render: (r) => r.priority ? <Badge label={r.priority} tone={TICKET_PRIORITY_TONE[r.priority] ?? "default"} /> : <span className="text-text-tertiary">—</span> },
              { key: "orden", header: "Orden", sortable: true, render: (r) => (
                <div className="flex min-w-0 flex-col">
                  <span className="truncate text-[11px] text-text-tertiary" title={r.subject}>{r.subject || r.type}</span>
                  <span className="truncate font-medium text-text-primary">{r.type}</span>
                </div>
              ) },
              // Sin "Descripción": en las órdenes del legacy viene vacía casi siempre
              // (sale "—" en toda la columna) y al entrar "Asignada a" empujaba
              // "Creada" y "Estado" fuera de la pantalla. El detalle largo se lee
              // abriendo la orden, que es donde hace falta.
              { key: "client", header: "Usuario", sortable: true, render: (r) => r.subscriberId
                ? <Link href={`/clientes/${r.subscriberId}`} className="text-brand hover:underline" onClick={(e) => e.stopPropagation()}>{r.client}</Link>
                : <span className="text-text-secondary">{r.client ?? "—"}</span> },
              { key: "barrio", header: "Barrio", render: (r) => <span className="text-[12px] text-text-secondary">{r.barrio ?? "—"}</span> },
              // Sí, siempre dice lo mismo — ese ES el punto. Sin esta columna la
              // tabla tenía cara de listado general y el técnico creyó que estaba
              // viendo las órdenes de todos. Que su nombre esté en cada fila lo
              // zanja de un vistazo, y si algún día apareciera otro nombre aquí,
              // sería la señal de que el alcance se rompió.
              { key: "tec", header: "Asignada a", render: (r) => <TecChip name={r.assigned} /> },
              { key: "created", header: "Creada", sortable: true, render: (r) => <span className="whitespace-nowrap text-[12px] text-text-secondary">{new Date(r.created).toLocaleDateString("es-CO")}</span> },
              { key: "status", header: "Estado", sortable: true, render: (r) => <Badge label={TICKET_STATUS_LABEL[r.status] ?? r.status} tone={TICKET_STATUS_TONE[r.status] ?? "default"} /> },
            ]}
          />
          {data && <div className="mt-3"><Pagination meta={{ page: data.page, pageSize: data.pageSize, total: data.total, pageCount: data.pages }} onPage={setPage} onPageSize={setPageSize} /></div>}
        </>
      )}
    </>
  );
}
