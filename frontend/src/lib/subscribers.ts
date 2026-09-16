// Cliente/tipos del módulo de Clientes (abonados ISP) — vertical Vestel.

export type SubscriberRow = {
  id: string;
  /** ID del legacy (`customers.id`). null en los clientes creados en este stack. */
  legacyId: number | null;
  abonado: number;
  name: string;
  docType: string | null;
  docNumber: string | null;
  phone: string | null;
  email: string | null;
  status: string | null;
  branch: string | null;
  /** Barrio ya resuelto a nombre (en la BD es el id del catálogo legacy). */
  neighborhood: string | null;
  /** Municipio ya resuelto a nombre (en la BD es el id del catálogo legacy). */
  city: string | null;
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

/* Catálogos de valores fijos de la ficha del cliente (tomados literal del legacy
   `customers/edit.php`). Viven aquí porque ya son dos los formularios que los
   ofrecen: el wizard de alta/edición y las tarjetas de la ficha, que se editan
   en sitio. Dos copias acabarían ofreciendo listas distintas. */
export const CUSTOMER_TYPES = ["Natural", "Juridico", "Gubernamental", "Militar"];
export const DOC_TYPES = ["CC", "CE", "NIT", "PAS", "PPT"];
export const SUSCRIPCIONES = ["Residencial", "Corporativo", "Dedicado"];
export const ESTRATOS = ["Estrato 1", "Estrato 2", "Estrato 3", "Estrato 4", "Estrato 5", "Estrato 6", "Estrato 7", "Estrato 8"];
/** Tecnologías de instalación (enum `InstallTech` del backend). */
export const INSTALL_TECHS = ["GPON", "EPON", "EOC", "RADIO", "FIBRA"];

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
  // Por PLATA YA VENCIDA (lo que se mira para cortar) vs. por número de documentos
  // abiertos, que no es lo mismo: ver `debtIds` en el backend. Lo de "vencida" no es
  // un matiz: la factura del mes sale el día 1 y vence el 20, así que sin eso el que
  // está al día figura como deudor de una mensualidad desde el día 1.
  { value: "debeFija", label: "Debe una mensualidad o más ya vencida" },
  { value: "debe1", label: "Tiene 1 factura sin pagar" },
  { value: "debeGt2", label: "Tiene +2 facturas sin pagar" },
  { value: "compromiso", label: "En compromiso" },
];

/** Traduce el valor del select de "Estado de cuenta" a los query params del backend. */
export function cuentaParams(v: string): { cuenta?: string; deuda?: string } {
  if (v === "debeFija") return { deuda: "fija" };
  if (v === "debe1") return { deuda: "1" };
  if (v === "debeGt2") return { deuda: "gt2" };
  if (v === "aldia" || v === "debe" || v === "compromiso") return { cuenta: v };
  return {};
}

/**
 * TIPO DE DOCUMENTO de un adjunto del cliente (`SubscriberFile.kind`).
 *
 * Espejo de `backend/src/subscribers/subscriber-file-kinds.ts`, que es quien manda:
 * el backend rechaza con 400 cualquier tipo que no esté en su lista, así que si se
 * agrega uno aquí hay que agregarlo allá (y al revés).
 *
 * Dos de ellos NO son una simple etiqueta y suben por su propia ruta:
 * `CARTA_RETIRO` habilita el paz y salvo y `VIVIENDA` es la foto de la ficha.
 */
export const SUB_FILE_KIND_OPTS: { value: string; label: string; hint?: string }[] = [
  { value: "CARTA_RETIRO", label: "Carta de retiro", hint: "PDF o imagen · habilita el paz y salvo" },
  { value: "SUSPENSION", label: "Solicitud de suspensión" },
  { value: "SOLICITUD", label: "Solicitud / petición" },
  { value: "RECLAMO", label: "Reclamo (PQR)" },
  { value: "CONTRATO", label: "Contrato o anexo" },
  { value: "IDENTIDAD", label: "Documento de identidad" },
  { value: "SOPORTE_PAGO", label: "Soporte de pago" },
  { value: "TRASLADO", label: "Traslado" },
  { value: "CAMBIO_TITULAR", label: "Cambio de titular" },
  { value: "DEVOLUCION_EQUIPO", label: "Devolución de equipo" },
  { value: "ACTA", label: "Acta o constancia" },
  { value: "VIVIENDA", label: "Foto de la vivienda", hint: "JPG, PNG o WEBP · será la foto de la ficha" },
  { value: "OTRO", label: "Otro documento" },
];

export const SUB_FILE_KIND_LABEL: Record<string, string> = Object.fromEntries(
  SUB_FILE_KIND_OPTS.map((o) => [o.value, o.label]),
);

/** Color de la pastilla: los papeles que mueven el servicio saltan a la vista. */
export const SUB_FILE_KIND_TONE: Record<string, "success" | "error" | "warning" | "info" | "default" | "brand"> = {
  CARTA_RETIRO: "error", SUSPENSION: "warning", RECLAMO: "warning",
  SOLICITUD: "info", TRASLADO: "info", CAMBIO_TITULAR: "info",
  CONTRATO: "brand", SOPORTE_PAGO: "success",
};

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

/**
 * ¿Ciudad y sede nombran el mismo sitio? Cada sede se llama como su municipio
 * (Yopal, Villanueva, Monterrey…), así que pintar las dos deja "Yopal · Yopal".
 * Se comparan sin distinguir mayúsculas y con `trim`: el catálogo del legacy
 * trae nombres con espacios de sobra ("Popayán ", "Achi ").
 */
export function mismoSitio(city?: string | null, branch?: string | null): boolean {
  if (!city || !branch) return false;
  const norm = (s: string) =>
    s.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return norm(city) === norm(branch);
}

/** Dónde vive el cliente, en una línea: "Centro · Yopal" (la sede solo si difiere). */
export function ubicacionDe(s: { neighborhood?: string | null; city?: string | null; branch?: string | null }): string {
  return [s.neighborhood, s.city, mismoSitio(s.city, s.branch) ? null : s.branch]
    .filter(Boolean).join(" · ");
}
