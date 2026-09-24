// Tipos del módulo de Red/ISP (vertical Vestel).
export type NetStats = {
  mikrotiks: number; olts: number; onus: number; naps: number;
  ports: number; portsUsed: number; portsFree: number; equipment: number; equipAssigned: number;
};
export type Mikrotik = { id: string; name: string; ip: string; port: string; tech: string; branch: string | null; online: boolean; isDefault: boolean };
export type Olt = { id: string; name: string; brand: string; ip: string; tech: string; branch: string | null; online: boolean; onus: number };
// `portsRegistered` = puertos que existen en la tabla; `portsUsed` = los que están
// Ocupados. No son lo mismo: una NAP recién creada tiene 16 registrados y 0 usados.
export type Nap = { id: string; name: string; branchId: string | null; branch: string | null; vlanId: string | null; vlan: number | null; portCount: number; portsRegistered: number; portsUsed?: number; address: string; gps: { lat: string; lng: string } | null };
export type NapPort = { id: string; port: number; status: string; nap: string | null; client: string | null; subscriberId: string | null; abonado: number | null; detail: string };
export type BranchOpt = { id: string; name: string; naps: number; vlans: number };
export type VlanOpt = { id: string; vlan: number; detail: string };
// La misma respuesta de /network/vlans, con lo que sólo mira la pantalla de administración.
export type Vlan = VlanOpt & { olt: string | null; oltId: string | null; tray: number | null; oltPort: number | null; branchId: string | null; branch: string | null; naps: number };
/** Un puerto PON tal como lo ve la OLT: cuántos service-ports y con qué VLANs. */
export type PuertoOlt = { port: number; servicios: number; vlans: { vlan: number; servicios: number }[] };
export type TarjetaOlt = { slot: number; board: string; status: string; tech: "GPON" | "EPON"; puertos: PuertoOlt[] };
/** `GET /network/vlans/olt-mapa`: la OLT de una sede leída en vivo (cacheada 10 min). */
export type MapaOlt = { id: string; name: string; ok: boolean; error: string | null; leidoEn: string | null; cached: boolean; tarjetas: TarjetaOlt[] };
/** Una VLAN en los cuatro sitios (catálogo, OLT, uplink, Mikrotik): `GET /network/vlans/salud`. */
export type EstadoVlanEquipos = "OK" | "ROTA" | "INCOMPLETA" | "SIN_CATALOGO" | "SIN_USO";
export type SaludVlan = {
  vlan: number;
  catalogo: { id: string; detail: string; puerto: string | null }[];
  pon: { principal: string[]; otros: string[] };
  servicePorts: number;
  olt: { existe: boolean; uplinks: { fsp: string; estado: string }[]; ok: boolean };
  mikrotik: { router: string | null; interfaz: string | null; interfazEsperada: string | null; sobre: string | null; pppoe: boolean; ok: boolean } | null;
  estado: EstadoVlanEquipos;
  falta: string[];
};
export type SaludOlt = {
  id: string; name: string; ok: boolean; error: string | null; leidoEn: string | null; cached?: boolean;
  uplink: { fsp: string | null; ambiguo: boolean; candidatos: { fsp: string; estado: string; vlans: number; interfazMikrotik: string | null }[] } | null;
  router: { id: string; name: string } | null;
  filas: SaludVlan[];
};
export type SaludSede = { branchId: string; olts: SaludOlt[]; mikrotikErrores: string[] };
/** `POST /network/vlans/:id/configurar-equipos` (dry-run o real). */
export type ConfigurarVlanRes = {
  ok: boolean; dryRun: boolean; vlan: number;
  necesitaUplink?: boolean; candidatos?: { fsp: string; vlans: number }[];
  olt?: { id: string; comandos: string[]; uplink: string | null };
  mikrotik?: { id: string; name: string; interfaz: string | null; comandos: string[] } | null;
  avisos: string[]; mikrotikErrores?: string[]; nadaQueHacer?: boolean;
  resultado?: {
    olt: { ok: boolean; dryRun: boolean; commands: string[]; respuestas?: { cmd: string; out: string }[]; error?: string } | null;
    mikrotik: { ok: boolean; dryRun: boolean; steps: string[]; error?: string } | null;
    mikrotikOmitido: string | null;
  };
  despues?: SaludVlan | null;
};
export type Onu = { id: string; olt: string | null; sn: string | null; slot: number | null; port: number | null; ontId: number | null; runState: string | null; rxPower: string | null; syncState: string; client: string | null; subscriberId: string | null; lastSync: string | null };
export type Equip = { id: string; code: number; mac: string | null; serial: string | null; brand: string | null; status: string | null; observation?: string | null; warehouse: string | null; client: string | null; subscriberId: string | null; installType: string | null; genieacs: boolean; /** Día en que se recogió del cliente; null si nunca volvió de una devolución. */ returnedAt: string | null };
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
  PROFILE: "Cambio de perfil",
  EDIT: "Edición de la ficha",
  // El interruptor manual de la ficha: sólo la lista MOROSOS, nada más.
  MOROSO_ON: "Desactivado (a morosos)",
  MOROSO_OFF: "Activado (fuera de morosos)",
};
