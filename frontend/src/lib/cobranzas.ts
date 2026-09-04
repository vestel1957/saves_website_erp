// Tipos y helpers del módulo de Cobranzas (vertical Vestel).

export type DebtInvoice = {
  id: string; tid: number; invoiceDate: string; dueDate: string;
  total: number; paid: number; balance: number; status: string;
  /** Mes que se cobra en esa factura ("agosto de 2026"). */
  mes?: string;
  /** Sólo en las FIJA: qué es el cargo (instalación, reconexión, mensualidad suelta…). */
  concepto?: string | null;
  /** Lo que se le rebaja si HOY se salda entera, por una promoción vigente. 0 = no aplica. */
  descuento?: number;
  /** Nombre de esa promoción ("5% Pronto pago") y su etiqueta ("5%"). */
  promocion?: string | null;
  promocionLabel?: string | null;
};

/**
 * Lo que costaría dejar pagado el mes que TODAVÍA NO se ha facturado (nace el día 1
 * con la corrida), ya con el descuento por adelantarlo. Lo calcula el backend: aquí
 * sólo se enseña y se suma al monto — al cobrar se manda cuántos meses, nunca el precio.
 */
export type Adelanto = {
  /** % que se rebaja por adelantar (ajuste `billing.advanceDiscountPct`). */
  pct: number;
  meses: { fecha: string; label: string; bruto: number; descuento: number; neto: number }[];
  bruto: number;
  descuento: number;
  neto: number;
};

export type Debt = {
  subscriberId: string; name: string | null; abonado: number;
  /** Saldo a favor del legacy (`customers.balance`), el que gasta el método "Balance". */
  balance: number;
  /** Saldo a favor de este sistema: lo que pagó de más y espera a su próxima factura. */
  advance?: number;
  totalDebt: number;
  /** Lo que hay que cobrar si lo salda todo hoy, ya con el descuento de la promoción. */
  totalConDescuento?: number;
  descuentoTotal?: number;
  /** El mes siguiente, con su precio ya rebajado. `null` = no se le puede calcular. */
  adelanto?: Adelanto | null;
  invoices: DebtInvoice[];
};

export type CashAccount = {
  id: number; name: string;
  cuid?: string | null; balance?: number;
  branchLegacy?: number | null; accountNumber?: string | null;
  code?: string | null; persisted?: boolean;
  /** Fondo fijo de la caja: no entra en el excedente del arqueo. */
  fixedFund?: number;
};

export const PAY_METHODS: { value: string; label: string }[] = [
  { value: "Cash", label: "Efectivo" },
  { value: "Bank", label: "Consignación / Transferencia" },
  { value: "Cheque", label: "Cheque" },
  { value: "Balance", label: "Saldo a favor del cliente" },
];

/**
 * ¿El método mueve dinero por banco? Debe coincidir con `isBankMethod` del backend
 * (`cobranzas.service.ts`), que con esto decide el asiento contable y guarda el
 * nombre del banco. El cheque se consigna, así que cuenta como banco.
 */
export const isBankMethod = (method: string) => method === "Bank" || method === "Cheque";

export const BANKS = ["Bancolombia", "BBVA colombia", "Banco de Bogota", "Davivienda"];

// Las categorías de movimiento NO se listan aquí: son datos, no código. Viven en
// TransactionCategory (migradas de `transactions_cat` del legacy), se administran
// en /tesoreria/cajas y se piden a GET /treasury/categories. Antes había aquí dos
// listas fijas inventadas que no coincidían con el legacy.

/**
 * Simula el reparto en cascada (mismo algoritmo que el backend) para previsualizar
 * a qué facturas se aplicaría un monto. No muta nada; solo para la UI.
 */
type FilaCascada = { tid: number; applied: number; leftBalance: number; willBePaid: boolean; descuento: number };

export function previewCascade(
  invoices: DebtInvoice[],
  amount: number,
): FilaCascada[] {
  const round2 = (n: number) => Math.round(n * 100) / 100;
  let monto = round2(amount);
  const out: FilaCascada[] = [];
  let lastIdx = -1;
  for (const inv of invoices) {
    if (monto <= 0) break;
    const saldo = inv.balance;
    if (saldo <= 0) continue;
    // El descuento de la promo sólo se gana si el dinero alcanza a SALDAR la factura
    // (misma regla que el backend). Si no alcanza, se abona lo que haya y no hay rebaja.
    const premio = inv.descuento ?? 0;
    const conPremio = premio > 0 && monto >= round2(saldo - premio);
    let applied: number;
    let descuento = 0;
    if (conPremio) { descuento = premio; applied = round2(saldo - premio); monto = round2(monto - applied); }
    else if (monto >= saldo) { applied = saldo; monto = round2(monto - saldo); }
    else { applied = monto; monto = 0; }
    out.push({
      tid: inv.tid, applied, descuento,
      leftBalance: round2(saldo - applied - descuento),
      willBePaid: applied + descuento >= saldo,
    });
    lastIdx = out.length - 1;
    if (monto <= 0) break;
  }
  // Excedente → última factura procesada (pago adelantado).
  if (monto > 0 && lastIdx >= 0) {
    out[lastIdx].applied = round2(out[lastIdx].applied + monto);
  }
  return out;
}
