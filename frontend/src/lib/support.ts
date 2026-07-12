// Tipos del módulo de Soporte (vertical Vestel).
export type TicketRow = { id: string; code: number | null; legacyId: number; subject: string; type: string; description: string | null; priority: string | null; created: string; status: string; assigned: string | null; client: string | null; subscriberId: string | null; sede: string | null; barrio: string | null; finalDate: string | null };
export type SupportStats = { total: number; pendientes: number; resueltos: number; anuladas: number; status: Record<string, number>; topTypes: { type: string; count: number }[]; topTechs: { tec: string; count: number }[]; todosPending: number };
export type Paged<T> = { items: T[]; total: number; page: number; pageSize: number; pages: number };

export const TICKET_STATUS_LABEL: Record<string, string> = { REALIZANDO: "Realizando", RESUELTO: "Resuelto", ANULADA: "Anulada", PENDIENTE: "Pendiente" };
export const TICKET_STATUS_TONE: Record<string, "success" | "warning" | "error" | "default"> = { REALIZANDO: "warning", RESUELTO: "success", ANULADA: "error", PENDIENTE: "warning" };

// Tipos de orden válidos (detalle). Fuente única: usada por Nueva orden y el filtro.
export const TICKET_TYPES = [
  "Instalacion", "Reconexion Internet", "Reconexion Television", "Reconexion Combo",
  "Corte Internet", "Corte Television", "Revision de Internet", "Revision de television",
  "Revision tv e internet", "Traslado", "Retiro voluntario", "Cambio de equipo",
  "Migracion", "Subir megas", "Bajar megas", "Cambio de clave", "Servicio Adicional",
];

// Prioridad de la orden (mayor → menor). Un color por nivel para leerla de un vistazo.
export const TICKET_PRIORITIES = ["Urgente", "Alta", "Media", "Baja"] as const;
export const TICKET_PRIORITY_TONE: Record<string, "success" | "warning" | "error" | "info" | "default"> = { Urgente: "error", Alta: "warning", Media: "info", Baja: "success" };
