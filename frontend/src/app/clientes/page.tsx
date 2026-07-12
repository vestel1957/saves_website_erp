"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PageHeading } from "@/components/accounting/PageHeading";
import { Icon } from "@/components/Icon";
import { DataTable } from "@/components/inventory/DataTable";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Field";
import { ClienteWizardModal } from "@/components/subscribers/ClienteWizardModal";
import { Pagination } from "@/components/ui/Pagination";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { useAuth } from "@/context/AuthProvider";
import {
  type SubscriberList, type Branch,
  SUB_STATUS_LABEL, SUB_STATUS_TONE, cop,
} from "@/lib/subscribers";

export default function ClientesPage() {
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);
  const { loading: authLoading, authFetch } = useAuth();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [data, setData] = useState<SubscriberList | null>(null);
  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [branchId, setBranchId] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  // Carga catálogos una vez.
  useEffect(() => {
    if (authLoading) return;
    void authFetch("/subscribers/branches").then((r) => r.json()).then(setBranches).catch(() => {});
  }, [authLoading, authFetch]);

  const load = useCallback(async () => {
    setLoading(true);
    const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (search.trim()) qs.set("search", search.trim());
    if (status) qs.set("status", status);
    if (branchId) qs.set("branchId", branchId);
    try {
      const res = await authFetch(`/subscribers?${qs.toString()}`);
      setData(await res.json());
    } finally {
      setLoading(false);
    }
  }, [authFetch, page, pageSize, search, status, branchId]);

  // Debounce de búsqueda/filtros.
  useEffect(() => {
    if (authLoading) return;
    const t = setTimeout(load, search ? 350 : 0);
    return () => clearTimeout(t);
  }, [authLoading, load]);

  // Al cambiar filtros, vuelve a página 1.
  useEffect(() => { setPage(1); }, [search, status, branchId, pageSize]);

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
      {loading && !data ? (
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
