// Tipos y helpers del módulo Gestión OLT (clon SmartOLT — control de ONUs por SSH).

export type OltMode = { live: boolean; mode: "LIVE" | "DRY_RUN"; brands: string[] };

export type OltRow = {
  id: string;
  name: string;
  brand: string;
  ip: string;
  port: string;
  tech: string;
  /** "ssh" | "telnet": cómo se habla con el equipo. */
  transport: string;
  branch: string | null;
  /** id de la sede: hace falta para reasignarla desde el modal. */
  branchId: string | null;
  sedeLegacy: number;
  username: string;
  isDefault: boolean;
  online: boolean;
  onus: number;
  defaults: { lineProfile: number | null; srvProfile: number | null; vlan: number | null; gemport: number | null; userVlan: number | null };
};

export type OltDashboard = {
  total: number; online: number; offline: number; debil: number; critica: number; sinCliente: number;
  porOlt: { oltId: string; nombre: string; total: number; online: number; offline: number; critica: number; lastSync: string | null }[];
};

export type Board = { slot: string; board: string; status: string; gpon: boolean; epon: boolean };
export type LiveOnu = {
  fsp: string; ont_id: string; sn: string; control_flag: string;
  run_state: string; config_state: string; match_state: string; rx_power: string;
  /** Cruce con el inventario local (por SN): abonado vinculado, si lo hay. */
  client?: string | null; subscriberId?: string | null; description?: string | null;
};
export type AutofindOnu = {
  fsp: string; sn: string; sn_full: string; password: string; loid: string;
  /** Campos extra del autofind (pueden venir vacíos según el modelo de ONU). */
  mac?: string; model?: string; vendor?: string; version?: string;
};
export type Profile = { id: string; name: string };

/** Ocupación de un slot: cuántas ONUs cuelgan de cada puerto PON. */
export type SlotPortSummary = { port: number; total: number; online: number; offline: number };
export type SlotSummary = { slot: number; total: number; online: number; offline: number; ports: SlotPortSummary[] };

/**
 * Tabla de tráfico de la OLT: es donde se limita la velocidad del abonado.
 * `mbps` es el PIR (techo) ya convertido; `cirMbps` el mínimo garantizado.
 */
export type TrafficTable = { id: string; cir: string; pir: string; mbps: number | null; cirMbps: number | null };

/** Etiqueta legible para un selector de velocidad. */
export function trafficLabel(t: TrafficTable): string {
  if (t.mbps === null) return `${t.id} · sin límite`;
  return `${t.id} · ${t.mbps.toLocaleString("es-CO")} Mbps`;
}
export type SystemInfo = { model: string; version: string; patch: string; uptime: string };

export type InvOnu = {
  id: string; oltId: string | null; olt: string | null; sn: string | null; description: string | null;
  frame: number | null; slot: number | null; port: number | null; ontId: number | null; fsp: string;
  runState: string | null; rxPower: string | null; syncState: string;
  subscriberId: string | null; client: string | null; lastSync: string | null;
};

export type OltLog = {
  id: string; action: string; ok: boolean; dryRun: boolean; detail: string | null;
  oltName: string | null; sn: string | null; fsp: string | null; userName: string | null; createdAt: string;
};

/** Dónde está y cómo está una ONU que YA estaba autenticada en la OLT. */
export type OnuExistente = {
  fsp: string; ont_id: number;
  run_state: string; config_state: string; match_state: string;
  description: string; lineprofile: string; srvprofile: string; srvprofile_name: string;
  servicePorts: { index: string; vlan: string; gemport: string; rx: string; tx: string }[];
};

export type ProvisionResult = {
  ok: boolean; dryRun: boolean; message?: string; error?: string;
  commands?: string[]; ontId?: string; raw?: string;
  /** `SN_YA_EXISTE`: la ONU ya está dada de alta; se puede adoptar. */
  codigo?: string;
  existente?: OnuExistente | null;
  /** Resultado de adoptarla: qué se le ajustó y qué no se pudo. */
  adoptada?: boolean;
  cambios?: string[];
  avisos?: string[];
  verificacion?: {
    ok: boolean; run_state: string | null; config_state: string | null;
    match_state: string | null; servicePorts: string[]; avisos: string[];
    nota?: string | null;
  } | null;
};

export type Paged<T> = { items: T[]; total: number; page: number; pageSize: number; pages: number };

// Umbrales de señal óptica (Rx, dBm): OK ≥ -25 · débil -25..-28 · crítica < -28.
export function rxTone(rx: string | null | undefined): "success" | "warning" | "error" | "default" {
  if (rx === null || rx === undefined || rx === "" || !/^-?[0-9.]+$/.test(rx)) return "default";
  const n = parseFloat(rx);
  if (n >= -25) return "success";
  if (n >= -28) return "warning";
  return "error";
}

export function runTone(s: string | null | undefined): "success" | "error" | "default" {
  const v = (s ?? "").toLowerCase();
  if (v.includes("online") || v === "up") return "success";
  if (v.includes("offline") || v === "down") return "error";
  return "default";
}

export const OLT_ACTION_LABEL: Record<string, string> = {
  TEST: "Probar conexión",
  BOARDS: "Tableros",
  ONUS: "Listar ONUs",
  AUTOFIND: "Autofind",
  PROFILES: "Perfiles",
  SYSTEM: "Sistema",
  DETAIL: "Detalle ONU",
  FIND: "Buscar por SN",
  PROVISION: "Autenticar ONU",
  REBOOT: "Reiniciar ONU",
  DELETE: "Eliminar ONU",
  SYNC: "Sincronizar",
  LINK: "Vincular cliente",
};
