// Tipos del módulo de WhatsApp masivo (Kapso / Cloud API oficial de Meta).

export type WaTemplateVar = { index: number; label: string; source: string; value?: string };

export type WaTemplate = {
  id: string; name: string; language: string; category: string | null;
  bodyText: string; headerText: string | null; variables: WaTemplateVar[] | null;
  active: boolean; createdAt: string; updatedAt: string;
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
