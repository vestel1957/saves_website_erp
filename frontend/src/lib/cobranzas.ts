// Tipos y helpers del módulo de Cobranzas (vertical Vestel).

export type DebtInvoice = {
  id: string; tid: number; invoiceDate: string; dueDate: string;
  total: number; paid: number; balance: number; status: string;
};

export type Debt = {
  subscriberId: string; name: string | null; abonado: number;
  balance: number; totalDebt: number; invoices: DebtInvoice[];
};

export type CashAccount = {
  id: number; name: string;
  cuid?: string | null; balance?: number;
  branchLegacy?: number | null; accountNumber?: string | null;
  code?: string | null; persisted?: boolean;
};

export const PAY_METHODS: { value: string; label: string }[] = [
  { value: "Cash", label: "Efectivo" },
  { value: "Bank", label: "Consignación / Transferencia" },
  { value: "Balance", label: "Saldo a favor del cliente" },
];

export const BANKS = ["Bancolombia", "BBVA colombia", "Banco de Bogota", "Davivienda"];

export const EXPENSE_CATEGORIES = [
  "Papeleria", "Servicios", "Nomina", "Mantenimiento", "Transporte",
  "Arriendo", "Impuestos", "Comisiones", "Otros",
];

/** Categorías sugeridas para un ingreso manual libre (no ligado a factura). */
export const INCOME_CATEGORIES = [
  "Reconexión", "Instalación", "Venta de equipo", "Traslado", "Reposición",
  "Intereses", "Otros ingresos",
];

/**
 * Simula el reparto en cascada (mismo algoritmo que el backend) para previsualizar
 * a qué facturas se aplicaría un monto. No muta nada; solo para la UI.
 */
export function previewCascade(
  invoices: DebtInvoice[],
  amount: number,
): { tid: number; applied: number; leftBalance: number; willBePaid: boolean }[] {
  const round2 = (n: number) => Math.round(n * 100) / 100;
  let monto = round2(amount);
  const out: { tid: number; applied: number; leftBalance: number; willBePaid: boolean }[] = [];
  let lastIdx = -1;
  for (const inv of invoices) {
    if (monto <= 0) break;
    const saldo = inv.balance;
    if (saldo <= 0) continue;
    let applied: number;
    if (monto >= saldo) { applied = saldo; monto = round2(monto - saldo); }
    else { applied = monto; monto = 0; }
    out.push({ tid: inv.tid, applied, leftBalance: round2(saldo - applied), willBePaid: applied >= saldo });
    lastIdx = out.length - 1;
    if (monto <= 0) break;
  }
  // Excedente → última factura procesada (pago adelantado).
  if (monto > 0 && lastIdx >= 0) {
    out[lastIdx].applied = round2(out[lastIdx].applied + monto);
  }
  return out;
}
