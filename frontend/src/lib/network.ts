// Tipos del módulo de Red/ISP (vertical Vestel).
export type NetStats = {
  mikrotiks: number; olts: number; onus: number; naps: number;
  ports: number; portsUsed: number; portsFree: number; equipment: number; equipAssigned: number;
};
export type Mikrotik = { id: string; name: string; ip: string; port: string; tech: string; branch: string | null; online: boolean; isDefault: boolean };
export type Olt = { id: string; name: string; brand: string; ip: string; tech: string; branch: string | null; online: boolean; onus: number };
export type Nap = { id: string; name: string; branch: string | null; vlan: number | null; portCount: number; portsRegistered: number; address: string; gps: { lat: string; lng: string } | null };
export type NapPort = { id: string; port: number; status: string; nap: string | null; client: string | null; subscriberId: string | null; abonado: number | null; detail: string };
export type BranchOpt = { id: string; name: string; naps: number };
export type VlanOpt = { id: string; vlan: number; detail: string };
export type Onu = { id: string; olt: string | null; sn: string | null; slot: number | null; port: number | null; ontId: number | null; runState: string | null; rxPower: string | null; syncState: string; client: string | null; subscriberId: string | null; lastSync: string | null };
export type Equip = { id: string; code: number; mac: string | null; serial: string | null; brand: string | null; status: string | null; warehouse: string | null; client: string | null; subscriberId: string | null; installType: string | null; genieacs: boolean };
export type Paged<T> = { items: T[]; total: number; page: number; pageSize: number; pages: number };

// --- Corte / reconexión Mikrotik ---
export type MikrotikMode = { live: boolean; mode: "LIVE" | "DRY_RUN" };
export type MikrotikActionResult = {
  ok: boolean;
  dryRun: boolean;
  action: "CUT" | "RECONNECT" | "STATUS" | "TEST";
  subscriberId?: string;
  mikrotik?: { id: string; name: string; host: string; tech: string };
  steps: string[];
  live?: {
    secretExists?: boolean;
    secretDisabled?: boolean;
    sessionActive?: boolean;
    ip?: string;
    inActivos?: boolean;
    inMorosos?: boolean;
  };
  message: string;
  error?: string;
};
export type MikrotikLog = {
  id: string;
  action: string;
  ok: boolean;
  dryRun: boolean;
  detail: string | null;
  mikrotikName: string | null;
  pppUsername: string | null;
  userName: string | null;
  createdAt: string;
};
export const MK_ACTION_LABEL: Record<string, string> = {
  CUT: "Corte",
  RECONNECT: "Reconexión",
  STATUS: "Consulta estado",
  TEST: "Prueba de router",
  PROVISION: "Alta PPPoE",
};
