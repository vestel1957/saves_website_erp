"use client";

import { useCallback, useEffect, useState } from "react";
import { listaJson } from "@/lib/errores";
import { fmtDate } from "@/lib/format";
import Link from "next/link";
import { Icon } from "@/components/Icon";
import { PageHeading } from "@/components/ui/PageHeading";
import { DataTable } from "@/components/ui/DataTable";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Field";
import { ListToolbar } from "@/components/ui/ListToolbar";
import { Pagination } from "@/components/ui/Pagination";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { EquipmentLabelModal, type LabelEquip } from "@/components/red/EquipmentLabelModal";
import { useAuth } from "@/context/AuthProvider";
import type { Equip, Paged } from "@/lib/network";
import { useRequest } from "@/lib/useRequest";
import { useOrden } from "@/lib/useOrden";

export default function EquiposPage() {
  const { loading: authLoading, authFetch } = useAuth();
  const [warehouses, setWarehouses] = useState<{ id: string; name: string }[]>([]);
  const [search, setSearch] = useState("");
  const [assigned, setAssigned] = useState("");
  const [warehouseId, setWarehouseId] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [label, setLabel] = useState<LabelEquip | null>(null);

  // Prefill de búsqueda desde ?q= (p.ej. al escanear el QR de un sticker).
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("q");
    if (q) setSearch(q);
  }, []);

  useEffect(() => { if (!authLoading) void authFetch("/network/warehouses").then(listaJson).then(setWarehouses).catch(() => {}); }, [authLoading, authFetch]);

  // Carga con cancelación: al teclear se aborta la petición en vuelo, para que
  // una respuesta lenta no pise a otra más nueva. Ver lib/useRequest.
  // Pagina en el servidor: el orden viaja en la query.
  const orden = useOrden();

  const { data, cargando: loading, error, refrescar: load } = useRequest<Paged<Equip>>(
    () => {
      const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize), ...orden.params });
      if (search.trim()) qs.set("search", search.trim());
      if (assigned) qs.set("assigned", assigned);
      if (warehouseId) qs.set("warehouseId", warehouseId);
      return `/network/equipment?${qs}`;
    },
    [page, pageSize, search, assigned, warehouseId],
    { debounceMs: search ? 350 : 0, saltar: authLoading },
  );

  useEffect(() => { setPage(1); }, [search, assigned, warehouseId, pageSize, orden.clave]);

  if (authLoading) return <PageSkeleton />;

  return (
    <>
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <PageHeading icon="boxes" title="Equipos / CPE" />
        <Link href="/red/equipos/nuevo"><Button size="sm"><Icon name="plus" size={14} /> Nuevo equipo</Button></Link>
      </div>

      <EquipmentLabelModal open={!!label} onClose={() => setLabel(null)} equip={label} />

      <ListToolbar search={search} onSearch={setSearch} searchPlaceholder="Buscar por código, MAC, serial o marca…">
        <Select value={assigned} onChange={(e) => setAssigned(e.target.value)} className="w-auto">
          <option value="">Todos</option><option value="yes">Asignados</option><option value="no">Disponibles</option>
        </Select>
        <Select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} className="w-auto">
          <option value="">Todos los almacenes</option>
          {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </Select>
      </ListToolbar>

      {loading && !data ? <PageSkeleton /> : (
        <>
          <DataTable rows={data?.items ?? []} empty="No se encontraron equipos." sort={orden.sort} onSort={orden.onSort} columns={[
            { key: "code", header: "Código", sortable: true, render: (r) => <span className="font-mono text-text-secondary">{r.code}</span> },
            { key: "brand", header: "Marca", sortable: true, render: (r) => r.brand ?? "—" },
            { key: "mac", header: "MAC", sortable: true, render: (r) => <span className="font-mono text-text-secondary">{r.mac ?? "—"}</span> },
            { key: "serial", header: "Serial", sortable: true, render: (r) => <span className="font-mono text-text-tertiary">{r.serial ?? "—"}</span> },
            { key: "wh", header: "Almacén", sortable: true, render: (r) => r.warehouse ?? "—" },
            { key: "client", header: "Asignado a", sortable: true, render: (r) => r.subscriberId ? <Link href={`/clientes/${r.subscriberId}`} className="text-brand hover:underline">{r.client}</Link> : <span className="text-text-tertiary">— disponible</span> },
            { key: "acs", header: "ACS", sortable: true, render: (r) => r.genieacs ? <Badge label="GenieACS" tone="info" /> : "—" },
            { key: "status", header: "Estado", sortable: true, render: (r) => <Badge label={r.status ?? "—"} tone={r.status === "Disponible" ? "success" : r.status === "Asignado" || r.status === "Instalado" ? "info" : "default"} /> },
            // Día en que se recogió del cliente, no el día en que se tecleó la devolución.
            { key: "returned", header: "Devuelto", sortable: true, render: (r) => r.returnedAt ? <span className="text-text-secondary">{fmtDate(r.returnedAt)}</span> : <span className="text-text-tertiary">—</span> },
            { key: "label", header: "", align: "right", render: (r) => (
              <button onClick={() => setLabel({ code: r.code, brand: r.brand, mac: r.mac, serial: r.serial })} title="Imprimir etiqueta QR"
                className="inline-flex items-center gap-1 rounded-lg border border-border-default px-2.5 py-1.5 text-[12px] font-semibold text-text-secondary transition-colors hover:bg-surface-2">
                <Icon name="download" size={13} /> Etiqueta
              </button>
            ) },
          ]} />
          {data && <div className="mt-3"><Pagination meta={{ page: data.page, pageSize: data.pageSize, total: data.total, pageCount: data.pages }} onPage={setPage} onPageSize={setPageSize} /></div>}
        </>
      )}
    </>
  );
}
