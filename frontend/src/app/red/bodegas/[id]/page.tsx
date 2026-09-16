"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { Badge } from "@/components/ui/Badge";
import { Input } from "@/components/ui/Field";
import { DataTable } from "@/components/ui/DataTable";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { useAuth } from "@/context/AuthProvider";
import { EditarEquipoModal, puedeEditarEquipos, type EquipoEditable } from "@/components/red/EditarEquipoModal";

type Warehouse = { id: string; name: string; description?: string | null; equipment?: number };
type EquipItem = {
  id: string; code: number; mac: string | null; serial: string | null; brand: string | null;
  status: string | null; observation?: string | null; warehouse: string | null; client: string | null; subscriberId: string | null; genieacs: boolean;
};
type EquipResp = { items: EquipItem[]; total: number; page: number; pageSize: number; pages: number };

export default function BodegaDetallePage() {
  const { id } = useParams<{ id: string }>();
  const { loading: authLoading, authFetch, user } = useAuth();
  const [editando, setEditando] = useState<EquipoEditable | null>(null);
  const editable = puedeEditarEquipos(user);
  const [wh, setWh] = useState<Warehouse | null>(null);
  const [equipos, setEquipos] = useState<EquipResp | null>(null);
  const [search, setSearch] = useState("");

  // Datos de la bodega (nombre/descripción) desde el listado.
  useEffect(() => {
    if (authLoading) return;
    void authFetch("/network/equipment-warehouses")
      .then((r) => r.json())
      .then((list: Warehouse[]) => setWh(list.find((w) => w.id === id) ?? null))
      .catch(() => setWh(null));
  }, [authLoading, authFetch, id]);

  const loadEquipos = useCallback(async (q: string) => {
    const params = new URLSearchParams({ warehouseId: id, pageSize: "100" });
    if (q.trim()) params.set("search", q.trim());
    try {
      const r = await authFetch(`/network/equipment?${params}`).then((x) => x.json());
      setEquipos(r);
    } catch {
      setEquipos({ items: [], total: 0, page: 1, pageSize: 100, pages: 0 });
    }
  }, [authFetch, id]);

  useEffect(() => {
    if (authLoading) return;
    const t = setTimeout(() => void loadEquipos(search), search ? 300 : 0);
    return () => clearTimeout(t);
  }, [authLoading, search, loadEquipos]);

  if (authLoading || !equipos) return <PageSkeleton />;

  return (
    <div className="flex flex-col gap-4">
      <PageHeading icon="warehouse" title={wh ? `Bodega: ${wh.name}` : "Bodega"} subtitle={wh?.description || "Equipos almacenados en esta sede"} />
      <EditarEquipoModal equipo={editando} onClose={() => setEditando(null)} onSaved={() => void loadEquipos(search)} />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center gap-2 rounded-xl border border-border-subtle bg-surface px-4 py-2 text-[13px]">
          <Icon name="router" size={16} className="text-brand" />
          <span className="font-bold text-text-primary">{equipos.total.toLocaleString("es-CO")}</span>
          <span className="text-text-tertiary">equipos en esta bodega</span>
        </span>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Icon name="search" size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Código, MAC, serial o marca…" className="w-64 pl-8" />
          </div>
          <Link
            href="/red/equipos"
            className="inline-flex items-center gap-1 rounded-lg border border-border-default px-2.5 py-1.5 text-[12px] font-semibold text-text-secondary transition-colors hover:bg-surface-2"
          >
            <Icon name="external-link" size={13} /> Administrar equipos
          </Link>
        </div>
      </div>

      <DataTable
        rows={equipos.items}
        empty={search ? "Ningún equipo coincide con la búsqueda." : "Esta bodega no tiene equipos."}
        columns={[
          { key: "code", header: "Código", render: (r: EquipItem) => <span className="font-mono text-text-secondary">{r.code}</span> },
          { key: "brand", header: "Marca", render: (r: EquipItem) => r.brand ?? "—" },
          { key: "mac", header: "MAC", render: (r: EquipItem) => <span className="font-mono text-text-secondary">{r.mac ?? "—"}</span> },
          { key: "serial", header: "Serial", render: (r: EquipItem) => <span className="font-mono text-text-tertiary">{r.serial ?? "—"}</span> },
          { key: "acs", header: "ACS", render: (r: EquipItem) => r.genieacs ? <Badge label="GenieACS" tone="info" /> : "—" },
          { key: "client", header: "Asignado a", render: (r: EquipItem) => r.subscriberId
              ? <Link href={`/clientes/${r.subscriberId}`} className="text-brand hover:underline">{r.client}</Link>
              : <span className="text-text-tertiary">— disponible</span> },
          { key: "status", header: "Estado", render: (r: EquipItem) => (
              <Badge label={r.status ?? "—"} tone={r.status === "Disponible" ? "success" : r.status === "Asignado" || r.status === "Instalado" ? "info" : "default"} />
            ) },
          ...(editable ? [{ key: "edit", header: "", align: "right" as const, render: (r: EquipItem) => (
              <button onClick={() => setEditando(r)} title="Editar equipo"
                className="inline-flex items-center gap-1 rounded-lg border border-border-default px-2.5 py-1.5 text-[12px] font-semibold text-text-secondary transition-colors hover:bg-surface-2">
                <Icon name="pencil" size={13} /> Editar
              </button>
            ) }] : []),
        ]}
      />
      {equipos.total > equipos.items.length && (
        <p className="text-[12px] text-text-tertiary">
          Mostrando {equipos.items.length} de {equipos.total.toLocaleString("es-CO")}. Usa la búsqueda para acotar o entra a{" "}
          <Link href="/red/equipos" className="text-brand hover:underline">Administrar equipos</Link>.
        </p>
      )}
    </div>
  );
}
