"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { objetoJson } from "@/lib/errores";
import Link from "next/link";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { DataTable } from "@/components/ui/DataTable";
import { Badge } from "@/components/ui/Badge";
import { Pagination } from "@/components/ui/Pagination";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { LoadError } from "@/components/ui/LoadError";
import { ListToolbar } from "@/components/ui/ListToolbar";
import { MultiSelect } from "@/components/ui/MultiSelect";
import { TecChip } from "@/components/soporte/TecChip";
import { TarjetaOrden } from "@/components/soporte/TarjetaOrden";
import { ChipServicio } from "@/components/soporte/ChipServicio";
import { AvisoTurno } from "@/components/soporte/AvisoTurno";
import { useAuth } from "@/context/AuthProvider";
import { useRequest } from "@/lib/useRequest";
import { useOrden } from "@/lib/useOrden";
import { ordenDeTexto, useFiltrosEnUrl, useFiltrosRecordados } from "@/lib/useFiltrosUrl";
import {
  type Paged, type TicketRow, type SupportStats,
  TICKET_STATUS_LABEL, TICKET_STATUS_TONE, TICKET_PRIORITY_TONE,
  TICKET_TYPES, TICKET_PRIORITIES,
} from "@/lib/support";

/** Un filtro múltiple tal como viaja en la URL: "PENDIENTE,REALIZANDO" → ["PENDIENTE","REALIZANDO"]. */
const listaDeUrl = (crudo?: string): string[] => (crudo ? crudo.split(",").map((v) => v.trim()).filter(Boolean) : []);

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
 * **Sólo el DÍA DE HOY (2026-09-10)**, a pedido del usuario: «mostrar únicamente las
 * órdenes asignadas al técnico para el día actual; no deben visualizar usuarios
 * generales ni el historial completo de órdenes realizadas». Antes traía las 966 de
 * toda su vida. Qué es "hoy" lo decide el servidor y no esta pantalla
 * (`whereTrabajoDelDia`): su agenda del día con lo atrasado, lo que tenga empezado,
 * lo que se le asignó hoy sin agendar y lo que cerró hoy. Lo de días pasados sigue a
 * un clic, en «Lo que ya hice» (`/mi-agenda/historial`), que va por día de trabajo.
 *
 * Sin selectores a propósito: no hay filtro de técnico (sólo hay uno posible), ni de
 * sede (las suyas son de su sede), ni de fechas (la lista ES de hoy: un rango de
 * fechas encima sólo podría dejarla vacía). Ordenar por una columna sí se deja:
 * ordenar no es filtrar.
 *
 * El BUSCADOR se queda (2026-08-03, a pedido), aunque hoy busque sobre un día: busca
 * DENTRO de lo suyo y no puede sacarlo de ahí — el alcance va en `where.AND` del
 * servicio y el texto sólo alimenta el `OR` de la búsqueda, así que teclear no
 * destapa órdenes de otro técnico ni de otro día.
 *
 * El alcance real no lo pone esta pantalla: lo impone `SupportService.tickets`
 * (`soloMisOrdenes`), que además cierra el detalle por URL. Aquí no se manda ningún
 * parámetro de alcance — si esta vista se equivocara, seguiría sin ver nada ajeno.
 */
export function MisOrdenes() {
  // Sus filtros también se guardan (en la dirección y, entre visitas, en el
  // navegador): el técnico que está barriendo sus pendientes abre una orden, la
  // cierra y vuelve a la lista TAL COMO LA DEJÓ. Ver `useFiltrosRecordados`.
  return (
    <Suspense fallback={<PageSkeleton />}>
      <MisOrdenesConFiltros />
    </Suspense>
  );
}

function MisOrdenesConFiltros() {
  const inicial = useFiltrosRecordados();
  if (!inicial) return <PageSkeleton />;
  return <MisOrdenesLista urlInicial={inicial.valores} recordado={inicial.recordado} />;
}

function MisOrdenesLista({ urlInicial, recordado }: { urlInicial: Record<string, string>; recordado: boolean }) {
  const { loading: authLoading, authFetch } = useAuth();
  const [stats, setStats] = useState<SupportStats | null>(null);
  const [search, setSearch] = useState(urlInicial.q ?? "");
  // Selección múltiple: "pendientes Y realizando" en una sola pasada. Viajan a la
  // API en el mismo parámetro, separadas por comas.
  const [status, setStatus] = useState<string[]>(listaDeUrl(urlInicial.estado));
  const [type, setType] = useState<string[]>(listaDeUrl(urlInicial.detalle));
  const [priority, setPriority] = useState<string[]>(listaDeUrl(urlInicial.prioridad));
  const [page, setPage] = useState(Number(urlInicial.pag) > 1 ? Number(urlInicial.pag) : 1);
  const [pageSize, setPageSize] = useState(Number(urlInicial.tam) > 0 ? Number(urlInicial.tam) : 25);
  const orden = useOrden(ordenDeTexto(urlInicial.ord));

  // Los filtros múltiples ya escritos como viajan (coma): sirven de dependencia
  // estable, cosa que un array —nuevo en cada render— no puede ser.
  const kStatus = status.join(","), kType = type.join(","), kPriority = priority.join(",");

  // Cuenta filtros PUESTOS, no valores marcados: tres estados son un filtro de estado.
  const filtrosActivos = (search ? 1 : 0) + [status, type, priority].filter((f) => f.length > 0).length;
  const limpiarTodo = () => {
    setSearch(""); setStatus([]); setType([]); setPriority([]);
  };

  const { data, cargando, error, refrescar: load } = useRequest<Paged<TicketRow>>(
    () => {
      const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize), ...orden.params });
      if (search.trim()) qs.set("search", search.trim());
      if (kStatus) qs.set("status", kStatus);
      if (kType) qs.set("type", kType);
      if (kPriority) qs.set("priority", kPriority);
      // `all=1` desactiva el corte por año de la vista general (`scopeDate`). Aquí ya
      // no amplía nada —el servidor acota al día— pero sin él la lista se quedaría
      // además dentro del año en curso, que es una regla de otra pantalla.
      qs.set("all", "1");
      return `/support/tickets?${qs.toString()}`;
    },
    [page, pageSize, orden.clave, search, kStatus, kType, kPriority],
    // Al teclear se espera un poco y se cancela la petición en vuelo, para que una
    // respuesta lenta no pise a otra más nueva (mismo criterio que /soporte).
    { saltar: authLoading, debounceMs: search ? 350 : 0 },
  );

  const cargarStats = () => { void authFetch("/support/stats").then(objetoJson).then(setStats).catch(() => {}); };
  useEffect(() => { if (!authLoading) cargarStats(); }, [authLoading]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cambiar un filtro manda a la página 1 — pero no en el primer render, que
  // borraría la página con la que se volvió de una orden.
  const primerRender = useRef(true);
  useEffect(() => {
    if (primerRender.current) { primerRender.current = false; return; }
    setPage(1);
  }, [pageSize, orden.clave, search, kStatus, kType, kPriority]);

  // Lo que está puesto en pantalla se refleja en la dirección (y queda guardado
  // para la próxima visita).
  useFiltrosEnUrl({
    q: search.trim(), estado: kStatus, detalle: kType, prioridad: kPriority,
    pag: page > 1 ? page : "", tam: pageSize !== 25 ? pageSize : "", ord: orden.clave,
  });

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
      <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
        <PageHeading
          icon="clipboard-check"
          title="Mis órdenes de hoy"
          subtitle="Tu trabajo del día. La que te toca ahora está en «Mi agenda»."
        />
        {/* Lo de días pasados ya no está en esta lista (2026-09-10): tiene su
            pantalla, y va por día de trabajo. Ver `app/mi-agenda/historial`. */}
        <Link
          href="/mi-agenda/historial"
          className="tap inline-flex items-center gap-1.5 rounded-lg border border-border-default px-3 py-2 text-[12.5px] font-semibold text-text-secondary hover:bg-surface-2"
        >
          <Icon name="history" size={14} /> Lo que ya hice
        </Link>
      </div>

      {/* Con una orden EMPEZADA encima no se puede empezar otra de esta lista (una
          orden a la vez, 2026-09-10). Abrirlas y trabajarlas sí: lo único cerrado es
          arrancar la segunda. Se avisa aquí arriba para que no se descubra al pulsar
          "Empezar". */}
      <div className="mb-2.5">
        <AvisoTurno />
      </div>

      {/* Cuántas son y cómo están. Es también la prueba de que la lista es suya y de
          hoy: el total de aquí y el de la tabla son el mismo número —los contadores
          salen del mismo alcance que la lista (`SupportService.stats`)—. */}
      <div className="mb-2.5 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <Contador label="Por atender" value={abiertas} icon="hourglass" tono="bg-warning-soft text-warning-text" />
        <Contador label="En curso" value={st.REALIZANDO ?? 0} icon="loader" tono="bg-info-soft text-info-text" />
        <Contador label="Cerradas hoy" value={st.RESUELTO ?? 0} icon="check" tono="bg-success-soft text-success-text" />
        <Contador label="Tu día (total)" value={stats?.total ?? 0} icon="clipboard-list" tono="bg-surface-2 text-text-secondary" />
      </div>

      {/* Buscar y filtrar entre las SUYAS. Ni el texto ni los filtros amplían el
          alcance (ver la cabecera del archivo); por eso el marcador dice "tus
          órdenes" y no "órdenes". Siguen sin estar los filtros que no le sirven a
          él: técnico (sólo hay uno posible) y sede (las suyas son de su sede). */}
      <ListToolbar
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Buscar en tus órdenes de hoy: n° de orden, cliente, nº de abonado o asunto…"
      >
        <MultiSelect
          label="Estado" todos="Todos los estados" value={status} onChange={setStatus}
          options={Object.entries(TICKET_STATUS_LABEL).map(([value, label]) => ({ value, label }))}
        />
        <MultiSelect
          label="Prioridad" todos="Toda prioridad" value={priority} onChange={setPriority}
          options={TICKET_PRIORITIES.map((p) => ({ value: p, label: p }))}
        />
        <MultiSelect
          label="Detalles" todos="Todos los detalles" value={type} onChange={setType} width={280}
          options={TICKET_TYPES.map((t) => ({ value: t, label: t }))}
        />
        {filtrosActivos > 0 && (
          <button
            onClick={limpiarTodo}
            className="inline-flex items-center gap-1 rounded-lg border border-border-default px-2.5 py-2 text-[12px] font-semibold text-text-secondary hover:bg-surface-2"
          >
            <Icon name="x" size={13} /> Limpiar ({filtrosActivos})
          </button>
        )}
      </ListToolbar>

      {/* Al entrar por el menú los filtros vuelven puestos: hay que decirlo, o una
          lista corta parece un sistema roto y no una lista filtrada. */}
      {recordado && filtrosActivos > 0 && (
        <p className="mb-2 flex flex-wrap items-center gap-1.5 text-[12px] text-text-tertiary">
          <Icon name="history" size={13} />
          Se aplicaron los filtros de tu última visita.
          <button onClick={limpiarTodo} className="font-semibold text-brand hover:underline">Ver todo tu día</button>
        </p>
      )}

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
              ? "Ninguna de tus órdenes de hoy coincide con esos filtros."
              : "Hoy no tienes órdenes asignadas. Lo de días pasados está en «Lo que ya hice»."}
            rowHref={(r) => `/soporte/${r.id}`}
            sort={orden.sort}
            onSort={orden.onSort}
            // En móvil, tarjeta de orden en vez de los ocho renglones
            // etiqueta/valor que salen de las columnas. Sin el nombre del técnico
            // —todas son suyas— y sin enlace al cliente: su alcance es la orden.
            cardRender={(r) => <TarjetaOrden r={r} ocultarTecnico enlazarCliente={false} />}
            columns={[
              { key: "code", header: "N°", sortable: true, render: (r) => <span className="font-mono text-text-secondary">{r.code ?? r.legacyId}</span> },
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
              // Debajo de la fecha, QUIÉN se la mandó: al técnico le importa a quién
              // preguntarle por una visita que no entiende, y hasta ahora la orden
              // no lo decía. Las heredadas del legacy sin autor no muestran renglón.
              { key: "created", header: "Creada", sortable: true, render: (r) => (
                <div className="flex min-w-0 flex-col">
                  <span className="whitespace-nowrap text-[12px] text-text-secondary">{new Date(r.created).toLocaleDateString("es-CO")}</span>
                  {r.generadaPor && <span className="max-w-[140px] truncate text-[11px] text-text-tertiary" title={`Generada por ${r.generadaPor}`}>por {r.generadaPor}</span>}
                </div>
              ) },
              { key: "status", header: "Estado", sortable: true, render: (r) => <Badge label={TICKET_STATUS_LABEL[r.status] ?? r.status} tone={TICKET_STATUS_TONE[r.status] ?? "default"} /> },
            ]}
          />
          {data && <div className="mt-3"><Pagination meta={{ page: data.page, pageSize: data.pageSize, total: data.total, pageCount: data.pages }} onPage={setPage} onPageSize={setPageSize} /></div>}
        </>
      )}
    </>
  );
}
