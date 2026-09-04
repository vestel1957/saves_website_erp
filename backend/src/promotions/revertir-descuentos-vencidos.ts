import { Prisma } from '@prisma/client';
import { aplicarNotaEnTx } from '../billing/facturas.service';
import { num, round2 } from '../common/money';
import { hoyEnColombia } from '../common/fecha-colombia';

/**
 * Retira el descuento de una promoción cuando el cliente NO pagó dentro de su
 * vigencia.
 *
 * El problema que cierra: la promo se aplica a la factura como nota crédito el
 * día que se concede, y ahí se queda. Quien se la aplicaba el día 3 y pagaba el
 * 20 se llevaba la rebaja igual, con lo que el "pronto pago" no premiaba nada.
 * En el legacy pasa lo mismo por otra vía (el portal público) y se corrige con
 * el parche de `/home/dev/parche-pronto-pago-legacy`; aquí se cierra la puerta
 * equivalente del sistema nuevo.
 *
 * Se ejecuta al COBRAR, justo antes de repartir la plata, y solo toca facturas
 * sin pagar: lo ya cobrado no se reescribe. El descuento no se borra —se
 * revierte con una nota débito— para que la factura conserve las dos huellas y
 * se pueda explicar en el mostrador.
 *
 * Va como función suelta y no como servicio a propósito: `CobranzasService` no
 * conoce a `PromotionsService` y meterle esa dependencia obligaría a reordenar
 * el contenedor, que hoy se cablea a mano (ver [[generador-contenedor-roto]]).
 */
export async function revertirDescuentosVencidos(
  tx: Prisma.TransactionClient,
  subscriberId: string,
  opts: { authorLegacyId?: number | null; editedBy?: string | null } = {},
): Promise<{ revertidas: number; monto: number; promociones: string[] }> {
  const vacio = { revertidas: 0, monto: 0, promociones: [] as string[] };

  const pendientes = await tx.subInvoice.findMany({
    where: { subscriberId, status: { in: ['DUE', 'PARTIAL'] } },
    select: { id: true },
  });
  if (!pendientes.length) return vacio;

  // La vigencia se mide contra la promoción QUE CONCEDIÓ el descuento, no contra
  // "si hay alguna promo viva hoy": cada aplicación sabe de cuál vino.
  // `hoyEnColombia` y no `new Date()`: entre las 7 PM y medianoche el UTC ya es
  // mañana, y una promo que vence hoy se daría por vencida esta misma tarde.
  const hoy = hoyEnColombia();
  const aplicaciones = await tx.promotionApplication.findMany({
    where: {
      invoiceId: { in: pendientes.map((i) => i.id) },
      revertedAt: null,
      promotion: { endDate: { lt: hoy } },
    },
    include: { promotion: { select: { name: true, endDate: true } } },
  });
  if (!aplicaciones.length) return vacio;

  let monto = 0;
  const promociones: string[] = [];
  for (const app of aplicaciones) {
    const amount = round2(num(app.amount));
    if (!(amount > 0)) continue;
    const vencio = app.promotion.endDate.toISOString().slice(0, 10);
    await aplicarNotaEnTx(tx, app.invoiceId, {
      type: 'DEBITO',
      amount,
      description: `Descuento retirado: "${app.promotion.name}" vencía el ${vencio} y el pago llegó después`,
      authorLegacyId: opts.authorLegacyId ?? null,
      editedBy: opts.editedBy ?? null,
    });
    await tx.promotionApplication.update({
      where: { id: app.id },
      data: { revertedAt: new Date() },
    });
    monto = round2(monto + amount);
    promociones.push(app.promotion.name);
  }

  return { revertidas: promociones.length, monto, promociones };
}
