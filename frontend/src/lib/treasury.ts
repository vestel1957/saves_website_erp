// Tipos del módulo de Tesorería (vertical Vestel).
import { PERM, type AuthUser } from "@/lib/auth";

/**
 * ¿Este usuario es una cajera "pura"? ESPEJO de `esCajera()` del backend
 * (`treasury/caja-scope.ts`): `area.caja` sin ningún área de mando por encima.
 *
 * Sirve para decidir QUÉ PANTALLA pintar (el panel de caja en vez del ejecutivo, el
 * arqueo en vez del informe) sin esperar a `/treasury/mi-caja`. El alcance real de los
 * datos lo sigue imponiendo el backend con un 403: esto es comodidad, no la barrera.
 */
const P_MANDO = [PERM.AREA_CONTABILIDAD, PERM.AREA_ADMINISTRACION, PERM.AREA_GERENCIA];
export function esCajera(user: Pick<AuthUser, "permissions"> | null | undefined): boolean {
  const p = user?.permissions ?? [];
  if (p.includes(PERM.SYSTEM_ADMIN)) return false;
  if (P_MANDO.some((m) => p.includes(m))) return false;
  return p.includes(PERM.AREA_CAJA);
}

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

/** Bloques del informe recalculados sin la pasarela en línea — ver `soloCaja`. */
type SoloCaja = Pick<InformeCierreData, "cobranza" | "formaPago" | "servicios" | "tipoServicio" | "meses">;

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
    /**
     * De qué se compone el efectivo del cajón. El backend lo manda desde siempre
     * (`arqueo()`); se declara aquí porque la cinta de cuadre del informe lo pinta.
     * OJO: el excedente NO es la suma de estas líneas — el excedente ES el efectivo,
     * y el arrastre ya viene dentro. Estas líneas sólo lo explican.
     */
    desglose?: {
      arrastre: number;
      ventas: number;
      egresos: number;
      transferencias: number;
      noEfectivo: number;
    };
  };
  /**
   * El mismo informe SIN los pagos de la pasarela en línea (Wompi). Es lo que ve la
   * cajera en sus gráficas: esa plata cae directa desde el celular del abonado y no
   * pasa por su ventanilla, así que contársela como recaudo suyo era enseñarle un
   * número que no puede arquear.
   *
   * Los campos de arriba NO cambian: son el informe del legacy, el que sale en tablas
   * y en el PDF y el que se concilia con el sistema viejo.
   */
  soloCaja: SoloCaja;
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
