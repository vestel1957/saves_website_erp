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

/**
 * Un cierre de caja. Réplica del legacy: NO hay tabla de cierres — el cierre ES la
 * transacción 'Saldo <fecha>' que barre el cajón, y su `id` es el de esa transacción.
 * Por eso sólo hay una cifra (el excedente): allá la base es cero y se lleva todo.
 */
export type CashClose = {
  id: string; cashAccountId: number; account: string | null; date: string;
  cajero: string | null;
  /** Lo que se barrió del cajón. */
  surplus: number;
  /** A dónde se arrastró (salta domingos y festivos; el sábado es hábil). */
  proximoDiaHabil: string;
};
export type CashCloseTotals = { count: number; surplus: number };
export type CashCloseList = {
  items: CashClose[]; totals: CashCloseTotals; total: number; page: number; pageSize: number; pages: number;
};
export type CashClosePeriod = { period: string; count: number; surplus: number };
export type CashCloseSummary = { group: "day" | "week" | "month"; items: CashClosePeriod[] };

export type CashAccountOpt = {
  id: number; name: string;
  cuid?: string | null; balance?: number;
  branchLegacy?: number | null; accountNumber?: string | null;
  /** Nombre de la sede ('Banco' si branchLegacy=0, null si la caja es derivada). */
  sede?: string | null;
  code?: string | null; persisted?: boolean;
};

type Bucket = { cantidad: number; monto: number };
type MesBucket = { cantidad: number; monto: number; Internet: Bucket; Television: Bucket };

/**
 * El informe del cierre: los bloques del legacy (`statement_list.php`) + el arqueo, que
 * es de donde sale la cabecera (horas, cajero, efectivo).
 */
export type InformeCierreData = {
  caja: { id: number; holder: string; accountNumber: string | null };
  fecha: string;
  cobranza: { excento: Bucket; base: Bucket; iva: Bucket; total: Bucket };
  porBanco: { nombre: string; cantidad: number; monto: number }[];
  formaPago: { saldoAnterior: Bucket; efectivo: Bucket; transferencia: Bucket; wompi: Bucket };
  servicios: {
    planes: { clave: string; megas: number; cantidad: number; monto: number }[];
    television: Bucket;
    reconexiones: Bucket;
    afiliaciones: { producto: string; cantidad: number; monto: number }[];
    ventas: Bucket;
    materiales: Bucket;
    otros: Bucket;
    total: Bucket;
  };
  tipoServicio: { Internet: Bucket; Television: Bucket };
  meses: { actual: MesBucket; anterior: MesBucket; anteriores: MesBucket };
  anulaciones: {
    anuladoDeCierre: Bucket;
    anuladoDeOtrosCierres: Bucket;
    cobranzaEfectiva: { monto: number };
    cobradoNeto: number;
  };
  egresos: { ordenes: Bucket; traslados: Bucket; transacciones: Bucket; total: Bucket };
  arqueo: {
    /** Id de la transacción 'Saldo' que ES el cierre. null = ese día aún no se ha cerrado. */
    id: string | null;
    cajero: string | null;
    /** null = no se sabe (cierre migrado: el legacy no guardaba la hora por caja). */
    horaApertura: string | null;
    horaCierre: string | null;
    migrado: boolean;
    yaCerrado: boolean;
    excedente: number;
    proximoDiaHabil: string;
  };
};

/**
 * Qué caja puede ver quien pregunta. La cajera va acotada a la suya (port de
 * `acc_list()` del legacy); el resto de roles ve todas.
 */
export type MiCaja = {
  todas: boolean;
  esCajera: boolean;
  caja: { id: number; name: string; branchLegacy: number | null } | null;
  sedes: number[];
};

export const TX_TYPE_LABEL: Record<string, string> = { INCOME: "Ingreso", EXPENSE: "Egreso", TRANSFER: "Traslado" };
export const TX_TYPE_TONE: Record<string, "success" | "error" | "info"> = { INCOME: "success", EXPENSE: "error", TRANSFER: "info" };
