// Cliente/tipos de promociones de facturación (legacy settings/promociones).

/** Formato de descuento (fiel al legacy `format_discount`). */
export type DiscountFormat = "%" | "flat" | "b_p" | "bflat";

export const DISCOUNT_FORMAT_OPTIONS: { value: DiscountFormat; label: string }[] = [
  { value: "%", label: "% Descuento (después de imp.)" },
  { value: "flat", label: "Monto fijo (después de imp.)" },
  { value: "b_p", label: "% Descuento (antes de imp.)" },
  { value: "bflat", label: "Monto fijo (antes de imp.)" },
];

export const isFlatDiscount = (f?: string | null) => f === "flat" || f === "bflat";
export const isBeforeTaxDiscount = (f?: string | null) => f === "b_p" || f === "bflat";

/** Etiqueta corta del descuento: "10%" o "$5.000". */
export function discountLabel(p: { discountFormat?: string | null; percentage: number; flatAmount?: number | null }): string {
  return isFlatDiscount(p.discountFormat)
    ? `$${Math.round(Number(p.flatAmount ?? 0)).toLocaleString("es-CO")}`
    : `${p.percentage}%`;
}

export type PromotionAssignee = {
  id: string;
  name: string;
  email: string | null;
};

/** Promoción tal como la ve el administrador (superusuario). */
export type Promotion = {
  id: string;
  name: string;
  description: string | null;
  percentage: number;
  discountFormat: DiscountFormat;
  flatAmount: number | null;
  startDate: string;
  endDate: string;
  active: boolean;
  global: boolean;
  /** Si está set, es promo POR ESTADO DE CLIENTE (no por funcionario). */
  subscriberStatus: string | null;
  assignees: PromotionAssignee[];
  vigente: boolean;
  timesApplied: number;
  createdBy: string | null;
  createdAt: string;
};

/** Promoción vigente que un funcionario puede aplicar. */
export type AvailablePromotion = {
  id: string;
  name: string;
  description: string | null;
  percentage: number;
  discountFormat: DiscountFormat;
  flatAmount: number | null;
  startDate: string;
  endDate: string;
  global: boolean;
  subscriberStatus: string | null;
};

/** Entrada del historial de asignaciones de promociones. */
export type PromotionAssignmentLog = {
  id: string;
  promotionId: string;
  promotionName: string;
  staffId: string | null;
  staffName: string;
  action: "ASSIGNED" | "UNASSIGNED";
  assignedByName: string | null;
  createdAt: string;
};

export type ApplyPromotionResult = {
  ok: boolean;
  promotion: string;
  percentage: number;
  amount: number;
  newTotal: number;
  newBalance: number;
  status: string;
};
