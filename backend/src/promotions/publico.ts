/**
 * A quién alcanza una promoción y cuánto descuenta.
 *
 * Vivía dentro de `PromotionsService` como métodos privados, y se sacó aquí cuando el
 * descuento pasó a concederse también AL COBRAR (`descuento-al-cobrar.ts`). Dos copias
 * de "¿esta promo alcanza a este cliente?" es la clase de duplicado que termina
 * descontándole a quien no debía: hay una sola definición y la usan los dos caminos.
 *
 * Va como funciones sueltas y no como servicio por lo mismo que
 * `revertir-descuentos-vencidos.ts`: `CobranzasService` no conoce a `PromotionsService`
 * y meterle esa dependencia obligaría a reordenar el contenedor, que se cablea a mano
 * (ver [[generador-contenedor-roto]]).
 */
import { Prisma } from '@prisma/client';
import { num, round2 } from '../common/money';
import { SubscriberStatusName } from './dto/promotions.dto';

export const isFlatFmt = (f: string) => f === 'flat' || f === 'bflat';
export const isBeforeTaxFmt = (f: string) => f === 'b_p' || f === 'bflat';
const copFmt = (n: number) => `$${Math.round(n).toLocaleString('es-CO')}`;
const uniq = (xs: string[]) => Array.from(new Set(xs.filter(Boolean)));

/** Etiqueta del descuento tal como se escribe en la factura ("5%", "$10.000, antes de imp."). */
export function discountLabel(format: string, percentage: number, flatAmount: number | null): string {
  const core = isFlatFmt(format) ? copFmt(num(flatAmount)) : `${percentage}%`;
  return isBeforeTaxFmt(format) ? `${core}, antes de imp.` : core;
}

/** Público de una promoción, ya normalizado (sin undefined). */
export type Audience = {
  allSubscribers: boolean;
  subscriberStatuses: SubscriberStatusName[];
  subscriberIds: string[];
  planIds: string[];
  branchIds: string[];
  neighborhoodRefs: string[];
};

/** Lo que hace falta saber de un cliente para decidir si una promo lo alcanza. */
export type SubscriberFacts = {
  id: string;
  status: string | null;
  branchId: string | null;
  neighborhood: string | null;
  /** Planes que se le están cobrando (servicios contratados o, si no tiene, su última factura). */
  planIds: string[];
};

/** Público guardado de una promo ya cargada (con sus relaciones). */
export function audienceOfPromo(p: {
  allSubscribers: boolean;
  subscriberStatuses: string[];
  neighborhoodRefs: string[];
  subscribers: { id: string }[];
  plans: { id: string }[];
  branches: { id: string }[];
}): Audience {
  return {
    allSubscribers: p.allSubscribers,
    subscriberStatuses: p.subscriberStatuses as SubscriberStatusName[],
    subscriberIds: p.subscribers.map((s) => s.id),
    planIds: p.plans.map((x) => x.id),
    branchIds: p.branches.map((b) => b.id),
    neighborhoodRefs: p.neighborhoodRefs,
  };
}

/** ¿El público tiene algún criterio puesto? Sin criterios no alcanza a nadie. */
export function hasCriteria(a: Audience): boolean {
  return (
    a.allSubscribers ||
    a.subscriberStatuses.length > 0 ||
    a.subscriberIds.length > 0 ||
    a.planIds.length > 0 ||
    a.branchIds.length > 0 ||
    a.neighborhoodRefs.length > 0
  );
}

/** ¿El público de la promo alcanza a este cliente? (Y entre dimensiones, O dentro.) */
export function reaches(a: Audience, f: SubscriberFacts): boolean {
  if (a.allSubscribers) return true;
  if (!hasCriteria(a)) return false;
  if (a.subscriberStatuses.length && !(f.status && a.subscriberStatuses.includes(f.status as SubscriberStatusName)))
    return false;
  if (a.branchIds.length && !(f.branchId && a.branchIds.includes(f.branchId))) return false;
  if (a.neighborhoodRefs.length && !(f.neighborhood && a.neighborhoodRefs.includes(f.neighborhood)))
    return false;
  if (a.subscriberIds.length && !a.subscriberIds.includes(f.id)) return false;
  if (a.planIds.length && !f.planIds.some((p) => a.planIds.includes(p))) return false;
  return true;
}

/**
 * Datos del cliente que deciden si una promo lo alcanza.
 *
 * `conPlanes: false` se salta la resolución del plan, que es la parte cara: los
 * clientes sin `SubscriberService` —casi todos los de CARTERA, ver
 * [[servicios-contratados-incompletos]]— obligan a una consulta cruda contra los
 * renglones de su última factura, y a razón de una por cliente eso convierte un
 * barrido de 1.230 en varios minutos. Quien llama sólo puede apagarlo cuando NINGUNA
 * de las promociones en juego filtra por plan; entonces `planIds` no se lee nunca
 * (`reaches` sólo lo mira si el público tiene planes) y el resultado es el mismo.
 */
export async function subscriberFacts(
  tx: Prisma.TransactionClient,
  subscriberId: string,
  opts: { conPlanes?: boolean } = {},
): Promise<SubscriberFacts | null> {
  const s = await tx.subscriber.findUnique({
    where: { id: subscriberId },
    select: {
      id: true, status: true, branchId: true, neighborhood: true,
      services: { select: { planId: true } },
    },
  });
  if (!s) return null;
  let planIds = uniq(s.services.map((x) => x.planId ?? ''));
  // Sin servicios contratados → el plan sale de su última factura (mismo respaldo que
  // usa la corrida mensual; ver [[servicios-contratados-incompletos]]).
  if (!s.services.length && opts.conPlanes !== false) {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT DISTINCT pl.id
        FROM "SubInvoiceItem" it
        JOIN "Plan" pl ON lower(btrim(pl.name)) = lower(btrim(COALESCE(it."productName", it.description)))
       WHERE it.price > 0
         AND it."invoiceId" = (SELECT i2.id FROM "SubInvoice" i2 WHERE i2."subscriberId" = ${subscriberId}
                                ORDER BY i2."invoiceDate" DESC, i2.tid DESC LIMIT 1)`;
    planIds = rows.map((r) => r.id);
  }
  return { id: s.id, status: s.status, branchId: s.branchId, neighborhood: s.neighborhood, planIds };
}

/**
 * Cuánto descuenta esta promoción sobre esta factura.
 *
 * "Antes de imp." descuenta sobre el subtotal (sin IVA); si no, sobre el total. El
 * monto fijo se topa a la base para que una promo de $50.000 no deje en negativo una
 * factura de $30.000.
 */
export function montoDeDescuento(
  promo: { discountFormat: string; percentage: number; flatAmount: Prisma.Decimal | number | null },
  invoice: { subtotal: Prisma.Decimal | number; total: Prisma.Decimal | number },
): number {
  const base = isBeforeTaxFmt(promo.discountFormat) ? num(invoice.subtotal) : num(invoice.total);
  return isFlatFmt(promo.discountFormat)
    ? round2(Math.min(num(promo.flatAmount), base))
    : round2((base * promo.percentage) / 100);
}
