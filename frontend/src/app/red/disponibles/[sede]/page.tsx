"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { fmtDate } from "@/lib/format";
import { Icon } from "@/components/Icon";
import { PageHeading } from "@/components/ui/PageHeading";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { DataTable } from "@/components/ui/DataTable";
import { ListToolbar } from "@/components/ui/ListToolbar";
import { Pagination } from "@/components/ui/Pagination";
import { StatCard } from "@/components/ui/StatCard";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { NuevoEquipoModal } from "@/components/red/NuevoEquipoModal";
import { NuevaTransferenciaModal } from "@/components/red/NuevaTransferenciaModal";
import { useAuth } from "@/context/AuthProvider";
import { SEDES_DISPONIBLES } from "@/lib/nav";
import { listaJson } from "@/lib/errores";
import { useRequest } from "@/lib/useRequest";

type Bodega = { id: string; name: string; branchLegacy: number | null };
type Disponible = {
  id: string; code: number; mac: string | null; serial: string | null; brand: string | null; status: string | null;
  returnedAt: string | null; warehouse: string | null; enOlt: boolean;
};
type Resp = {
  sedes: { legacyId: number; name: string; total: number; bodegas: { id: string; name: string; total: number }[] }[];
  items: Disponible[]; filtrados: number; page: number; pageSize: number; pages: number;
};

/**
 * Equipos disponibles de UNA sede (2026-09-14).
 *
 * Desde aquí se suben equipos nuevos a las bodegas de la sede y se piden traspasos
 * entre bodegas de equipos (mismo flujo y mismas firmas que Transferencias). La
 * lista muestra lo que está sin cliente y en buen estado en esas bodegas — ver
 * `NetworkService.equipmentAvailable`.
 */
export default function EquiposDisponiblesSedePage() {
  const { sede } = useParams<{ sede: string }>();
  const actual = SEDES_DISPONIBLES.find((s) => s.slug === sede);
  const { loading: authLoading, authFetch, can } = useAuth();
  // Dar de alta equipo: administración o el jefe de bodega (el backend lo revalida).
  const puedeSubir = can(["area.administracion", "inventory.admin"]);

  const [bodegas, setBodegas] = useState<Bodega[] | null>(null);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [subir, setSubir] = useState(false);
  const [traspaso, setTraspaso] = useState(false);

  useEffect(() => {
    if (authLoading || !actual) return;
    void authFetch("/network/warehouses")
      .then(listaJson<Bodega>)
      .then((l) => setBodegas(l.filter((w) => w.branchLegacy === actual.legacyId)))
      .catch(() => setBodegas([]));
  }, [authLoading, authFetch, actual]);

  const { data, cargando, refrescar } = useRequest<Resp>(
    () => {
      if (!actual) return null;
      const qs = new URLSearchParams({ branch: String(actual.legacyId), page: String(page), pageSize: String(pageSize) });
      if (search.trim()) qs.set("search", search.trim());
      return `/network/equipment-available?${qs}`;
    },
    [actual?.legacyId, page, pageSize, search],
    { debounceMs: search ? 350 : 0, saltar: authLoading || !actual },
  );

  useEffect(() => { setPage(1); }, [search, pageSize, sede]);

  const resumen = useMemo(() => data?.sedes.find((s) => s.legacyId === actual?.legacyId) ?? null, [data, actual]);
  const bodegasSede = useMemo(() => (bodegas ?? []).map((b) => ({ id: b.id, name: b.name })), [bodegas]);

  if (!actual) {
    return <p className="p-6 text-[13px] text-text-secondary">Esta sede no existe.</p>;
  }
  if (authLoading || bodegas === null || (cargando && !data)) return <PageSkeleton />;

  // Una cajera sólo ve sus sedes: aquí la respuesta no trae esta.
  const fueraDeAlcance = !!data && !resumen;
  const sinBodega = bodegas.length === 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <PageHeading icon="package-check" title={`Equipos disponibles · ${actual.label}`} subtitle="Sin cliente y en buen estado, en las bodegas de la sede" />
        {!fueraDeAlcance && !sinBodega && (
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={() => setTraspaso(true)}>
              <Icon name="arrow-left-right" size={14} /> Traspaso de equipos
            </Button>
            {puedeSubir && (
              <Button size="sm" onClick={() => setSubir(true)}>
                <Icon name="plus" size={14} /> Subir equipo
              </Button>
            )}
          </div>
        )}
      </div>

      <NuevoEquipoModal open={subir} onClose={() => setSubir(false)} onCreated={refrescar} bodegas={bodegasSede} />
      <NuevaTransferenciaModal open={traspaso} onClose={() => setTraspaso(false)} onCreated={refrescar} sedeOrigen={actual.legacyId} />

      {fueraDeAlcance ? (
        <Aviso texto={`${actual.label} no es de tu sede, así que no ves ni mueves sus equipos.`} />
      ) : sinBodega ? (
        <Aviso texto={`${actual.label} todavía no tiene bodega de equipos, así que aquí no se pueden subir ni traspasar equipos.`} />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard icon="package-check" label="Disponibles en la sede" value={(resumen?.total ?? 0).toLocaleString("es-CO")} />
            {(resumen?.bodegas ?? []).map((b) => (
              <StatCard key={b.id} icon="warehouse" label={b.name} value={b.total.toLocaleString("es-CO")} />
            ))}
          </div>

          <ListToolbar search={search} onSearch={setSearch} searchPlaceholder="Buscar por código, MAC, serial o marca…" />

          <DataTable
            rows={data?.items ?? []}
            loading={cargando}
            empty={search ? "Ningún equipo disponible coincide con la búsqueda." : `No hay equipos disponibles en ${actual.label}.`}
            columns={[
              { key: "code", header: "Código", render: (r: Disponible) => <span className="font-mono text-text-secondary">{r.code}</span> },
              { key: "brand", header: "Marca", render: (r: Disponible) => r.brand ?? "—" },
              { key: "mac", header: "MAC", render: (r: Disponible) => <span className="font-mono text-text-secondary">{r.mac ?? "—"}</span> },
              { key: "serial", header: "Serial", render: (r: Disponible) => (
                  <span className="flex items-center gap-1.5">
                    <span className="font-mono text-text-tertiary">{r.serial ?? "—"}</span>
                    {r.enOlt && <span title="Este serial está autenticado en una OLT: probablemente está instalado en una casa y no en el estante."><Badge label="En una OLT" tone="warning" /></span>}
                  </span>
                ) },
              { key: "wh", header: "Bodega", render: (r: Disponible) => <span className="text-[12px] text-text-secondary">{r.warehouse ?? "—"}</span> },
              { key: "status", header: "Estado", render: (r: Disponible) => <Badge label={r.status ?? "—"} tone="success" /> },
              { key: "returned", header: "Devuelto", render: (r: Disponible) => r.returnedAt ? <span className="text-text-secondary">{fmtDate(r.returnedAt)}</span> : <span className="text-text-tertiary">—</span> },
            ]}
          />
          {data && (
            <Pagination meta={{ page: data.page, pageSize: data.pageSize, total: data.filtrados, pageCount: data.pages }} onPage={setPage} onPageSize={setPageSize} />
          )}
        </>
      )}
    </div>
  );
}

function Aviso({ texto }: { texto: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border-default bg-surface px-6 py-16 text-center">
      <Icon name="map-pin" size={22} className="text-text-tertiary" />
      <p className="text-[13px] text-text-secondary">{texto}</p>
    </div>
  );
}
