/**
 * El descuento de una PROMOCIÓN vigente, concedido AL COBRAR.
 *
 * Hasta el 2026-09-01 el 5% de pronto pago estaba quemado en `billing/pronto-pago.ts`
 * con su propia regla ("la factura es de un mes que aún no empieza"). Se retiró al
 * volver a facturar el mes corriente ([[mes-que-factura-la-corrida]]) y el descuento
 * pasó a configurarse como promoción. Pero la promoción sólo se aplicaba A MANO, una
 * factura a la vez, desde `/facturacion/[id]`: en la ventanilla no aparecía, y con
 * ~4.900 facturas al mes eso no es un flujo, es un imposible. Esto cierra ese hueco.
 *
 * Se concede AL COBRAR y no al emitir, por el mismo motivo de siempre: si se escribiera
 * en la factura al nacer, quien paga tarde se lo lleva igual —la fuga que ya costó
 * 1,13 M COP en el portal legacy ([[fuga-descuento-pronto-pago]])—. Al cobrar, la
 * vigencia de la promo decide sola: el 3 de septiembre hay descuento y el 10 no.
 *
 * SOLO si el pago salda la factura entera. Un abono parcial no gana descuento; si el
 * cliente vuelve y la termina de pagar dentro de la vigencia, ahí sí se lo lleva.
 *
 * A QUÉ facturas llega lo dice cada promoción en `invoiceScope` (`alcanzaLaFactura`):
 * el pronto pago sólo rebaja la MENSUALIDAD del mes en curso —quien arrastra mora la
 * paga completa y los cargos sueltos se cobran enteros—, y una campaña de cartera
 * rebaja las mensualidades atrasadas, que es justo lo contrario y lo que hace falta
 * para que un cliente en CARTERA vuelva a pagar.
 *
 * ⚠️ Es AUTOMÁTICO: cualquier promoción vigente cuyo público alcance al cliente se
 * aplica sola en ventanilla. Si algún día hace falta una promo que NO se conceda sola,
 * hay que distinguirla con una bandera en `Promotion` — hoy no existe.
 */
import { Prisma, PromotionInvoiceScope } from '@prisma/client';
import { aplicarNotaEnTx } from '../billing/facturas.service';
import { num, round2 } from '../common/money';
import {
  audienceOfPromo, discountLabel, montoDeDescuento, reaches, subscriberFacts,
} from './publico';

type Tx = Prisma.TransactionClient;

/**
 * ¿Esta promoción alcanza a ESTA factura?
 *
 * Dos campañas distintas quieren cosas opuestas, y hasta el 2026-09-02 sólo existía
 * la primera —escrita a mano dentro de este módulo, sin forma de pedir la otra—:
 *
 * · **`MENSUALIDAD_DEL_MES`** (el pronto pago). Lo que la empresa le promete al
 *   cliente (`chatbot/tramites.catalogo.ts` → `pronto_pago`) es "5% si paga dentro de
 *   los primeros 5 días del mes, **sólo el mes en curso, no facturas atrasadas**". El
 *   plazo lo pone la vigencia de la promoción; lo que se decide aquí es QUÉ factura se
 *   rebaja, y son dos condiciones:
 *
 *   1. **Del mes en curso.** Sin este filtro, al cliente con 4 facturas pendientes se
 *      le rebajaban las 4 —tres de ellas ya vencidas—, que es justo la fuga que este
 *      módulo existe para no repetir (ver [[fuga-descuento-pronto-pago]]). El mes sale
 *      de `invoiceDate` porque no hay columna de periodo, ni aquí ni en el legacy, y
 *      desde [[mes-que-factura-la-corrida]] el día 1 se factura el mes corriente: la de
 *      septiembre lleva fecha de septiembre. Las dos fechas son `date-only` en UTC
 *      (`hoy`/`payDate` vienen de `dateOnly(hoyColombia())`), así que se comparan en
 *      UTC: en hora local, una factura del día 1 se leería como del mes anterior.
 *
 *   2. **Es la mensualidad (`RECURRENTE`), no un cargo.** El pronto pago premia pagar
 *      el servicio del mes a tiempo; un cargo no tiene nada que ver con eso. Las FIJAS
 *      son los cobros sueltos —traslado (30.000, ver [[traslado-direccion-y-cargo]]),
 *      reconexión, instalación, afiliación— y se emiten con fecha de hoy, así que sin
 *      esta condición TODAS caían dentro del mes en curso y se llevaban el 5%: el
 *      traslado se cobraba a 28.500. Efecto colateral: la mensualidad re-facturada a
 *      mano, que en esta base también viaja como FIJA ([[mes-a-pagar-en-recaudo]]),
 *      tampoco se rebaja sola; para ésas sigue estando el botón manual.
 *
 * · **`MENSUALIDADES_PENDIENTES`** (recuperación de cartera). La campaña opuesta: lo
 *   que hay que rebajar es justamente la MORA, porque el objetivo no es premiar la
 *   puntualidad sino que el cliente vuelva a pagar. Con la regla del pronto pago una
 *   promo dirigida a los clientes en CARTERA no descontaba nunca —lo que ellos deben
 *   es, por definición, de meses anteriores— y en ventanilla no aparecía nada. Cae la
 *   condición del mes, pero NO la de que sea mensualidad: se perdona el servicio no
 *   pagado, no un traslado facturado esta misma mañana.
 *
 * · **`CUALQUIER_PENDIENTE`**. Todo lo pendiente, cargos sueltos incluidos. Hay que
 *   pedirlo a propósito: al 50%, un traslado de 30.000 se cobra a 15.000.
 *
 * Vale para los DOS caminos. Hasta el 2026-09-03 el botón "Promociones" de
 * `/facturacion/[id]` podía rebajar cualquier factura ("ahí hay alguien decidiendo"),
 * y por ahí el pronto pago llegó a mensualidades de junio, julio y agosto y a un cargo
 * suelto. El alcance es de la promoción, no de quién la aplica: si la campaña dice
 * "la mensualidad del mes", eso vale también a mano. Para rebajar otra cosa está la
 * nota crédito de siempre, con su motivo escrito.
 */
export function alcanzaLaFactura(
  promo: { invoiceScope: PromotionInvoiceScope },
  inv: { kind: string; invoiceDate: Date },
  hoy: Date,
): boolean {
  if (promo.invoiceScope === 'CUALQUIER_PENDIENTE') return true;
  if (inv.kind !== 'RECURRENTE') return false;
  if (promo.invoiceScope === 'MENSUALIDADES_PENDIENTES') return true;
  const f = new Date(inv.invoiceDate);
  return f.getUTCFullYear() === hoy.getUTCFullYear() && f.getUTCMonth() === hoy.getUTCMonth();
}

type FacturaCandidata = {
  id: string;
  tid: number;
  /** `RECURRENTE` = mensualidad; `FIJA` = cargo suelto (traslado, reconexión…). */
  kind: string;
  /** Columna `date`: el mes se lee en UTC (ver [[sql-crudo-fechas-date]]). */
  invoiceDate: Date;
  subtotal: Prisma.Decimal | number;
  total: Prisma.Decimal | number;
  paidAmount: Prisma.Decimal | number;
  /**
   * Descuento de CABECERA (`SubInvoice.discount`). Aquí nadie lo escribe: viene del
   * legacy por el sync cuando el PORTAL DE PAGOS ya le puso su rebaja a la factura.
   * Ver `yaRebajadaEnOrigen`.
   */
  discount?: Prisma.Decimal | number | null;
};

/**
 * ¿La factura ya llegó rebajada desde el legacy?
 *
 * El portal de pagos (`vestel.com.co/crm`) aplica su propia promoción —la misma fila
 * de `promos` que nexus le publica— escribiéndola en la CABECERA de la factura:
 * `discount` = total × %, nota "Descuento 5 %", marca `promo_sistema_clientes1`. El
 * sync la trae tal cual, pero en nexus eso no deja `PromotionApplication`, que es la
 * única huella que este módulo miraba para no conceder dos veces.
 *
 * Caso real (2026-09-02, factura 503819): el cliente entró al portal (5 % en cabecera:
 * 173.250 → 164.587) y luego vino a pagar en ventanilla, donde se le concedió OTRO 5 %
 * como nota crédito, calculado además sobre el total ya rebajado (8.229 en vez de
 * 8.663). Pagó con el 9,75 % de descuento. Tres facturas así antes de este candado.
 *
 * Regla: una factura que ya trae descuento de cabecera NO recibe ninguna promoción
 * automática encima. Da igual de qué promo venga: en el legacy esa cabecera es el
 * descuento de pronto pago del portal y no hay forma de saber más.
 */
export function yaRebajadaEnOrigen(inv: { discount?: Prisma.Decimal | number | null }): boolean {
  return num(inv.discount ?? 0) > 0;
}

/** Lo que se le rebajaría a una factura, y de qué promoción viene. */
export type DescuentoPendiente = {
  promotionId: string;
  promotionName: string;
  /** "5%", "$10.000, antes de imp."… tal como queda escrito en la factura. */
  label: string;
  /** Snapshot del % de la promo (0 en las de monto fijo), como lo guarda el botón manual. */
  percentage: number;
  amount: number;
};

/**
 * Cuánto se le rebajaría a cada factura si el cliente la saldara hoy.
 *
 * Devuelve un mapa `invoiceId → descuento`. Todas las facturas son del MISMO cliente
 * (es el modal de recaudo), así que el público se resuelve una sola vez.
 *
 * Sólo mira lo que se puede saber sin escribir: que haya promo vigente que lo alcance,
 * que no se le haya concedido ya esa promo a esa factura, y que la factura no esté
 * timbrada ante la DIAN (una timbrada no se puede abaratar: eso exige nota crédito
 * electrónica, y ese camino todavía no existe aquí).
 *
 * Si hay varias promos vigentes que alcanzan al cliente, gana la que MÁS descuenta.
 */
export async function descuentosDePromocionPendientes(
  tx: Tx,
  subscriberId: string,
  facturas: FacturaCandidata[],
  hoy: Date,
  /**
   * Acota el cálculo a estas promociones (por id). Lo usa el barrido del PORTAL
   * (`descuento-portal.ts`), que concede por adelantado SÓLO las publicadas allá: sin
   * esto, ese barrido le regalaría también el pronto pago a todo el mundo antes de
   * que nadie pague, que es justo lo que el descuento al cobrar existe para evitar.
   * Sin la lista, se miran todas las vigentes (lo de siempre, en ventanilla).
   */
  soloPromociones?: string[],
): Promise<Map<string, DescuentoPendiente>> {
  const fuera = new Map<string, DescuentoPendiente>();
  if (!facturas.length) return fuera;
  if (soloPromociones && !soloPromociones.length) return fuera;

  const vigentes = await tx.promotion.findMany({
    where: {
      active: true, startDate: { lte: hoy }, endDate: { gte: hoy },
      ...(soloPromociones ? { id: { in: soloPromociones } } : {}),
    },
    include: {
      subscribers: { select: { id: true } },
      plans: { select: { id: true } },
      branches: { select: { id: true } },
    },
  });
  if (!vigentes.length) return fuera;

  // El plan del cliente sólo hace falta si alguna de estas promos filtra por plan, y
  // resolverlo es lo caro (ver `subscriberFacts`). Casi nunca lo es: las del portal ni
  // siquiera pueden serlo.
  const conPlanes = vigentes.some((p) => p.plans.length > 0);
  const facts = await subscriberFacts(tx, subscriberId, { conPlanes });
  if (!facts) return fuera;
  const alcanzan = vigentes.filter((p) => reaches(audienceOfPromo(p), facts));
  if (!alcanzan.length) return fuera;

  const ids = facturas.map((f) => f.id);
  // Ya concedida: no se aplica dos veces la misma promo a la misma factura (misma
  // regla que el botón manual de `/facturacion/[id]`). Cuentan TAMBIÉN las revertidas,
  // por dos motivos: `PromotionApplication` es único por (promoción, factura) y crear
  // otra reventaría, y sobre todo porque un descuento que ya se retiró por pagar tarde
  // no debe volver a concederse.
  const yaConcedidas = new Set(
    (await tx.promotionApplication.findMany({
      where: { invoiceId: { in: ids } },
      select: { invoiceId: true, promotionId: true },
    })).map((a) => `${a.invoiceId}:${a.promotionId}`),
  );
  // Timbradas ante la DIAN: intocables.
  const timbradas = new Set(
    (await tx.electronicInvoice.findMany({
      where: { invoiceId: { in: ids }, type: 'FACTURADA', dianNumber: { not: null } },
      select: { invoiceId: true },
    })).map((e) => e.invoiceId),
  );

  for (const f of facturas) {
    if (timbradas.has(f.id)) continue;
    // Ya rebajada por el portal del legacy: no se apila un segundo descuento.
    if (yaRebajadaEnOrigen(f)) continue;
    const saldo = round2(num(f.total) - num(f.paidAmount));
    if (saldo <= 0) continue;

    let mejor: DescuentoPendiente | null = null;
    for (const p of alcanzan) {
      // Qué facturas rebaja cada campaña es cosa SUYA: el pronto pago sólo llega a la
      // mensualidad del mes, la de cartera a todo lo que se deba.
      if (!alcanzaLaFactura(p, f, hoy)) continue;
      if (yaConcedidas.has(`${f.id}:${p.id}`)) continue;
      const amount = montoDeDescuento(p, f);
      // El descuento no puede comerse más de lo que queda debiendo (factura casi saldada).
      if (!(amount > 0) || amount >= saldo) continue;
      if (!mejor || amount > mejor.amount) {
        mejor = {
          promotionId: p.id,
          promotionName: p.name,
          label: discountLabel(p.discountFormat, p.percentage, num(p.flatAmount)),
          percentage: p.percentage,
          amount,
        };
      }
    }
    if (mejor) fuera.set(f.id, mejor);
  }
  return fuera;
}

/**
 * Concede el descuento a las facturas que el pago SÍ alcanza a saldar.
 *
 * Se llama dentro de la transacción del recaudo, después de retirar los descuentos
 * vencidos y ANTES del reparto en cascada: la cascada tiene que repartir contra el
 * total ya rebajado, o el cliente pagaría el 95% y la factura quedaría PARTIAL debiendo
 * justo el descuento.
 *
 * El reparto se simula aquí con los saldos rebajados —mismo orden que la cascada real—
 * y sólo se premia a la que queda saldada del todo. Así el que abona a medias no se
 * lleva rebaja, y el dinero que libera cada descuento alcanza para la factura siguiente.
 */
export async function aplicarPromocionesAlCobrar(
  tx: Tx,
  subscriberId: string,
  facturas: FacturaCandidata[],
  opts: {
    payDate: Date;
    monto: number;
    staffId?: string | null;
    editedBy?: string | null;
    authorLegacyId?: number | null;
  },
): Promise<{ facturas: { tid: number; descuento: number; promocion: string }[]; total: number }> {
  const posibles = await descuentosDePromocionPendientes(tx, subscriberId, facturas, opts.payDate);
  if (!posibles.size) return { facturas: [], total: 0 };

  // Simulación del reparto con los saldos ya rebajados: quién queda saldada.
  let disponible = round2(opts.monto);
  const premiadas: FacturaCandidata[] = [];
  for (const f of facturas) {
    if (disponible <= 0) break;
    const saldo = round2(num(f.total) - num(f.paidAmount));
    if (saldo <= 0) continue;
    const descuento = posibles.get(f.id)?.amount ?? 0;
    const aCubrir = round2(saldo - descuento);
    if (disponible < aCubrir) break; // el dinero se agota aquí: pago parcial, sin premio
    disponible = round2(disponible - aCubrir);
    if (descuento > 0) premiadas.push(f);
  }
  if (!premiadas.length) return { facturas: [], total: 0 };

  const aplicadas: { tid: number; descuento: number; promocion: string }[] = [];
  let total = 0;
  for (const f of premiadas) {
    const d = posibles.get(f.id)!;
    // Mismo texto que el botón manual, para que la factura se lea igual venga de donde venga.
    await aplicarNotaEnTx(tx, f.id, {
      type: 'CREDITO',
      amount: d.amount,
      description: `Promoción: ${d.promotionName} (${d.label})`,
      editedBy: opts.editedBy ?? null,
      authorLegacyId: opts.authorLegacyId ?? null,
    });
    // La huella que hace idempotente el descuento y que `revertirDescuentosVencidos`
    // necesita para poder retirarlo si algún día la promo vence antes del pago.
    await tx.promotionApplication.create({
      data: {
        promotionId: d.promotionId,
        invoiceId: f.id,
        staffId: opts.staffId ?? null,
        appliedByName: opts.editedBy ?? null,
        percentage: d.percentage,
        amount: d.amount,
      },
    });
    aplicadas.push({ tid: f.tid, descuento: d.amount, promocion: d.promotionName });
    total = round2(total + d.amount);
  }
  return { facturas: aplicadas, total };
}
