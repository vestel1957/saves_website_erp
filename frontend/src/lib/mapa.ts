/** Tipos del módulo de mapa (endpoints `/geo/*` del backend). */

export type PuntoAbonado = {
  id: string;
  abonado: number;
  name: string;
  address: string | null;
  phone: string | null;
  status: string | null;
  sede: string | null;
  lat: number;
  lng: number;
};

export type PuntoNap = {
  id: string;
  name: string;
  address: string;
  ports: number;
  portCount: number;
  sede: string | null;
  lat: number;
  lng: number;
};

export type PuntosMapa = {
  truncated: boolean;
  subscribers: PuntoAbonado[];
  naps: PuntoNap[];
};

export type PuntoTecnico = {
  userId: string;
  userName: string;
  lat: number;
  lng: number;
  accuracy: number | null;
  reason: string;
  refType: string | null;
  refId: string | null;
  createdAt: string;
  minutosDesde: number;
};

export type CoberturaGeo = {
  total: number;
  conGps: number;
  totalActivos: number;
  conGpsActivos: number;
  naps: number;
  napsConGps: number;
};

/** Texto legible del motivo por el que se grabó un punto. */
export const MOTIVO_PING: Record<string, string> = {
  "ticket.open": "abrió una orden",
  "ticket.close": "cerró una orden",
  "ticket.attach": "subió evidencia",
  "subscriber.capture": "capturó el GPS de un cliente",
  manual: "registró su ubicación",
  heartbeat: "tenía la app abierta",
};

/**
 * Pasado este rato sin reportar, el punto deja de ser "dónde está" y pasa a ser
 * "dónde estuvo". Son varias veces el latido (1 min) para que perder un par de
 * reportes —un sótano, un semáforo sin cobertura— no lo apague; bajarlo más
 * llenaría el mapa de técnicos parpadeando entre gris y morado.
 */
export const TECNICO_EN_VIVO_MIN = 4;

/** Morado lleno = reportando ahora; gris = el último punto ya tiene horas. */
export const COLOR_TECNICO_VIVO = "#7c3aed";
export const COLOR_TECNICO_FRIO = "#94a3b8";

/** "hace 4 min" / "hace 2 h 10 min" */
export function haceCuanto(min: number): string {
  if (min < 1) return "ahora mismo";
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `hace ${h} h ${m} min` : `hace ${h} h`;
}

export type Ruta = {
  origen: { lat: number; lng: number };
  destino: { lat: number; lng: number };
  nombre: string | null;
  geometry: { lat: number; lng: number }[];
  distanceM: number;
  durationS: number | null;
  /** La ruta real no se pudo calcular: esto es la línea recta. */
  aproximada: boolean;
};

/** "6 min" / "1 h 12 min" */
export function formatearDuracion(s: number): string {
  const min = Math.max(1, Math.round(s / 60));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}
