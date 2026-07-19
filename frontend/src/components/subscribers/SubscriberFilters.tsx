"use client";

import { Select } from "@/components/ui/Field";
import { SUB_SERVICIO_OPTS, SUB_TECH_OPTS, SUB_CUENTA_OPTS } from "@/lib/subscribers";

/**
 * Selects de filtro adicionales para el buscador de clientes (servicio,
 * tecnología y estado de cuenta), heredados del listado del legacy.
 * Comparte estado con la página que lo usa vía value/onChange.
 */
export function SubscriberFilters({
  servicio, tecnologia, cuenta,
  onServicio, onTecnologia, onCuenta,
}: {
  servicio: string;
  tecnologia: string;
  cuenta: string;
  onServicio: (v: string) => void;
  onTecnologia: (v: string) => void;
  onCuenta: (v: string) => void;
}) {
  return (
    <>
      <Select value={servicio} onChange={(e) => onServicio(e.target.value)} className="w-auto" aria-label="Servicio">
        {SUB_SERVICIO_OPTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </Select>
      <Select value={tecnologia} onChange={(e) => onTecnologia(e.target.value)} className="w-auto" aria-label="Tecnología">
        {SUB_TECH_OPTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </Select>
      <Select value={cuenta} onChange={(e) => onCuenta(e.target.value)} className="w-auto" aria-label="Estado de cuenta">
        {SUB_CUENTA_OPTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </Select>
    </>
  );
}
