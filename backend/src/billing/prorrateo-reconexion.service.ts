import { Prisma } from '@prisma/client';
import { Logger } from '../core/logger';
import { PrismaService } from '../prisma/prisma.service';
import { PostingService } from '../accounting/posting.service';
import { nextTid, TID_SEQ } from '../common/tid';
import { num, round2 } from '../common/money';
import { hoyEnColombia } from '../common/fecha-colombia';
import {
  cabeceraDeProrrateo, etiquetaProrrateo, valorProrrateado, ventanaProrrateo, VentanaProrrateo,
} from './prorrateo-reconexion';
import { planDeUltimaFactura } from './plan-facturable';
import { CARGOS_POR_ORDEN } from './cargos-orden';

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
 * CUÁNDO NO COBRA, aunque haya días sin facturar: si lo ÚNICO que el abonado pagó
 * hoy fue un cargo puntual —el traslado vale 30.000 y ya (`pagoDeHoyFueSoloUnCargo`,
 * regla del usuario del 08-09-2026)—. Sólo se mira cuando el disparo es un pago
 * (`porPago`), no cuando lo dispara el cierre de una orden.
 *
 * DÓNDE CAE EL COBRO.
 *   · Factura de la MENSUALIDAD del mes con saldo → se le añade el renglón (y queda
 *     `editedAt`, o el sync de ida la revertiría en la siguiente pasada de 15
 *     minutos).
 *   · Factura del mes ya pagada, timbrada ante la DIAN, o inexistente → factura
 *     NUEVA con vencimiento a fin de mes. El legacy sí revive una factura pagada;
 *     aquí no, porque eso deja mintiendo al recibo que el cliente acaba de recibir
 *     y rompe el documento electrónico.
 *   · NUNCA en un cobro puntual de ventanilla (traslado, 'Agregar Internet',
 *     afiliación): esa factura se emitió por un valor cerrado (`esCobroPuntual`).
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
 * ¿La cabecera de una factura NOMBRA ese servicio? ('no' y '-' son como el legacy
 * escribe "este servicio no lo tiene"; vacío o NULL es "aquí no se dijo nada").
 */
const nombra = (s: string | null | undefined) => {
  const t = clave(s);
  return !!t && t !== 'no' && t !== '-';
};

/**
 * Los renglones de CARGO DE ORDEN ('Agregar Internet', 'Traslado'): un pago único
 * por un trabajo, no la mensualidad de un servicio.
 *
 * Sin esto, 'Agregar Internet' cae en el `/internet/` de `tipoPorNombre` y el
 * prorrateo da el internet por facturado este mes — justo en la factura donde SIEMPRE
 * está ese renglón, que es la del cliente al que se le acaba de montar el servicio.
 * Resultado: al que estrena internet no se le cobraba ni un solo día del mes.
 *
 * Sale de `CARGOS_POR_ORDEN` y no de una lista escrita aquí para que el día que se
 * añada un cargo nuevo no haya que acordarse de este fichero.
 *
 * A propósito NO entran aquí los otros renglones de una vez que hay en las facturas
 * heredadas ('Reconexión Internet', 'Afiliación …', 'Instalacion'): son 11.000
 * renglones del legacy y cambiar cómo se leen movería plata en el prorrateo de las
 * reconexiones, que es un camino distinto del que arregla esto.
 */
const CARGOS_DE_ORDEN = new Set(CARGOS_POR_ORDEN.map((c) => clave(c.producto)));

/**
 * Qué servicio es un renglón que NO está en el catálogo `Plan`.
 *
 * Hace falta porque las facturas viejas del legacy traen nombres que aquí no
 * existen como plan ('Television', 'SoloTelevision22', planes retirados). Sin este
 * respaldo, un renglón desconocido no marcaría su tipo como facturado y el
 * prorrateo lo volvería a cobrar.
 */
function tipoPorNombre(nombre: string): string | null {
  if (CARGOS_DE_ORDEN.has(nombre)) return null;
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
   * ¿Esta factura es un COBRO PUNTUAL de ventanilla y no la mensualidad del mes?
   *
   * Lo es la que no lleva ni un renglón de servicio: la del traslado (30.000 y ya),
   * la de 'Agregar Internet', la de una afiliación o la venta de un equipo. A esas
   * NO se les cuelga nada.
   *
   * Por qué importa: el destino del prorrateo era «la última factura del mes», y en
   * un traslado esa es justo la de los 30.000 recién emitida. La factura 500029
   * (28-08-2026) acabó con 'Traslado 30.000' + '10Megas(F) · reconexión 28–31 ago
   * 5.161' = 35.161, y el cliente que iba a pagar un traslado se encontró otra cosa
   * en la ventanilla. El cobro de los días no está mal —sigue haciéndose— pero va en
   * la mensualidad del mes o en una factura propia, nunca dentro de un cargo que se
   * emitió por un valor cerrado.
   */
  private esCobroPuntual(
    items: Array<{ productName: string | null; description: string | null; price: Prisma.Decimal | number | null }>,
    catalogo: Map<string, string>,
  ): boolean {
    return !items.some((it) => {
      if (num(it.price) <= 0) return false;
      const nombre = clave(it.productName || it.description);
      return Boolean(catalogo.get(nombre) ?? tipoPorNombre(nombre));
    });
  }

  /** `esCobroPuntual` para quien no tiene el catálogo a mano (scripts de reparación). */
  async esCobroPuntualDeFactura(
    items: Array<{ productName: string | null; description: string | null; price: Prisma.Decimal | number | null }>,
  ): Promise<boolean> {
    return this.esCobroPuntual(items, await this.catalogoDePlanes());
  }

  /**
   * ¿Lo ÚNICO que pagó hoy el abonado fue un cobro puntual (el traslado, 'Agregar
   * Internet', una afiliación)?
   *
   * Regla del usuario (08-09-2026): «las facturas de traslado solo deben cobrar los
   * 30.000 y ya, no debe cobrar días ni nada de eso». El traslado se paga en
   * ventanilla o por el portal, ese pago reconecta al que estaba cortado, y la
   * reconexión traía detrás el cobro de los días que quedan del mes: el cliente
   * pagaba 30.000 y le nacía un cobro que no pidió. Aquí se corta esa cadena.
   *
   * Se mira LO PAGADO y no de dónde viene la llamada porque el traslado entra por
   * dos puertas —la cajera (`CobranzasService`) y el portal, cuyo pago aplica el
   * legacy y aquí sólo se reconecta— y ninguna de las dos le puede contar a la otra
   * lo que cobró. La transacción, en cambio, apunta a su factura en los dos casos.
   *
   * Si hoy también pagó su mensualidad, esto es `false` y los días se cobran como
   * siempre: lo que exime es haber pagado SÓLO el cargo.
   */
  async pagoDeHoyFueSoloUnCargo(
    subscriberId: string,
    hoy: Date = hoyEnColombia(),
  ): Promise<{ si: boolean; conceptos: string[] }> {
    const manana = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), hoy.getUTCDate() + 1));
    const pagos = await this.prisma.transaction.findMany({
      where: {
        subscriberId, status: 'VIGENTE', type: 'INCOME',
        date: { gte: hoy, lt: manana },
        invoiceId: { not: null },
      },
      select: {
        invoice: {
          select: { tid: true, items: { select: { productName: true, description: true, price: true } } },
        },
      },
    });
    const facturas = pagos.map((p) => p.invoice).filter((f): f is NonNullable<typeof f> => !!f);
    // Sin pagos de hoy no hay nada que eximir: esto lo dispara también el cierre de
    // una orden, donde el cobro de los días es justamente lo que toca.
    if (!facturas.length) return { si: false, conceptos: [] };

    const catalogo = await this.catalogoDePlanes();
    if (!facturas.every((f) => this.esCobroPuntual(f.items, catalogo))) return { si: false, conceptos: [] };
    const conceptos = [...new Set(
      facturas.flatMap((f) => f.items.filter((it) => num(it.price) > 0).map((it) => (it.productName || it.description || '').trim())),
    )].filter(Boolean);
    return { si: true, conceptos };
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
      // UNO por servicio y nada más, la misma regla que la corrida mensual: el
      // respaldo puede traer dos planes del mismo tipo (el catálogo tiene el mismo
      // nombre repetido con distinta caja, o el abonado cambió de plan dentro de las
      // dos últimas facturas) y aquí cada uno es un renglón que se cobra. Al abonado
      // 4286 se le cobraron $73.600 de reconexión el 08-09-2026 — '10MegasF' y
      // '10megasF', su internet dos veces — y encima no era lo que parecía: nadie le
      // cobró la televisión, que es lo que la cajera creía estar viendo.
      const yaTomado = new Set<string>();
      for (const d of derivados.get(subscriberId) ?? []) {
        if (!faltan.includes(d.kind as any) || yaTomado.has(d.kind)) continue;
        yaTomado.add(d.kind);
        contratados.push({ kind: d.kind, planName: d.planName, price: d.price, taxRate: d.taxRate, qty: 1 });
      }
    }

    // LAS facturas del mes en curso (todas las que no estén anuladas, de la última a
    // la primera). De ellas salen dos cosas distintas, y por eso no basta con mirar
    // una: si el servicio ya está facturado se responde con TODAS —un cargo de
    // ventanilla emitido después de la mensualidad tapaba la mensualidad y el mes se
    // cobraba dos veces— y el cobro cae sólo en la que se puede tocar.
    const facturas = await this.prisma.subInvoice.findMany({
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
    for (const f of facturas) {
      for (const it of f.items) {
        if (num(it.price) <= 0) continue;
        const nombre = clave(it.productName || it.description);
        yaFacturado.add(nombre);
        const tipo = catalogo.get(nombre) ?? tipoPorNombre(nombre);
        if (tipo) tiposFacturados.add(tipo);
      }
    }

    // DÓNDE cae el cobro: la factura de la MENSUALIDAD del mes, nunca un cobro
    // puntual de ventanilla (ver `esCobroPuntual`). Si en el mes sólo hay cobros
    // puntuales —o no hay nada—, los días se van a una factura nueva.
    const factura = facturas.find((f) => !this.esCobroPuntual(f.items, catalogo));

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
    opts: { ctx?: string; autor?: string; porPago?: boolean } = {},
  ): Promise<ResultadoProrrateo> {
    // Lo dispara un PAGO: si ese pago fue sólo el traslado (o cualquier otro cargo
    // puntual), no se le cobra nada más — ver `pagoDeHoyFueSoloUnCargo`.
    if (opts.porPago) {
      const cargo = await this.pagoDeHoyFueSoloUnCargo(subscriberId).catch(() => ({ si: false, conceptos: [] as string[] }));
      if (cargo.si) {
        const que = cargo.conceptos.join(' + ') || 'un cargo puntual';
        this.logger.log(`Prorrateo de reconexión del abonado ${subscriberId}: hoy sólo pagó ${que} — no se cobran días.`);
        return VACIO('on', `Hoy sólo pagó ${que}: no se le cobran los días del mes.`);
      }
    }

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

  /** Qué servicios NOMBRA este cobro (y cuántos puntos), para la cabecera de la factura. */
  private serviciosCobrados(r: ResultadoProrrateo) {
    return {
      INTERNET: r.lineas.find((l) => l.kind === 'INTERNET')?.concepto ?? null,
      TV: r.lineas.find((l) => l.kind === 'TV')?.concepto ?? null,
      puntos: r.lineas.filter((l) => l.kind === 'PUNTOS').reduce((n, l) => n + l.qty, 0) || null,
    };
  }

  /**
   * Lo que el abonado tiene contratado según su última factura recurrente, que es
   * de donde lo lee todo el sistema (ficha, contrato, corrida). Sirve para que una
   * factura de prorrateo no nazca contando media verdad.
   */
  private async snapshotDeServicios(subscriberId: string) {
    const previa = await this.prisma.subInvoice.findFirst({
      where: { subscriberId, kind: 'RECURRENTE', status: { not: 'CANCELED' } },
      orderBy: [{ invoiceDate: 'desc' }, { tid: 'desc' }],
      select: { serviceCombo: true, serviceTv: true, puntos: true, estadoCombo: true, estadoTv: true },
    });
    return {
      serviceCombo: previa?.serviceCombo ?? null,
      serviceTv: previa?.serviceTv ?? null,
      puntos: previa?.puntos ?? null,
      estadoCombo: previa?.estadoCombo ?? null,
      estadoTv: previa?.estadoTv ?? null,
    };
  }

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
        serviceCombo: true, serviceTv: true, puntos: true,
        items: { select: { productName: true, description: true, price: true } },
        electronicInvoices: { select: { type: true, dianNumber: true } },
      },
    });
    if (!inv) return null;
    if (inv.status === 'PAID' || num(inv.paidAmount) >= num(inv.total)) return null;
    if (inv.electronicInvoices.some((e) => e.type === 'FACTURADA' && e.dianNumber)) return null;
    // El mismo freno que en `evaluar`, aquí porque esta es la puerta por la que se
    // escribe: un cargo cerrado (traslado, agregar internet, afiliación) no engorda.
    if (this.esCobroPuntual(inv.items, await this.catalogoDePlanes())) return null;

    const etiqueta = etiquetaProrrateo(v);
    // La cabecera tiene que nombrar lo que la factura cobra. Esta factura puede ser
    // otro prorrateo del mismo día —al que se le devolvió primero el internet y luego
    // la TV— y entonces le falta el servicio que se añade ahora: la factura #505081
    // del abonado 56720 quedó con un renglón 'Television26' y `serviceTv` en blanco, y
    // la ficha del cliente dejó de enseñar su televisión. Sólo se rellena lo que se
    // cobra; el otro servicio se queda como estaba.
    const cobrado = this.serviciosCobrados(r);
    const cabecera: {
      serviceCombo?: string; serviceTv?: string; puntos?: number;
      estadoCombo?: null; estadoTv?: null;
    } = {};
    if (cobrado.INTERNET && !nombra(inv.serviceCombo)) cabecera.serviceCombo = cobrado.INTERNET;
    if (cobrado.TV && !nombra(inv.serviceTv)) cabecera.serviceTv = cobrado.TV;
    if (cobrado.puntos && !inv.puntos) cabecera.puntos = cobrado.puntos;
    // Y el servicio que vuelve queda al aire en la factura donde se le cobra (misma
    // convención del legacy: NULL = al aire).
    if (cobrado.INTERNET) cabecera.estadoCombo = null;
    if (cobrado.TV) cabecera.estadoTv = null;

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
          ...cabecera,
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
    // La cabecera es el snapshot de lo que el cliente TIENE, no de lo que este
    // documento cobra: se arrastra la de su factura anterior y se pisa sólo el
    // servicio que vuelve (ver `cabeceraDeProrrateo`).
    const cabecera = cabeceraDeProrrateo(
      await this.snapshotDeServicios(subscriberId),
      this.serviciosCobrados(r),
    );

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
          serviceCombo: cabecera.serviceCombo,
          serviceTv: cabecera.serviceTv,
          puntos: cabecera.puntos,
          estadoCombo: cabecera.estadoCombo as Prisma.SubInvoiceCreateInput['estadoCombo'],
          estadoTv: cabecera.estadoTv as Prisma.SubInvoiceCreateInput['estadoTv'],
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
