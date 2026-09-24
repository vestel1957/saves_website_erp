import { Prisma } from '@prisma/client';
import { ivaDe, num, round2 } from '../common/money';
import { hoyEnColombia } from '../common/fecha-colombia';
import { conceptoMesAdelantado } from '../common/concepto-factura';
import { aplicarNotaEnTx } from './nota-en-tx';

/**
 * ANTICIPOS (saldo a favor): la plata que el cliente paga de más se guarda y se
 * aplica sola a la factura del mes siguiente cuando esa factura nace.
 *
 * El caso real: el cliente llega a la ventanilla y quiere pagar el mes corriente Y el
 * siguiente. La factura del siguiente todavía no existe (nace el día 1 con la corrida),
 * así que el excedente se queda en el aire. En el legacy no se queda: lo reparte
 * `Invoices_model::procesar_pagos_adelantados($csd)`, que recorre las facturas del
 * cliente, junta el sobrante (`pamnt - total`) y lo imputa a las que están `due`. Nexus
 * cobraba el excedente pero no lo repartía nunca: la factura de septiembre nacía en
 * `DUE` con `paidAmount = 0` y el cliente aparecía debiendo un mes que ya había pagado.
 * Esto cierra esa brecha.
 *
 * ── Por qué NO se copia la mecánica del legacy tal cual ──────────────────────────
 *
 * Allá el excedente vive DENTRO de la factura sobrepagada (`pamnt > total`) y el reparto
 * parte en dos la transacción original. Aquí eso no se sostiene mientras los dos sistemas
 * convivan:
 *
 *   · `SubInvoice.paidAmount` lo manda el legacy: el sync de ida copia `invoices.pamnt`
 *     encima del nuestro en cada pasada (15 min) INCLUSO en las facturas blindadas con
 *     `editedAt` — ver `syncInvoices` en scripts/sync-legacy-vivo.js. Un excedente
 *     guardado ahí, o restado de ahí al consumirlo, no sobrevive a la siguiente pasada.
 *   · `Transaction.credit` también se re-lee del legacy en los movimientos ya empujados
 *     (`refrescarTransacciones`, ventana de 30 días), así que partir una transacción
 *     bajándole el crédito se deshace solo y la plata se contaría dos veces.
 *
 * Por eso el anticipo vive en `CustomerAdvance`, una tabla que el sync no toca.
 *
 * ── Qué se escribe al aplicarlo ──────────────────────────────────────────────────
 *
 * Una PAREJA de movimientos sin caja (`cashAccountId = null`), que es lo que mantiene
 * cuadrado todo lo demás:
 *
 *   · al CRÉDITO contra la factura destino → la factura queda pagada con respaldo, sale
 *     en "Pagos aplicados" y, cuando la factura existe también en el legacy, el writeback
 *     la deja pagada allá (`reflejarEnLegacy` recalcula `pamnt` desde `transactions`).
 *   · al DÉBITO por el mismo valor, sin factura → consume el anticipo.
 *
 * Neto cero: el saldo de la caja no se mueve (la plata entró el día del recaudo y ahí
 * sigue contada), el arqueo y el cierre del día no ven nada (filtran por caja y estos
 * dos van sin caja) y el acumulado del cliente (`debitCache`/`creditCache`) no se infla.
 */

/** Por debajo de esto no se reparte: calderilla que sólo genera ruido (paridad legacy). */
export const MINIMO_ANTICIPO = 50;

export type AplicacionAnticipo = {
  advanceId: string;
  invoiceId: string;
  tid: number;
  amount: number;
  status: 'PAID' | 'PARTIAL';
};

export type ResultadoAnticipos = {
  aplicados: AplicacionAnticipo[];
  total: number;
  /** Lo que queda sin imputar después del reparto. */
  pendiente: number;
};

const VACIO: ResultadoAnticipos = { aplicados: [], total: 0, pendiente: 0 };

/**
 * Reparto puro: qué anticipo paga qué factura y por cuánto. Sin BD, para poder
 * probarlo (ver anticipos.spec.ts) y para que la regla se lea de un vistazo.
 *
 * Los dos lados van del más viejo al más nuevo: el anticipo más antiguo se gasta
 * primero y se imputa a la factura más antigua, igual que el reparto en cascada de un
 * recaudo normal.
 */
export function repartirAnticipos(
  anticipos: { id: string; pendiente: number }[],
  facturas: { id: string; tid: number; saldo: number }[],
): { advanceId: string; invoiceId: string; tid: number; amount: number }[] {
  const reparto: { advanceId: string; invoiceId: string; tid: number; amount: number }[] = [];
  const saldos = facturas.map((f) => ({ ...f }));
  for (const a of anticipos) {
    let queda = round2(a.pendiente);
    if (queda < MINIMO_ANTICIPO) continue;
    for (const f of saldos) {
      if (queda < MINIMO_ANTICIPO) break;
      if (f.saldo <= 0) continue;
      const amount = round2(Math.min(queda, f.saldo));
      if (amount <= 0) continue;
      reparto.push({ advanceId: a.id, invoiceId: f.id, tid: f.tid, amount });
      f.saldo = round2(f.saldo - amount);
      queda = round2(queda - amount);
    }
  }
  return reparto;
}

/**
 * Guarda el excedente de un recaudo como anticipo del cliente.
 *
 * `transactionId` es el movimiento que trajo la plata: se crea igual que cualquier
 * ingreso de ventanilla (misma caja, mismo día, mismo método) pero SIN factura, así que
 * el cierre del día lo cuenta y el writeback lo lleva al legacy con `tid = 0` — la plata
 * entra al libro de allá sin dejar una referencia colgando a una factura que no existe.
 */
export async function registrarAnticipo(
  tx: Prisma.TransactionClient,
  p: {
    subscriberId: string;
    amount: number;
    date: Date;
    method?: string | null;
    transactionId?: string | null;
    sourceInvoiceId?: string | null;
    receiptId?: string | null;
    note?: string | null;
    /**
     * Mes(es) adelantados con descuento: el cliente pagó el mes rebajado antes de que
     * existiera la factura, así que la rebaja viaja PROMETIDA aquí y se concede cuando
     * la factura nace (ver `concederDescuentosAdelantados`).
     */
    adelanto?: { pct: number; descuento: number; meses: number; mensualidadNeta: number } | null;
  },
) {
  return tx.customerAdvance.create({
    data: {
      subscriberId: p.subscriberId,
      amount: round2(p.amount),
      applied: 0,
      status: 'ABIERTO',
      date: p.date,
      method: p.method ?? null,
      transactionId: p.transactionId ?? null,
      sourceInvoiceId: p.sourceInvoiceId ?? null,
      receiptId: p.receiptId ?? null,
      note: p.note ?? null,
      discountPct: p.adelanto ? p.adelanto.pct : null,
      discountAmount: p.adelanto ? round2(p.adelanto.descuento) : 0,
      discountApplied: 0,
      months: p.adelanto ? p.adelanto.meses : null,
      monthlyNet: p.adelanto ? round2(p.adelanto.mensualidadNeta) : null,
    },
  });
}

/** Saldo a favor sin imputar de un cliente. */
export async function saldoAFavor(tx: Prisma.TransactionClient, subscriberId: string): Promise<number> {
  const abiertos = await tx.customerAdvance.findMany({
    where: { subscriberId, status: 'ABIERTO' },
    select: { amount: true, applied: true },
  });
  return round2(abiertos.reduce((s, a) => s + Math.max(0, num(a.amount) - num(a.applied)), 0));
}

/**
 * Rótulo de la nota crédito del mes adelantado. Es además la HUELLA que hace
 * idempotente el descuento: antes de concederlo se mira si la factura ya trae una nota
 * que empiece por aquí. No se usa `PromotionApplication` a propósito —
 * `revertirDescuentosVencidos` retiraría en el siguiente cobro una rebaja que el
 * cliente ya pagó, porque la promo que la inspiró venció hace un mes.
 */
export const NOTA_ADELANTO = 'Descuento por pago adelantado';

/**
 * Concede el descuento PROMETIDO al cobrar un mes por adelantado.
 *
 * El caso: el 2 de septiembre el cliente paga septiembre y, marcando la casilla, deja
 * pagado octubre. Octubre vale 100.000 y se le cobran 95.000, porque adelantar rebaja
 * un 5% (`billing.advanceDiscountPct`). La factura de octubre no existe todavía —nace
 * el día 1 con la corrida—, así que ese 5% no se puede escribir en ninguna parte: viaja
 * prometido en el anticipo (`CustomerAdvance.discountAmount`) y se salda aquí, cuando
 * la factura ya existe.
 *
 * Reglas:
 *  · Sólo a facturas `RECURRENTE` de un mes POSTERIOR al del recaudo. Lo que se premió
 *    fue adelantarse; la mora se paga entera (misma promesa que el pronto pago, ver
 *    `promotions/descuento-al-cobrar.ts`).
 *  · Un mes de descuento por factura, en orden de fecha, hasta agotar lo prometido.
 *  · Se concede aunque el anticipo ya no alcance a saldar la factura (el plan subió de
 *    precio entre medias): la rebaja se pagó, y el cliente se queda debiendo sólo la
 *    diferencia. Nunca más que el saldo de la factura.
 */
export async function concederDescuentosAdelantados(
  tx: Prisma.TransactionClient,
  subscriberId: string,
  opts: { fecha?: Date; editedBy?: string | null } = {},
): Promise<{ facturas: { tid: number; monto: number }[]; total: number }> {
  const vacio = { facturas: [] as { tid: number; monto: number }[], total: 0 };

  const conDescuento = await tx.customerAdvance.findMany({
    where: { subscriberId, status: 'ABIERTO', discountAmount: { gt: 0 } },
    orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
    select: { id: true, date: true, discountPct: true, discountAmount: true, discountApplied: true, months: true, monthlyNet: true },
  });
  const vivos = conDescuento
    .map((a) => ({
      ...a,
      pendiente: round2(num(a.discountAmount) - num(a.discountApplied)),
      porMes: round2(num(a.discountAmount) / Math.max(1, a.months ?? 1)),
    }))
    .filter((a) => a.pendiente > 0);
  if (!vivos.length) return vacio;

  const pendientes = await tx.subInvoice.findMany({
    where: { subscriberId, status: { in: ['DUE', 'PARTIAL'] }, kind: 'RECURRENTE' },
    orderBy: [{ invoiceDate: 'asc' }, { tid: 'asc' }],
    select: { id: true, tid: true, invoiceDate: true, total: true, paidAmount: true },
  });
  if (!pendientes.length) return vacio;

  // Huella: una factura que ya lleva la nota no la vuelve a recibir. `aplicarAnticipos`
  // corre en cada recaudo, y una factura que quedó PARTIAL volvería a pasar por aquí.
  const yaRebajadas = new Set(
    (await tx.subInvoiceItem.findMany({
      where: {
        invoiceId: { in: pendientes.map((i) => i.id) },
        productName: 'Nota Credito',
        description: { startsWith: NOTA_ADELANTO },
      },
      select: { invoiceId: true },
    })).map((i) => i.invoiceId),
  );

  const concedidas: { tid: number; monto: number }[] = [];
  let total = 0;

  for (const adv of vivos) {
    // "Posterior al recaudo": el mes de la factura tiene que ir por delante del mes en
    // que entró la plata. Comparado en UTC porque `invoiceDate` es columna `date`
    // (ver [[sql-crudo-fechas-date]]).
    const corte = new Date(adv.date);
    const mesCorte = corte.getUTCFullYear() * 12 + corte.getUTCMonth();
    for (const inv of pendientes) {
      if (adv.pendiente <= 0) break;
      if (yaRebajadas.has(inv.id)) continue;
      const f = new Date(inv.invoiceDate);
      if (f.getUTCFullYear() * 12 + f.getUTCMonth() <= mesCorte) continue;
      const saldo = round2(num(inv.total) - num(inv.paidAmount));
      if (saldo <= 0) continue;
      let monto = round2(Math.min(adv.porMes, adv.pendiente, saldo));
      // La factura tiene que quedar CLAVADA en el neto que se cobró en ventanilla. El
      // total del mes puede salir unos centavos distinto del que se prometió (IVA
      // redondeado por renglón: 58.500 + 22.269·1,19 = 85.000,11 contra 85.000), y
      // sin este ajuste el anticipo la dejaría PARTIAL debiendo 0,11 (caso 22093,
      // 2026-09-16). Sólo por debajo de un peso: más que eso es otro precio.
      const neto = num(adv.monthlyNet);
      if (neto > 0) {
        const clavado = round2(saldo - neto);
        if (clavado > 0 && Math.abs(clavado - monto) < 1) monto = clavado;
      }
      if (monto <= 0) continue;

      const pct = adv.discountPct != null ? num(adv.discountPct) : null;
      await aplicarNotaEnTx(tx, inv.id, {
        type: 'CREDITO',
        amount: monto,
        description: `${NOTA_ADELANTO}${pct ? ` (${pct}%)` : ''}: pagado el ${fmtFecha(adv.date)}`,
        editedBy: opts.editedBy ?? null,
      });
      yaRebajadas.add(inv.id);
      adv.pendiente = round2(adv.pendiente - monto);
      concedidas.push({ tid: inv.tid, monto });
      total = round2(total + monto);
    }
    const aplicado = round2(num(adv.discountAmount) - adv.pendiente);
    if (aplicado !== num(adv.discountApplied)) {
      await tx.customerAdvance.update({ where: { id: adv.id }, data: { discountApplied: aplicado } });
    }
  }
  return { facturas: concedidas, total };
}

/** `2026-09-02` — la fecha del recaudo tal cual, para el texto de la nota. */
function fmtFecha(d: Date): string {
  return new Date(d).toISOString().slice(0, 10);
}

/**
 * Aplica los anticipos abiertos del cliente a sus facturas pendientes.
 *
 * Se llama cuando NACE una factura (la corrida del mes y la factura manual) y al
 * registrar un recaudo, que son los mismos dos momentos en que el legacy dispara
 * `procesar_pagos_adelantados`.
 *
 * Sólo entra la mensualidad (`RECURRENTE`), como allá: un cargo puntual —instalación,
 * traslado, reconexión— no se paga solo con el saldo a favor de nadie; ése lo cobra la
 * cajera cuando el cliente venga.
 */
export async function aplicarAnticipos(
  tx: Prisma.TransactionClient,
  subscriberId: string,
  opts: { fecha?: Date; editedBy?: string | null } = {},
): Promise<ResultadoAnticipos> {
  // Mismo cerrojo que usa el recaudo (`CobranzasService.lockSubscriber`): esto es otro
  // read-modify-write sobre `paidAmount`, y la corrida del mes puede coincidir con una
  // cajera cobrando. Orden de bloqueo: Subscriber primero; aquí no se toca ninguna caja.
  await tx.$queryRaw`SELECT id FROM "Subscriber" WHERE id = ${subscriberId} FOR UPDATE`;

  // El descuento del mes adelantado se concede AQUÍ, antes de mirar los saldos: la
  // nota crédito baja el total de la factura y el reparto de abajo tiene que trabajar
  // sobre el total ya rebajado. Si fuera al revés, el anticipo (que es el 95%) dejaría
  // la factura PARTIAL debiendo justo el 5% que ya se le premió en ventanilla.
  await concederDescuentosAdelantados(tx, subscriberId, opts);

  const abiertos = await tx.customerAdvance.findMany({
    where: { subscriberId, status: 'ABIERTO' },
    orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
    select: { id: true, amount: true, applied: true, date: true },
  });
  const anticipos = abiertos
    .map((a) => ({ id: a.id, pendiente: round2(num(a.amount) - num(a.applied)) }))
    .filter((a) => a.pendiente >= MINIMO_ANTICIPO);
  if (!anticipos.length) return { ...VACIO, pendiente: 0 };

  const pendientes = await tx.subInvoice.findMany({
    where: { subscriberId, status: { in: ['DUE', 'PARTIAL'] }, kind: 'RECURRENTE' },
    orderBy: [{ invoiceDate: 'asc' }, { tid: 'asc' }],
    select: { id: true, tid: true, total: true, paidAmount: true, legacyId: true },
  });
  const facturas = pendientes
    .map((i) => ({ id: i.id, tid: i.tid, saldo: round2(num(i.total) - num(i.paidAmount)) }))
    .filter((f) => f.saldo > 0);
  if (!facturas.length) {
    return { aplicados: [], total: 0, pendiente: round2(anticipos.reduce((s, a) => s + a.pendiente, 0)) };
  }

  const reparto = repartirAnticipos(anticipos, facturas);
  if (!reparto.length) return { aplicados: [], total: 0, pendiente: round2(anticipos.reduce((s, a) => s + a.pendiente, 0)) };

  const fecha = opts.fecha ?? hoyEnColombia();
  const saldoDe = new Map(pendientes.map((i) => [i.id, { total: num(i.total), paid: num(i.paidAmount) }]));
  const consumido = new Map<string, number>();
  const aplicados: AplicacionAnticipo[] = [];

  for (const r of reparto) {
    const inv = saldoDe.get(r.invoiceId)!;
    const nuevoPagado = round2(inv.paid + r.amount);
    // Menos de un peso de diferencia es el redondeo del IVA por renglón (85.000,11 contra
    // 85.000 cobrados), no deuda: mismo criterio que `mismoDinero` en el sync.
    const status: 'PAID' | 'PARTIAL' = inv.total - nuevoPagado < 1 ? 'PAID' : 'PARTIAL';

    // Crédito contra la factura: es el pago que la deja saldada (y el que el writeback
    // lleva al legacy si la factura también vive allá).
    const credito = await tx.transaction.create({
      data: {
        type: 'INCOME', category: 'Sales', credit: r.amount, debit: 0,
        subscriberId, method: 'Balance', date: fecha, invoiceId: r.invoiceId,
        // Sin caja a propósito: la plata entró el día del recaudo y ya está contada en
        // el arqueo de ese día. Cargarla otra vez a una caja la duplicaría en el cierre.
        cashAccountId: null, accountName: null,
        ext: false, status: 'VIGENTE',
        note: `Pago adelantado aplicado a la factura #${r.tid}`,
      },
    });
    // Débito que consume el anticipo: deja el neto en cero para la caja y para el
    // acumulado del cliente.
    const debito = await tx.transaction.create({
      data: {
        type: 'EXPENSE', category: 'Anticipo', credit: 0, debit: r.amount,
        subscriberId, method: 'Balance', date: fecha, invoiceId: null,
        cashAccountId: null, accountName: null,
        ext: false, status: 'VIGENTE',
        // Sin "Saldo " por delante: ver la nota del excedente en `collect`.
        note: `Anticipo trasladado a la factura #${r.tid}`,
      },
    });

    await tx.subInvoice.update({
      where: { id: r.invoiceId },
      data: { paidAmount: nuevoPagado, status },
    });
    await tx.customerAdvanceApplication.create({
      data: {
        advanceId: r.advanceId, invoiceId: r.invoiceId, amount: r.amount, date: fecha,
        transactionId: credito.id, debitTransactionId: debito.id,
      },
    });

    inv.paid = nuevoPagado;
    consumido.set(r.advanceId, round2((consumido.get(r.advanceId) ?? 0) + r.amount));
    aplicados.push({ advanceId: r.advanceId, invoiceId: r.invoiceId, tid: r.tid, amount: r.amount, status });
  }

  // Cierre de cada anticipo tocado: lo que quede por debajo del mínimo ya no se va a
  // repartir nunca, así que se da por consumido en vez de quedarse abierto para siempre.
  for (const [advanceId, monto] of consumido) {
    const a = abiertos.find((x) => x.id === advanceId)!;
    const applied = round2(num(a.applied) + monto);
    const queda = round2(num(a.amount) - applied);
    await tx.customerAdvance.update({
      where: { id: advanceId },
      data: { applied, status: queda >= MINIMO_ANTICIPO ? 'ABIERTO' : 'APLICADO' },
    });
  }

  const total = round2(aplicados.reduce((s, a) => s + a.amount, 0));
  const pendiente = round2(anticipos.reduce((s, a) => s + a.pendiente, 0) - total);
  return { aplicados, total, pendiente };
}

/**
 * Deshace el descuento del mes adelantado cuando se ANULA el recaudo que lo pagó.
 *
 * Sin esto, anular el pago le devolvía la plata al cliente y le dejaba la rebaja: la
 * factura de octubre se quedaba un 5% más barata gratis. Se revierte con nota DÉBITO,
 * igual que `revertirDescuentosVencidos`, para que la factura conserve las dos huellas.
 *
 * Las notas se localizan por su rótulo (`NOTA_ADELANTO`) y la fecha del recaudo, que va
 * escrita en el propio texto, y se revierte como mucho lo que este anticipo concedió
 * (`discountApplied`). Si el mismo cliente tuviera DOS anticipos con descuento del mismo
 * día, la nota que se retire podría ser la del otro — pero el total sí cuadra, porque
 * cada anulación está topada por lo suyo.
 *
 * Lo normal es que no haya nada que hacer: se anula el mismo día, la factura del mes
 * siguiente todavía no ha nacido y `discountApplied` es 0.
 */
export async function revertirDescuentoAdelantado(
  tx: Prisma.TransactionClient,
  advanceId: string,
  opts: { editedBy?: string | null } = {},
): Promise<{ revertidas: number; monto: number }> {
  const adv = await tx.customerAdvance.findUnique({
    where: { id: advanceId },
    select: { subscriberId: true, date: true, discountApplied: true },
  });
  if (!adv) return { revertidas: 0, monto: 0 };
  let porRevertir = round2(num(adv.discountApplied));
  if (porRevertir <= 0) return { revertidas: 0, monto: 0 };

  const marca = `${NOTA_ADELANTO}`;
  const sello = `pagado el ${fmtFecha(adv.date)}`;
  const notas = await tx.subInvoiceItem.findMany({
    where: {
      productName: 'Nota Credito',
      description: { startsWith: marca, endsWith: sello },
      invoice: { subscriberId: adv.subscriberId },
    },
    orderBy: { id: 'asc' },
    select: { id: true, invoiceId: true, price: true },
  });

  let monto = 0;
  let revertidas = 0;
  for (const n of notas) {
    if (porRevertir <= 0) break;
    // El precio de una nota crédito se guarda en negativo (ver `aplicarNotaEnTx`).
    const valor = round2(Math.min(Math.abs(num(n.price)), porRevertir));
    if (valor <= 0) continue;
    await aplicarNotaEnTx(tx, n.invoiceId, {
      type: 'DEBITO',
      amount: valor,
      description: `${NOTA_ADELANTO} retirado: se anuló el recaudo del ${fmtFecha(adv.date)}`,
      editedBy: opts.editedBy ?? null,
    });
    porRevertir = round2(porRevertir - valor);
    monto = round2(monto + valor);
    revertidas += 1;
  }
  await tx.customerAdvance.update({
    where: { id: advanceId },
    data: { discountApplied: porRevertir },
  });
  return { revertidas, monto };
}

/**
 * Deshace las aplicaciones de un anticipo (o de UNA aplicación concreta) devolviéndole
 * el saldo al cliente y dejando las facturas como estaban.
 *
 * Lo llama la anulación de movimientos: si se anula el recaudo que originó el anticipo,
 * la plata ya no existe y lo que se hizo con ella tampoco puede quedar en pie.
 */
export async function revertirAplicaciones(
  tx: Prisma.TransactionClient,
  where: { advanceId?: string; transactionId?: string },
): Promise<number> {
  const apps = await tx.customerAdvanceApplication.findMany({
    where: {
      revertedAt: null,
      ...(where.advanceId ? { advanceId: where.advanceId } : {}),
      ...(where.transactionId ? { transactionId: where.transactionId } : {}),
    },
  });
  if (!apps.length) return 0;

  for (const app of apps) {
    const monto = num(app.amount);
    // Se anulan los dos movimientos de la pareja (no se borran: la plata deja rastro).
    const ids = [app.transactionId, app.debitTransactionId].filter((x): x is string => !!x);
    if (ids.length) {
      await tx.transaction.updateMany({
        where: { id: { in: ids }, status: 'VIGENTE' },
        data: { status: 'ANULADA' },
      });
    }
    // La factura se relee AQUÍ y no se trae con un `include` de arriba: dos anticipos
    // pueden haber caído en la misma factura, y con la foto vieja la segunda reversa
    // restaría sobre un `paidAmount` que la primera ya bajó (la factura quedaría
    // cobrada de más).
    const inv = await tx.subInvoice.findUnique({
      where: { id: app.invoiceId },
      select: { id: true, paidAmount: true, status: true },
    });
    if (inv && inv.status !== 'CANCELED') {
      const pagado = Math.max(0, round2(num(inv.paidAmount) - monto));
      await tx.subInvoice.update({
        where: { id: inv.id },
        data: { paidAmount: pagado, status: pagado <= 0 ? 'DUE' : 'PARTIAL' },
      });
    }
    await tx.customerAdvanceApplication.update({
      where: { id: app.id },
      data: { revertedAt: new Date() },
    });
    const adv = await tx.customerAdvance.findUnique({
      where: { id: app.advanceId }, select: { amount: true, applied: true, status: true },
    });
    if (adv) {
      const applied = Math.max(0, round2(num(adv.applied) - monto));
      await tx.customerAdvance.update({
        where: { id: app.advanceId },
        data: {
          applied,
          // Sólo vuelve a estar disponible si el anticipo sigue vivo: si lo que se anuló
          // fue el recaudo que lo creó, quien llama lo deja en ANULADO después.
          status: adv.status === 'ANULADO' ? 'ANULADO'
            : round2(num(adv.amount) - applied) >= MINIMO_ANTICIPO ? 'ABIERTO' : 'APLICADO',
        },
      });
    }
  }
  return apps.length;
}

/**
 * QUÉ MESES CUBRE un pago adelantado — port de
 * `Invoices_model::calculo_de_facturas_adelantadas()` (legacy).
 *
 * Es lo que el recibo de caja imprime debajo de lo que sí se facturó: un renglón por
 * cada mes que la plata alcanza a pagar, aunque esas facturas **no existan todavía**.
 * El comentario del legacy es literal: *"esto es para el calculo de facturas sin crear
 * al hacer pagos adelantados"*. La factura de verdad nace el día 1 en la corrida y ahí
 * el anticipo se le imputa solo (ver `aplicarAnticipos`), así que aquí no se crea nada:
 * esto es sólo el papel que el cliente se lleva.
 *
 * El valor del mes sale de los servicios que el abonado tiene contratados HOY
 * (internet + TV + puntos, con su IVA), igual que allá; si eso da cero —el hueco de
 * los abonados sin `SubscriberService`, ver [[servicios-contratados-incompletos]]—
 * cae al total de su última factura, que es exactamente el respaldo del legacy
 * (`if($total<=0){ $total=round($var_factura->total); }`).
 *
 * Los meses se cuentan desde la ÚLTIMA factura del cliente, no desde hoy: si ya se le
 * facturó agosto, lo que está adelantando es septiembre.
 */
export type MesAdelantado = { fecha: Date; monto: number };

/** Tope de seguridad: nadie adelanta dos años, y evita un bucle infinito. */
const MAX_MESES_ADELANTADOS = 24;

/**
 * De dónde salen los meses que se adelantan: el mes de la ÚLTIMA factura del cliente
 * (lo ya facturado) y lo que le cuesta un mes con lo que tiene contratado hoy.
 *
 * Es la fuente única del recibo (`mesesCubiertos`) y de la propuesta que la ventanilla
 * le enseña a la cajera (`propuestaAdelanto`): si cada uno lo calculara por su cuenta,
 * el papel diría un mes y la casilla otro.
 *
 * La mensualidad sale de los servicios ACTIVOS (precio·cantidad + IVA) igual que allá;
 * si eso da cero —el hueco de los abonados sin `SubscriberService`, ver
 * [[servicios-contratados-incompletos]]— cae al total de su última factura, que es
 * exactamente el respaldo del legacy (`if($total<=0){ $total=round($var_factura->total); }`).
 */
export async function baseDelAdelanto(
  tx: Prisma.TransactionClient,
  subscriberId: string,
): Promise<{ ultimaFacturada: Date; mensualidad: number } | null> {
  const ultima = await tx.subInvoice.findFirst({
    where: { subscriberId },
    orderBy: [{ invoiceDate: 'desc' }, { tid: 'desc' }],
    select: { invoiceDate: true, total: true },
  });
  if (!ultima) return null;

  const servicios = await tx.subscriberService.findMany({
    where: { subscriberId, status: 'ACTIVO', price: { gt: 0 } },
    select: { price: true, qty: true, taxRate: true },
  });
  let mensualidad = round2(servicios.reduce((s, x) => {
    const base = round2(num(x.price) * (x.qty ?? 1));
    return s + base + ivaDe(base, num(x.taxRate));
  }, 0));
  if (mensualidad <= 0) mensualidad = round2(num(ultima.total));
  if (mensualidad <= 0) return null;
  return { ultimaFacturada: new Date(ultima.invoiceDate), mensualidad };
}

/**
 * El día 1 del mes número `n` después de `base` (n = 1 → el mes siguiente).
 *
 * Se cuenta por AÑO/MES sobre el día 1, no sumando meses a la fecha tal cual:
 * `invoiceDate` es columna `date` y se lee en UTC (ver [[sql-crudo-fechas-date]]), y
 * una factura del 31 sumándole un mes se pasaría al mes siguiente del siguiente (31 de
 * enero + 1 mes = 3 de marzo). El legacy arrastra ese fallo con `strtotime`; aquí no.
 */
export function mesSiguiente(base: Date, n = 1): Date {
  const d = new Date(base);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
}

/**
 * QUÉ MESES CUBRE un pago adelantado — port de
 * `Invoices_model::calculo_de_facturas_adelantadas()` (legacy).
 *
 * Es lo que el recibo de caja imprime debajo de lo que sí se facturó: un renglón por
 * cada mes que la plata alcanza a pagar, aunque esas facturas **no existan todavía**.
 * El comentario del legacy es literal: *"esto es para el calculo de facturas sin crear
 * al hacer pagos adelantados"*. La factura de verdad nace el día 1 en la corrida y ahí
 * el anticipo se le imputa solo (ver `aplicarAnticipos`), así que aquí no se crea nada:
 * esto es sólo el papel que el cliente se lleva.
 *
 * Los meses se cuentan desde la ÚLTIMA factura del cliente, no desde hoy: si ya se le
 * facturó agosto, lo que está adelantando es septiembre.
 *
 * `opts.mensualidad` la manda el recibo cuando el anticipo se cobró CON DESCUENTO: el
 * cliente pagó 95.000 por un mes de 100.000, y sin decírselo el papel partiría ese
 * adelanto en "octubre 100.000" y un resto suelto en vez de un solo renglón.
 */
export async function mesesCubiertos(
  tx: Prisma.TransactionClient,
  subscriberId: string,
  monto: number,
  opts: { mensualidad?: number } = {},
): Promise<MesAdelantado[]> {
  const disponible = round2(monto);
  if (disponible <= 0) return [];

  const base = await baseDelAdelanto(tx, subscriberId);
  if (!base) return [];
  const mensualidad = round2(opts.mensualidad && opts.mensualidad > 0 ? opts.mensualidad : base.mensualidad);
  if (mensualidad <= 0) return [];

  const meses: MesAdelantado[] = [];
  let queda = disponible;
  let n = 0;
  while (queda > 0 && meses.length < MAX_MESES_ADELANTADOS) {
    n += 1;
    const valor = round2(Math.min(queda, mensualidad));
    meses.push({ fecha: mesSiguiente(base.ultimaFacturada, n), monto: valor });
    queda = round2(queda - valor);
  }
  return meses;
}

/**
 * Descuento por adelantar un mes, en % (ajuste `billing.advanceDiscountPct`).
 *
 * El defecto es 5 (2026-09-16, decisión del usuario: "el que paga adelantado debe sí o
 * sí quedar con el descuento"). Entre el 8 y el 16 de septiembre estuvo en 0 y los
 * adelantos se cobraron sin rebaja. Si la fila del ajuste falta o trae basura se
 * aplica el 5; para apagarlo hay que escribir 0 a propósito en Ajustes → Facturación.
 */
export const PCT_ADELANTO_DEFECTO = 5;

export async function porcentajeAdelanto(tx: Prisma.TransactionClient): Promise<number> {
  const row = await tx.appSetting.findUnique({ where: { key: 'billing.advanceDiscountPct' } });
  const n = Number(row?.value);
  return Number.isFinite(n) && n >= 0 && n < 100 ? n : PCT_ADELANTO_DEFECTO;
}

export type PropuestaAdelanto = {
  /** % que se le rebaja por adelantar (0 = el ajuste está apagado). */
  pct: number;
  meses: { fecha: Date; label: string; bruto: number; descuento: number; neto: number }[];
  bruto: number;
  descuento: number;
  /** Lo que hay que cobrarle de más para dejar esos meses pagados. */
  neto: number;
};

/**
 * Cuánto cuesta dejar pagados los próximos `meses` meses, ya con el descuento por
 * pago adelantado puesto.
 *
 * Lo pide el modal de recaudo para la casilla "pagar también el mes siguiente": la
 * cajera necesita el número exacto que va a cobrar, no una regla que aplicar de cabeza.
 * El backend lo vuelve a calcular al cobrar (`collect`) — lo que manda el navegador es
 * cuántos meses, nunca el precio.
 */
export async function propuestaAdelanto(
  tx: Prisma.TransactionClient,
  subscriberId: string,
  meses = 1,
): Promise<PropuestaAdelanto | null> {
  if (meses <= 0 || meses > MAX_MESES_ADELANTADOS) return null;
  const base = await baseDelAdelanto(tx, subscriberId);
  if (!base) return null;
  const pct = await porcentajeAdelanto(tx);

  const filas: PropuestaAdelanto['meses'] = [];
  for (let n = 1; n <= meses; n += 1) {
    const fecha = mesSiguiente(base.ultimaFacturada, n);
    const bruto = round2(base.mensualidad);
    // Lo que se cobra en ventanilla va en PESOS ENTEROS (nadie da vueltas de céntimos)
    // y el descuento es el resto: así la nota crédito deja la factura clavada en el
    // neto y el anticipo la salda exacta, sin dejarla PARTIAL debiendo 19 centavos.
    const neto = Math.round((bruto * (100 - pct)) / 100);
    filas.push({ fecha, label: conceptoMesAdelantado(fecha, null), bruto, descuento: round2(bruto - neto), neto });
  }
  return {
    pct,
    meses: filas,
    bruto: round2(filas.reduce((s, m) => s + m.bruto, 0)),
    descuento: round2(filas.reduce((s, m) => s + m.descuento, 0)),
    neto: round2(filas.reduce((s, m) => s + m.neto, 0)),
  };
}
