import { Prisma, InvoiceRon } from '@prisma/client';
import { Logger } from '../core/logger';
import { PrismaService } from '../prisma/prisma.service';
import { PostingService } from '../accounting/posting.service';
import { nextTid, TID_SEQ } from '../common/tid';
import { num, round2 } from '../common/money';
import { hoyEnColombia } from '../common/fecha-colombia';
import { exigirSedeSuscriptor } from '../common/sede-scope';
import type { AuthUser } from '../auth/current-user.decorator';
import type { CargoDeOrden } from './cargos-orden';

/**
 * El cargo de una orden de trabajo: lo que se le cobra al cliente por un trabajo
 * puntual que no va en la mensualidad (llevarle el servicio a la casa nueva,
 * agregarle el internet al que solo tenía televisión…).
 *
 * QUÉ COBRA. No lo decide este servicio: se lo dan hecho en un `CargoDeOrden` de
 * `cargos-orden.ts`, que es la lista de tipos de orden que llevan cobro. Aquí solo
 * está la mecánica, que es la misma para todos.
 *
 * CUÁNTO. Del catálogo, no de una constante: el producto 'Traslado' de `Material`
 * vale 30.000 y no lleva IVA. Que salga de ahí es lo que permite que el día que
 * suba de precio lo cambie contabilidad desde el catálogo y no haga falta tocar
 * código. `precioPorDefecto` es solo el respaldo para que un catálogo sin esa fila
 * no deje el trabajo sin cobrar.
 *
 * CÓMO. Factura APARTE (`kind: FIJA`, un solo renglón, vence el mismo día), que es
 * exactamente como lo lleva haciendo el legacy: 3.875 facturas de 30.000 con el
 * único ítem 'Traslado'. No se le añade el renglón a la mensualidad a propósito —
 * estos cargos se cobran en ventanilla cuando se piden, no a fin de mes, y una
 * factura suelta es la que la cajera puede recibir en el acto. Y es un PAGO ÚNICO:
 * la corrida mensual factura planes, no cargos, así que esto no se repite el mes
 * que viene.
 *
 * CUÁNDO. Al ABRIR la orden (decisión del usuario, 2026-08-27): el cliente lo pide,
 * paga y el técnico sale. No al cerrarla.
 *
 * INTERRUPTOR. Uno por cargo (`billing.cargoTraslado`,
 * `billing.cargoAgregarInternet`): `on` cobra · `informe` calcula y lo deja en el
 * log sin tocar plata · `off` ni lo calcula. La orden se abre igual en los tres
 * casos: quedarse sin factura no puede impedir que el trabajo entre.
 */

export type ModoCargo = 'on' | 'informe' | 'off';

const normalizar = (v?: string | null) =>
  (v ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();

export type TarifaCargo = {
  /** Base sin IVA, al peso. */
  precio: number;
  ivaPct: number;
  /** Nombre con el que va a `productName` (los reportes agrupan por él). */
  concepto: string;
  /** true = salió del catálogo; false = se usó el respaldo. */
  delCatalogo: boolean;
};

export type ResultadoCargo = {
  /** true = hay factura emitida. */
  cobrado: boolean;
  modo: ModoCargo;
  precio: number;
  invoiceTid?: number;
  invoiceId?: string;
  /** El concepto con el que se facturó, para dejarlo anotado en la orden. */
  concepto?: string;
  /** En una línea, para el log y para quien abrió la orden. */
  mensaje: string;
};

/**
 * Una factura que YA cobra este trabajo y todavía no tiene orden detrás.
 *
 * Es lo que hay que enseñarle a quien abre la orden a mano ANTES de guardarla: si el
 * cliente ya pagó los 30.000 en ventanilla, abrir la orden emitiría la segunda.
 */
export type FacturaYaCobrada = {
  tid: number;
  /** Fecha de emisión (YYYY-MM-DD). */
  fecha: string;
  total: number;
  status: string;
  /** El concepto del primer renglón, para reconocerla de un vistazo. */
  concepto: string | null;
  notes: string | null;
  /** true = su renglón es justamente el producto de este cargo (candidata segura). */
  mismoConcepto: boolean;
};

/**
 * Cuánto se mira hacia atrás buscando esa factura. Un mes: el cliente pide el trabajo,
 * paga en ventanilla y la orden se abre en días, no en meses — y más atrás empezarían a
 * salir los cargos de trabajos anteriores ya hechos.
 */
const DIAS_ATRAS_YA_COBRADA = 30;

export class CargoOrdenService {
  private readonly logger = new Logger(CargoOrdenService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly posting: PostingService,
  ) {}

  /**
   * Modo de trabajo de un cargo. El ajuste manda sobre la variable de entorno, para
   * poder apagarlo desde Configuración sin reiniciar el proceso.
   */
  async modo(cargo: CargoDeOrden): Promise<ModoCargo> {
    const row = await this.prisma.appSetting
      .findUnique({ where: { key: cargo.ajuste } })
      .catch(() => null);
    const v = (row?.value ?? process.env[cargo.env] ?? 'on').trim().toLowerCase();
    if (v === 'off' || v === 'false' || v === 'no') return 'off';
    if (v === 'informe' || v === 'dry' || v === 'dryrun' || v === 'dry-run') return 'informe';
    return 'on';
  }

  /**
   * Lo que vale hoy un cargo. Lo consulta también la web, para que el aviso del
   * formulario ("se le cobrarán $30.000") diga el precio de verdad y no uno escrito
   * en el frontend que se quede viejo.
   */
  async tarifa(cargo: CargoDeOrden): Promise<TarifaCargo> {
    // `Material` es una fila POR BODEGA (ver material-tecnico-su-bodega), así que
    // del mismo producto hay varias: se coge la primera con precio, que es lo que
    // hace el resto del sistema con el catálogo facturable.
    const fila = await this.prisma.material
      .findFirst({
        where: { name: { equals: cargo.producto, mode: 'insensitive' }, price: { gt: 0 } },
        orderBy: { name: 'asc' },
        select: { name: true, price: true, taxRate: true },
      })
      .catch(() => null);
    if (!fila) {
      return { precio: cargo.precioPorDefecto, ivaPct: 0, concepto: cargo.producto, delCatalogo: false };
    }
    return {
      precio: round2(num(fila.price)),
      ivaPct: num(fila.taxRate),
      concepto: fila.name,
      delCatalogo: true,
    };
  }

  /**
   * Las facturas de este cliente que YA cobran este trabajo y NO tienen orden detrás.
   *
   * POR QUÉ EXISTE. Un mismo trabajo se puede cobrar por dos caminos —la factura
   * primero (motivo de `motivos-factura.ts`, la orden nace al pagarse) o la orden
   * primero (el cargo automático de aquí)— y la cajera que factura a mano en
   * ventanilla y luego abre la orden recorre los dos: el cliente acaba con dos
   * facturas de 30.000 del mismo trabajo. Pasó el 2026-09-08 con la factura #505077
   * («Agregar internet», pagada) de un cliente que todavía no tenía su orden.
   *
   * NO se descuenta sola: se ENSEÑA, y quien abre la orden dice si es esa
   * (`yaFacturadaTid`). Adivinar sería peor — un cliente puede pedir dos traslados en
   * el mismo mes y el segundo se cobra igual.
   *
   * Se deja fuera lo que ya tiene dueño:
   *   · las anuladas;
   *   · las que emitió una orden (llevan `chargeInvoiceTid` apuntándolas, y además
   *     dicen «orden #…» en la observación — que es el filtro que aguanta cuando el
   *     writeback les cambia el número y el `chargeInvoiceTid` se queda viejo);
   *   · las que tienen un `PendingOrder` — ésas abren su orden solas al pagarse.
   */
  async facturasYaCobradas(
    cargo: CargoDeOrden,
    subscriberId: string,
    user?: AuthUser,
  ): Promise<FacturaYaCobrada[]> {
    // Las facturas de un cliente son dato suyo: se pasa por el mismo acotado por sede
    // que la creación de la orden, para que preguntar por ellas no sea la puerta de
    // atrás del filtro (ver `sede-scope`).
    if (user) await exigirSedeSuscriptor(this.prisma, user, subscriberId);
    const desde = new Date(Date.now() - DIAS_ATRAS_YA_COBRADA * 86_400_000);
    const facturas = await this.prisma.subInvoice
      .findMany({
        where: {
          subscriberId,
          // Los cargos son siempre factura aparte de un renglón: la mensualidad del
          // cliente no cobra un traslado y ofrecerla sería invitar a atarla mal.
          kind: 'FIJA',
          status: { not: 'CANCELED' },
          createdAt: { gte: desde },
          pendingOrder: null,
          // Las que emitió una orden llevan «orden #…» escrito por `emitir`. Se
          // filtran por el texto además de por `chargeInvoiceTid` porque el
          // writeback renumera las facturas al empujarlas al legacy y hasta hoy
          // dejaba ese puntero apuntando a un número que ya no existe.
          NOT: { notes: { contains: 'orden #' } },
        },
        orderBy: { invoiceDate: 'desc' },
        take: 10,
        select: {
          tid: true, invoiceDate: true, total: true, status: true, notes: true,
          items: { take: 1, select: { productName: true, description: true } },
        },
      })
      .catch(() => []);
    if (!facturas.length) return [];

    // Las que ya son de una orden. Se pregunta por `chargeInvoiceTid` y también por
    // `moveInvoiceTid`, que es la columna que llevan escrita los traslados de agosto.
    const tids = facturas.map((f) => f.tid);
    const conOrden = await this.prisma.ticket
      .findMany({
        where: { OR: [{ chargeInvoiceTid: { in: tids } }, { moveInvoiceTid: { in: tids } }] },
        select: { chargeInvoiceTid: true, moveInvoiceTid: true },
      })
      .catch(() => []);
    const tomadas = new Set<number>();
    for (const t of conOrden) {
      if (t.chargeInvoiceTid) tomadas.add(t.chargeInvoiceTid);
      if (t.moveInvoiceTid) tomadas.add(t.moveInvoiceTid);
    }

    const producto = normalizar(cargo.producto);
    return facturas
      .filter((f) => !tomadas.has(f.tid))
      .map((f) => {
        const concepto = f.items[0]?.productName ?? f.items[0]?.description ?? null;
        return {
          tid: f.tid,
          fecha: f.invoiceDate.toISOString().slice(0, 10),
          total: round2(num(f.total)),
          status: f.status,
          concepto,
          notes: f.notes,
          mismoConcepto: normalizar(concepto) === producto,
        };
      });
  }

  /**
   * Emite la factura del cargo. NUNCA lanza: esto cuelga de la creación de una
   * orden de trabajo, y que el cobro falle no puede impedir que el trabajo entre —
   * el técnico tiene que poder salir igual. Lo que no se pudo cobrar queda en el
   * log y la orden se ve sin factura (`chargeInvoiceTid` en null).
   *
   * @param ctx  de dónde viene (orden #…), que va a las notas de la factura.
   */
  async cobrar(
    cargo: CargoDeOrden,
    subscriberId: string,
    opts: { ctx?: string; autor?: string; detalle?: string } = {},
  ): Promise<ResultadoCargo> {
    const modo = await this.modo(cargo).catch(() => 'on' as ModoCargo);
    const que = cargo.etiqueta.toLowerCase();
    if (modo === 'off') {
      return { cobrado: false, modo, precio: 0, mensaje: `El cargo por ${que} está apagado: no se facturó nada.` };
    }

    const tarifa = await this.tarifa(cargo);
    const traza = `abonado ${subscriberId}${opts.ctx ? ` (${opts.ctx})` : ''}`;
    if (tarifa.precio <= 0) {
      return { cobrado: false, modo, precio: 0, mensaje: `El producto de ${que} no tiene precio: no se cobró nada.` };
    }
    if (modo === 'informe') {
      this.logger.log(`[informe] Cargo por ${que} del ${traza}: $${tarifa.precio.toLocaleString('es-CO')}. No se cobró (modo informe).`);
      return {
        cobrado: false, modo, precio: tarifa.precio, concepto: tarifa.concepto,
        mensaje: `${cargo.etiqueta} vale $${tarifa.precio.toLocaleString('es-CO')} — calculado en modo informe, NO se facturó.`,
      };
    }

    try {
      const factura = await this.emitir(cargo, subscriberId, tarifa, opts);
      this.logger.log(`Cargo por ${que} del ${traza}: $${tarifa.precio.toLocaleString('es-CO')} → factura #${factura.tid}.`);
      return {
        cobrado: true, modo, precio: tarifa.precio, invoiceTid: factura.tid, invoiceId: factura.id,
        concepto: tarifa.concepto,
        mensaje: `Factura #${factura.tid} por $${round2(tarifa.precio + factura.iva).toLocaleString('es-CO')} (${que}).`,
      };
    } catch (e) {
      this.logger.error(`Cargo por ${que} del ${traza}: ${(e as Error).message}. Quedó SIN cobrar.`);
      return { cobrado: false, modo, precio: tarifa.precio, concepto: tarifa.concepto, mensaje: `No se pudo facturar ${que}: ${(e as Error).message}` };
    }
  }

  /** La factura en sí: un renglón, del día, y vencida el mismo día. */
  private async emitir(
    cargo: CargoDeOrden,
    subscriberId: string,
    tarifa: TarifaCargo,
    opts: { ctx?: string; autor?: string; detalle?: string },
  ): Promise<{ id: string; tid: number; iva: number }> {
    const sub = await this.prisma.subscriber.findUnique({
      where: { id: subscriberId },
      select: { id: true, status: true, eInvoice: true },
    });
    if (!sub) throw new Error('el abonado no existe');

    const base = round2(tarifa.precio);
    // El IVA al peso, como en el resto de la facturación: un centavo aquí acaba en
    // un total distinto entre nexus y el legacy cada 15 minutos.
    const iva = Math.round((base * tarifa.ivaPct) / 100);
    const hoy = hoyEnColombia();
    const notas = [opts.ctx ? `${cargo.etiqueta} · ${opts.ctx}` : cargo.etiqueta, opts.detalle].filter(Boolean).join(' · ');

    const inv = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const tid = await nextTid(tx, TID_SEQ.subInvoice);
      return tx.subInvoice.create({
        data: {
          tid, subscriberId: sub.id,
          // Vence el mismo día que se emite: es un cargo de ventanilla, no una
          // mensualidad. Así lo hace el legacy en sus 3.875 facturas de traslado.
          invoiceDate: hoy, dueDate: hoy,
          subtotal: base, tax: iva, total: round2(base + iva), paidAmount: 0,
          status: 'DUE', kind: 'FIJA',
          // El estado del cliente estampado en la factura, igual que en la
          // facturación manual: sin esto el perfil del legacy la ve "sin estado".
          ron: sub.status === 'INACTIVO' ? null : (sub.status as unknown as InvoiceRon),
          eInvoiceFlag: sub.eInvoice ? 'Crear Factura Electronica' : null,
          itemsCount: 1,
          notes: notas,
          items: {
            create: [{
              productId: 0, productName: tarifa.concepto, description: notas || tarifa.concepto,
              qty: 1, price: base, taxRate: tarifa.ivaPct,
              subtotal: base, taxTotal: iva, discountTotal: 0,
            }],
          },
        },
        select: { id: true, tid: true },
      });
    });

    await this.posting
      .postSalesInvoice({
        sourceId: inv.id, date: hoy, number: inv.tid,
        subtotal: base, tax: iva, createdBy: opts.autor ?? 'Sistema',
      })
      .catch((e) => this.logger.warn(`Contabilización del cargo (factura #${inv.tid}): ${(e as Error).message}`));

    return { id: inv.id, tid: inv.tid, iva };
  }
}
