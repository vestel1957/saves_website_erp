"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Icon } from "@/components/Icon";
import { PageHeading } from "@/components/ui/PageHeading";
import { DataTable } from "@/components/ui/DataTable";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Field";
import { Pagination } from "@/components/ui/Pagination";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { EquipmentLabelModal, type LabelEquip } from "@/components/red/EquipmentLabelModal";
import { useAuth } from "@/context/AuthProvider";
import type { Equip, Paged } from "@/lib/network";

export default function EquiposPage() {
  const { loading: authLoading, authFetch } = useAuth();
  const [data, setData] = useState<Paged<Equip> | null>(null);
  const [warehouses, setWarehouses] = useState<{ id: string; name: string }[]>([]);
  const [search, setSearch] = useState("");
  const [assigned, setAssigned] = useState("");
  const [warehouseId, setWarehouseId] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [loading, setLoading] = useState(true);
  const [label, setLabel] = useState<LabelEquip | null>(null);

  // Prefill de búsqueda desde ?q= (p.ej. al escanear el QR de un sticker).
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("q");
    if (q) setSearch(q);
  }, []);

  useEffect(() => { if (!authLoading) void authFetch("/network/warehouses").then((r) => r.json()).then(setWarehouses).catch(() => {}); }, [authLoading, authFetch]);

  const load = useCallback(async () => {
    setLoading(true);
    const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (search.trim()) qs.set("search", search.trim());
    if (assigned) qs.set("assigned", assigned);
    if (warehouseId) qs.set("warehouseId", warehouseId);
    try { setData(await (await authFetch(`/network/equipment?${qs}`)).json()); } finally { setLoading(false); }
  }, [authFetch, page, pageSize, search, assigned, warehouseId]);

  useEffect(() => { if (!authLoading) { const t = setTimeout(load, search ? 350 : 0); return () => clearTimeout(t); } }, [authLoading, load]);
  useEffect(() => { setPage(1); }, [search, assigned, warehouseId, pageSize]);

  if (authLoading) return <PageSkeleton />;

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <PageHeading icon="boxes" title="Equipos / CPE" />
        <Link href="/red/equipos/nuevo"><Button size="sm"><Icon name="plus" size={14} /> Nuevo equipo</Button></Link>
      </div>

      <EquipmentLabelModal open={!!label} onClose={() => setLabel(null)} equip={label} />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px]">
          <Icon name="search" size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
          <Input className="pl-9" placeholder="Buscar por código, MAC, serial o marca…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Select value={assigned} onChange={(e) => setAssigned(e.target.value)} className="w-auto">
          <option value="">Todos</option><option value="yes">Asignados</option><option value="no">Disponibles</option>
        </Select>
        <Select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} className="w-auto">
          <option value="">Todos los almacenes</option>
          {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </Select>
      </div>

      {loading && !data ? <PageSkeleton /> : (
        <>
          <DataTable rows={data?.items ?? []} empty="No se encontraron equipos." columns={[
            { key: "code", header: "Código", render: (r) => <span className="font-mono text-text-secondary">{r.code}</span> },
            { key: "brand", header: "Marca", render: (r) => r.brand ?? "—" },
            { key: "mac", header: "MAC", render: (r) => <span className="font-mono text-text-secondary">{r.mac ?? "—"}</span> },
            { key: "serial", header: "Serial", render: (r) => <span className="font-mono text-text-tertiary">{r.serial ?? "—"}</span> },
            { key: "wh", header: "Almacén", render: (r) => r.warehouse ?? "—" },
            { key: "client", header: "Asignado a", render: (r) => r.subscriberId ? <Link href={`/clientes/${r.subscriberId}`} className="text-brand hover:underline">{r.client}</Link> : <span className="text-text-tertiary">— disponible</span> },
            { key: "acs", header: "ACS", render: (r) => r.genieacs ? <Badge label="GenieACS" tone="info" /> : "—" },
            { key: "status", header: "Estado", render: (r) => <Badge label={r.status ?? "—"} tone={r.status === "Disponible" ? "success" : r.status === "Asignado" || r.status === "Instalado" ? "info" : "default"} /> },
            { key: "label", header: "", align: "right", render: (r) => (
              <button onClick={() => setLabel({ code: r.code, brand: r.brand, mac: r.mac, serial: r.serial })} title="Imprimir etiqueta QR"
                className="inline-flex items-center gap-1 rounded-lg border border-border-default px-2.5 py-1.5 text-[12px] font-semibold text-text-secondary transition-colors hover:bg-surface-2">
                <Icon name="download" size={13} /> Etiqueta
              </button>
            ) },
          ]} />
          {data && data.pages > 1 && <div className="mt-3"><Pagination meta={{ page: data.page, pageSize: data.pageSize, total: data.total, pageCount: data.pages }} onPage={setPage} onPageSize={setPageSize} /></div>}
        </>
      )}
    </>
  );
}
