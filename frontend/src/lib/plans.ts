// Cliente/tipos del catálogo de planes de servicio (vertical Vestel).

export type ServiceKind = "INTERNET" | "TV" | "PUNTOS" | "STREAMING";

export const SERVICE_KIND_LABEL: Record<ServiceKind, string> = {
  INTERNET: "Internet",
  TV: "Televisión",
  PUNTOS: "Puntos TV",
  STREAMING: "Streaming",
};

export type Plan = {
  id: string;
  name: string;
  kind: ServiceKind;
  pppProfile: string | null;
  price: number;
  taxRate: number; // IVA% (TV=19, internet=0)
  megas: number | null;
  active: boolean;
  subscribers: number; // cuántos abonados usan el plan
};

/** Un plan dentro de un combo, con lo que vale dentro y lo que vale suelto. */
export type BundleItem = {
  planId: string;
  planName: string;
  kind: ServiceKind;
  price: number; // precio dentro del combo (base sin IVA)
  listPrice: number; // precio del plan suelto
  taxRate: number;
  megas: number | null;
  planActive: boolean;
};

/** Una app (producto OTT de PlayHub) que se puede ofrecer dentro de un combo. */
export type BundleApp = {
  /** Código del catálogo de PlayHub: es lo que se guarda y lo que viaja a su API. */
  code: string;
  name: string;
  /** Área comercial a la que pertenece: Standard, Premium, Premium Plus, Diamante. */
  area: string;
};

/**
 * Combo comercial: varios planes vendidos juntos a precio propio.
 * `total`/`savings` los calcula el backend para que la pantalla no repita la cuenta.
 */
export type Bundle = {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  items: BundleItem[];
  /** Apps que el cliente puede elegir con el combo. Vacío = no ofrece apps. */
  apps: BundleApp[];
  total: number;
  listTotal: number;
  savings: number;
  subscribers: number;
  /** Arrastra un plan oculto: no se puede vender hasta arreglarlo. */
  blocked: boolean;
};

/** Resultado de cambiar el plan de un abonado (incluye el empuje al router). */
export type ChangePlanResult = {
  ok: boolean;
  plan: { id: string; name: string; price: number; pppProfile: string | null };
  router: {
    ok: boolean;
    dryRun: boolean;
    action: string;
    steps: string[];
    message: string;
    error?: string;
    mikrotik?: { name: string; host: string };
  } | null;
};
