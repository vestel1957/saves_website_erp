// Tipos y helpers puros de inventario compartidos entre Client y Server Components.
// NO debe importar "next/headers" ni nada server-only (eso vive en src/lib/inventory.ts).

// ---- types ---------------------------------------------------------------
export interface InventoryOverview {
  totalValue: number;
  availableStock: number;
  committedStock: number;
  outOfStock: number;
  belowMinimum: number;
  stagnantProducts: number;
  adjustments: number;
  openOrders: number;
  pendingReceipts: number;
  trend: { months: string[]; inflow: number[]; outflow: number[] };
  topProducts: { name: string; value: number }[];
  movementsByReason: { label: string; value: number }[];
}

export interface Product {
  id: string;
  sku: string;
  internalCode?: string | null;
  barcode?: string | null;
  name: string;
  type: string;
  isActive: boolean;
  averageCost: string;
  lastCost: string;
  category?: { name: string } | null;
  brand?: { name: string } | null;
  uom?: { code: string } | null;
}

export interface Warehouse {
  id: string;
  code: string;
  name: string;
  type: string;
  isActive: boolean;
  _count?: { locations: number; stockLevels: number };
}

export interface StockRow {
  id: string;
  product: { id: string; sku: string; name: string; category?: { id: string; name: string } | null };
  warehouse: { code: string; name: string };
  location?: { code: string; name: string } | null;
  onHand: number;
  reserved: number;
  inCustody?: number;
  available: number;
  avgCost: number;
  value: number;
  lastEntryAt: string | null;
}

export interface KardexRow {
  id: string;
  date: string;
  reason: string;
  direction: string;
  quantityIn: string;
  quantityOut: string;
  unitCost: string;
  balanceQty: string;
  balanceValue: string;
  avgCost: string;
  reference?: string | null;
  warehouse?: { code: string; name: string };
}

export interface MovementRow {
  id: string;
  date: string;
  type: string;
  reason: string;
  productName: string;
  quantity: string;
  unitCost: string;
  totalCost: string;
  reference?: string | null;
  warehouseFrom?: { name: string } | null;
  warehouseTo?: { name: string } | null;
  // Contraparte (de dónde / hacia dónde) más allá de la bodega
  party?: { id: string; name: string; taxId?: string | null } | null;
  counterpartyEmployee?: { id: string; firstName: string; lastName: string; area?: string | null } | null;
  costCenter?: { id: string; code: string; name: string } | null;
}

// ---- Etiquetas Origen/Destino de un movimiento --------------------------------
// Cuando no hay contraparte estructurada, la etiqueta se deriva del motivo.
const ORIGIN_REASON_LABEL: Record<string, string> = {
  OPENING: "Saldo inicial",
  ADJUSTMENT: "Ajuste de inventario",
  RETURN: "Devolución",
  PRODUCTION: "Producción",
  PURCHASE: "Compra",
};
const DEST_REASON_LABEL: Record<string, string> = {
  INTERNAL_CONSUMPTION: "Consumo interno",
  SALE: "Venta",
  LOSS: "Baja · pérdida",
  THEFT: "Baja · robo",
  DAMAGE: "Baja · daño",
  ADJUSTMENT: "Ajuste de inventario",
};

/** De dónde viene el movimiento. Entrada → proveedor/motivo; salida/transf. → bodega. */
export function originLabel(m: MovementRow): string {
  if (m.type === "IN") return m.party?.name ?? ORIGIN_REASON_LABEL[m.reason] ?? "—";
  return m.warehouseFrom?.name ?? "—";
}

/** Hacia dónde va el movimiento. Salida → funcionario/área/tercero/motivo; entrada/transf. → bodega. */
export function destLabel(m: MovementRow): string {
  if (m.type === "OUT") {
    if (m.counterpartyEmployee) {
      const e = m.counterpartyEmployee;
      const name = `${e.firstName} ${e.lastName}`.trim();
      return e.area ? `${name} (${e.area})` : name;
    }
    if (m.costCenter) return `${m.costCenter.code} · ${m.costCenter.name}`;
    if (m.party) return m.party.name;
    return DEST_REASON_LABEL[m.reason] ?? "—";
  }
  return m.warehouseTo?.name ?? "—";
}

export interface PurchaseOrder {
  id: string;
  number: string;
  status: string;
  orderDate: string;
  total: string;
  lines: { id: string; quantity: string; unitCost: string; product: { name: string } }[];
  _count?: { receipts: number };
}

export interface ValuedReport {
  total: number;
  byWarehouse: Record<string, number>;
  items: number;
}

export interface RotationRow {
  sku?: string;
  product?: string;
  outQty: number;
  onHand: number;
  turnover: number | null;
  costOfGoods: number;
}

export interface ReorderSuggestion {
  product: { sku: string; name: string };
  warehouseId: string;
  onHand: number;
  reorderPoint: number;
  avgDailyConsumption: number;
  daysOfStock: number | null;
  suggestedQty: number;
  estimatedCost: number;
}
