// Tipos y helpers del módulo GenieACS / TR-069 (cortes masivos de TV vía NBI).

export type GenieacsMode = { live: boolean; mode: "LIVE" | "DRY_RUN"; tvTag: string; tvParam: string };

export type GenieacsServer = {
  id: string;
  name: string;
  nbiUrl: string;
  username: string;
  sedeLegacy: number;
  isDefault: boolean;
  online: boolean;
  /** El NBI tiene basic-auth configurado (usuario + clave). */
  hasAuth?: boolean;
  /** La clave ya quedó cifrada en reposo (false = fila legacy en texto plano). */
  secretEncrypted?: boolean;
};

export type GenieacsDashboard = {
  total: number;
  active: number;
  mid: number;
  stale: number;
  suspended: number;
  byManufacturer: { name: string; count: number }[];
  byModel: { name: string; count: number }[];
};

export type CpeRow = {
  id: string;
  manufacturer: string | null;
  model: string | null;
  serial: string | null;
  pppUser: string | null;
  wanIp: string | null;
  lastInform: string | null;
  daysSince: number | null;
  alive: boolean;
  tvSuspended: boolean;
  tags: string[];
  /** ONU sin TR-069: viene del inventario de la OLT; su TV se corta por OMCI. */
  source?: "olt";
  oltId?: string;
  oltName?: string;
  fsp?: string;
  runState?: string | null;
};

export type GenieacsLog = {
  id: string; action: string; ok: boolean; dryRun: boolean; detail: string | null;
  serverName: string | null; deviceId: string | null; count: number | null;
  userName: string | null; createdAt: string;
};

export type TvBatchResult = {
  ok: boolean; dryRun: boolean; message?: string;
  plan?: { action: string; tag: string; param: string; value: boolean; devices: number };
  done?: number; failed?: number; errors?: string[];
};

export type Paged<T> = { items: T[]; total: number; page: number; pageSize: number; pages: number };

export const GENIEACS_ACTION_LABEL: Record<string, string> = {
  TEST: "Probar NBI",
  LIST: "Listar CPEs",
  TAG_CUT: "Corte de TV",
  TAG_RESTORE: "Alta de TV",
  REFRESH: "Refrescar parámetros",
  SET_PARAM: "Fijar parámetro",
  INSTALL_PROVISION: "Instalar provision",
  LINK: "Servidor",
  DELETE: "Eliminar",
};

/** Opciones del filtro de estado. Deben coincidir con las que entiende el service. */
export const ESTADO_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "Todos los estados" },
  { value: "vivos", label: "Vivos (≤1 día)" },
  { value: "recientes", label: "Recientes (≤180 días)" },
  { value: "muertos", label: "Muertos (>180 días)" },
  { value: "suspendidos", label: "TV suspendida" },
  { value: "activos", label: "TV activa" },
];

/** Fecha y hora exactas del último inform, para el detalle y el `title` de la tabla. */
export function informExact(iso: string | null): string {
  if (!iso) return "Nunca informó";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "Fecha inválida";
  return new Date(t).toLocaleString("es-CO", { dateStyle: "medium", timeStyle: "short" });
}

/** Tono para la antigüedad del último inform. */
export function informTone(days: number | null): "success" | "warning" | "error" | "default" {
  if (days === null) return "error";
  if (days <= 1) return "success";
  if (days <= 30) return "warning";
  return "error";
}

export function informLabel(days: number | null): string {
  if (days === null) return "sin inform";
  if (days === 0) return "hoy";
  if (days === 1) return "ayer";
  if (days <= 60) return `hace ${days} días`;
  return `hace ${Math.floor(days / 30)} meses`;
}
