"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { Badge } from "@/components/ui/Badge";
import { Input } from "@/components/ui/Field";
import { DataTable } from "@/components/ui/DataTable";
import { PagedTable } from "@/components/ui/PagedTable";
import { ListToolbar } from "@/components/ui/ListToolbar";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { useAuth } from "@/context/AuthProvider";
import { esTecnico } from "@/lib/support";
import { listaJson, objetoJson } from "@/lib/errores";

type Warehouse = { id: string; name: string; description?: string | null; equipment?: number };
type EquipItem = {
  id: string; code: number; mac: string | null; serial: string | null; brand: string | null;
  status: string | null; warehouse: string | null; client: string | null; subscriberId: string | null; genieacs: boolean;
};
type EquipResp = { items: EquipItem[]; total: number; page: number; pageSize: number; pages: number };

/**
 * El técnico no ve bodegas: ve SUS equipos (2026-07-31).
 *
 * No hay bodega por técnico —el legacy sólo tuvo bodegas por sede— así que la lista
 * de bodegas no le dice nada. Lo que sí existe es el equipo puesto a su nombre
 * (`Equipment.assignedRaw`), y eso es lo que se le pinta, sin el rodeo de entrar a
 * una bodega de una sola fila. El recorte real lo hace el backend: `/network/equipment`
 * le devuelve sólo lo suyo pida lo que pida.
 */
function MisEquipos() {
  const { authFetch } = useAuth();
  const [equipos, setEquipos] = useState<EquipResp | null>(null);
  const [search, setSearch] = useState("");

  const cargar = useCallback(async (q: string) => {
    const params = new URLSearchParams({ pageSize: "100" });
    if (q.trim()) params.set("search", q.trim());
    const vacio: EquipResp = { items: [], total: 0, page: 1, pageSize: 100, pages: 0 };
    try {
      // `objetoJson` y no `.json()` a secas: el cuerpo de un error TAMBIÉN es JSON
      // válido, así que un 403 se colaba en el estado y el `equipos.items.map` del
      // render tumbaba la pantalla entera con "Algo se rompió en esta pantalla"
      // (ver lib/errores.ts). Sin datos la vista se degrada; no se cae.
      setEquipos((await authFetch(`/network/equipment?${params}`).then(objetoJson<EquipResp>)) ?? vacio);
    } catch {
      setEquipos(vacio);
    }
  }, [authFetch]);

  useEffect(() => {
    const t = setTimeout(() => void cargar(search), search ? 300 : 0);
    return () => clearTimeout(t);
  }, [search, cargar]);

  if (!equipos) return <PageSkeleton />;

  return (
    <div className="flex flex-col gap-4">
      <PageHeading icon="router" title="Mis equipos" subtitle="Los equipos que están a tu nombre" />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center gap-2 rounded-xl border border-border-subtle bg-surface px-4 py-2 text-[13px]">
          <Icon name="router" size={16} className="text-brand" />
          <span className="font-bold text-text-primary">{equipos.total.toLocaleString("es-CO")}</span>
          <span className="text-text-tertiary">{equipos.total === 1 ? "equipo a tu nombre" : "equipos a tu nombre"}</span>
        </span>
        <div className="relative">
          <Icon name="search" size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Código, MAC, serial o marca…" className="w-64 pl-8" />
        </div>
      </div>

      <DataTable
        rows={equipos.items}
        empty={search ? "Ningún equipo tuyo coincide con la búsqueda." : "No tienes equipos a tu nombre. Cuando bodega te entregue uno, aparece aquí."}
        columns={[
          { key: "code", header: "Código", render: (r: EquipItem) => <span className="font-mono text-text-secondary">{r.code}</span> },
          { key: "brand", header: "Marca", render: (r: EquipItem) => r.brand ?? "—" },
          { key: "mac", header: "MAC", render: (r: EquipItem) => <span className="font-mono text-text-secondary">{r.mac ?? "—"}</span> },
          { key: "serial", header: "Serial", render: (r: EquipItem) => <span className="font-mono text-text-tertiary">{r.serial ?? "—"}</span> },
          { key: "acs", header: "ACS", render: (r: EquipItem) => r.genieacs ? <Badge label="GenieACS" tone="info" /> : "—" },
          { key: "wh", header: "Bodega", render: (r: EquipItem) => <span className="text-[12px] text-text-secondary">{r.warehouse ?? "—"}</span> },
          { key: "status", header: "Estado", render: (r: EquipItem) => (
              <Badge label={r.status ?? "—"} tone={r.status === "Disponible" ? "success" : r.status === "Asignado" || r.status === "Instalado" ? "info" : "default"} />
            ) },
        ]}
      />
      {equipos.total > equipos.items.length && (
        <p className="text-[12px] text-text-tertiary">
          Mostrando {equipos.items.length} de {equipos.total.toLocaleString("es-CO")}. Usa la búsqueda para acotar.
        </p>
      )}
    </div>
  );
}

export default function BodegaEquiposPage() {
  const { loading: authLoading, authFetch, user } = useAuth();
  const [rows, setRows] = useState<Warehouse[] | null>(null);
  const [search, setSearch] = useState("");
  const soloLoSuyo = esTecnico(user);

  useEffect(() => {
    if (authLoading || soloLoSuyo) return;
    void authFetch("/network/equipment-warehouses")
      .then(listaJson<Warehouse>)
      .then(setRows)
      .catch(() => setRows([]));
  }, [authLoading, authFetch, soloLoSuyo]);

  // Filtro en cliente por nombre/descripción sobre lo ya cargado.
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q || !rows) return rows ?? [];
    return rows.filter((w) => [w.name, w.description].some((v) => (v ?? "").toLowerCase().includes(q)));
  }, [rows, search]);

  if (authLoading) return <PageSkeleton />;
  if (soloLoSuyo) return <MisEquipos />;
  if (!rows) return <PageSkeleton />;
  const totalEquipos = rows.reduce((s, w) => s + (w.equipment ?? 0), 0);

  return (
    <div className="flex flex-col gap-4">
      <PageHeading icon="boxes" title="Bodegas de equipos" subtitle="Almacenes de equipos por sede — abre una para ver su contenido" />

      <div className="flex items-center gap-3 rounded-xl border border-border-subtle bg-surface px-4 py-3 shadow-sm">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-soft text-brand"><Icon name="boxes" size={17} /></span>
        <div>
          <div className="text-[11px] text-text-tertiary">Total equipos en bodega</div>
          <div className="text-[18px] font-bold text-text-primary">{totalEquipos.toLocaleString("es-CO")}</div>
        </div>
        <div className="ml-4 border-l border-border-subtle pl-4">
          <div className="text-[11px] text-text-tertiary">Bodegas</div>
          <div className="text-[18px] font-bold text-text-primary">{rows.length}</div>
        </div>
      </div>

      <ListToolbar search={search} onSearch={setSearch} searchPlaceholder="Buscar bodega…" />

      {/* Tabla de bodegas: al dar click en una fila se abre su vista de equipos. */}
      <PagedTable
        rows={shown}
        empty={search ? "Ninguna bodega coincide con la búsqueda." : "Sin bodegas."}
        rowHref={(w: Warehouse) => `/red/bodegas/${w.id}`}
        columns={[
          { key: "name", header: "Bodega", render: (w: Warehouse) => (
              <span className="flex items-center gap-2 font-medium text-text-primary">
                <Icon name="warehouse" size={15} className="text-text-tertiary" />{w.name}
              </span>
            ) },
          { key: "desc", header: "Descripción", render: (w: Warehouse) => <span className="text-text-secondary">{w.description || "—"}</span> },
          { key: "eq", header: "Equipos", align: "right", render: (w: Warehouse) => <span className="font-semibold">{(w.equipment ?? 0).toLocaleString("es-CO")}</span> },
          { key: "go", header: "", align: "right", render: () => (
              <span className="inline-flex items-center gap-1 text-[12px] font-semibold text-text-tertiary">
                Ver equipos <Icon name="chevron-right" size={14} />
              </span>
            ) },
        ]}
      />
    </div>
  );
}
