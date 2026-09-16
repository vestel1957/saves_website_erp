import type { PrismaService } from '../prisma/prisma.service';
import { hoyEnColombia } from '../common/fecha-colombia';

/**
 * Qué descuento por PRONTO PAGO hay vigente hoy — leído de las promociones, no de un
 * texto escrito a mano.
 *
 * Existe por una llamada del 2026-09-08: la promo "5% Pronto pago" venció el día 5 y
 * el chatbot seguía prometiéndosela a los clientes, porque su respuesta era una
 * constante en `chatbot/tramites.catalogo.ts` ("es la única promoción permanente:
 * 5%…"). El bot no puede prometer plata que el sistema no va a descontar: quien llama
 * el día 8 pagaba completo después de que se le dijera que tenía rebaja.
 *
 * No hay promociones recurrentes ([[pago-adelantado-legacy]]): la del pronto pago se
 * crea cada mes a mano. Preguntando aquí, el bot deja de prometerla sola cuando vence
 * y vuelve a anunciarla sola en cuanto alguien crea la de octubre, sin tocar código.
 *
 * Sólo se anuncian las promociones **generales**: las que rebajan la mensualidad del
 * mes en curso, en porcentaje, y alcanzan a cualquier cliente activo. Una campaña
 * dirigida —de cartera, de un plan, de una sede o de clientes sueltos— no se le canta
 * a todo el que pregunte: quien no entra en ella se sentiría engañado, y el que sí
 * entra la ve igualmente al pagar.
 */
export type ProntoPagoVigente = {
  nombre: string;
  porcentaje: number;
  desde: Date;
  hasta: Date;
};

export async function prontoPagoVigente(
  prisma: PrismaService,
  hoy: Date = hoyEnColombia(),
): Promise<ProntoPagoVigente | null> {
  const promos = await prisma.promotion.findMany({
    where: {
      active: true,
      startDate: { lte: hoy },
      endDate: { gte: hoy },
      discountFormat: '%',
      percentage: { gt: 0 },
      // El pronto pago es, por definición, la MENSUALIDAD del mes que corre. Una que
      // alcance lo atrasado es una campaña de cartera, y una que rebaje cargos es otra
      // cosa (instalación, traslado): ninguna de las dos se anuncia como pronto pago.
      onlyCurrentMonth: true,
      invoiceKinds: { has: 'RECURRENTE' },
      NOT: { invoiceKinds: { has: 'FIJA' } },
    },
    select: {
      name: true, percentage: true, startDate: true, endDate: true,
      allSubscribers: true, subscriberStatuses: true, neighborhoodRefs: true,
      subscribers: { select: { id: true }, take: 1 },
      plans: { select: { id: true }, take: 1 },
      branches: { select: { id: true }, take: 1 },
    },
    orderBy: { percentage: 'desc' },
  });

  const general = promos.find(
    (p) => !p.subscribers.length && !p.plans.length && !p.branches.length
      && !(p.neighborhoodRefs ?? []).length
      && (p.allSubscribers || p.subscriberStatuses.includes('ACTIVO')),
  );
  if (!general) return null;
  return {
    nombre: general.name,
    porcentaje: general.percentage,
    desde: general.startDate,
    hasta: general.endDate,
  };
}

const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

/** «del 1 al 5 de septiembre» — las columnas `date` se leen en UTC. */
export function vigenciaEnPalabras(desde: Date, hasta: Date): string {
  const d1 = desde.getUTCDate();
  const d2 = hasta.getUTCDate();
  const m1 = MESES[desde.getUTCMonth()];
  const m2 = MESES[hasta.getUTCMonth()];
  if (m1 === m2 && desde.getUTCFullYear() === hasta.getUTCFullYear()) {
    return d1 === d2 ? `el ${d1} de ${m1}` : `del ${d1} al ${d2} de ${m1}`;
  }
  return `del ${d1} de ${m1} al ${d2} de ${m2}`;
}

/**
 * Lo que el bot le dice al cliente sobre el pronto pago. Cuando no hay nada vigente
 * la respuesta es que NO lo hay — nunca "pregunte a un asesor", que en la práctica es
 * dejar la promesa viva en la cabeza del cliente.
 */
export function textoProntoPago(p: ProntoPagoVigente | null): string {
  if (!p) {
    return 'En este momento NO hay descuento por pronto pago vigente. No le prometas ninguno '
      + 'ni le des porcentajes de otros meses. Si el cliente dice que se lo ofrecieron o que ya '
      + 'se lo aplicaron, no discutas: pásalo a un asesor con hablar_con_humano.';
  }
  return `Hay ${p.porcentaje}% de descuento si paga ${vigenciaEnPalabras(p.desde, p.hasta)}. `
    + 'Solo aplica a la mensualidad del mes en curso, NO a facturas atrasadas, y se le '
    + 'descuenta al momento de pagar. Fuera de esas fechas no hay descuento.';
}
