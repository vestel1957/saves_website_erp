/** Compact currency, e.g. 968000 -> "$968K", 1820000 -> "$1.82M" */
export function compactCurrency(value: number): string {
  if (Math.abs(value) >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
  }
  if (Math.abs(value) >= 1_000) {
    return `$${Math.round(value / 1_000)}K`;
  }
  return `$${value}`;
}

/** Full currency, e.g. 248930 -> "$248,930" */
export function fullCurrency(value: number): string {
  return `$${value.toLocaleString("en-US")}`;
}

/** Fecha legible para el encabezado, p. ej. "martes, 9 de junio" */
export function headerDate(d = new Date()): string {
  return d.toLocaleDateString("es-CO", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

// ── Fechas ──────────────────────────────────────────────────────────────────
// Estaban replicadas ~31 veces, casi siempre con la MISMA línea. Ojo al consolidar:
// conviven variantes que no son equivalentes (sólo fecha, fecha+hora, estilos
// distintos), así que aquí van las dos canónicas y cada pantalla usa la que toca.

/** Fecha corta es-CO. Nulo/vacío → guion largo, que es lo que espera la UI. */
export function fmtDate(d: string | Date | null | undefined): string {
  if (!d) return "—";
  const fecha = d instanceof Date ? d : new Date(d);
  return Number.isNaN(fecha.getTime()) ? "—" : fecha.toLocaleDateString("es-CO");
}

/** Fecha y hora es-CO, para hilos, auditoría y movimientos. */
export function fmtDateTime(d: string | Date | null | undefined): string {
  if (!d) return "—";
  const fecha = d instanceof Date ? d : new Date(d);
  return Number.isNaN(fecha.getTime())
    ? "—"
    : fecha.toLocaleString("es-CO", { dateStyle: "medium", timeStyle: "short" });
}
