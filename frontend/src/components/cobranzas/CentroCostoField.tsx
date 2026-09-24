"use client";

import { useEffect, useState } from "react";
import { Select, Field } from "@/components/ui/Field";
import { useAuth } from "@/context/AuthProvider";
import { type CashAccount } from "@/lib/cobranzas";

export type CentroCosto = {
  id: string; code: string; name: string; parentId: string | null;
  kind?: "SEDE" | "GENERAL" | "OTRO";
  branch?: { legacyId: number; name: string } | null;
};

/**
 * Centros de costo activos para el selector de ingresos y egresos. `null` = quien
 * registra no puede verlos (la cajera): el campo no sale y el asiento toma el de su caja.
 */
export function useCentrosCosto(activo: boolean) {
  const { authFetch, can } = useAuth();
  const puede = can(["area.contabilidad", "area.administracion", "area.gerencia"]);
  const [centros, setCentros] = useState<CentroCosto[] | null>(null);
  useEffect(() => {
    if (!activo || !puede) return;
    void authFetch("/accounting/cost-centers")
      .then((r) => (r.ok ? r.json() : null))
      .then((rows: CentroCosto[] | null) => setCentros(Array.isArray(rows) ? rows : null))
      .catch(() => setCentros(null));
  }, [activo, puede, authFetch]);
  return puede ? centros : null;
}

/**
 * Lo mismo que decide el backend (`common/centro-costo.ts`, `centroDeTesoreria`) cuando no
 * se elige centro: la sede de la caja; el banco (`branchLegacy` 0) va a Administración
 * general; sin caja o caja sin sede, «Sin asignar». Sólo sirve para rotular la opción
 * automática: quien manda es el servidor.
 */
function centroSugerido(centros: CentroCosto[], caja: CashAccount | null | undefined) {
  if (!caja || caja.branchLegacy == null) return null;
  if (caja.branchLegacy === 0) {
    return centros.find((c) => c.code === "CC-ADMIN") ?? centros.find((c) => c.kind === "GENERAL") ?? null;
  }
  return centros.find((c) => c.branch?.legacyId === caja.branchLegacy) ?? null;
}

/**
 * Selector OPCIONAL del centro de costo de un ingreso o egreso. Vacío = automático (el de
 * la caja), que es lo que se envía casi siempre; nunca bloquea el registro.
 */
export function CentroCostoField({ centros, caja, value, onChange }: {
  centros: CentroCosto[] | null;
  caja: CashAccount | null | undefined;
  value: string;
  onChange: (v: string) => void;
}) {
  if (!centros) return null;
  const sugerido = centroSugerido(centros, caja);
  // La raíz (y cualquier centro que agrupe a otros) no se imputa: sólo las hojas.
  const padres = new Set(centros.map((c) => c.parentId).filter(Boolean));
  const hojas = centros.filter((c) => !padres.has(c.id));
  return (
    <Field label="Centro de costo" hint="Opcional. Por defecto, el de la sede de la caja.">
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{`Automático — ${sugerido ? sugerido.name : "sin asignar"}`}</option>
        {hojas.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </Select>
    </Field>
  );
}
