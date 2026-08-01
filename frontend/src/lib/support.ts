// Tipos del módulo de Soporte (vertical Vestel).
import { PERM, can, type AuthUser } from "@/lib/auth";

/**
 * ¿Este usuario es un técnico "puro"? Misma regla que la geo-cerca y `GeoGate`:
 * `area.tecnicos` sin ningún área de mando por encima ni el superusuario.
 *
 * Decide QUÉ PANEL se pinta en `/dashboard` (el de rendimiento del técnico en vez del
 * ejecutivo) y qué botones se le ofrecen en inventario y soporte, sin esperar
 * respuesta del servidor. El alcance real de los datos lo sigue imponiendo el
 * backend (`common/tecnico-scope.ts`), que aplica exactamente esta misma regla:
 * esto sólo evita pintarle lo que le van a rechazar.
 * Hermano de `esCajera()` en `lib/treasury.ts`.
 */
export function esTecnico(user: Pick<AuthUser, "permissions"> | null | undefined): boolean {
  if (!user) return false;
  if ((user.permissions ?? []).includes(PERM.SYSTEM_ADMIN)) return false;
  // El jefe de bodega responde por TODO el inventario aunque sea del área técnica.
  if ((user.permissions ?? []).includes(PERM.INV_ADMIN)) return false;
  if (can(user, [PERM.AREA_GERENCIA, PERM.AREA_ADMINISTRACION, PERM.AREA_CONTABILIDAD])) return false;
  return can(user, PERM.AREA_TECNICOS);
}

/** Una orden de la cola del técnico, tal como la manda `/support/mi-jornada`. */
export type OrdenDeJornada = {
  id: string; code: number | null; subject: string; type: string; status: string;
  priority: string | null; problema: string | null; created: string;
  /** Días que lleva abierta. Null si la orden no trae fecha. */
  diasAbierta: number | null;
  vencida: boolean;
  /** Implica salir a la calle (ver `field-work.policy.ts` del backend). */
  campo: boolean;
  client: string | null; subscriberId: string | null; abonado: number | null;
  address: string | null; phone: string | null; phone2: string | null; sede: string | null;
  /** Solo 1 de cada 4 abonados tiene GPS: null = no ofrecer "navegar". */
  gps: { lat: number; lng: number } | null;
};

export type MiJornada = {
  resolved: boolean;
  tech: { id: string; name: string } | null;
  hoy: string;
  contadores: { pendiente: number; realizando: number; resueltoHoy: number; resueltas7d: number; vencidas: number; rezagadas: number; campo: number };
  /** El trabajo del día: abiertas de los últimos `diasRezago` días, en orden de atención. */
  agenda: OrdenDeJornada[];
  /** Abiertas más viejas que `diasRezago` (las 20 más recientes). Ver `DIAS_REZAGO`. */
  rezagadas: OrdenDeJornada[];
  diasVencimiento: number;
  diasRezago: number;
};

/** `/support/mi-rendimiento`: las métricas del tablero de gerencia, acotadas a uno mismo. */
export type MiRendimiento = {
  resolved: boolean;
  desde?: string;
  hasta?: string;
  resumen: {
    cerradas: number; asignadas: number; abiertas: number; revisitas: number;
    revisitaPct: number | null; evidenciaPct: number | null; firmaPct: number | null;
    cicloHoras: number | null; vencidas: number; antiguedadDias: number | null;
    muestraSuficiente: boolean;
  } | null;
  equipo: { medianaRevisita: number | null; medianaEvidencia: number | null; revisitaPct: number | null; ventanaRevisitaDias: number; muestraMinima: number } | null;
  porTipo: { tipo: string; cerradas: number; revisitas: number; revisitaPct: number | null }[];
  casos: { id: string; code: number | null; tipo: string; fecha: string; abonado: string | null; cliente: string | null; queja: string | null; quejaFecha: string | null }[];
};
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
