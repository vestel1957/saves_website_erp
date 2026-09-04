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

/**
 * Medianoche UTC exacta = valor "solo fecha": así serializa el backend sus columnas
 * de día (invoiceDate, dueDate…, construidas con Date.UTC a las 00:00:00.000Z).
 * Esas hay que pintarlas en UTC: en Bogotá (UTC-5) la factura del 01/08 se veía
 * como 31/07 porque el navegador la corría a las 7 p. m. del día anterior.
 * Un timestamp real (createdAt, pagos) prácticamente nunca cae en la medianoche
 * UTC exacta, así que esos siguen saliendo en hora local, que es lo que se espera.
 */
const esSoloFecha = (f: Date) =>
  f.getUTCHours() === 0 && f.getUTCMinutes() === 0 && f.getUTCSeconds() === 0 && f.getUTCMilliseconds() === 0;

/** Fecha corta es-CO. Nulo/vacío → guion largo, que es lo que espera la UI. */
export function fmtDate(d: string | Date | null | undefined): string {
  if (!d) return "—";
  const fecha = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(fecha.getTime())) return "—";
  return fecha.toLocaleDateString("es-CO", esSoloFecha(fecha) ? { timeZone: "UTC" } : undefined);
}

/**
 * Día largo con su nombre: "martes, 25 de agosto de 2026".
 *
 * Para encabezar agrupaciones por día, donde la fecha corta se lee como un dato más
 * de la fila y no como el título del bloque.
 */
export function fmtDiaLargo(d: string | Date | null | undefined): string {
  if (!d) return "—";
  const fecha = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(fecha.getTime())) return "—";
  return fecha.toLocaleDateString("es-CO", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
    ...(esSoloFecha(fecha) ? { timeZone: "UTC" } : {}),
  });
}

/** Sólo la hora ("5:11 p. m."), para cuando el día ya está escrito al lado. */
export function fmtHora(d: string | Date | null | undefined): string {
  if (!d) return "—";
  const fecha = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(fecha.getTime())) return "—";
  return fecha.toLocaleTimeString("es-CO", { hour: "numeric", minute: "2-digit" });
}

/** Fecha y hora es-CO, para hilos, auditoría y movimientos. */
export function fmtDateTime(d: string | Date | null | undefined): string {
  if (!d) return "—";
  const fecha = d instanceof Date ? d : new Date(d);
  return Number.isNaN(fecha.getTime())
    ? "—"
    : fecha.toLocaleString("es-CO", { dateStyle: "medium", timeStyle: "short" });
}

// ── Moneda ──────────────────────────────────────────────────────────────────

/**
 * Pesos colombianos, sin decimales. Es la forma que usa todo el ERP (52 ficheros).
 *
 * OJO: `lib/payroll.ts` exporta otro `cop` que produce un formato DISTINTO
 * ("$1.234" con toLocaleString, en vez del formato de moneda de Intl). No se unifica
 * a la ligera porque cambiaría el aspecto de las nóminas impresas; queda anotado.
 */
export const cop = (n: number): string =>
  new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(n || 0);
