/**
 * Que el PORTAL DE PAGOS EN LÍNEA cobre ya con el descuento puesto.
 *
 * El portal (`vestel.com.co/crm`, PHP del legacy) arma lo que va a cobrar de una sola
 * forma: `SUM(total) - SUM(pamnt)` sobre las filas de `invoices` del cliente
 * (`Customers_model::due_details`), y ese número es el que viaja al widget de Wompi.
 * No tiene concepto de "descuento a mostrar": lo único que baja lo que cobra es que la
 * factura del legacy VALGA menos.
 *
 * Su promoción propia no sirve para esto, por tres motivos comprobados en el código:
 * sólo toca la ÚLTIMA factura del cliente (`aplicar_discuount_pago_oportuno`, `order by
 * tid desc limit 1` — en un cliente de cartera esa suele ser un cargo reciente, no la
 * deuda), el banner que la ofrece sólo aparece **después del día 20** del mes
 * (`if($promo1!=null || date("d")<=20)` en `views/invoices/invoices.php`) y no se puede
 * corregir desde aquí: el vhost de Plesk no es legible por este usuario y no hay sudo.
 *
 * Así que la única vía es conceder el descuento ANTES de que pague, escribir la nota
 * crédito de este lado y dejar que `pushEditedInvoices` (writeback, gate
 * `LEGACY_WRITEBACK_EDICIONES_LIVE`, ya abierto) baje el `total` de la fila del legacy.
 *
 * ⚠️ Eso invierte la regla de oro del descuento al cobrar —"se concede AL COBRAR, o
 * quien paga tarde se lo lleva igual" ([[fuga-descuento-pronto-pago]])—, y por eso:
 *
 *   1. **Sólo alcanza a las promociones marcadas con `portalPreapply`**, un
 *      interruptor propio y separado de `portalPublish`. No vale reutilizar aquél: el
 *      5% de pronto pago está publicado en el portal, y repartirlo por adelantado a
 *      todos los activos con factura pendiente es exactamente lo contrario de premiar
 *      a quien paga a tiempo.
 *   2. **Tiene gate propio** (`PROMO_PORTAL_PRECONCEDER_LIVE`). Cerrado, el barrido
 *      calcula y cuenta, pero no escribe nada: sirve para ver a cuánto asciende antes
 *      de repartirlo.
 *   3. **Se retira solo** cuando la promoción vence sin que el cliente pague
 *      (`revertirDescuentosVencidos`), que es lo que impide que la rebaja se vuelva
 *      permanente en el legacy.
 *
 * Un descuento ya concedido no se vuelve a conceder: la huella es la misma
 * `PromotionApplication` que usan la ventanilla y el botón manual.
 */
import { PrismaService } from '../prisma/prisma.service';
import { round2 } from '../common/money';
import { hoyEnColombia } from '../common/fecha-colombia';
import { descuentosDePromocionPendientes } from './descuento-al-cobrar';
import { revertirDescuentosVencidos } from './revertir-descuentos-vencidos';
import { aplicarNotaEnTx } from '../billing/nota-en-tx';

/** ¿Se escribe de verdad, o el barrido sólo cuenta lo que haría? */
export const PORTAL_PRECONCEDER_LIVE = process.env.PROMO_PORTAL_PRECONCEDER_LIVE === 'true';

/** Autor que queda escrito en la nota crédito y en la aplicación de la promoción. */
const AUTOR = 'Portal de pagos (automático)';

/**
 * Respiro entre cliente y cliente CUANDO SE ESCRIBE.
 *
 * La primera pasada de una campaña escribe miles de notas crédito seguidas, y el
 * Postgres es compartido ([[postgres-conexiones-compartidas]]): la del 2026-09-02
 * (2.838 notas) hizo que un recaudo de ventanilla se pasara del timeout de 5 s de su
 * transacción interactiva y devolviera 500 —la cajera lo reintentó y entró, pero eso no
 * puede volver a pasar—. Repartir la cartera no tiene ninguna prisa; cobrar sí.
 *
 * No afecta a las pasadas de régimen: ahí casi nunca hay nada que conceder, porque lo
 * ya concedido se salta.
 */
const RESPIRO_MS = 25;
const respirar = () => new Promise((r) => setTimeout(r, RESPIRO_MS));

export type ResumenDescuentoPortal = {
  live: boolean;
  /** Promociones vigentes publicadas en el portal que se tuvieron en cuenta. */
  promociones: string[];
  /** Clientes que la campaña alcanza y tienen algo pendiente. */
  candidatos: number;
  /** Clientes a los que se les concedió (o se les concedería) algo. */
  beneficiados: number;
  facturas: number;
  monto: number;
  /** Descuentos retirados porque su promoción venció sin que el cliente pagara. */
  retirados: { clientes: number; facturas: number; monto: number };
  errores: { subscriberId: string; error: string }[];
};

/**
 * Concede por adelantado el descuento de las promociones publicadas en el portal, y
 * retira el de las que vencieron sin pago.
 *
 * El cálculo es el MISMO de la ventanilla (`descuentosDePromocionPendientes`), acotado
 * a las promos del portal: una sola definición de cuánto se rebaja y a qué factura, o
 * el cliente vería un número en línea y otro distinto en el mostrador.
 *
 * Va cliente por cliente y no en una sola consulta a propósito: cada uno se escribe en
 * su propia transacción, así un fallo en uno no tumba el barrido entero ni deja media
 * cartera con notas a medias. Es un barrido periódico, no una ruta de usuario.
 */
export async function barrerDescuentosDelPortal(
  prisma: PrismaService,
  opts: {
    live?: boolean;
    /**
     * Acota TODO el barrido a un solo cliente —conceder y retirar—. Existe para poder
     * probar la campaña de punta a punta (ver el valor ya rebajado en el portal) antes
     * de soltarla sobre la cartera entera; el cron nunca lo pasa.
     */
    soloSubscriberId?: string;
  } = {},
): Promise<ResumenDescuentoPortal> {
  const live = opts.live ?? PORTAL_PRECONCEDER_LIVE;
  const hoy = hoyEnColombia();
  const resumen: ResumenDescuentoPortal = {
    live, promociones: [], candidatos: 0, beneficiados: 0, facturas: 0, monto: 0,
    retirados: { clientes: 0, facturas: 0, monto: 0 }, errores: [],
  };

  // Lo primero es retirar: si una promo venció ayer, el legacy tiene que volver a
  // cobrar entero HOY, aunque hoy no haya ninguna campaña viva que conceder.
  await retirarVencidos(prisma, resumen, opts.soloSubscriberId);

  const promos = await prisma.promotion.findMany({
    where: {
      active: true, portalPreapply: true,
      startDate: { lte: hoy }, endDate: { gte: hoy },
    },
    select: { id: true, name: true, allSubscribers: true, subscriberStatuses: true },
  });
  if (!promos.length) return resumen;
  resumen.promociones = promos.map((p) => p.name);

  // Los candidatos se acotan por ESTADO (o todos) y luego cada uno se evalúa contra el
  // público completo dentro de `descuentosDePromocionPendientes`, que es quien decide
  // de verdad. Acotar así es sólo para no recorrer los 8.028 clientes con deuda: si la
  // promo además filtra por sede, barrio, plan o lista de clientes, el filtro fino lo
  // pone `reaches` y aquí no se pierde a nadie (el estado nunca ensancha el público).
  const todos = promos.some((p) => p.allSubscribers || !p.subscriberStatuses.length);
  const estados = [...new Set(promos.flatMap((p) => p.subscriberStatuses))];
  const candidatos = await prisma.subscriber.findMany({
    where: {
      ...(todos ? {} : { status: { in: estados } }),
      ...(opts.soloSubscriberId ? { id: opts.soloSubscriberId } : {}),
      invoices: { some: { status: { in: ['DUE', 'PARTIAL'] } } },
    },
    select: { id: true },
  });
  resumen.candidatos = candidatos.length;

  const ids = promos.map((p) => p.id);
  for (const { id } of candidatos) {
    try {
      const concedido = await concederA(prisma, id, ids, hoy, live);
      if (concedido.facturas) {
        resumen.beneficiados++;
        resumen.facturas += concedido.facturas;
        resumen.monto = round2(resumen.monto + concedido.monto);
        if (live) await respirar();
      }
    } catch (e) {
      resumen.errores.push({ subscriberId: id, error: (e as Error).message });
    }
  }
  return resumen;
}

/** Lo que se le concede (o se le concedería) a UN cliente. */
async function concederA(
  prisma: PrismaService,
  subscriberId: string,
  promocionIds: string[],
  hoy: Date,
  live: boolean,
): Promise<{ facturas: number; monto: number }> {
  const facturas = await prisma.subInvoice.findMany({
    where: { subscriberId, status: { in: ['DUE', 'PARTIAL'] } },
    orderBy: [{ invoiceDate: 'asc' }, { tid: 'asc' }],
    select: {
      id: true, tid: true, kind: true, invoiceDate: true,
      subtotal: true, total: true, paidAmount: true, discount: true,
    },
  });
  const pendientes = await descuentosDePromocionPendientes(
    prisma, subscriberId, facturas, hoy, promocionIds,
  );
  if (!pendientes.size) return { facturas: 0, monto: 0 };

  const monto = round2([...pendientes.values()].reduce((a, b) => a + b.amount, 0));
  if (!live) return { facturas: pendientes.size, monto };

  // Todo lo de un cliente en una sola transacción: o se le rebaja la cartera entera o
  // no se le toca. A medias, el portal le cobraría una cifra que no es ni la de antes
  // ni la de después.
  await prisma.$transaction(async (tx) => {
    for (const [invoiceId, d] of pendientes) {
      await aplicarNotaEnTx(tx, invoiceId, {
        type: 'CREDITO',
        amount: d.amount,
        // Mismo texto que la ventanilla y que el botón manual: la factura se lee igual
        // venga de donde venga el descuento.
        description: `Promoción: ${d.promotionName} (${d.label})`,
        editedBy: AUTOR,
      });
      await tx.promotionApplication.create({
        data: {
          promotionId: d.promotionId,
          invoiceId,
          appliedByName: AUTOR,
          percentage: d.percentage,
          amount: d.amount,
        },
      });
    }
  });
  return { facturas: pendientes.size, monto };
}

/**
 * Retira los descuentos cuya promoción ya venció y el cliente no pagó.
 *
 * Es la mitad que hace que esto no sea un regalo permanente: sin ella, la rebaja se
 * queda escrita en la factura del legacy y el portal seguiría cobrando de menos en
 * octubre por una campaña de septiembre. Reutiliza la misma función que la ventanilla
 * (`revertirDescuentosVencidos`), que sólo toca facturas sin pagar y deja la huella en
 * forma de nota débito.
 */
async function retirarVencidos(
  prisma: PrismaService,
  resumen: ResumenDescuentoPortal,
  soloSubscriberId?: string,
) {
  const hoy = hoyEnColombia();
  const vencidas = await prisma.promotionApplication.findMany({
    where: { revertedAt: null, promotion: { endDate: { lt: hoy }, portalPreapply: true } },
    select: { invoiceId: true },
  });
  if (!vencidas.length) return;
  // `PromotionApplication.invoiceId` es una columna suelta, no una relación (así nació,
  // para poder anotar la huella sin atarse al ciclo de vida de la factura): a quién
  // pertenece cada factura hay que preguntarlo aparte.
  const facturas = await prisma.subInvoice.findMany({
    where: {
      id: { in: vencidas.map((a) => a.invoiceId) },
      status: { in: ['DUE', 'PARTIAL'] },
      ...(soloSubscriberId ? { subscriberId: soloSubscriberId } : {}),
    },
    select: { subscriberId: true },
  });
  const clientes = [...new Set(facturas.map((f) => f.subscriberId).filter(Boolean) as string[])];
  if (!clientes.length) return;
  if (!resumen.live) {
    resumen.retirados = { clientes: clientes.length, facturas: facturas.length, monto: 0 };
    return;
  }
  for (const subscriberId of clientes) {
    try {
      const r = await prisma.$transaction((tx) =>
        revertirDescuentosVencidos(tx, subscriberId, { editedBy: AUTOR }));
      if (r.revertidas) {
        resumen.retirados.clientes++;
        resumen.retirados.facturas += r.revertidas;
        resumen.retirados.monto = round2(resumen.retirados.monto + r.monto);
        await respirar();
      }
    } catch (e) {
      resumen.errores.push({ subscriberId, error: (e as Error).message });
    }
  }
}
