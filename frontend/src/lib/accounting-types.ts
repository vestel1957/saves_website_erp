export type AccountType = "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "COST" | "EXPENSE";
export type NormalSide = "DEBIT" | "CREDIT";

export interface Account {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  normalSide: NormalSide;
  parentId: string | null;
  level: number;
  isPostable: boolean;
  isActive: boolean;
  currency: string;
}

export interface AccountNode extends Account {
  children: AccountNode[];
}

export interface JournalLine {
  id: string;
  accountId: string;
  account: { code: string; name: string };
  costCenter?: { name: string } | null;
  debit: string;
  credit: string;
  description: string | null;
}

export interface JournalEntry {
  id: string;
  number: number;
  date: string;
  type: "MANUAL" | "AUTOMATIC" | "RECURRING" | "CLOSING";
  status: "DRAFT" | "POSTED" | "REVERSED";
  description: string;
  reference?: string | null;
  sourceType?: string | null;
  lines: JournalLine[];
}

export interface LedgerRow {
  lineId: string;
  number: number;
  date: string;
  description: string;
  debit: number;
  credit: number;
  balance: number;
}

export interface Ledger {
  account: { id: string; code: string; name: string; normalSide: NormalSide };
  openingBalance: number;
  lines: LedgerRow[];
  totalDebit: number;
  totalCredit: number;
  closingBalance: number;
}

export interface TrialBalanceRow {
  accountId: string;
  code: string;
  name: string;
  /** Arrastre: saldo con el que la cuenta entra al periodo (débito − crédito). */
  saldoAnterior: number;
  debit: number;
  credit: number;
  saldoDeudor: number;
  saldoAcreedor: number;
}

export interface TrialBalance {
  rows: TrialBalanceRow[];
  totals: { saldoAnterior: number; debit: number; credit: number; saldoDeudor: number; saldoAcreedor: number };
  /** Cuadran los movimientos del periodo. */
  balanced: boolean;
  /** Cuadran los saldos finales (arrastre incluido). */
  saldosCuadrados: boolean;
}

export interface StatementLine {
  code: string;
  name: string;
  amount: number;
}

export interface IncomeStatement {
  income: StatementLine[];
  costs: StatementLine[];
  expenses: StatementLine[];
  totals: {
    totalIncome: number;
    totalCosts: number;
    grossProfit: number;
    totalExpenses: number;
    netIncome: number;
  };
}

export interface CostCenterRow {
  id: string;
  code: string;
  name: string;
  parentId: string | null;
  isActive: boolean;
  kind: "SEDE" | "GENERAL" | "OTRO";
  branch: { legacyId: number; name: string } | null;
}

export interface CostCenterBranch {
  legacyId: number;
  name: string;
  costCenter: { id: string; code: string; name: string } | null;
}

export type IncomeStatementTotals = IncomeStatement["totals"];

/** Una cuenta de resultado repartida por columna (`amounts[columna.key]`). */
export interface IncomeByCenterRow {
  accountId: string;
  code: string;
  name: string;
  amounts: Record<string, number>;
  total: number;
}

export interface IncomeStatementByCenter {
  range: { from: string | null; to: string | null };
  /** Sedes, Administración general, otros centros con movimiento y «Sin asignar» (key `SIN_ASIGNAR`). */
  columns: {
    key: string;
    code: string;
    name: string;
    kind: "SEDE" | "GENERAL" | "OTRO" | "SIN_ASIGNAR";
    isActive: boolean;
    branch: { legacyId: number; name: string } | null;
  }[];
  income: IncomeByCenterRow[];
  costs: IncomeByCenterRow[];
  expenses: IncomeByCenterRow[];
  totalsByColumn: Record<string, IncomeStatementTotals>;
  totals: IncomeStatementTotals;
  /** Columnas sumadas = total del informe = estado de resultados sin filtro. */
  cuadre: {
    ok: boolean;
    detalle: { campo: string; columnas: number; total: number; estadoDeResultados: number; ok: boolean }[];
  };
}

export interface BalanceSheet {
  assets: StatementLine[];
  liabilities: StatementLine[];
  equity: StatementLine[];
  netIncome: number;
  totals: {
    totalAssets: number;
    totalLiabilities: number;
    totalEquity: number;
    liabilitiesPlusEquity: number;
  };
  balanced: boolean;
}

export interface CashFlow {
  opening: number;
  inflows: number;
  outflows: number;
  netChange: number;
  closing: number;
  operating?: number;
  investing?: number;
  financing?: number;
}

export interface AgingBuckets {
  current: number;
  d1_30: number;
  d31_60: number;
  d61_90: number;
  d90_plus: number;
  total: number;
}

export interface OpenItem {
  invoiceId?: string;
  billId?: string;
  number: string;
  party: string;
  date: string;
  dueDate: string;
  total: number;
  balance: number;
  status: string;
}

export interface OpenItems {
  items: OpenItem[];
  total: number;
}
