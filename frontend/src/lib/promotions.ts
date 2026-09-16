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
 * A qué FACTURAS del cliente alcanza el descuento, que son DOS preguntas distintas:
 * el TIPO de factura que rebaja y si se limita al mes en curso.
 *
 * Hasta el 2026-09-10 iban pegadas en un solo selector de tres opciones, y con eso no
 * había forma de armar una campaña que rebajara SÓLO los cargos —"instalación a mitad
 * de precio"—: cualquier opción que alcanzara un cargo alcanzaba también la
 * mensualidad. Separadas, cada campaña dice lo suyo:
 *
 * · El PRONTO PAGO premia pagar el servicio del mes a tiempo → mensualidad + este mes.
 * · La RECUPERACIÓN DE CARTERA existe para rebajar lo atrasado → mensualidad + todas.
 * · Una campaña comercial de instalación o traslado → cargos.
 */
export type InvoiceKind = "RECURRENTE" | "FIJA";

/** Las tres combinaciones de tipo que ofrece la pantalla (el backend admite la lista). */
export type InvoiceKindChoice = "MENSUALIDAD" | "CARGOS" | "AMBAS";

export const INVOICE_KIND_OPTIONS: {
  value: InvoiceKindChoice; label: string; detail: string;
}[] = [
  {
    value: "MENSUALIDAD",
    label: "Mensualidad",
    detail: "Sólo la factura del servicio. Los cargos sueltos —traslado, reconexión, instalación— se cobran completos.",
  },
  {
    value: "CARGOS",
    label: "Cargos",
    detail: "Sólo los cobros sueltos: instalación, afiliación, traslado, reconexión. La mensualidad se cobra completa.",
  },
  {
    value: "AMBAS",
    label: "Las dos",
    detail: "Mensualidad y cargos. Al 50%, un traslado de $30.000 se cobra a $15.000: pídelo sólo si es lo que quieres.",
  },
];

/** Si el descuento se limita a lo facturado ESTE MES o alcanza también lo atrasado. */
export const INVOICE_AGE_OPTIONS: {
  value: "MES" | "TODAS"; label: string; detail: string;
}[] = [
  {
    value: "MES",
    label: "Sólo las de este mes",
    detail: "Lo atrasado se cobra completo. Es el pronto pago: premia pagar a tiempo, no la mora.",
  },
  {
    value: "TODAS",
    label: "También las atrasadas",
    detail: "Alcanza lo vencido. Es la campaña de cartera: se rebaja lo no pagado para que el cliente vuelva.",
  },
];

export const kindsDeEleccion = (c: InvoiceKindChoice): InvoiceKind[] =>
  c === "CARGOS" ? ["FIJA"] : c === "AMBAS" ? ["RECURRENTE", "FIJA"] : ["RECURRENTE"];

export function eleccionDeKinds(kinds: InvoiceKind[] | null | undefined): InvoiceKindChoice {
  const k = kinds?.length ? kinds : ["RECURRENTE"];
  if (k.includes("RECURRENTE") && k.includes("FIJA")) return "AMBAS";
  return k.includes("FIJA") ? "CARGOS" : "MENSUALIDAD";
}

/** Etiqueta corta del alcance, para la tarjeta de la promoción. */
export function alcanceFacturasLabel(p: {
  invoiceKinds: InvoiceKind[]; onlyCurrentMonth: boolean; invoiceIds?: string[] | null;
}): string {
  const n = p.invoiceIds?.length ?? 0;
  if (n) return n === 1 ? "1 factura elegida" : `${n} facturas elegidas`;
  const que = { MENSUALIDAD: "Mensualidad", CARGOS: "Cargos", AMBAS: "Todo" }[
    eleccionDeKinds(p.invoiceKinds)
  ];
  return p.onlyCurrentMonth ? `${que} · este mes` : `${que} · con lo atrasado`;
}

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
  invoiceKinds: InvoiceKind[];
  onlyCurrentMonth: boolean;
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
  /** TIPO de factura que rebaja: la mensualidad, los cargos sueltos o las dos. */
  invoiceKinds: InvoiceKind[];
  /** Limitarlo a lo facturado este mes (pronto pago) o alcanzar también lo atrasado. */
  onlyCurrentMonth: boolean;
  /**
   * Facturas elegidas a mano (sólo con UN cliente de público). `null` = nadie las ha
   * tocado y se marcan solas según el tipo y la antigüedad; en cuanto se toca una
   * casilla pasa a ser la lista exacta que se guarda.
   */
  invoiceIds: string[] | null;
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

/** Una factura que el cliente debe, para elegir a cuáles llega la promoción. */
export type PendingInvoice = {
  id: string;
  tid: number;
  kind: InvoiceKind;
  invoiceDate: string;
  subtotal: number;
  total: number;
  paidAmount: number;
  saldo: number;
  concepto: string | null;
  /** Timbrada ante la DIAN: no se puede abaratar sin nota crédito electrónica. */
  timbrada: boolean;
  /** Ya trae el descuento que le puso el portal de pagos del legacy. */
  rebajadaEnOrigen: boolean;
};

/** ¿La regla de tipo + antigüedad alcanzaría esta factura? (Espejo de `alcanzaLaFactura`.) */
export function alcanzaPorRegla(
  d: Pick<PromotionDraft, "invoiceKinds" | "onlyCurrentMonth">,
  inv: Pick<PendingInvoice, "kind" | "invoiceDate">,
  hoy = new Date(),
): boolean {
  const tipos = d.invoiceKinds?.length ? d.invoiceKinds : ["RECURRENTE"];
  if (!tipos.includes(inv.kind)) return false;
  if (!d.onlyCurrentMonth) return true;
  const [y, m] = inv.invoiceDate.slice(0, 7).split("-").map(Number);
  return y === hoy.getFullYear() && m === hoy.getMonth() + 1;
}

/**
 * Cuánto le rebajaría la promoción a esta factura y, si no se puede, por qué. Mismas
 * reglas que el cobro en ventanilla (`descuentosDePromocionPendientes`): allí una
 * factura que no pasa se salta callada, y aquí hay que decirlo ANTES de elegirla.
 */
export function descuentoSobreFactura(
  discountFormat: DiscountFormat, percentage: number, flatAmount: number, inv: PendingInvoice,
): { monto: number; motivo: string | null; tope: boolean } {
  if (inv.timbrada) return { monto: 0, motivo: "Timbrada ante la DIAN", tope: false };
  if (inv.rebajadaEnOrigen) return { monto: 0, motivo: "Ya trae el descuento del portal", tope: false };
  const base = isBeforeTaxDiscount(discountFormat) ? inv.subtotal : inv.total;
  const monto = isFlatDiscount(discountFormat)
    ? Math.min(flatAmount || 0, base)
    : Math.round((base * (percentage || 0)) / 100 * 100) / 100;
  // Si el descuento pasa de lo que debe, elegida a mano se le perdona el saldo entero
  // (nunca más: lo ya abonado no vuelve como saldo a favor). Por la regla automática
  // no se aplicaría, así que no se marca sola.
  if (monto >= inv.saldo) return { monto: inv.saldo, motivo: null, tope: true };
  return { monto, motivo: null, tope: false };
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
  invoiceKinds: InvoiceKind[];
  onlyCurrentMonth: boolean;
  /** Facturas elegidas a mano; si trae alguna, rebaja exactamente esas. */
  invoiceIds: string[];
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
