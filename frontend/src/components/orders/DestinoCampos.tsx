"use client";

import { useEffect, useMemo, useState } from "react";
import { Select, Field } from "@/components/ui/Field";
import { useAuth } from "@/context/AuthProvider";

/** Bodega destino y sede de una orden de compra (lo que el legacy llama `almacen_seleccionado` y `refer`). */
export type Destino = { warehouseId: string; branch: string };

export const destinoVacio = (): Destino => ({ warehouseId: "", branch: "" });

type Bodega = { id: string; title: string; isMain: boolean; branchLegacy: number | null; branch: string | null };
type Destinos = { branches: { legacyId: number; name: string }[]; warehouses: Bodega[] };

/** Sedes y bodegas de `GET /orders/destinations`, cargadas una vez por pantalla. */
export function useDestinos() {
  const { loading, authFetch } = useAuth();
  const [data, setData] = useState<Destinos>({ branches: [], warehouses: [] });
  useEffect(() => {
    if (loading) return;
    void authFetch("/orders/destinations")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setData(d))
      .catch(() => {});
  }, [loading, authFetch]);
  return data;
}

/**
 * Selectores de sede y bodega destino. Escoger una bodega con sede llena la sede; la
 * sede acota la lista a sus bodegas más las que no tienen sede ("Productos de
 * compra"), que el legacy usa para compras de todas las sedes.
 */
export function DestinoCampos({
  value, onChange, requireWarehouse, destinos, soloBodega = false,
}: {
  value: Destino;
  onChange: (v: Destino) => void;
  /** Compra de material: sin bodega, lo recibido no entra a ningún inventario. */
  requireWarehouse: boolean;
  destinos: Destinos;
  /** Solo el selector de bodega (al recibir, la sede ya es de la orden). */
  soloBodega?: boolean;
}) {
  const bodegas = useMemo(
    () => destinos.warehouses.filter((w) => soloBodega || !value.branch || !w.branch || w.branch === value.branch),
    [destinos.warehouses, value.branch, soloBodega],
  );
  const elegirBodega = (id: string) => {
    const w = destinos.warehouses.find((x) => x.id === id);
    onChange({ warehouseId: id, branch: w?.branch ?? value.branch });
  };
  const elegirSede = (branch: string) => {
    const w = destinos.warehouses.find((x) => x.id === value.warehouseId);
    // La bodega de otra sede deja de servir; la que no tiene sede, sí.
    onChange({ branch, warehouseId: w && w.branch && w.branch !== branch ? "" : value.warehouseId });
  };

  const selectorBodega = (
    <Field
      label="Bodega destino"
      required={requireWarehouse}
      hint={requireWarehouse ? "Aquí entra el material al darle Recibir" : "Opcional en órdenes de servicio"}
    >
      <Select value={value.warehouseId} onChange={(e) => elegirBodega(e.target.value)}>
        <option value="">{requireWarehouse ? "Escoge la bodega…" : "Sin bodega"}</option>
        {bodegas.map((w) => (
          <option key={w.id} value={w.id}>{w.title}{w.branch ? "" : " (sin sede)"}{w.isMain ? " · principal" : ""}</option>
        ))}
      </Select>
    </Field>
  );
  if (soloBodega) return selectorBodega;

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Field label="Sede" required>
        <Select value={value.branch} onChange={(e) => elegirSede(e.target.value)}>
          <option value="">Escoge la sede…</option>
          {destinos.branches.map((b) => <option key={b.legacyId} value={b.name}>{b.name}</option>)}
        </Select>
      </Field>
      {selectorBodega}
    </div>
  );
}
