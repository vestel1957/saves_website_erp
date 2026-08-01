"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { DataTable } from "@/components/ui/DataTable";
import { Badge } from "@/components/ui/Badge";
import { Pagination } from "@/components/ui/Pagination";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { LoadError } from "@/components/ui/LoadError";
import { TecChip } from "@/components/soporte/TecChip";
import { useAuth } from "@/context/AuthProvider";
import { useRequest } from "@/lib/useRequest";
import { useOrden } from "@/lib/useOrden";
import {
  type Paged, type TicketRow, type SupportStats,
  TICKET_STATUS_LABEL, TICKET_STATUS_TONE, TICKET_PRIORITY_TONE,
} from "@/lib/support";

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
 * Sin filtros a propósito: no hay selector de técnico (sólo hay uno posible), ni de
 * sede (las suyas son de su sede), ni de fechas (se muestran TODAS las suyas, sin el
 * corte por año que sí tiene la vista general — a él no se le esconde su historia).
 * Ordenar por una columna sí se deja: ordenar no es filtrar, y "las más viejas
 * primero" es una pregunta legítima de quien va a ponerse al día.
 *
 * El alcance real no lo pone esta pantalla: lo impone `SupportService.tickets`
 * (`soloMisOrdenes`), que además cierra el detalle por URL. Aquí no se manda ningún
 * parámetro de alcance — si esta vista se equivocara, seguiría sin ver nada ajeno.
 */
export function MisOrdenes() {
  const router = useRouter();
  const { loading: authLoading, authFetch } = useAuth();
  const [stats, setStats] = useState<SupportStats | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const orden = useOrden();

  // `all=1` = sin corte por año. La vista general recorta al año en curso porque
  // barre 314.000 órdenes; las de una sola persona caben enteras.
  const { data, cargando, error, refrescar: load } = useRequest<Paged<TicketRow>>(
    () => `/support/tickets?all=1&page=${page}&pageSize=${pageSize}&${new URLSearchParams(orden.params)}`,
    [page, pageSize, orden.clave],
    { saltar: authLoading },
  );

  const cargarStats = () => { void authFetch("/support/stats").then((r) => r.json()).then(setStats).catch(() => {}); };
  useEffect(() => { if (!authLoading) cargarStats(); }, [authLoading]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setPage(1); }, [pageSize, orden.clave]);

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
          subtitle="Solo las órdenes asignadas a ti. No verás las de otros técnicos."
        />
      </div>

      {/* Cuántas son y cómo están. Es también la prueba de que la lista es suya: el
          total de aquí y el de la tabla son el mismo número. */}
      <div className="mb-2.5 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <Contador label="Por atender" value={abiertas} icon="hourglass" tono="bg-warning-soft text-warning-text" />
        <Contador label="En curso" value={st.REALIZANDO ?? 0} icon="loader" tono="bg-info-soft text-info-text" />
        <Contador label="Resueltas" value={st.RESUELTO ?? 0} icon="check" tono="bg-success-soft text-success-text" />
        <Contador label="A tu nombre (total)" value={stats?.total ?? 0} icon="clipboard-list" tono="bg-surface-2 text-text-secondary" />
      </div>

      {error && !data ? (
        <LoadError message="No se pudieron cargar tus órdenes." onRetry={load} />
      ) : cargando && !data ? (
        <PageSkeleton />
      ) : (
        <>
          <DataTable
            rows={data?.items ?? []}
            empty="No tienes órdenes de trabajo asignadas."
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
