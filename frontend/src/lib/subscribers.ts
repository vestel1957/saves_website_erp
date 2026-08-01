// Cliente/tipos del módulo de Clientes (abonados ISP) — vertical Vestel.

export type SubscriberRow = {
  id: string;
  abonado: number;
  name: string;
  docType: string | null;
  docNumber: string | null;
  phone: string | null;
  email: string | null;
  status: string | null;
  branch: string | null;
  /** Saldo a favor del abonado (cache de transacciones). NO es lo que debe. */
  balance: number;
  /** Lo que debe: Σ(total − pagado) de sus facturas sin pagar. */
  debt: number;
  installTech: string | null;
};

export type SubscriberList = {
  items: SubscriberRow[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
};

export type SubscriberStats = {
  total: number;
  activos: number;
  cartera: number;
  cortados: number;
  suspendidos: number;
  status: Record<string, number>;
  carteraTotal: number;
};

export type Branch = { id: string; name: string };

/** Estados del ciclo de vida y su presentación. */
export const SUB_STATUS_LABEL: Record<string, string> = {
  ACTIVO: "Activo", CARTERA: "Cartera", COMPROMISO: "Compromiso", CORTADO: "Cortado",
  DEPURADO: "Depurado", EVENTO: "Evento", EXONERADO: "Exonerado", INSTALAR: "Instalar",
  POR_RETIRAR: "Por retirar", REPORTADO: "Reportado", RETIRADO: "Retirado",
  SUSPENDIDO: "Suspendido", INACTIVO: "Inactivo",
};

export const SUB_STATUS_TONE: Record<string, "success" | "error" | "warning" | "info" | "default"> = {
  ACTIVO: "success", CARTERA: "error", CORTADO: "error", REPORTADO: "error",
  COMPROMISO: "warning", SUSPENDIDO: "warning", POR_RETIRAR: "warning",
  INSTALAR: "info", EXONERADO: "info",
  DEPURADO: "default", RETIRADO: "default", EVENTO: "default", INACTIVO: "default",
};

/** Opciones de filtro adicionales (heredadas del legacy: servicio, tecnología, cuenta). */
export const SUB_SERVICIO_OPTS: { value: string; label: string }[] = [
  { value: "", label: "Todos los servicios" },
  { value: "internet", label: "Solo Internet" },
  { value: "tv", label: "Solo TV" },
  { value: "combo", label: "Combo (Internet + TV)" },
];

export const SUB_TECH_OPTS: { value: string; label: string }[] = [
  { value: "", label: "Toda tecnología" },
  { value: "FTTH", label: "Fibra (FTTH)" },
  { value: "EOC", label: "EOC / cobre" },
];

/**
 * Estado de cuenta. Combina en un solo select los dos parámetros del backend
 * (`cuenta` = aldia|debe|compromiso y `deuda` = 1|gt2). `cuentaParams` traduce
 * el valor elegido a los query params correctos.
 */
export const SUB_CUENTA_OPTS: { value: string; label: string }[] = [
  { value: "", label: "Toda la cuenta" },
  { value: "aldia", label: "Al día" },
  { value: "debe", label: "Con deuda" },
  { value: "debe1", label: "Debe 1 mes" },
  { value: "debeGt2", label: "Debe +2 meses" },
  { value: "compromiso", label: "En compromiso" },
];

/** Traduce el valor del select de "Estado de cuenta" a los query params del backend. */
export function cuentaParams(v: string): { cuenta?: string; deuda?: string } {
  if (v === "debe1") return { deuda: "1" };
  if (v === "debeGt2") return { deuda: "gt2" };
  if (v === "aldia" || v === "debe" || v === "compromiso") return { cuenta: v };
  return {};
}

export const INVOICE_STATUS_LABEL: Record<string, string> = {
  PAID: "Pagada", DUE: "Pendiente", PARTIAL: "Parcial", CANCELED: "Anulada",
};
export const INVOICE_STATUS_TONE: Record<string, "success" | "error" | "warning" | "default"> = {
  PAID: "success", DUE: "error", PARTIAL: "warning", CANCELED: "default",
};

/** Tipo de factura (InvoiceKind). */
export const INVOICE_KIND_LABEL: Record<string, string> = {
  RECURRENTE: "Recurrente", FIJA: "Fija", NOTA_CREDITO: "Nota crédito", NOTA_DEBITO: "Nota débito",
};

/**
 * Estado del cliente capturado en la factura (InvoiceRon = eje servicio/cartera).
 * Es el "estado del usuario a la hora de crear la factura".
 */
export const INVOICE_RON_LABEL: Record<string, string> = {
  ACTIVO: "Activo", INSTALAR: "Instalar", CORTADO: "Cortado", SUSPENDIDO: "Suspendido",
  EXONERADO: "Exonerado", CARTERA: "Cartera", COMPROMISO: "Compromiso", DEPURADO: "Depurado",
  RETIRADO: "Retirado", ANULADO: "Anulado", REPORTADO: "Reportado", EVENTO: "Evento",
  DADO_DE_BAJA: "Dado de baja", POR_RETIRAR: "Por retirar",
};
export const INVOICE_RON_TONE: Record<string, "success" | "error" | "warning" | "info" | "default"> = {
  ACTIVO: "success", CARTERA: "error", CORTADO: "error", REPORTADO: "error", ANULADO: "error",
  COMPROMISO: "warning", SUSPENDIDO: "warning", POR_RETIRAR: "warning",
  INSTALAR: "info", EXONERADO: "info",
  DEPURADO: "default", RETIRADO: "default", EVENTO: "default", DADO_DE_BAJA: "default",
};

// La implementación vive en `lib/format.ts`; se reexporta para no tocar los 52
// ficheros que ya la importan desde aquí.
export { cop } from "./format";

/** Solo dígitos, normalizando a formato internacional Colombia (57 + 10 dígitos). */
export function toE164Co(phone?: string | null): string | null {
  if (!phone) return null;
  const d = phone.replace(/\D/g, "");
  if (!d) return null;
  if (d.length === 10) return `57${d}`;
  if (d.length === 12 && d.startsWith("57")) return d;
  return d; // se deja tal cual si no calza el patrón típico
}

/** Enlace a chat de WhatsApp (wa.me), o null si no hay número válido. */
export const waLink = (phone?: string | null) => {
  const e = toE164Co(phone);
  return e ? `https://wa.me/${e}` : null;
};

/** Iniciales para el avatar (máx. 2). */
export function initials(name?: string | null): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
}

/** Antigüedad legible desde una fecha de ingreso (ej. "hace 3 años"). */
export function antiguedad(entry?: string | null): string | null {
  if (!entry) return null;
  const start = new Date(entry).getTime();
  if (Number.isNaN(start)) return null;
  const days = Math.floor((Date.now() - start) / 86_400_000);
  if (days < 0) return null;
  if (days < 30) return `hace ${days} día${days === 1 ? "" : "s"}`;
  const months = Math.floor(days / 30);
  if (months < 12) return `hace ${months} ${months === 1 ? "mes" : "meses"}`;
  const years = Math.floor(days / 365);
  const rem = Math.floor((days - years * 365) / 30);
  return rem > 0 ? `hace ${years} a. ${rem} m.` : `hace ${years} año${years === 1 ? "" : "s"}`;
}

/** Clases de color del avatar según el tono del estado del cliente. */
export const STATUS_AVATAR_CLASS: Record<string, string> = {
  success: "bg-success-soft text-success-text",
  error: "bg-error-soft text-error-text",
  warning: "bg-warning-soft text-warning-text",
  info: "bg-info-soft text-info-text",
  default: "bg-surface-2 text-text-secondary",
};
