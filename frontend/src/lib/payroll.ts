// Tipos, etiquetas y helpers compartidos del módulo de Nómina.

export type ConceptType = "EARNING" | "DEDUCTION";

export type PayrollConcept = {
  id: string;
  code: string;
  name: string;
  description?: string | null;
  type: ConceptType;
  salaryNature: "SALARIAL" | "NON_SALARIAL";
  category: string;
  calcMethod: "FIXED" | "PERCENTAGE" | "PER_QUANTITY" | "PROPORTIONAL";
  rate?: number | string | null;
  base: "NONE" | "BASIC_SALARY" | "DAILY_SALARY" | "GROSS_SALARIAL" | "IBC";
  autoApply: boolean;
  cycleDays?: number | null;
  affectsHealth: boolean;
  affectsPension: boolean;
  active: boolean;
};

export type PayrollPeriod = {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  payday?: string | null;
  status: "OPEN" | "PROCESSING" | "CLOSED";
  _count?: { payslips: number; events: number };
};

export type PayslipLine = {
  id: string;
  type: ConceptType;
  salaryNature: string;
  category: string;
  label: string;
  origin?: string | null;
  formula?: string | null;
  quantity?: string | number | null;
  unitValue?: string | number | null;
  amount: string | number;
  order: number;
};

export type Payslip = {
  id: string;
  baseSalary: string | number;
  grossSalary: string | number;
  totalEarnings: string | number;
  totalDeductions: string | number;
  netSalary: string | number;
  status: "DRAFT" | "ISSUED" | "PAID";
  issuedAt?: string | null;
  employee?: { id: string; firstName: string; lastName: string; docNumber: string; position?: string | null; area?: string | null };
  period?: { id: string; name: string; startDate: string; endDate: string; status?: string };
  contract?: { baseSalary: string | number; contractType: string } | null;
  lines?: PayslipLine[];
};

export type PayrollOverview = {
  kpis: {
    latestPeriodName: string | null;
    latestPeriodStatus: string | null;
    payslipsCount: number;
    activeEmployees: number;
    totalEarnings: number;
    totalDeductions: number;
    netCost: number;
  };
  trend: { name: string; earnings: number; deductions: number; net: number }[];
  earningsByCategory: { label: string; value: number }[];
  deductionsByCategory: { label: string; value: number }[];
};

export const CONCEPT_TYPE_LABEL: Record<string, string> = {
  EARNING: "Devengado",
  DEDUCTION: "Deducción",
};

export const SALARY_NATURE_LABEL: Record<string, string> = {
  SALARIAL: "Salarial",
  NON_SALARIAL: "No salarial",
};

export const CALC_METHOD_LABEL: Record<string, string> = {
  FIXED: "Valor fijo",
  PERCENTAGE: "Porcentaje",
  PER_QUANTITY: "Cantidad × unitario",
  PROPORTIONAL: "Prima proporcional",
};

export const CALC_BASE_LABEL: Record<string, string> = {
  NONE: "—",
  BASIC_SALARY: "Salario base (hora)",
  DAILY_SALARY: "Salario diario (día)",
  GROSS_SALARIAL: "Devengado salarial",
  IBC: "IBC",
};

export const PAY_CLASSES: [string, string][] = [
  ["QUINCENAL", "Quincenal (mes de 30 días)"],
  ["QUINCENAL_ROLL", "Quincenal ROLL (días reales del mes)"],
];

export const PAY_CLASS_LABEL: Record<string, string> = Object.fromEntries(PAY_CLASSES);

export const CONCEPT_CATEGORIES: [string, string][] = [
  ["BASIC_SALARY", "Salario base"],
  ["OVERTIME", "Horas extras / recargos"],
  ["BONUS", "Bonificación"],
  ["ALLOWANCE", "Auxilio"],
  ["COMMISSION", "Comisión"],
  ["VACATION", "Vacaciones"],
  ["SICK_LEAVE", "Incapacidad"],
  ["PENSION", "Pensión"],
  ["HEALTH", "Salud"],
  ["TAX", "Retención / impuesto"],
  ["OTHER", "Otro"],
];

export const EVENT_TYPES: [string, string][] = [
  ["VACATION", "Vacaciones"],
  ["SICK_LEAVE", "Incapacidad"],
  ["LICENSE", "Licencia"],
  ["PERMISSION", "Permiso"],
  ["ABSENCE", "Ausencia"],
  ["BONUS", "Bonificación"],
  ["COMMISSION", "Comisión"],
  ["ALLOWANCE", "Auxilio"],
  ["DEDUCTION", "Deducción"],
  ["OTHER", "Otro"],
];

export const CONTRACT_TYPES: [string, string][] = [
  ["INDEFINITE", "Término indefinido"],
  ["FIXED_TERM", "Término fijo"],
  ["WORK_LABOR", "Obra o labor"],
  ["SERVICES", "Prestación de servicios"],
  ["APPRENTICESHIP", "Aprendizaje"],
];

export const PERIOD_STATUS_LABEL: Record<string, string> = {
  OPEN: "Abierto",
  PROCESSING: "En proceso",
  CLOSED: "Cerrado",
};

export const PERIOD_STATUS_TONE: Record<string, "success" | "warning" | "default"> = {
  OPEN: "success",
  PROCESSING: "warning",
  CLOSED: "default",
};

export const PAYSLIP_STATUS_LABEL: Record<string, string> = {
  DRAFT: "Borrador",
  ISSUED: "Emitido",
  PAID: "Pagado",
};

export const EVENT_STATUS_LABEL: Record<string, string> = {
  PENDING: "Pendiente",
  APPROVED: "Aprobada",
  REJECTED: "Rechazada",
};

const N = (v: string | number | null | undefined) => Number(v ?? 0);

/** Moneda colombiana: 2040000 → "$2.040.000". */
export function cop(value: string | number | null | undefined): string {
  return "$" + Math.round(N(value)).toLocaleString("es-CO");
}

export function fmtDate(d?: string | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("es-CO", { year: "numeric", month: "short", day: "2-digit" });
}

export { N as toNumber };
