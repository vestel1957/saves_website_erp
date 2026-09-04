import { NotFoundException } from '../core/http/errores';
import { Prisma } from '@prisma/client';
import { num, round2 } from '../common/money';
import { RETENTION_LABEL_TO_ENUM } from './retenciones';

/**
 * Aplica una nota crédito/débito a una factura DENTRO de una transacción ya
 * abierta por otro.
 *
 * Es el cuerpo de `FacturasService.createNote`, sacado de la clase para que lo
 * pueda usar quien ya está dentro de su propia `$transaction` —el recaudo, sin
 * ir más lejos—. Prisma no anida transacciones interactivas: llamar a
 * `createNote` desde dentro de `collect` abriría una segunda conexión que no ve
 * lo que la primera aún no ha confirmado, y el reparto del pago trabajaría
 * sobre totales viejos.
 *
 * No valida permisos ni el monto: eso lo hace quien llama.
 *
 * Vive en su propio archivo y no dentro de `facturas.service.ts` porque también la
 * necesita `anticipos.ts` (el descuento del mes adelantado) y ese servicio ya importa
 * `anticipos`: dejarla allí cerraba un ciclo de imports. `facturas.service` la
 * re-exporta, así que quien ya la importaba de ahí sigue igual.
 */
export async function aplicarNotaEnTx(
  tx: Prisma.TransactionClient,
  invoiceId: string,
  opts: {
    type: 'CREDITO' | 'DEBITO';
    amount: number;
    /**
     * El POR QUÉ de la nota, obligatorio. No es opcional a propósito: una nota
     * mueve el total de una factura y sin motivo el renglón queda mudo en el
     * documento, en el historial y en el listado de notas. Quien la aplique a mano
     * lo escribe (lo exige `CreateNoteDto`) y quien la aplique desde código pone
     * aquí la frase que explica el automatismo ("Promoción: …", "Descuento por mes
     * adelantado: …"). Al ser obligatorio en el tipo, TypeScript no deja añadir un
     * origen nuevo de notas sin decir por qué.
     */
    description: string;
    retentionType?: keyof typeof RETENTION_LABEL_TO_ENUM | null;
    authorLegacyId?: number | null;
    editedBy?: string | null;
  },
) {
  const amount = round2(opts.amount);
  const inv = await tx.subInvoice.findUnique({ where: { id: invoiceId } });
  if (!inv) throw new NotFoundException('Factura no encontrada');

  const isCredit = opts.type === 'CREDITO';
  const product = isCredit ? 'Nota Credito' : 'Nota Debito';
  const price = isCredit ? -amount : amount;

  let subtotal = num(inv.subtotal);
  let total = num(inv.total);
  const paid = num(inv.paidAmount);
  let status = inv.status;

  if (isCredit) {
    subtotal = round2(subtotal - amount);
    total = round2(total - amount);
    if (subtotal < 0) subtotal = 0;
    if (total < 0) total = 0;
    if (round2(total - paid) <= 0) status = 'PAID';
    else if (paid > 0) status = 'PARTIAL';
  } else {
    subtotal = round2(subtotal + amount);
    total = round2(total + amount);
    if (paid > 0 && paid < total) status = 'PARTIAL';
    else if (paid === 0) status = 'DUE';
  }

  // Retención (opcional). Paridad legacy: se guarda el TIPO en la línea y también en
  // el header (`invoices.tipo_retencion`), donde la última nota pisa a la anterior;
  // el VALOR es el `amount` que digitó el usuario — el legacy no lo calcula, y los
  // porcentajes sólo se aplican al armar el payload de Siigo.
  const retention = opts.retentionType ? RETENTION_LABEL_TO_ENUM[opts.retentionType] : null;

  await tx.subInvoiceItem.create({
    data: {
      invoiceId, productId: 0, productName: product,
      description: opts.description.trim() || product,
      qty: 1, price, taxRate: 0, subtotal: price, taxTotal: 0, discountTotal: 0,
      retentionType: retention,
      createdByUserId: opts.authorLegacyId ?? null,
    },
  });
  await tx.subInvoice.update({
    where: { id: invoiceId },
    data: {
      subtotal, total, status, itemsCount: { increment: 1 },
      ...(retention ? { retentionType: retention } : {}),
      // Una nota cambia el total, así que la factura queda MODIFICADA aquí y hay
      // que blindarla del sync igual que una edición. Sin esto, el descuento se
      // aplicaba, el sync veía el total distinto al del legacy y en la siguiente
      // pasada (≤15 min) le devolvía el total viejo: la nota quedaba colgada en el
      // detalle y el cliente seguía debiendo lo mismo. Pasó de verdad con la
      // factura 470096. `editCount` NO se toca: eso cuenta ediciones, no notas.
      editedAt: new Date(),
      editedBy: opts.editedBy ?? null,
    },
  });

  // Recalcular cache de dinero del cliente.
  if (inv.subscriberId) {
    const agg = await tx.transaction.aggregate({
      _sum: { debit: true, credit: true },
      where: { subscriberId: inv.subscriberId, status: 'VIGENTE', ext: false },
    });
    await tx.subscriber.update({
      where: { id: inv.subscriberId },
      data: { debitCache: agg._sum.debit ?? 0, creditCache: agg._sum.credit ?? 0 },
    });
  }

  return { invoiceId, type: opts.type, amount, newTotal: total, newBalance: round2(total - paid), status };
}
