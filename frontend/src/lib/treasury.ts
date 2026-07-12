// Tipos del módulo de Tesorería (vertical Vestel).
export type TxRow = {
  id: string; date: string; type: string; category: string;
  debit: number; credit: number; amount: number;
  payer: string; subscriberId: string | null;
  method: string | null; account: string | null; bank: string | null;
  invoiceTid: number | null; status: string; note: string | null;
  attach: string | null; attachName: string | null;
};
export type TxList = { items: TxRow[]; total: number; page: number; pageSize: number; pages: number };

export type TreasuryStats = {
  ingresos: number; egresos: number; balance: number;
  nIngresos: number; nEgresos: number; anuladas: number;
  topEgresos: { category: string; total: number }[];
};

export type CashClose = {
  id: string; cashAccountId: number; date: string;
  base: number; sales: number; expenses: number; deposited: number; surplus: number;
};
export type CashCloseTotals = {
  count: number; base: number; sales: number; expenses: number; deposited: number; surplus: number;
};
export type CashCloseList = {
  items: CashClose[]; totals: CashCloseTotals; total: number; page: number; pageSize: number; pages: number;
};
export type CashClosePeriod = {
  period: string; count: number; base: number; sales: number; expenses: number; deposited: number; surplus: number;
};
export type CashCloseSummary = { group: "day" | "week" | "month"; items: CashClosePeriod[] };

export type CashAccountOpt = {
  id: number; name: string;
  cuid?: string | null; balance?: number;
  branchLegacy?: number | null; accountNumber?: string | null;
  code?: string | null; persisted?: boolean;
};

export const TX_TYPE_LABEL: Record<string, string> = { INCOME: "Ingreso", EXPENSE: "Egreso", TRANSFER: "Traslado" };
export const TX_TYPE_TONE: Record<string, "success" | "error" | "info"> = { INCOME: "success", EXPENSE: "error", TRANSFER: "info" };
