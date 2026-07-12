// Tipos del módulo Gestión Mikrotik (clon de Mikrotiks.php — conectar y configurar routers).

export type MkMode = { live: boolean; mode: "LIVE" | "DRY_RUN" };

export type MkBranch = { id: string; name: string; legacyId: number };

export type MkRouter = {
  id: string;
  name: string;
  ip: string;
  port: string;
  tech: string;
  branch: string | null;
  branchId: string | null;
  sedeLegacy: number;
  username: string;
  isDefault: boolean;
  online: boolean;
  /** Nº de routers en la misma sede (para mostrar el flag "por defecto"). */
  sedeRouters: number;
};

export type MkSystem = {
  identity: string; version: string; uptime: string; boardName: string;
  architecture: string; cpuLoad: string; totalMemory: string; freeMemory: string;
  model: string; serial: string; firmware: string;
};

export type MkSummary = { secrets: number; active: number; activos: number; morosos: number };

export type MkSecret = {
  id: string; name: string; profile: string; service: string;
  remoteAddress: string; localAddress: string; disabled: boolean; comment: string;
};

export type MkActive = { id: string; name: string; address: string; uptime: string; callerId: string; service: string };

export type MkProfile = { id: string; name: string; rateLimit: string; localAddress: string; remoteAddress: string; onlyOne: string };

export type MkIpRow = { ip: string; user: string; profile: string; disabled: boolean; online: boolean; liveAddress: string; comment: string; conflict: boolean };

export type MkIpStats = { total: number; online: number; offline: number; disabled: number; conflicts: number };

export type MkLog = {
  id: string; action: string; ok: boolean; dryRun: boolean; detail: string | null;
  mikrotikName: string | null; userName: string | null; createdAt: string;
};

export type Paged<T> = { items: T[]; total: number; page: number; pageSize: number; pages: number };

export const MK_ADMIN_ACTION_LABEL: Record<string, string> = {
  CREATE: "Crear router",
  UPDATE: "Actualizar",
  DELETE: "Eliminar",
  DEFAULT: "Por defecto",
  TEST: "Probar conexión",
  SYSTEM: "Sistema",
  SECRETS: "Secrets PPPoE",
  ACTIVE: "Sesiones activas",
  PROFILES: "Perfiles",
  SUMMARY: "Resumen",
  TOGGLE: "Habilitar/deshabilitar secret",
  KICK: "Cerrar sesión",
  // acciones per-cliente que también apuntan a un router (compartido con la corte/reconexión):
  CUT: "Corte",
  RECONNECT: "Reconexión",
  STATUS: "Consulta estado",
  PROVISION: "Alta PPPoE",
  PROFILE: "Cambio de perfil",
};

/** Tecnologías del legacy (mikrotiks/index2 <select tegnologia>). */
export const MK_TECHS = ["", "GPON", "EPON", "EOC", "RADIO", "FIBRA"] as const;
