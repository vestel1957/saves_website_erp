// Tipos del módulo de Facturación (vertical Vestel).
export type InvoiceRow = {
  id: string;
  tid: number;
  subscriberId: string | null;
  subscriber: string;
  abonado: number | null;
  date: string;
  dueDate: string;
  total: number;
  paid: number;
  balance: number;
  status: string;
  ron: string | null;
  kind: string;
  service: string | null;
  eInvoiceFlag: string | null; // 'Crear Factura Electronica' | 'Factura Electronica Creada' | null
};

export type InvoiceList = {
  items: InvoiceRow[];
  sum: { total: number; balance: number };
  total: number; page: number; pageSize: number; pages: number;
};

export type BillingStats = {
  total: number;
  facturadoTotal: number;
  pagadas: number;
  pendientes: number;
  parciales: number;
  carteraTotal: number;
  carteraFacturas: number;
  status: Record<string, number>;
};

export type Aging = { corriente: number; d1_30: number; d31_60: number; d61_90: number; d90: number };

export const INVOICE_KIND_LABEL: Record<string, string> = {
  RECURRENTE: "Recurrente", FIJA: "Fija", NOTA_CREDITO: "Nota crédito", NOTA_DEBITO: "Nota débito",
};

// Estado operativo (ron) — mismos nombres que el ciclo de vida del cliente.
export const RON_LABEL: Record<string, string> = {
  ACTIVO: "Activo", INSTALAR: "Instalar", CORTADO: "Cortado", SUSPENDIDO: "Suspendido",
  EXONERADO: "Exonerado", CARTERA: "Cartera", COMPROMISO: "Compromiso", DEPURADO: "Depurado",
  RETIRADO: "Retirado", ANULADO: "Anulado", REPORTADO: "Reportado", EVENTO: "Evento",
  DADO_DE_BAJA: "Dado de baja", POR_RETIRAR: "Por retirar",
};
