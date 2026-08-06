"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { DataTable } from "@/components/ui/DataTable";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Field";
import { ListToolbar } from "@/components/ui/ListToolbar";
import { ClienteWizardModal } from "@/components/subscribers/ClienteWizardModal";
import { SubscriberFilters } from "@/components/subscribers/SubscriberFilters";
import { Pagination } from "@/components/ui/Pagination";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { useAuth } from "@/context/AuthProvider";
import {
  type SubscriberList, type Branch,
  SUB_STATUS_LABEL, SUB_STATUS_TONE, cuentaParams,
} from "@/lib/subscribers";
import { useRequest } from "@/lib/useRequest";
import { useOrden } from "@/lib/useOrden";
import { LoadError } from "@/components/ui/LoadError";

export default function ClientesPage() {
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);
  const { loading: authLoading, authFetch, sedeScoped } = useAuth();
  const [branches, setBranches] = useState<Branch[]>([]);

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [branchId, setBranchId] = useState("");
  const [servicio, setServicio] = useState("");
  const [tecnologia, setTecnologia] = useState("");
  const [cuenta, setCuenta] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  // El listado se pagina en el servidor, así que el orden también: ordenar aquí
  // solo movería las 25 filas de la página.
  const orden = useOrden();

  // Carga catálogos una vez.
  useEffect(() => {
    if (authLoading) return;
    void authFetch("/subscribers/branches").then((r) => r.json()).then(setBranches).catch(() => {});
  }, [authLoading, authFetch]);

  // Carga con cancelación: al teclear en el filtro, la petición en vuelo se aborta.
  // Antes sólo se cancelaba el temporizador del debounce, así que una respuesta
  // lenta podía llegar después de otra más nueva y pisar la tabla con datos que ya
  // no correspondían al filtro escrito.
  const {
    data,
    cargando: loading,
    error,
    refrescar: load,
  } = useRequest<SubscriberList>(
    () => {
      // withPlan: la tabla enseña qué tiene contratado cada cliente. El backend lo
      // busca en el servicio registrado y, si no lo tiene, en sus facturas o en el
      // perfil de red (ver `serviciosDeRespaldo`).
      const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize), withPlan: "1", ...orden.params });
      if (search.trim()) qs.set("search", search.trim());
      if (status) qs.set("status", status);
      if (branchId) qs.set("branchId", branchId);
      if (servicio) qs.set("servicio", servicio);
      if (tecnologia) qs.set("tecnologia", tecnologia);
      const cp = cuentaParams(cuenta);
      if (cp.cuenta) qs.set("cuenta", cp.cuenta);
      if (cp.deuda) qs.set("deuda", cp.deuda);
      return `/subscribers?${qs.toString()}`;
    },
    [page, pageSize, search, status, branchId, servicio, tecnologia, cuenta, orden.clave],
    { debounceMs: search ? 350 : 0, saltar: authLoading },
  );

  // Al cambiar filtros o el orden, vuelve a página 1: lo que el usuario busca al
  // ordenar está al principio, no en la página en la que estaba.
  useEffect(() => { setPage(1); }, [search, status, branchId, servicio, tecnologia, cuenta, pageSize, orden.clave]);

  if (authLoading) return <PageSkeleton />;

  return (
    <>
      <PageHeading
        icon="users"
        title="Clientes"
        subtitle={data ? `${data.total.toLocaleString("es-CO")} clientes` : "Clientes ISP"}
      />

      {/* Filtros */}
      <ListToolbar
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Buscar por nombre, documento, celular o abonado…"
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Icon name="user-plus" size={15} /> Nuevo cliente
          </Button>
        }
      >
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-auto">
          <option value="">Todos los estados</option>
          {Object.entries(SUB_STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
        {/* Sin filtro de sede para quien está acotado a la suya: el listado ya viene
            sólo con sus clientes, así que elegir sede no tendría entre qué elegir. */}
        {!sedeScoped && (
          <Select value={branchId} onChange={(e) => setBranchId(e.target.value)} className="w-auto">
            <option value="">Todas las sedes</option>
            {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </Select>
        )}
        <SubscriberFilters
          servicio={servicio} tecnologia={tecnologia} cuenta={cuenta}
          onServicio={setServicio} onTecnologia={setTecnologia} onCuenta={setCuenta}
        />
      </ListToolbar>

      <ClienteWizardModal
        mode="create"
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onDone={(id) => { if (id) router.push(`/clientes/${id}`); else void load(); }}
      />

      {/* Tabla */}
      {error && !data ? (
        // Distingue "falló la carga" de "no hay clientes": antes un 500 dejaba la
        // tabla vacía y parecía que el filtro no devolvía nada.
        <LoadError message={error} onRetry={load} />
      ) : loading && !data ? (
        <PageSkeleton />
      ) : (
        <>
          <DataTable
            rows={data?.items ?? []}
            empty="No se encontraron clientes con esos criterios."
            sort={orden.sort}
            onSort={orden.onSort}
            columns={[
              { key: "abonado", header: "Abonado", sortable: true, render: (r) => <span className="font-mono text-text-secondary">{r.abonado}</span> },
              { key: "name", header: "Nombre", sortable: true, render: (r) => <span className="font-medium text-text-primary">{r.name}</span> },
              { key: "doc", header: "Documento", sortable: true, render: (r) => <span className="text-text-secondary">{r.docNumber ?? "—"}</span> },
              { key: "phone", header: "Celular", sortable: true, render: (r) => r.phone ?? "—" },
              { key: "branch", header: "Sede", sortable: true, render: (r) => r.branch ?? "—" },
              {
                key: "plan",
                header: "Plan",
                render: (r: any) => {
                  const partes = [r.internet, r.tv].filter(Boolean) as { plan: string | null }[];
                  if (!partes.length) return <span className="text-text-tertiary">—</span>;
                  return (
                    <div className="flex flex-col leading-tight">
                      {r.internet?.plan && (
                        <span className="flex items-center gap-1 font-semibold text-text-primary">
                          <Icon name="wifi" size={12} className="shrink-0 text-brand" />
                          {r.internet.plan}
                        </span>
                      )}
                      {r.tv?.plan && (
                        <span className="flex items-center gap-1 text-[11px] text-text-secondary">
                          <Icon name="tv" size={11} className="shrink-0 text-text-tertiary" />
                          {r.tv.plan}
                        </span>
                      )}
                    </div>
                  );
                },
              },
              { key: "status", header: "Estado", sortable: true, render: (r) => <Badge label={SUB_STATUS_LABEL[r.status ?? ""] ?? r.status ?? "—"} tone={SUB_STATUS_TONE[r.status ?? ""] ?? "default"} /> },
              { key: "go", header: "", align: "right", render: (r) => <Link href={`/clientes/${r.id}`} className="inline-flex items-center gap-1 rounded-lg border border-border-default px-3 py-1.5 text-[12px] font-semibold text-text-secondary transition-colors hover:bg-surface-2">Ver ficha →</Link> },
            ]}
          />
          {data && (
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
    </>
  );
}
