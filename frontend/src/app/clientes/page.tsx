"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { DataTable } from "@/components/ui/DataTable";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Field";
import { ClienteWizardModal } from "@/components/subscribers/ClienteWizardModal";
import { SubscriberFilters } from "@/components/subscribers/SubscriberFilters";
import { Pagination } from "@/components/ui/Pagination";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { useAuth } from "@/context/AuthProvider";
import {
  type SubscriberList, type Branch,
  SUB_STATUS_LABEL, SUB_STATUS_TONE, cop, cuentaParams,
} from "@/lib/subscribers";
import { useRequest } from "@/lib/useRequest";
import { LoadError } from "@/components/ui/LoadError";

export default function ClientesPage() {
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);
  const { loading: authLoading, authFetch } = useAuth();
  const [branches, setBranches] = useState<Branch[]>([]);

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [branchId, setBranchId] = useState("");
  const [servicio, setServicio] = useState("");
  const [tecnologia, setTecnologia] = useState("");
  const [cuenta, setCuenta] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

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
      const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
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
    [page, pageSize, search, status, branchId, servicio, tecnologia, cuenta],
    { debounceMs: search ? 350 : 0, saltar: authLoading },
  );

  // Al cambiar filtros, vuelve a página 1.
  useEffect(() => { setPage(1); }, [search, status, branchId, servicio, tecnologia, cuenta, pageSize]);

  if (authLoading) return <PageSkeleton />;

  return (
    <>
      <PageHeading
        icon="users"
        title="Clientes"
        subtitle={data ? `${data.total.toLocaleString("es-CO")} clientes` : "Clientes ISP"}
      />

      {/* Filtros */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px]">
          <Icon name="search" size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
          <Input
            className="pl-9"
            placeholder="Buscar por nombre, documento, celular o abonado…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-auto">
          <option value="">Todos los estados</option>
          {Object.entries(SUB_STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
        <Select value={branchId} onChange={(e) => setBranchId(e.target.value)} className="w-auto">
          <option value="">Todas las sedes</option>
          {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </Select>
        <SubscriberFilters
          servicio={servicio} tecnologia={tecnologia} cuenta={cuenta}
          onServicio={setServicio} onTecnologia={setTecnologia} onCuenta={setCuenta}
        />
        <Button className="ml-auto" onClick={() => setCreateOpen(true)}>
          <Icon name="user-plus" size={15} /> Nuevo cliente
        </Button>
      </div>

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
            columns={[
              { key: "abonado", header: "Abonado", render: (r) => <span className="font-mono text-text-secondary">{r.abonado}</span> },
              { key: "name", header: "Nombre", render: (r) => <span className="font-medium text-text-primary">{r.name}</span> },
              { key: "doc", header: "Documento", render: (r) => <span className="text-text-secondary">{r.docNumber ?? "—"}</span> },
              { key: "phone", header: "Celular", render: (r) => r.phone ?? "—" },
              { key: "branch", header: "Sede", render: (r) => r.branch ?? "—" },
              { key: "status", header: "Estado", render: (r) => <Badge label={SUB_STATUS_LABEL[r.status ?? ""] ?? r.status ?? "—"} tone={SUB_STATUS_TONE[r.status ?? ""] ?? "default"} /> },
              { key: "balance", header: "Saldo", align: "right", render: (r) => <span className={r.balance > 0 ? "font-semibold text-success-text" : "text-text-tertiary"}>{cop(r.balance)}</span> },
              { key: "go", header: "", align: "right", render: (r) => <Link href={`/clientes/${r.id}`} className="inline-flex items-center gap-1 rounded-lg border border-border-default px-3 py-1.5 text-[12px] font-semibold text-text-secondary transition-colors hover:bg-surface-2">Ver ficha →</Link> },
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
    </>
  );
}
