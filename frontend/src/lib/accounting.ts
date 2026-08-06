import type {
  Account,
  AccountNode,
  AgingBuckets,
  BalanceSheet,
  CashFlow,
  IncomeStatement,
  JournalEntry,
  Ledger,
  OpenItems,
  TrialBalance,
} from "./accounting-types";

export interface MonthlySummary {
  months: string[];
  income: number[];
  expenses: number[];
}

export interface AccountMappingRow {
  key: string;
  accountId: string | null;
  account: { code: string; name: string } | null;
  description: string | null;
}

export interface FiscalPeriodRow {
  id: string;
  name: string;
  type: "MONTH" | "YEAR";
  year: number;
  month: number | null;
  startDate: string;
  endDate: string;
  status: "OPEN" | "CLOSED" | "LOCKED";
  closedAt: string | null;
  closedBy?: string | null;
}

/** Una cuenta en el arrastre: con cuánto entró, qué se movió y con cuánto sale. */
export interface PeriodBalanceRow {
  accountId: string;
  code: string;
  name: string;
  type: "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "COST" | "EXPENSE";
  opening: number;
  debit: number;
  credit: number;
  closing: number;
}

export interface PeriodBalanceTotals {
  opening: number;
  debit: number;
  credit: number;
  closing: number;
}

export interface PeriodBalances {
  periodo: FiscalPeriodRow;
  /** false = el periodo sigue abierto y estas cifras todavía se mueven. */
  guardado: boolean;
  asientoCierre: { id: string; number: number; date: string; description: string } | null;
  items: PeriodBalanceRow[];
  totales: PeriodBalanceTotals;
}

export interface ClosePreview {
  periodo: { id: string; name: string; startDate: string; endDate: string };
  anterior: { id: string; name: string; status: string } | null;
  filas: (PeriodBalanceRow & { saldo: number })[];
  cierre: {
    cuentaResultado: { id: string; code: string; name: string } | null;
    lineas: { accountId: string; code: string; name: string; debit: number; credit: number }[];
    /** Positivo = utilidad; negativo = pérdida. */
    utilidad: number;
  };
  totales: PeriodBalanceTotals;
}

export interface ClosedPeriod extends FiscalPeriodRow {
  asientoCierre: { id: string; number: number } | null;
  utilidad: number;
  cuentasArrastradas: number;
}

type Fetcher = (path: string, init?: RequestInit) => Promise<Response>;
const qs = (r?: { from?: string; to?: string; status?: string }) => {
  const p = new URLSearchParams();
  if (r?.from) p.set("from", r.from);
  if (r?.to) p.set("to", r.to);
  if (r?.status) p.set("status", r.status);
  const s = p.toString();
  return s ? `?${s}` : "";
};

/**
 * Cliente tipado del módulo de Contabilidad. Se construye con el `authFetch`
 * del AuthProvider (inyecta el Bearer y maneja el 401):
 *   const api = useMemo(() => accountingApi(authFetch), [authFetch]);
 */
export function accountingApi(authFetch: Fetcher) {
  const get = async <T>(path: string): Promise<T> => {
    const res = await authFetch(path);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || `Error ${res.status}`);
    return res.json();
  };
  const send = async <T>(path: string, method: string, body?: unknown): Promise<T> => {
    const res = await authFetch(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || `Error ${res.status}`);
    return res.json();
  };

  return {
    // plan de cuentas
    getAccounts: () => get<Account[]>("/accounting/accounts"),
    getAccountsTree: () => get<AccountNode[]>("/accounting/accounts/tree"),
    createAccount: (data: Partial<Account>) => send<Account>("/accounting/accounts", "POST", data),
    updateAccount: (id: string, data: Partial<Account>) => send<Account>(`/accounting/accounts/${id}`, "PATCH", data),

    // libro diario
    getJournal: (r?: { from?: string; to?: string; status?: string }) =>
      get<JournalEntry[]>(`/accounting/journal-entries${qs(r)}`),
    reverseEntry: (id: string) => send<JournalEntry>(`/accounting/journal-entries/${id}/reverse`, "POST"),

    // libro mayor
    getLedger: (accountId: string, r?: { from?: string; to?: string }) =>
      get<Ledger>(`/accounting/ledger/${accountId}${qs(r)}`),

    // reportes
    getTrialBalance: (r?: { from?: string; to?: string }) => get<TrialBalance>(`/accounting/reports/trial-balance${qs(r)}`),
    getIncomeStatement: (r?: { from?: string; to?: string }) => get<IncomeStatement>(`/accounting/reports/income-statement${qs(r)}`),
    getBalanceSheet: (r?: { from?: string; to?: string }) => get<BalanceSheet>(`/accounting/reports/balance-sheet${qs(r)}`),
    getCashFlow: (r?: { from?: string; to?: string }) => get<CashFlow>(`/accounting/reports/cash-flow${qs(r)}`),
    getMonthlySummary: (months = 6) => get<MonthlySummary>(`/accounting/reports/monthly-summary?months=${months}`),

    // cartera / CxP
    getReceivables: () => get<OpenItems>("/accounting/receivables"),
    getReceivablesAging: () => get<AgingBuckets>("/accounting/receivables/aging"),
    getPayables: () => get<OpenItems>("/accounting/payables"),
    getPayablesAging: () => get<AgingBuckets>("/accounting/payables/aging"),

    // periodos y arrastre de fin de mes
    getPeriods: () => get<FiscalPeriodRow[]>("/accounting/periods"),
    createPeriod: (data: { year: number; month?: number }) => send<FiscalPeriodRow>("/accounting/periods", "POST", data),
    /** El arrastre del periodo (guardado si está cerrado; en vivo si sigue abierto). */
    getPeriodBalances: (id: string) => get<PeriodBalances>(`/accounting/periods/${id}/balances`),
    /** Qué pasaría al cerrar, sin escribir nada. */
    previewClose: (id: string) => get<ClosePreview>(`/accounting/periods/${id}/preview`),
    closePeriod: (id: string) => send<ClosedPeriod>(`/accounting/periods/${id}/close`, "POST"),
    reopenPeriod: (id: string) => send<FiscalPeriodRow>(`/accounting/periods/${id}/reopen`, "POST"),

    // mapeo de cuentas
    getMappings: () => get<AccountMappingRow[]>("/accounting/mappings"),
    upsertMapping: (data: { key: string; accountId: string; description?: string }) =>
      send<unknown>("/accounting/mappings", "POST", data),
  };
}

export type AccountingApi = ReturnType<typeof accountingApi>;
