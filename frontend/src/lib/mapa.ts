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
};

/** "hace 4 min" / "hace 2 h 10 min" */
export function haceCuanto(min: number): string {
  if (min < 1) return "ahora mismo";
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `hace ${h} h ${m} min` : `hace ${h} h`;
}
