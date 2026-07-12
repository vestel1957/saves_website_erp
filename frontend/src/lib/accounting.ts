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

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Error ${res.status} al cargar ${path}`);
  }
  return res.json();
}

export const getAccounts = () => get<Account[]>("/accounting/accounts");
export const getAccountsTree = () => get<AccountNode[]>("/accounting/accounts/tree");
export const getJournal = () => get<JournalEntry[]>("/accounting/journal-entries");
export const getLedger = (accountId: string) =>
  get<Ledger>(`/accounting/ledger/${accountId}`);
export const getTrialBalance = () => get<TrialBalance>("/accounting/reports/trial-balance");
export const getIncomeStatement = () =>
  get<IncomeStatement>("/accounting/reports/income-statement");
export const getBalanceSheet = () => get<BalanceSheet>("/accounting/reports/balance-sheet");
export const getCashFlow = () => get<CashFlow>("/accounting/reports/cash-flow");
export const getReceivables = () => get<OpenItems>("/accounting/receivables");
export const getReceivablesAging = () => get<AgingBuckets>("/accounting/receivables/aging");
export const getPayables = () => get<OpenItems>("/accounting/payables");
export const getPayablesAging = () => get<AgingBuckets>("/accounting/payables/aging");

export interface MonthlySummary {
  months: string[];
  income: number[];
  expenses: number[];
}
export const getMonthlySummary = (months = 6) =>
  get<MonthlySummary>(`/accounting/reports/monthly-summary?months=${months}`);
