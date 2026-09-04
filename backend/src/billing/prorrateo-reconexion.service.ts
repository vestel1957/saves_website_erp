import { Prisma } from '@prisma/client';
import { Logger } from '../core/logger';
import { PrismaService } from '../prisma/prisma.service';
import { PostingService } from '../accounting/posting.service';
import { nextTid, TID_SEQ } from '../common/tid';
import { num, round2 } from '../common/money';
import { hoyEnColombia } from '../common/fecha-colombia';
import { etiquetaProrrateo, valorProrrateado, ventanaProrrateo, VentanaProrrateo } from './prorrateo-reconexion';
import { planDeUltimaFactura } from './plan-facturable';

/**
 * El cobro de los días que quedan del mes cuando a un abonado se le devuelve un
 * servicio que llevaba cortado — lo que en el legacy son las órdenes terminadas
 * en "2" (`Reconexion Internet2`, `Reconexion Television2`, `Reconexion Combo2`).
 *
 * CÓMO DECIDE SI COBRA. No por la fecha del corte —que es como lo mira el legacy,
 * comparando el mes del último "Corte …" contra el de la factura— sino por lo que
 * de verdad importa y además se puede comprobar: **¿está ese servicio facturado en
 * el mes en curso?**
 *
 *   · Sí lo está → el corte fue después de facturar (mismo mes): el cliente ya
 *     pagó ese mes entero. No se cobra nada y la orden se llama sin el "2".
 *   · No lo está → el servicio venía cortado desde antes de la corrida y nadie
 *     facturó este mes. Se cobran los días que quedan y la orden lleva el "2".
 *
 * Son equivalentes en la práctica (un corte del mes pasado deja al servicio fuera
 * de la factura de este mes), pero la regla de aquí no depende de que exista la
 * orden de corte: el corte masivo lo sigue haciendo el legacy y hay 221 abonados
 * cortados en el router de los que aquí no hay rastro de corte. Y de paso es la
 * misma pregunta que hace idempotente el cobro: si el renglón ya está, no se
 * vuelve a poner, cobre quien cobre y por donde cobre.
 *
 * DÓNDE CAE EL COBRO.
 *   · Factura del mes con saldo → se le añade el renglón (y queda `editedAt`, o el
 *     sync de ida la revertiría en la siguiente pasada de 15 minutos).
 *   · Factura del mes ya pagada, timbrada ante la DIAN, o inexistente → factura
 *     NUEVA con vencimiento a fin de mes. El legacy sí revive una factura pagada;
 *     aquí no, porque eso deja mintiendo al recibo que el cliente acaba de recibir
 *     y rompe el documento electrónico.
 *
 * INTERRUPTOR. `billing.prorrateoReconexion` (o `BILLING_PRORRATEO_RECONEXION`):
 *   `on` cobra · `informe` calcula y lo deja escrito en el log sin tocar plata ·
 *   `off` ni lo calcula.
 */

/** Qué servicio se está devolviendo. La TV arrastra sus puntos/decos. */
export type ServicioProrrateable = 'INTERNET' | 'TV';

export type ModoProrrateo = 'on' | 'informe' | 'off';

/** Un renglón que se cobraría (o se cobró). */
export type LineaProrrateo = {
  kind: 'INTERNET' | 'TV' | 'PUNTOS';
  /** Nombre del plan, tal cual va a `productName` (los reportes agrupan por él). */
  concepto: string;
  qty: number;
  /** Base sin IVA, ya prorrateada y al peso. */
  base: number;
  ivaPct: number;
  iva: number;
  total: number;
};

export type ResultadoProrrateo = {
  /** ¿Había días sin facturar que cobrar? false = el mes ya estaba cubierto. */
  aplica: boolean;
  /** true = se escribió en una factura. false con `aplica` = modo informe o fallo. */
  cobrado: boolean;
  modo: ModoProrrateo;
  dias: number;
  lineas: LineaProrrateo[];
  base: number;
  iva: number;
  total: number;
  /** Factura donde cayó (o donde habría caído). */
  invoiceTid?: number;
  /** true = hubo que crear factura nueva. */
  facturaNueva?: boolean;
  /** En una línea, para el log y para quien cobró. */
  mensaje: string;
};

const VACIO = (modo: ModoProrrateo, mensaje: string): ResultadoProrrateo => ({
  aplica: false, cobrado: false, modo, dias: 0, lineas: [], base: 0, iva: 0, total: 0, mensaje,
});

/** Normaliza un nombre de plan para compararlo con los renglones de la factura. */
const clave = (s: string | null | undefined) => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Qué servicio es un renglón que NO está en el catálogo `Plan`.
 *
 * Hace falta porque las facturas viejas del legacy traen nombres que aquí no
 * existen como plan ('Television', 'SoloTelevision22', planes retirados). Sin este
 * respaldo, un renglón desconocido no marcaría su tipo como facturado y el
 * prorrateo lo volvería a cobrar.
 */
function tipoPorNombre(nombre: string): string | null {
  if (/punto|deco/.test(nombre)) return 'PUNTOS';
  if (/televi|tv\b/.test(nombre)) return 'TV';
  if (/mega|internet|fibra|banda/.test(nombre)) return 'INTERNET';
  return null;
}

export class ProrrateoReconexionService {
  private readonly logger = new Logger(ProrrateoReconexionService.name);

  /**
   * El catálogo de planes (83 filas) cacheado un minuto. Sin esto, el cargue de
   * pagos —que evalúa abonado por abonado— lo relee una vez por cliente.
   */
  private catalogoCache: { hasta: number; mapa: Map<string, string> } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly posting: PostingService,
  ) {}

  /**
   * Modo de trabajo. El ajuste manda sobre la variable de entorno para que se
   * pueda apagar desde Configuración sin reiniciar el proceso.
   */
  async modo(): Promise<ModoProrrateo> {
    const row = await this.prisma.appSetting
      .findUnique({ where: { key: 'billing.prorrateoReconexion' } })
      .catch(() => null);
    const v = (row?.value ?? process.env.BILLING_PRORRATEO_RECONEXION ?? 'on').trim().toLowerCase();
    if (v === 'off' || v === 'false' || v === 'no') return 'off';
    if (v === 'informe' || v === 'dry' || v === 'dryrun' || v === 'dry-run') return 'informe';
    return 'on';
  }

  /**
   * ¿Esta reconexión arrastra mes sin facturar? Es lo que decide si la orden se
   * llama `Reconexion Internet` o `Reconexion Internet2`.
   *
   * Se usa ANTES de cobrar (para nombrar la orden que se abre cuando el equipo no
   * responde y hay que mandar un técnico): ahí no se cobra nada todavía — se
   * cobrará cuando el técnico cierre la orden y el servicio exista de verdad.
   */
  async arrastraMes(subscriberId: string, servicios: ServicioProrrateable[]): Promise<boolean> {
    try {
      if ((await this.modo()) === 'off') return false;
      const plan = await this.evaluar(subscriberId, servicios);
      return plan.aplica;
    } catch (e) {
      this.logger.warn(`No se pudo evaluar el arrastre del abonado ${subscriberId}: ${(e as Error).message}`);
      return false;
    }
  }

  /** Nombre de plan → servicio, desde el catálogo. Cacheado (ver `catalogoCache`). */
  private async catalogoDePlanes(): Promise<Map<string, string>> {
    const ahora = Date.now();
    if (this.catalogoCache && this.catalogoCache.hasta > ahora) return this.catalogoCache.mapa;
    const filas = await this.prisma.plan.findMany({ select: { name: true, kind: true } });
    const mapa = new Map(filas.map((pl) => [clave(pl.name), pl.kind as string]));
    this.catalogoCache = { hasta: ahora + 60_000, mapa };
    return mapa;
  }

  /**
   * Qué se cobraría, sin escribir nada. Separado de `aplicar` porque el nombre de
   * la orden se decide con esto mismo y no tiene sentido calcularlo dos veces.
   */
  async evaluar(
    subscriberId: string,
    servicios: ServicioProrrateable[],
    hoy: Date = hoyEnColombia(),
  ): Promise<ResultadoProrrateo & { invoiceId?: string; ventana: VentanaProrrateo }> {
    const modo = await this.modo();
    const v = ventanaProrrateo(hoy);
    const nada = (m: string) => ({ ...VACIO(modo, m), ventana: v });
    if (modo === 'off') return nada('El prorrateo de reconexión está apagado.');
    if (!servicios.length) return nada('No se reconectó ningún servicio facturable.');

    // Qué líneas trae contratadas. Se leen TODOS los servicios, no sólo los ACTIVO:
    // el que se está reconectando está justamente marcado como cortado.
    const kinds: Array<'INTERNET' | 'TV' | 'PUNTOS'> = [];
    if (servicios.includes('INTERNET')) kinds.push('INTERNET');
    if (servicios.includes('TV')) kinds.push('TV', 'PUNTOS');

    const mesIni = new Date(Date.UTC(v.desde.getUTCFullYear(), v.desde.getUTCMonth(), 1));
    const mesFin = new Date(Date.UTC(v.desde.getUTCFullYear(), v.desde.getUTCMonth() + 1, 1));

    const contratados: Array<{ kind: string; planName: string | null; price: number; taxRate: number; qty: number }> =
      (await this.prisma.subscriberService.findMany({
        where: { subscriberId, kind: { in: kinds as any } },
        select: { kind: true, planName: true, price: true, taxRate: true, qty: true },
      })).map((s) => ({ kind: s.kind, planName: s.planName, price: num(s.price), taxRate: num(s.taxRate), qty: s.qty ?? 1 }));

    // Respaldo: el plan sacado de sus facturas.
    //
    // No es un caso raro, es LA MAYORÍA de esta población. La migración sólo pobló
    // `SubscriberService` para los que estaban en ACTIVO, así que justo el cliente
    // que se reconecta —el que llevaba meses cortado— es el que no tiene el plan en
    // la ficha: 9 de las 26 reconexiones con arrastre de la última semana. Sin este
    // respaldo el prorrateo no cobraría a un tercio de ellos.
    //
    // Es la misma consulta que usa la corrida mensual (`plan-facturable.ts`), a
    // propósito: el precio que se cobra por reconectar tiene que ser el mismo que le
    // habría salido en su mensualidad.
    const faltan = kinds.filter((k) => k !== 'PUNTOS' && !contratados.some((c) => c.kind === k));
    if (faltan.length) {
      const derivados = await planDeUltimaFactura(this.prisma, [subscriberId], mesIni).catch(() => new Map());
      for (const d of derivados.get(subscriberId) ?? []) {
        if (!faltan.includes(d.kind as any)) continue;
        contratados.push({ kind: d.kind, planName: d.planName, price: d.price, taxRate: d.taxRate, qty: 1 });
      }
    }

    // Factura del mes en curso (la última que no esté anulada). De ella salen dos
    // cosas: si el servicio ya está facturado, y dónde cae el cobro.
    const factura = await this.prisma.subInvoice.findFirst({
      where: { subscriberId, status: { not: 'CANCELED' }, invoiceDate: { gte: mesIni, lt: mesFin } },
      orderBy: [{ invoiceDate: 'desc' }, { tid: 'desc' }],
      select: {
        id: true, tid: true, status: true, total: true, paidAmount: true, subtotal: true, tax: true,
        items: { select: { productName: true, description: true, price: true } },
        electronicInvoices: { select: { type: true, dianNumber: true } },
      },
    });

    // Lo ya facturado este mes. Se mira por NOMBRE y también por TIPO de servicio,
    // y lo segundo no es un lujo: la ficha y la factura no siempre llaman igual al
    // mismo plan. El abonado 54872 tiene "50 Megas F" en su ficha y "100 Megas F-26"
    // en la factura de agosto que le hizo el legacy; comparando sólo el nombre, su
    // internet se habría cobrado dos veces el mismo mes.
    //
    // De paso es lo que hace idempotente el cobro: dos reconexiones en el mismo mes
    // —o el pago y después el técnico cerrando la orden— no cobran dos veces.
    const catalogo = await this.catalogoDePlanes();
    const yaFacturado = new Set<string>();
    const tiposFacturados = new Set<string>();
    for (const it of factura?.items ?? []) {
      if (num(it.price) <= 0) continue;
      const nombre = clave(it.productName || it.description);
      yaFacturado.add(nombre);
      const tipo = catalogo.get(nombre) ?? tipoPorNombre(nombre);
      if (tipo) tiposFacturados.add(tipo);
    }

    const lineas: LineaProrrateo[] = [];
    const sinPrecio: string[] = [];
    for (const svc of contratados) {
      const precio = svc.price;
      const concepto = (svc.planName || svc.kind).trim();
      if (precio <= 0) { sinPrecio.push(concepto); continue; }
      if (yaFacturado.has(clave(concepto)) || tiposFacturados.has(svc.kind)) continue;
      const qty = Math.max(1, svc.qty);
      const base = valorProrrateado(precio, v) * qty;
      if (base <= 0) continue;
      const ivaPct = svc.taxRate;
      // El IVA también al peso: el renglón entero tiene que ser entero o el
      // writeback y el sync verían totales distintos cada 15 minutos.
      const iva = Math.round((base * ivaPct) / 100);
      lineas.push({ kind: svc.kind as LineaProrrateo['kind'], concepto, qty, base, ivaPct, iva, total: round2(base + iva) });
    }

    if (!lineas.length) {
      const motivo = contratados.length === 0
        ? 'No hay plan del que sacar el precio: ni en su ficha (SubscriberService) ni en sus facturas.'
        : sinPrecio.length
          ? `Su servicio no tiene precio en la ficha (${sinPrecio.join(', ')}): no se cobra de memoria.`
          : 'El mes ya está facturado: no hay días que cobrar.';
      return { ...nada(motivo), invoiceId: factura?.id, invoiceTid: factura?.tid };
    }

    const base = round2(lineas.reduce((s, l) => s + l.base, 0));
    const iva = round2(lineas.reduce((s, l) => s + l.iva, 0));
    const conceptos = lineas.map((l) => `${l.concepto}${l.qty > 1 ? ` x${l.qty}` : ''}`).join(' + ');
    return {
      aplica: true, cobrado: false, modo, dias: v.dias, lineas, base, iva, total: round2(base + iva),
      invoiceId: factura?.id, invoiceTid: factura?.tid, ventana: v,
      mensaje: `${v.dias} día(s) de ${conceptos} = $${round2(base + iva).toLocaleString('es-CO')}`,
    };
  }

  /**
   * Evalúa y cobra. NUNCA lanza: esto cuelga de un recaudo o del cierre de una
   * orden, y ninguno de los dos se puede caer porque la factura no se dejó tocar.
   *
   * @param ctx  de dónde viene (recibo de caja, orden #…), para el log y la nota.
   */
  async aplicar(
    subscriberId: string,
    servicios: ServicioProrrateable[],
    opts: { ctx?: string; autor?: string } = {},
  ): Promise<ResultadoProrrateo> {
    let plan: Awaited<ReturnType<ProrrateoReconexionService['evaluar']>>;
    try {
      plan = await this.evaluar(subscriberId, servicios);
    } catch (e) {
      this.logger.error(`Prorrateo de reconexión del abonado ${subscriberId}: ${(e as Error).message}`);
      return VACIO('on', `No se pudo calcular el prorrateo: ${(e as Error).message}`);
    }
    const { ventana, invoiceId, ...resultado } = plan;
    if (!resultado.aplica) return resultado;

    const traza = `abonado ${subscriberId}${opts.ctx ? ` (${opts.ctx})` : ''}`;
    if (resultado.modo === 'informe') {
      this.logger.log(`[informe] Prorrateo de reconexión del ${traza}: ${resultado.mensaje}. No se cobró (modo informe).`);
      return { ...resultado, mensaje: `${resultado.mensaje} — calculado en modo informe, NO se cobró.` };
    }

    try {
      const escrito = invoiceId
        ? await this.cobrarEnFacturaDelMes(invoiceId, resultado, ventana, opts)
        : null;
      const destino = escrito ?? (await this.cobrarEnFacturaNueva(subscriberId, resultado, ventana, opts));
      this.logger.log(
        `Prorrateo de reconexión del ${traza}: ${resultado.mensaje} → factura #${destino.tid}` +
        `${destino.nueva ? ' (nueva)' : ''}.`,
      );
      return { ...resultado, cobrado: true, invoiceTid: destino.tid, facturaNueva: destino.nueva,
        mensaje: `Se cobraron ${resultado.mensaje} en la factura #${destino.tid}${destino.nueva ? ' (nueva)' : ''}.` };
    } catch (e) {
      this.logger.error(`Prorrateo de reconexión del ${traza}: ${(e as Error).message}. El cliente quedó sin cobrar esos días.`);
      return { ...resultado, mensaje: `No se pudo cobrar el prorrateo: ${(e as Error).message}` };
    }
  }

  // ------------------------------------------------------------------
  // Escritura
  // ------------------------------------------------------------------

  /**
   * Mete los renglones en la factura del mes, si esa factura se puede tocar.
   *
   * Devuelve `null` —y el cobro se va a una factura nueva— cuando la factura ya
   * está pagada (el recibo del cliente dejaría de cuadrar) o ya fue timbrada ante
   * la DIAN (ese documento no se toca: se corrige por nota o por otra factura).
   */
  private async cobrarEnFacturaDelMes(
    invoiceId: string,
    r: ResultadoProrrateo,
    v: VentanaProrrateo,
    opts: { ctx?: string; autor?: string },
  ): Promise<{ tid: number; nueva: boolean } | null> {
    const inv = await this.prisma.subInvoice.findUnique({
      where: { id: invoiceId },
      select: {
        id: true, tid: true, status: true, subtotal: true, tax: true, total: true, paidAmount: true,
        electronicInvoices: { select: { type: true, dianNumber: true } },
      },
    });
    if (!inv) return null;
    if (inv.status === 'PAID' || num(inv.paidAmount) >= num(inv.total)) return null;
    if (inv.electronicInvoices.some((e) => e.type === 'FACTURADA' && e.dianNumber)) return null;

    const etiqueta = etiquetaProrrateo(v);
    await this.prisma.$transaction(async (tx) => {
      for (const l of r.lineas) {
        await tx.subInvoiceItem.create({
          data: {
            invoiceId: inv.id, productId: 0, productName: l.concepto,
            description: `${l.concepto} · ${etiqueta}`,
            qty: l.qty, price: round2(l.base / l.qty), taxRate: l.ivaPct,
            subtotal: l.base, taxTotal: l.iva, discountTotal: 0,
          },
        });
      }
      const total = round2(num(inv.total) + r.total);
      const pagado = num(inv.paidAmount);
      await tx.subInvoice.update({
        where: { id: inv.id },
        data: {
          subtotal: round2(num(inv.subtotal) + r.base),
          tax: round2(num(inv.tax) + r.iva),
          total,
          itemsCount: { increment: r.lineas.length },
          status: pagado <= 0 ? 'DUE' : pagado < total ? 'PARTIAL' : 'PAID',
          // Sin esto el sync de ida compara la huella (total/pamnt/status) contra el
          // MySQL vivo y a los 15 minutos devuelve el total viejo y borra el renglón:
          // el prorrateo se evaporaría solo. Con la marca, además, el writeback lo
          // empuja al legacy y la factura queda igual en los dos sistemas.
          editedAt: new Date(),
          editedBy: opts.autor ?? 'Sistema (prorrateo de reconexión)',
        },
      });
    });
    // Contabilidad: la factura ya tiene su asiento, así que esto es un AJUSTE por el
    // delta, no una factura nueva. `edit` va como AAAAMMDD para que dos intentos del
    // mismo día no dupliquen el asiento. Si la factura vino del legacy no hay asiento
    // original y el ajuste se descarta solo (ver `postSalesInvoiceAdjustment`).
    await this.posting
      .postSalesInvoiceAdjustment({
        sourceId: inv.id, date: v.desde, number: inv.tid,
        edit: Number(v.desde.toISOString().slice(0, 10).replace(/-/g, '')),
        deltaSubtotal: r.base, deltaTax: r.iva,
        createdBy: opts.autor ?? 'Sistema',
      })
      .catch((e) => this.logger.warn(`Contabilización del prorrateo (factura #${inv.tid}): ${(e as Error).message}`));
    return { tid: inv.tid, nueva: false };
  }

  /**
   * Factura nueva sólo por los días que quedan, con vencimiento a fin de mes.
   *
   * El vencimiento NO es el día 20 de costumbre: este documento cubre hasta que
   * acaba el mes y el legacy hace lo mismo (`invoiceduedate` = último día). Poner
   * el día 20 haría vencer hoy mismo una factura emitida el 24.
   */
  private async cobrarEnFacturaNueva(
    subscriberId: string,
    r: ResultadoProrrateo,
    v: VentanaProrrateo,
    opts: { ctx?: string; autor?: string },
  ): Promise<{ tid: number; nueva: boolean }> {
    const sub = await this.prisma.subscriber.findUnique({
      where: { id: subscriberId },
      select: { id: true, status: true, eInvoice: true },
    });
    const etiqueta = etiquetaProrrateo(v);
    const internet = r.lineas.find((l) => l.kind === 'INTERNET')?.concepto ?? null;
    const tv = r.lineas.find((l) => l.kind === 'TV')?.concepto ?? null;
    const puntos = r.lineas.filter((l) => l.kind === 'PUNTOS').reduce((n, l) => n + l.qty, 0) || null;

    const inv = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const tid = await nextTid(tx, TID_SEQ.subInvoice);
      return tx.subInvoice.create({
        data: {
          tid, subscriberId,
          invoiceDate: v.desde, dueDate: v.hasta,
          subtotal: r.base, tax: r.iva, total: r.total, paidAmount: 0,
          status: 'DUE', kind: 'RECURRENTE',
          // Es la mensualidad (el pedazo que queda), no un cargo suelto: el estado
          // que se estampa es ACTIVO porque el servicio acaba de volver.
          ron: 'ACTIVO',
          serviceCombo: internet, serviceTv: tv, puntos,
          eInvoiceFlag: sub?.eInvoice ? 'Crear Factura Electronica' : null,
          itemsCount: r.lineas.length,
          notes: `Reconexión: ${etiqueta}.${opts.ctx ? ` Origen: ${opts.ctx}.` : ''}`,
          items: {
            create: r.lineas.map((l) => ({
              productId: 0, productName: l.concepto,
              description: `${l.concepto} · ${etiqueta}`,
              qty: l.qty, price: round2(l.base / l.qty), taxRate: l.ivaPct,
              subtotal: l.base, taxTotal: l.iva, discountTotal: 0,
            })),
          },
        },
        select: { id: true, tid: true },
      });
    });
    await this.posting
      .postSalesInvoice({
        sourceId: inv.id, date: v.desde, number: inv.tid,
        subtotal: r.base, tax: r.iva, createdBy: opts.autor ?? 'Sistema',
      })
      .catch((e) => this.logger.warn(`Contabilización del prorrateo (factura #${inv.tid}): ${(e as Error).message}`));
    return { tid: inv.tid, nueva: true };
  }
}
