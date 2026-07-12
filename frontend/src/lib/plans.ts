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
