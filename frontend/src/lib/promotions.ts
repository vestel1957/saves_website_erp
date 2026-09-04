// Cliente/tipos de promociones de facturación (legacy settings/promociones).
//
// El destinatario de una promoción es el CLIENTE, no el funcionario (2026-08-03):
// la campaña define su PÚBLICO —todos, ciertos estados, clientes puntuales, planes,
// sedes o barrios— y solo aparece en las facturas de los clientes que están dentro.

/** Formato de descuento (fiel al legacy `format_discount`). */
export type DiscountFormat = "%" | "flat" | "b_p" | "bflat";

export const DISCOUNT_FORMAT_OPTIONS: { value: DiscountFormat; label: string }[] = [
  { value: "%", label: "% Descuento (después de imp.)" },
  { value: "flat", label: "Monto fijo (después de imp.)" },
  { value: "b_p", label: "% Descuento (antes de imp.)" },
  { value: "bflat", label: "Monto fijo (antes de imp.)" },
];

/**
 * A qué FACTURAS del cliente alcanza el descuento automático de ventanilla.
 *
 * Es lo que separa dos campañas opuestas: el PRONTO PAGO premia pagar el servicio del
 * mes a tiempo (y por eso no toca ni la mora ni los cargos sueltos), mientras que una
 * de RECUPERACIÓN DE CARTERA existe justamente para rebajar lo atrasado. Hasta el
 * 2026-09-02 sólo existía la primera regla, quemada en el backend: una promo dirigida
 * a los clientes en CARTERA no descontaba nunca, porque lo que ellos deben es siempre
 * de meses anteriores.
 */
export type InvoiceScope =
  | "MENSUALIDAD_DEL_MES"
  | "MENSUALIDADES_PENDIENTES"
  | "CUALQUIER_PENDIENTE";

export const INVOICE_SCOPE_OPTIONS: {
  value: InvoiceScope; label: string; detail: string;
}[] = [
  {
    value: "MENSUALIDAD_DEL_MES",
    label: "La mensualidad del mes",
    detail:
      "Sólo la factura del servicio de este mes. Lo atrasado y los cargos sueltos (traslado, reconexión, instalación) se cobran completos. Es el pronto pago.",
  },
  {
    value: "MENSUALIDADES_PENDIENTES",
    label: "Toda mensualidad que deba",
    detail:
      "Las mensualidades atrasadas y la de este mes. Los cargos sueltos se cobran completos. Es la campaña de cartera: se rebaja el servicio no pagado para que el cliente vuelva.",
  },
  {
    value: "CUALQUIER_PENDIENTE",
    label: "Todo lo que deba",
    detail:
      "Cualquier factura pendiente, cargos incluidos. Al 50%, un traslado de $30.000 se cobra a $15.000: pídelo sólo si es lo que quieres.",
  },
];

export const isFlatDiscount = (f?: string | null) => f === "flat" || f === "bflat";
export const isBeforeTaxDiscount = (f?: string | null) => f === "b_p" || f === "bflat";

/** Etiqueta corta del descuento: "10%" o "$5.000". */
export function discountLabel(p: { discountFormat?: string | null; percentage: number; flatAmount?: number | null }): string {
  return isFlatDiscount(p.discountFormat)
    ? `$${Math.round(Number(p.flatAmount ?? 0)).toLocaleString("es-CO")}`
    : `${p.percentage}%`;
}

/**
 * Factura tipo para simular el efecto del descuento mientras se arma la promoción.
 *
 * No es un ejemplo inventado: es la combinación subtotal/total más frecuente de los
 * últimos 60 días (45.521 facturas). Con IVA de por medio, "antes" y "después de
 * impuestos" dan totales distintos y hasta ahora no había forma de verlo antes de
 * guardar — se descubría en la factura del cliente.
 */
export const FACTURA_EJEMPLO = { subtotal: 61008, iva: 3992, total: 65000 };

export type SimulacionDescuento = {
  /** Sobre qué valor se calcula (subtotal si es antes de imp., total si no). */
  base: number;
  /** Cuánto se descuenta. */
  descuento: number;
  /** Cuánto termina pagando el cliente. */
  paga: number;
  /** Explicación en una línea de por qué salió ese número. */
  nota: string;
};

/**
 * Reproduce EXACTAMENTE el cálculo del backend (`PromotionsService.apply`): la base
 * es el subtotal cuando el descuento es antes de impuestos y el total cuando es
 * después; el monto fijo se topa a la base; el resultado se resta como nota crédito.
 * El IVA NO se recalcula — por eso un monto fijo da lo mismo antes que después,
 * salvo que supere el subtotal.
 */
export function simularDescuento(
  discountFormat: DiscountFormat,
  percentage: number,
  flatAmount: number,
  f = FACTURA_EJEMPLO,
): SimulacionDescuento | null {
  const antes = isBeforeTaxDiscount(discountFormat);
  const base = antes ? f.subtotal : f.total;
  const cop = (n: number) => `$${Math.round(n).toLocaleString("es-CO")}`;

  if (isFlatDiscount(discountFormat)) {
    if (!(flatAmount > 0)) return null;
    const descuento = Math.min(flatAmount, base);
    return {
      base,
      descuento,
      paga: f.total - descuento,
      nota:
        descuento < flatAmount
          ? `Se topa en ${cop(base)}: el monto no puede pasar de la base ${antes ? "sin IVA" : "facturada"}.`
          : `Se restan ${cop(flatAmount)} del total. Antes o después de impuestos da lo mismo mientras no supere ${cop(f.subtotal)}.`,
    };
  }

  if (!Number.isInteger(percentage) || percentage < 1 || percentage > 100) return null;
  const descuento = Math.round((base * percentage) / 100 * 100) / 100;
  return {
    base,
    descuento,
    paga: f.total - descuento,
    nota: antes
      ? `El ${percentage}% sale del subtotal (${cop(f.subtotal)}), sin contar el IVA.`
      : `El ${percentage}% sale del total facturado (${cop(f.total)}), IVA incluido.`,
  };
}

/**
 * Plantilla de promoción: la FORMA de una campaña que se repite.
 *
 * Guarda nombre, descuento y fechas, pero NO el público: la misma campaña se dirige
 * cada vez a clientes distintos, y arrastrar el público de la vez anterior es
 * justamente el error que hay que evitar.
 */
export type PromotionTemplate = {
  id: string;
  name: string;
  description: string | null;
  discountFormat: DiscountFormat;
  percentage: number;
  flatAmount: number | null;
  startDate: string;
  endDate: string;
  invoiceScope: InvoiceScope;
};

/** Borrador del formulario, tal como lo teclea quien arma la promoción. */
export type PromotionDraft = {
  name: string;
  description: string;
  discountFormat: DiscountFormat;
  percentage: string;
  flatAmount: string;
  startDate: string;
  endDate: string;
  active: boolean;
  /** A qué facturas del cliente alcanza el descuento automático de ventanilla. */
  invoiceScope: InvoiceScope;
  /** Publicarla en el portal de pagos en línea (vestel.com.co). */
  portalPublish: boolean;
  /** Que el portal cobre ya con el descuento puesto (rebaja la cartera por adelantado). */
  portalPreapply: boolean;
};

/**
 * ¿Esta campaña se puede publicar en el PORTAL DE PAGOS EN LÍNEA? El portal descuenta
 * con la tabla `promos` del legacy, que sólo guarda un porcentaje y un estado de
 * cliente: ni montos fijos ni públicos por cliente, plan, sede o barrio. Devuelve el
 * motivo cuando no se puede, para poder decirlo en pantalla en vez de deshabilitar la
 * casilla sin explicación.
 */
export function motivoNoPublicableEnPortal(d: PromotionDraft, a: PromotionAudience): string | null {
  if (isFlatDiscount(d.discountFormat))
    return "El portal sólo descuenta porcentajes, no montos fijos.";
  if (d.discountFormat !== "%")
    return "El portal descuenta sobre el total: usa el porcentaje después de impuestos.";
  if (a.subscriberIds.length || a.planIds.length || a.branchIds.length || a.neighborhoodRefs.length)
    return "El portal sólo distingue por ESTADO del cliente, no por cliente, plan, sede ni barrio.";
  if (!a.allSubscribers && !a.subscriberStatuses.length)
    return "Elige a qué estados alcanza para poder publicarla en el portal.";
  return null;
}

/**
 * ¿Por qué NO se puede pedir que el portal cobre ya con el descuento?
 *
 * El portal de pagos (PHP del legacy) arma lo que cobra sumando las facturas del
 * cliente: no tiene descuento "de sólo mostrar". La única forma de que allá se vea el
 * valor rebajado es concederlo por adelantado, y eso choca con publicarla —el banner
 * del portal descontaría otra vez sobre lo ya rebajado—.
 */
export function motivoNoPreaplicableEnPortal(d: PromotionDraft): string | null {
  if (d.portalPublish)
    return "Ya está publicada en el portal: elige una sola de las dos o se descontaría dos veces.";
  return null;
}

/** Un requisito del formulario y si ya está cumplido. */
export type RequisitoPromocion = { label: string; ok: boolean };

/**
 * Los cuatro requisitos para poder guardar, en el mismo orden en que aparecen en el
 * formulario. Es la MISMA lista que usa el panel de resumen y la que decide si el
 * botón se habilita: antes cada regla vivía suelta dentro de `save()` y solo se
 * conocía al pulsar «Crear», en forma de toast que se iba solo.
 */
export function requisitosPromocion(d: PromotionDraft, a: PromotionAudience): RequisitoPromocion[] {
  const flat = isFlatDiscount(d.discountFormat);
  const pct = Number(d.percentage);
  return [
    { label: "Nombre de la campaña", ok: !!d.name.trim() },
    flat
      ? { label: "Monto mayor a $0", ok: Number(d.flatAmount) > 0 }
      : { label: "Porcentaje entre 1 y 100", ok: Number.isInteger(pct) && pct >= 1 && pct <= 100 },
    { label: "Público definido", ok: audienceHasCriteria(a) },
    { label: "Fecha final igual o posterior a la inicial", ok: d.endDate >= d.startDate },
  ];
}

/** Cliente puntual dentro del público de una promoción. */
export type PromotionSubscriber = {
  id: string;
  fullName: string | null;
  abonado: number;
  status: string | null;
};

export type NamedRef = { id: string; name: string };

/** Público de una promoción tal como se manda al backend. */
export type PromotionAudience = {
  allSubscribers: boolean;
  subscriberStatuses: string[];
  subscriberIds: string[];
  planIds: string[];
  branchIds: string[];
  neighborhoodRefs: string[];
};

export const EMPTY_AUDIENCE: PromotionAudience = {
  allSubscribers: false,
  subscriberStatuses: [],
  subscriberIds: [],
  planIds: [],
  branchIds: [],
  neighborhoodRefs: [],
};

/** ¿El público tiene al menos un criterio? (Sin criterios no alcanza a nadie.) */
export const audienceHasCriteria = (a: PromotionAudience) =>
  a.allSubscribers ||
  a.subscriberStatuses.length > 0 ||
  a.subscriberIds.length > 0 ||
  a.planIds.length > 0 ||
  a.branchIds.length > 0 ||
  a.neighborhoodRefs.length > 0;

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
  invoiceScope: InvoiceScope;
  /** Público de la promo. */
  allSubscribers: boolean;
  subscriberStatuses: string[];
  subscribers: PromotionSubscriber[];
  plans: NamedRef[];
  branches: NamedRef[];
  neighborhoodRefs: string[];
  neighborhoods: { ref: string; name: string }[];
  vigente: boolean;
  timesApplied: number;
  /** Publicada en el portal de pagos en línea (tabla `promos` del legacy). */
  portalPublish: boolean;
  /** El portal cobra ya con el descuento puesto. */
  portalPreapply: boolean;
  legacyPromoIds: number[];
  portalPublishedAt: string | null;
  createdBy: string | null;
  createdAt: string;
};

/** Promoción vigente aplicable a una factura (su cliente está dentro del público). */
export type AvailablePromotion = {
  id: string;
  name: string;
  description: string | null;
  percentage: number;
  discountFormat: DiscountFormat;
  flatAmount: number | null;
  startDate: string;
  endDate: string;
  allSubscribers: boolean;
  subscriberStatuses: string[];
};

/** Catálogos para armar el público en pantalla. */
export type PromotionCatalogs = {
  plans: { id: string; name: string; kind: string }[];
  branches: NamedRef[];
  neighborhoods: { ref: string; name: string }[];
};

/** Conteo (y muestra) de clientes alcanzados por un público. */
export type AudienceResult = {
  count: number;
  sample: PromotionSubscriber[];
  sinCriterios: boolean;
};

/** Entrada de la bitácora del público de una promoción. */
export type PromotionTargetLog = {
  id: string;
  promotionId: string;
  promotionName: string;
  kind: "ALL" | "STATUS" | "SUBSCRIBER" | "PLAN" | "BRANCH" | "NEIGHBORHOOD";
  targetLabel: string;
  action: "ADDED" | "REMOVED";
  changedByName: string | null;
  createdAt: string;
};

/** Aplicación de una promoción a una factura. */
export type PromotionApplication = {
  id: string;
  invoiceId: string;
  tid: number | null;
  subscriberName: string | null;
  abonado: number | null;
  amount: number;
  percentage: number;
  appliedByName: string | null;
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
