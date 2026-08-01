// Tipos del módulo de WhatsApp masivo (Kapso / Cloud API oficial de Meta).

export type WaTemplateVar = { index: number; label: string; source: string; value?: string };

export type WaTemplate = {
  id: string; name: string; language: string; category: string | null;
  bodyText: string; headerText: string | null; variables: WaTemplateVar[] | null;
  active: boolean; createdAt: string; updatedAt: string;
  /** Estado en Meta: APPROVED | PENDING | REJECTED | NO_EXISTE | null (sin dato). */
  metaStatus?: string | null;
};

/** Estado de aprobación en Meta y su presentación. */
export const WA_META_STATUS: Record<string, { label: string; tone: "default" | "info" | "success" | "error" | "warning" }> = {
  APPROVED: { label: "Aprobada", tone: "success" },
  PENDING: { label: "En revisión", tone: "warning" },
  REJECTED: { label: "Rechazada", tone: "error" },
  NO_EXISTE: { label: "No existe en Meta", tone: "error" },
};

export type WaCampaign = {
  id: string; name: string; templateName: string; language: string;
  total: number; sent: number; delivered: number; read: number; failed: number;
  status: string; createdByName: string | null; createdAt: string; finishedAt: string | null;
};

export type WaCampaignList = { items: WaCampaign[]; total: number; page: number; pageSize: number; pages: number };

export type WaSend = {
  id: string; phone: string; status: string; error: string | null; sentAt: string | null;
  subscriberId: string | null; name: string | null; abonado: number | null;
};

export type WaCampaignReport = {
  campaign: WaCampaign; sends: WaSend[]; total: number; page: number; pageSize: number; pages: number;
};

/** Fuentes disponibles para una variable {{n}} de plantilla. */
export const WA_VAR_SOURCES: { value: string; label: string }[] = [
  { value: "name", label: "Nombre del cliente" },
  { value: "firstName", label: "Primer nombre" },
  { value: "abonado", label: "N.º de abonado" },
  { value: "phone", label: "Teléfono" },
  { value: "deuda", label: "Deuda pendiente" },
  { value: "custom", label: "Valor fijo" },
];

/** Estados de un envío y su color. */
export const WA_SEND_STATUS: Record<string, { label: string; tone: "default" | "info" | "success" | "error" | "warning" }> = {
  QUEUED: { label: "En cola", tone: "default" },
  SENT: { label: "Enviado", tone: "info" },
  DELIVERED: { label: "Entregado", tone: "success" },
  READ: { label: "Leído", tone: "success" },
  FAILED: { label: "Fallido", tone: "error" },
};

/** Estados de un cliente (para el filtro de destinatarios). */
export const SUBSCRIBER_STATUSES = ["ACTIVO", "CORTADO", "CARTERA", "SUSPENDIDO", "RETIRADO"];

/** Salud real del número contra Kapso/Meta (GET /admin/whatsapp/health). */
export type WaHealth = {
  ok: boolean; error?: string;
  phone?: string | null; name?: string | null;
  quality?: string | null; tier?: string | null;
  codeVerification?: string | null; platform?: string | null;
};

/** Calidad del número según Meta (semáforo): bloqueos/reportes la bajan. */
export const WA_QUALITY: Record<string, { label: string; tone: "success" | "warning" | "error" }> = {
  GREEN: { label: "Calidad alta", tone: "success" },
  YELLOW: { label: "Calidad media", tone: "warning" },
  RED: { label: "Calidad baja", tone: "error" },
};

/** Tier de mensajería de Meta → clientes únicos a los que se puede iniciar conversación en 24 h. */
export const WA_TIER: Record<string, string> = {
  TIER_50: "50 clientes / 24 h",
  TIER_250: "250 clientes / 24 h",
  TIER_1K: "1.000 clientes / 24 h",
  TIER_10K: "10.000 clientes / 24 h",
  TIER_100K: "100.000 clientes / 24 h",
  TIER_UNLIMITED: "Sin límite",
};
