import { BadRequestException, ForbiddenException, NotFoundException } from '../core/http/errores';
import { InvoiceKind, InvoiceRon, Prisma, ServiceKind, ServiceStatus, SubscriberStatus, SubInvoiceStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ChangeServiceStatusDto, ChangeStatusDto, CreateSubscriberDto, ReturnEquipmentDto, UpdateInvoiceDto, UpdateSubscriberDto } from './dto/update-subscriber.dto';
import { MikrotikActionResult, MikrotikService } from '../network/mikrotik.service';
import { MikrotikAdminService } from '../network/mikrotik-admin.service';
import { GenieacsService } from '../network/genieacs.service';
import type { AuthUser } from '../auth/current-user.decorator';
import { deudaPendiente, num, round2, saldoPendiente } from '../common/money';
import { direccionDe, referenciaDe } from '../common/subscriber-address';
import { conVlanEnComentario, vlanDeComentario } from '../common/net-comment';
import { partirNotaDeEstado, sinEcosDelSync } from './motivo-estado';
import { saldoAFavor } from '../billing/anticipos';
import { mensualidadesCompletas, planDeUltimaFactura } from '../billing/plan-facturable';
import { descuentosDePromocionPendientes } from '../promotions/descuento-al-cobrar';
import { sedesDe, whereSedeSuscriptor, exigirSedeSuscriptor, exigirSedeDestino } from '../common/sede-scope';
import { esClienteDeSuOrden, esTecnicoDeCampo } from '../common/tecnico-scope';
import { exigirBodegaDeSuSede, sedesDeUsuario } from '../network/bodega-scope';
import { nextTid, TID_SEQ } from '../common/tid';
import { orden, paginacion } from '../common/pagination-params';
import { anotarBorradoLegacy } from '../common/legacy-deletion';
import { contratadoEnFactura } from '../common/servicios-del-abonado';
import { clavePppDe, esUsuarioPppUtil, TECNOLOGIA_FTTH, usuarioPppDe, variantePpp } from './conexion-alta';
import { hoyEnColombia } from '../common/fecha-colombia';
import { esOrdenDeRetiroOSuspension } from '../support/order-types';
import { enteroBuscable } from '../support/support.service';
import { ORDEN_CRONOLOGICO, tieneHoraReal } from '../support/orden-cronologico';
import { equiposDeOrdenes } from '../support/equipo-reserva.service';
import { KIND_CARTA_RETIRO } from './subscriber-files.service';
import { ESTADO_SERVICIO_EVENT, type EstadoServicioEvent } from './subscribers.events';
import type { OrdenAbierta, OrdenesAutomaticasService } from '../support/ordenes-automaticas.service';
import type { EmisorDeEventos } from '../core/eventos';

/**
 * Enumera motivos en castellano: "A, B y C". Con un solo requisito daba igual, pero
 * el paz y salvo pide cuatro cosas y un `join(' y ')` sacaba "debe 30.000 y no ha
 * devuelto el equipo y no ha entregado la carta y no tiene la orden cerrada".
 */
const enumerar = (partes: string[]): string =>
  partes.length <= 1 ? (partes[0] ?? '') : `${partes.slice(0, -1).join(', ')} y ${partes[partes.length - 1]}`;

/** Monto legible para los motivos que se le muestran a quien pide el paz y salvo. */
const copFmt = (n: number) =>
  new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n || 0);


/** Un día `date` (medianoche UTC) escrito para leer: 28/08/2026. En UTC a propósito,
 *  o en Colombia se vería el día anterior. */
const diaEnTexto = (d: Date) => d.toLocaleDateString('es-CO', { timeZone: 'UTC' });

/**
 * La orden que respalda cada movimiento manual del estado de un servicio.
 *
 * Son los nombres del catálogo del legacy (`DETALLES_POR_CLASE.servicio`), que es de
 * donde los lee el técnico y por los que agrupan sus informes.
 *
 * La reconexión va SIN el sufijo "2" a propósito: ese sufijo dice que hay días sin
 * facturar que se le cobran al cliente al cerrar la orden (ver
 * `billing/prorrateo-reconexion.service.ts`), y aquí no se está cobrando nada — sólo
 * anotando lo que ya se hizo en la calle. Por lo mismo tampoco se pasa como tipo
 * equivalente: si el abonado tiene abierta una "Reconexion …2", esa se queda donde
 * está para que la cierre quien la cobre.
 */
const ORDEN_DE_ESTADO: Record<'INTERNET' | 'TV', Record<'ACTIVO' | 'CORTADO' | 'SUSPENDIDO', string>> = {
  INTERNET: { CORTADO: 'Corte Internet', SUSPENDIDO: 'Suspension Internet', ACTIVO: 'Reconexion Internet' },
  TV: { CORTADO: 'Corte Television', SUSPENDIDO: 'Suspension Television', ACTIVO: 'Reconexion Television' },
};

/** Estados de factura que cuentan como deuda. */
const UNPAID_STATUSES: SubInvoiceStatus[] = ['DUE', 'PARTIAL'];

/** Valores admitidos del filtro «Deuda» (los que `debtIds` sabe resolver). */
const DEUDA_FILTROS = new Set(['1', 'compromiso', 'gt2', 'fija']);

/** Filtro compartido por la lista de clientes y las operaciones masivas. */
type ListFilter = {
  search?: string; status?: string; branchId?: string;
  servicio?: string; // internet | tv | combo
  planId?: string; // un plan concreto del catálogo
  tecnologia?: string; // FTTH | EOC
  cuenta?: string; // aldia | debe | compromiso
  deuda?: string; // 1 | compromiso (2: la de este mes + la del anterior) | gt2 | fija
  page?: number; pageSize?: number; withPlan?: string;
  sortBy?: string; sortDir?: string; // orden pedido por la cabecera de la tabla
};

/** Nombre visible del suscriptor a partir de los campos legacy partidos. */
function displayName(s: {
  firstName: string | null; secondName: string | null;
  lastName1: string | null; lastName2: string | null;
  companyName: string | null; fullName: string | null;
}): string {
  if (s.fullName && s.fullName.trim()) return s.fullName.trim();
  const parts = [s.firstName, s.secondName, s.lastName1, s.lastName2].map((p) => (p || '').trim()).filter(Boolean);
  const person = parts.join(' ');
  if (person) return person;
  return (s.companyName || '').trim() || 'Sin nombre';
}

/** Campos de factura que consumen la ficha y la lista de facturas. */
const INVOICE_SELECT: Prisma.SubInvoiceSelect = {
  id: true, tid: true, invoiceDate: true, dueDate: true, total: true,
  paidAmount: true, status: true, ron: true, kind: true, notes: true, serviceCombo: true, serviceTv: true,
  promo: true, promo2: true, promoModifiedDate: true, promo2ModifiedDate: true,
  eInvoiceFlag: true, eInvoiceGenDate: true, eInvoiceServices: true,
  electronicInvoices: {
    orderBy: { date: 'desc' }, take: 1,
    select: { dianNumber: true, cufe: true, pdfUrl: true, date: true, siigoInvoiceId: true },
  },
};

/** Da forma a una factura (misma estructura para la ficha y la lista paginada). */
function mapInvoice(i: any) {
  const ei = i.electronicInvoices[0];
  return {
    id: i.id, tid: i.tid, date: i.invoiceDate, dueDate: i.dueDate,
    total: num(i.total), paid: num(i.paidAmount), balance: num(i.total) - num(i.paidAmount),
    status: i.status, ron: i.ron, kind: i.kind, notes: i.notes, combo: i.serviceCombo, tv: i.serviceTv,
    promo: {
      p1: i.promo, p2: i.promo2, date1: i.promoModifiedDate, date2: i.promo2ModifiedDate,
      has: !!(i.promo || i.promo2),
    },
    eInvoice: {
      flag: i.eInvoiceFlag, services: i.eInvoiceServices, genDate: i.eInvoiceGenDate,
      created: i.eInvoiceFlag === 'Factura Electronica Creada' || !!ei,
      dian: ei?.dianNumber ?? null, cufe: ei?.cufe ?? null, pdfUrl: ei?.pdfUrl ?? null, date: ei?.date ?? null,
    },
  };
}

/** Compone el nombre visible a partir de las 4 partes; null si todas vacías. */
function composeName(...parts: (string | null | undefined)[]): string | null {
  const joined = parts.map((p) => (p || '').trim()).filter(Boolean).join(' ');
  return joined || null;
}

/**
 * Los catálogos de dirección (ciudad, barrio…) se guardan en el suscriptor como el
 * ID legacy en texto. Devuelve ese id como número, o null si viene vacío o basura.
 */
function legacyRef(v: string | null | undefined): number | null {
  const n = Number((v ?? '').trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Campos string del perfil que se aplican tal cual ("" → null). */
const PROFILE_STR_FIELDS = [
  'firstName', 'secondName', 'lastName1', 'lastName2', 'companyName', 'customerType',
  'docType', 'docNumber', 'email', 'phone1', 'phone2', 'estrato', 'suscripcion',
  'departmentRef', 'cityRef', 'localityRef', 'neighborhood', 'addressLine', 'gpsLat', 'gpsLng',
  // Datos de conectividad. El legacy los capturaba en el alta (`create.php`: name_s, contra,
  // perfil, Ipremota, tegnologia); en Nexus el DTO no los aceptaba y NADA escribía
  // `pppUsername`, así que un cliente creado aquí nunca podía aprovisionarse en el router.
  'pppUsername', 'pppPassword', 'pppProfile', 'ipRemote', 'installTech',
  // El resto de la tarjeta «Red / Conexión» de la ficha. Faltaban por lo mismo que
  // los de arriba: se veían pero no había por dónde corregirlos, y son datos que
  // llegaron del legacy mal capturados (MAC de la ONT vacía, comentario con la VLAN
  // equivocada). El writeback ya sabía llevárselos allá (`CUSTOMER_FIELD2COLS`).
  'ipLocal', 'macEquipo', 'macOnt', 'netComment',
] as const;

/** Traduce el DTO del wizard (pasos 1-2) a data de Prisma (sin branch ni fullName). */
function buildProfileData(dto: Record<string, any>): any {
  const data: any = {};
  for (const k of PROFILE_STR_FIELDS) if (dto[k] !== undefined) data[k] = dto[k] === '' ? null : dto[k];
  if (dto.abonado !== undefined) data.abonado = dto.abonado;
  if (dto.clausula !== undefined) data.clausula = dto.clausula;
  if (dto.birthDate !== undefined) data.birthDate = dto.birthDate ? new Date(dto.birthDate) : null;
  if (dto.contractDate !== undefined) data.contractDate = dto.contractDate ? new Date(dto.contractDate) : null;
  if (dto.nomenclature !== undefined) data.nomenclature = dto.nomenclature ?? null;
  return data;
}

export class SubscribersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mikrotik: MikrotikService,
    private readonly mikrotikAdmin: MikrotikAdminService,
    private readonly genieacs: GenieacsService,
    /**
     * Opcional a propósito, igual que en `ReconexionService`: sin él la ficha sigue
     * funcionando, sólo que lo que se cambie aquí espera al cron para viajar al legacy.
     */
    private readonly events?: EmisorDeEventos,
    /**
     * También opcional: sin él el cambio manual de estado se guarda igual, sólo que
     * no queda la orden de servicio que lo respalda (ver `registrarOrdenDeServicio`).
     */
    private readonly ordenes?: OrdenesAutomaticasService,
    /** Opcional: sin él la devolución se guarda igual, pero la ONU sigue dada de alta en la OLT. */
    private readonly onuAlDevolver?: import('../network/onu-al-devolver.service').OnuAlDevolverService,
  ) {}

  /** Tarjetas de resumen: totales por estado + cartera global. */
  async stats() {
    const [byStatus, total, cartera] = await Promise.all([
      this.prisma.subscriber.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.subscriber.count(),
      this.prisma.subInvoice.aggregate({
        _sum: { total: true, paidAmount: true },
        where: { status: { in: ['DUE', 'PARTIAL'] } },
      }),
    ]);
    const status: Record<string, number> = {};
    for (const r of byStatus) status[r.status ?? 'SIN_ESTADO'] = r._count._all;
    return {
      total,
      activos: status['ACTIVO'] ?? 0,
      cartera: status['CARTERA'] ?? 0,
      cortados: status['CORTADO'] ?? 0,
      suspendidos: status['SUSPENDIDO'] ?? 0,
      status,
      carteraTotal: num(cartera._sum.total) - num(cartera._sum.paidAmount),
    };
  }

  /**
   * Los servicios que el cliente tiene contratados, sacados de su ÚLTIMA FACTURA.
   *
   * `SubscriberService` no está completo: se materializó de una sola pasada y solo
   * para los ACTIVO cuya factura casaba con el catálogo
   * (`scripts/seed-plans-from-services.js`), así que 2.350 clientes vivos se
   * quedaron sin ni una fila — los 1.266 de CARTERA en bloque, 278 de compromiso,
   * 223 activos… — y su ficha decía "sin plan" mientras el legacy sí enseñaba el
   * plan. No es que no tengan: es que aquí no se copió.
   *
   * El legacy lo lee de la factura (`invoices.combo` / `invoices.television`), que
   * aquí son `SubInvoice.serviceCombo` / `serviceTv`. Esta es la misma fuente, así
   * que lo que se ve coincide con lo que se le está cobrando.
   *
   * El precio sale del ítem de esa factura cuyo nombre casa con el plan; si no
   * casa, va sin precio antes que con uno inventado.
   */
  private async serviciosDeUltimaFactura(ids: string[]) {
    const porAbonado = new Map<string, { kind: string; planName: string; price: number | null; status: null; source: 'factura' }[]>();
    if (!ids.length) return porAbonado;

    const ultimas = await this.prisma.$queryRaw<
      { id: string; subscriberId: string; serviceCombo: string | null; serviceTv: string | null }[]
    >`
      SELECT DISTINCT ON (i."subscriberId") i.id, i."subscriberId", i."serviceCombo", i."serviceTv"
        FROM "SubInvoice" i
       WHERE i."subscriberId" IN (${Prisma.join(ids)})
       ORDER BY i."subscriberId", i."invoiceDate" DESC NULLS LAST, i.tid DESC`;
    if (!ultimas.length) return porAbonado;

    const items = await this.prisma.subInvoiceItem.findMany({
      where: { invoiceId: { in: ultimas.map((u) => u.id) } },
      select: { invoiceId: true, description: true, productName: true, price: true },
    });
    const itemsPorFactura = new Map<string, typeof items>();
    for (const it of items) {
      const arr = itemsPorFactura.get(it.invoiceId) ?? [];
      arr.push(it);
      itemsPorFactura.set(it.invoiceId, arr);
    }

    const norm = (s?: string | null) => (s ?? '').trim().toLowerCase();
    // 'no' es como el legacy escribe "este servicio no lo tiene".
    const contratado = (s?: string | null) => !!norm(s) && norm(s) !== 'no';

    for (const u of ultimas) {
      const deLaFactura = itemsPorFactura.get(u.id) ?? [];
      const precioDe = (plan: string) => {
        const it = deLaFactura.find((x) => norm(x.description) === norm(plan) || norm(x.productName) === norm(plan));
        return it && num(it.price) > 0 ? num(it.price) : null;
      };
      const lineas: { kind: string; planName: string; price: number | null; status: null; source: 'factura' }[] = [];
      if (contratado(u.serviceCombo)) {
        const plan = u.serviceCombo!.trim();
        lineas.push({ kind: 'INTERNET', planName: plan, price: precioDe(plan), status: null, source: 'factura' });
      }
      if (contratado(u.serviceTv)) {
        const plan = u.serviceTv!.trim();
        lineas.push({ kind: 'TV', planName: plan, price: precioDe(plan), status: null, source: 'factura' });
      }
      if (lineas.length) porAbonado.set(u.subscriberId, lineas);
    }
    return porAbonado;
  }

  /**
   * Los servicios que el abonado tiene DADOS DE BAJA: el `'no'` que el legacy escribe
   * en `combo`/`television` y que deja `removeService` al quitar un servicio.
   *
   * Sale de la factura que DICTA EL PLAN —la última recurrente viva, la misma que lee
   * el legacy y sobre la que se escribe la baja—, no de la última factura a secas: una
   * FIJA posterior (una instalación, un traslado) arrastra el snapshot viejo y taparía
   * la baja recién hecha.
   *
   * Vacío NO es `'no'`: vacío es "esta factura no lo dice" —las emitidas a mano en
   * ventanilla salen así— y ahí siguen mandando las fuentes derivadas. Sólo el `'no'`
   * explícito tapa, porque es el único que significa "alguien decidió quitarlo".
   */
  private async serviciosDadosDeBaja(ids: string[]) {
    const quitados = new Map<string, Set<string>>();
    if (!ids.length) return quitados;
    const filas = await this.prisma.$queryRaw<
      { subscriberId: string; combo: string | null; tv: string | null }[]
    >`
      SELECT DISTINCT ON (i."subscriberId")
             i."subscriberId", i."serviceCombo" AS combo, i."serviceTv" AS tv
        FROM "SubInvoice" i
       WHERE i."subscriberId" IN (${Prisma.join(ids)})
         AND i.kind = 'RECURRENTE' AND i.status <> 'CANCELED'
       ORDER BY i."subscriberId", i."invoiceDate" DESC NULLS LAST, i.tid DESC`;
    for (const f of filas) {
      const off = new Set<string>();
      if ((f.combo ?? '').trim().toLowerCase() === 'no') off.add('INTERNET');
      if ((f.tv ?? '').trim().toLowerCase() === 'no') off.add('TV');
      if (off.size) quitados.set(f.subscriberId, off);
    }
    return quitados;
  }

  /**
   * Tercera fuente: el PLAN QUE SE LE FACTURÓ, sacado de los ítems.
   *
   * Hay clientes cuya última factura trae los campos `combo`/`television` vacíos
   * pero cobra un ítem que se llama igual que un plan del catálogo ('100 Megas
   * F-26'). Se cruza el nombre del ítem contra `Plan`, que además dice si es
   * internet o televisión, y se toma el más reciente de cada tipo: es lo último
   * que la empresa le cobró por ese servicio.
   */
  private async serviciosDeItemsFacturados(ids: string[]) {
    const porAbonado = new Map<string, { kind: string; planName: string; price: number | null; status: null; source: 'factura' }[]>();
    if (!ids.length) return porAbonado;
    /**
     * Sólo el último año. Sin ventana, esta consulta mira TODA la historia del
     * abonado y resucita servicios que dejó hace años: a la abonada 2169 le sacó un
     * 'Punto Adicional' de febrero de 2021. Un servicio que no se le factura desde
     * hace más de un año no es un servicio contratado, es un rastro.
     */
    const ventana = new Date(Date.UTC(new Date().getUTCFullYear() - 1, new Date().getUTCMonth(), 1));
    const filas = await this.prisma.$queryRaw<
      { subscriberId: string; kind: string; name: string; price: Prisma.Decimal | null }[]
    >`
      SELECT DISTINCT ON (i."subscriberId", pl.kind)
             i."subscriberId", pl.kind::text AS kind, pl.name, it.price
        FROM "SubInvoice" i
        JOIN "SubInvoiceItem" it ON it."invoiceId" = i.id
        JOIN "Plan" pl ON lower(btrim(pl.name)) = lower(btrim(COALESCE(it."productName", it.description)))
       WHERE i."subscriberId" IN (${Prisma.join(ids)})
         AND i."invoiceDate" >= ${ventana}
       ORDER BY i."subscriberId", pl.kind, i."invoiceDate" DESC NULLS LAST, i.tid DESC`;
    for (const f of filas) {
      const arr = porAbonado.get(f.subscriberId) ?? [];
      arr.push({ kind: f.kind, planName: f.name, price: num(f.price) || null, status: null, source: 'factura' });
      porAbonado.set(f.subscriberId, arr);
    }
    return porAbonado;
  }

  /**
   * Último recurso: el PERFIL DEL ROUTER como plan de internet.
   *
   * `Subscriber.pppProfile` es `customers.perfil` del legacy — el perfil PPPoE con
   * el que el cliente navega ('10Megas', '300Megas'), o sea su velocidad real
   * aunque nadie le haya registrado el plan ni le haya facturado todavía. De los
   * 154 clientes vivos que no tienen ni servicio ni factura con plan, 38 sí tienen
   * un perfil de verdad; los otros traen basura de captura ('-', 'default',
   * 'Seleccione...' —y su errata 'Seleccine...') que no dice nada.
   *
   * El filtro es "tiene que llevar un número": todos los perfiles reales nombran
   * las megas ('10Megas', '1000Megas26D') y ninguna de las basuras lo hace. Es más
   * de fiar que ir listando las erratas una por una.
   */
  private servicioDePerfilPpp(pppProfile?: string | null) {
    const perfil = (pppProfile ?? '').trim();
    if (!/\d/.test(perfil)) return [];
    return [{ kind: 'INTERNET', planName: perfil, price: null, status: null, source: 'perfil' as const }];
  }

  /**
   * El plan de los clientes que no lo tienen registrado como servicio, buscándolo
   * por todas partes y en este orden: lo que dice su última factura → el plan del
   * catálogo que se le haya facturado alguna vez → el perfil con el que navega. Y
   * por encima de los tres, lo que se haya dado de BAJA, que no se deduce de nada.
   *
   * Se resuelve en bloque (una consulta por fuente para toda la página) porque lo
   * usan tanto la ficha como el listado.
   */
  /** El plan que la corrida de este mes le derivaría de sus últimas mensualidades. */
  private planDeMensualidades(ids: string[]) {
    const hoy = new Date();
    return planDeUltimaFactura(this.prisma, ids, new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), 1)));
  }

  private async serviciosDeRespaldo(filas: { id: string; pppProfile?: string | null }[]) {
    const porAbonado = new Map<string, { kind: string; planName: string | null; price: number | null; status: string | null; source: string }[]>();
    if (!filas.length) return porAbonado;

    /**
     * La BAJA manda sobre las tres fuentes.
     *
     * Todas ellas miran hacia atrás —la última factura, los renglones del último año,
     * el perfil del router— y todas resucitan lo que se acaba de quitar. Al abonado
     * 56130 le quitaron la televisión el 09-09-2026 y le seguía saliendo: su factura
     * del mes no nombra servicios (emitida a mano en ventanilla) y el segundo escalón
     * se la sacaba del renglón 'Television' de noviembre del año anterior.
     */
    const quitados = await this.serviciosDadosDeBaja(filas.map((f) => f.id));
    const vivos = <T extends { kind: string }>(id: string, svc: T[]) => {
      const off = quitados.get(id);
      return off ? svc.filter((x) => !off.has(x.kind)) : svc;
    };

    const deFactura = await this.serviciosDeUltimaFactura(filas.map((f) => f.id));
    for (const [id, svc] of deFactura) {
      const q = vivos(id, svc);
      if (q.length) porAbonado.set(id, q);
    }

    /**
     * La última factura puede nombrar UNO solo de los dos servicios y no por eso el otro
     * se dio de baja. Abonado 51993 (2026-09-14): combo TV + internet, pero con sólo la
     * TV registrada; la corrida del 01-09 —todavía con la regla de todo o nada— le emitió
     * septiembre con la TV sola, y desde entonces la ficha, que se paraba en esa factura,
     * dejó de enseñarle el internet que sigue usando. Se completa lo que falte con la
     * MISMA regla de la corrida (últimas 2 mensualidades), para que la ficha diga lo que
     * se le va a cobrar; los 12 meses de `serviciosDeItemsFacturados` revivirían bajas.
     */
    const aMedias = filas.filter((f) => {
      const k = new Set((porAbonado.get(f.id) ?? []).map((x) => x.kind));
      return k.size > 0 && (!k.has('INTERNET') || !k.has('TV'));
    });
    if (aMedias.length) {
      const derivados = await this.planDeMensualidades(aMedias.map((f) => f.id));
      for (const f of aMedias) {
        const actuales = porAbonado.get(f.id)!;
        const k = new Set(actuales.map((x) => x.kind));
        const extra = vivos(f.id, (derivados.get(f.id) ?? [])
          .filter((d) => (d.kind === 'INTERNET' || d.kind === 'TV') && !k.has(d.kind) && (k.add(d.kind), true))
          .map((d) => ({ kind: d.kind, planName: d.planName, price: d.price ?? null, status: null, source: 'factura' })));
        if (extra.length) porAbonado.set(f.id, [...actuales, ...extra]);
      }
    }

    const faltan = filas.filter((f) => !porAbonado.has(f.id));
    if (faltan.length) {
      const deItems = await this.serviciosDeItemsFacturados(faltan.map((f) => f.id));
      for (const [id, svc] of deItems) {
        const q = vivos(id, svc);
        if (q.length) porAbonado.set(id, q);
      }
    }

    for (const f of filas) {
      if (porAbonado.has(f.id)) continue;
      // Mismo candado en el último escalón: a quien se le dio de baja el internet no
      // se le devuelve desde el perfil con el que navegaba.
      if (quitados.get(f.id)?.has('INTERNET')) continue;
      const delPerfil = this.servicioDePerfilPpp(f.pppProfile);
      if (delPerfil.length) porAbonado.set(f.id, delPerfil);
    }
    return porAbonado;
  }

  /**
   * Los servicios registrados MÁS los que le falten, derivados de sus facturas.
   *
   * La regla era todo o nada —"si tiene alguna fila, se cree la ficha entera"— y eso
   * hacía desaparecer servicios en cuanto un abonado quedaba a medio registrar. Se
   * vio el 07-09-2026: una cliente con televisión (sin fila, derivada de su factura)
   * pidió internet por una orden de 'AgregarInternet'; al nacerle la fila de INTERNET
   * el respaldo se apagó entero y su televisión desapareció de la ficha — y de la
   * corrida del mes siguiente, que tenía el mismo todo-o-nada.
   *
   * Lo registrado SIEMPRE manda: del respaldo sólo se toman los `kind` que faltan, y
   * uno por `kind` (el catálogo tiene planes duplicados con distinta caja).
   */
  private async conRespaldo<T extends { kind: string }>(
    registrados: T[],
    fila: { id: string; pppProfile?: string | null },
  ) {
    const suyos = new Set(registrados.map((x) => x.kind));
    // Sólo se sale a buscar si de verdad falta algo. El respaldo son cuatro consultas.
    if (suyos.has('INTERNET') && suyos.has('TV')) return registrados as (T | { kind: string; planName: string | null; price: number | null; status: string | null; source: string })[];
    const derivados = ((await this.serviciosDeRespaldo([fila])).get(fila.id) ?? [])
      .filter((d) => {
        // Sólo los dos servicios que el respaldo sabe deducir de verdad. Los PUNTOS
        // no: son un accesorio con cantidad, la ficha ya los pinta desde su propia
        // fila, y derivarlos de una factura revive fantasmas — a la abonada 2169 le
        // apareció un 'Punto Adicional' de febrero de 2021, con cantidad 0.
        if (d.kind !== 'INTERNET' && d.kind !== 'TV') return false;
        if (suyos.has(d.kind)) return false;
        suyos.add(d.kind);
        return true;
      });
    return [...registrados, ...derivados];
  }

  /**
   * El ESTADO DE CADA SERVICIO (al aire / cortado / suspendido), sacado de la
   * última factura recurrente.
   *
   * Un abonado puede tener la televisión cortada y el internet navegando —o al
   * revés— y hasta ahora la ficha no lo enseñaba: `SubscriberService.status`
   * dice ACTIVO casi siempre (se materializó de una pasada, y solo el corte de
   * TV hecho DESDE nexus lo mueve), así que un corte hecho en el legacy no se
   * veía por ningún lado. Hoy son 246 abonados en ACTIVO con la TV cortada y
   * 366 con el internet cortado.
   *
   * La verdad viva está en la factura: `invoices.estado_tv` / `estado_combo`
   * del legacy (aquí `estadoTv` / `estadoCombo`), que el sync refresca cada 15
   * min y el writeback devuelve. La convención es la de allá: NULL = el
   * servicio está al aire; con valor = está caído, y el valor dice por qué. Es
   * la misma lectura que hace el contrato en PDF (`ContractsService.serviciosDe`),
   * así que la ficha y el papel no se pueden contradecir.
   *
   * Solo cuentan las RECURRENTES: una FIJA es un cobro puntual y no habla del
   * servicio. Y tampoco las ANULADAS: cuando el legacy borra una factura, el sync la
   * marca CANCELED aquí (ver los borrados que no propagan) y esa factura fantasma se
   * quedaba decidiendo si el cliente está cortado — 11 abonados, 9 de ellos con un
   * corte que ya no existe.
   *
   * Y el estado solo vale si ESA MISMA factura nombra el servicio. El legacy
   * escribe `estado_combo = 'cortado'` también a los abonados de solo televisión,
   * que jamás tuvieron internet (el campo `combo` viene en 'no'): son 270 casos y
   * sin este candado la ficha les inventaría un internet cortado. Es el mismo
   * candado que hace el legacy al armar el contrato: lee el estado únicamente
   * cuando el servicio no viene vacío.
   */
  private async estadoPorServicio(ids: string[]) {
    const porAbonado = new Map<string, { INTERNET: string | null; TV: string | null }>();
    if (!ids.length) return porAbonado;
    const filas = await this.prisma.$queryRaw<
      {
        subscriberId: string; estadoTv: string | null; estadoCombo: string | null;
        serviceTv: string | null; serviceCombo: string | null;
      }[]
    >`
      SELECT DISTINCT ON (i."subscriberId")
             i."subscriberId", i."serviceTv", i."serviceCombo",
             i."estadoTv"::text AS "estadoTv", i."estadoCombo"::text AS "estadoCombo"
        FROM "SubInvoice" i
       WHERE i."subscriberId" IN (${Prisma.join(ids)})
         AND i.kind = 'RECURRENTE'
         AND i.status <> 'CANCELED'
       ORDER BY i."subscriberId", i."invoiceDate" DESC NULLS LAST, i.tid DESC`;
    // 'no' es como el legacy escribe "este servicio no lo tiene". El candado es el
    // mismo que usa el cartel de las listas de órdenes, y por eso está en un solo
    // sitio: si aquí y allí se decidiera por separado, la ficha diría que el cliente
    // tiene internet y la lista que es de solo televisión.
    for (const f of filas) {
      porAbonado.set(f.subscriberId, {
        INTERNET: contratadoEnFactura(f.serviceCombo) ? f.estadoCombo : null,
        TV: contratadoEnFactura(f.serviceTv) ? f.estadoTv : null,
      });
    }
    return porAbonado;
  }

  /**
   * Pega ese estado a las líneas de servicio que se van a enseñar.
   *
   * Manda el CORTE, venga de donde venga: si la factura dice que la TV está
   * caída pero el servicio registrado dice ACTIVO se enseña caída (cortó el
   * legacy y aquí nadie se enteró); y al revés, un corte de TV hecho desde nexus
   * —que sí escribe `SubscriberService.status`— no se borra porque la factura
   * del mes todavía no lo refleje. Esconder un corte es el error caro: es justo
   * lo que el cliente está llamando a reclamar.
   *
   * Los PUNTOS son decos de televisión: corren la suerte de la TV.
   */
  private conEstadoDeServicio<T extends { kind: string; status: string | null }>(
    lineas: T[],
    estado?: { INTERNET: string | null; TV: string | null },
  ) {
    const caido = (v?: string | null) => !!v && v !== 'ACTIVO';
    return lineas.map((l) => {
      const deFactura = l.kind === 'INTERNET' ? estado?.INTERNET
        : l.kind === 'TV' || l.kind === 'PUNTOS' ? estado?.TV
          : null;
      if (caido(l.status)) return l;
      return caido(deFactura) ? { ...l, status: deFactura! } : { ...l, status: l.status ?? 'ACTIVO' };
    });
  }

  /**
   * Columnas por las que la tabla de clientes puede pedir orden. La clave es la
   * de la columna en el frontend; lo que no esté aquí se sirve con el orden por
   * defecto (por número de abonado).
   */
  private static readonly ORDEN_LISTA = {
    abonado: 'abonado',
    // El nombre visible sale de los campos partidos del legacy (ver
    // `displayName`), así que se ordena por los mismos y en el mismo orden. Los
    // 7 registros que traen `fullName` y las razones sociales sin persona
    // quedan levemente fuera de sitio; no hay forma de ordenar un COALESCE
    // desde Prisma y por 7 filas de 21.829 no vale montar una vista.
    name: (dir: 'asc' | 'desc') => [
      { firstName: dir }, { secondName: dir }, { lastName1: dir }, { lastName2: dir },
    ],
    doc: 'docNumber',
    phone: 'phone1',
    branch: 'branch.name',
    status: 'status',
    balance: 'balance',
    // El ID del legacy sí ordena (es un número), con los nulos al final: los
    // clientes creados en este stack no lo tienen y, sin esto, en descendente
    // Postgres los pondría de primeros y la tabla abriría con una columna de "—".
    // El barrio NO está en la lista blanca a propósito: en la tabla es el id del
    // catálogo, así que ordenar por él no daría el alfabético que uno espera.
    legacyId: (dir: 'asc' | 'desc') => ({ legacyId: { sort: dir, nulls: 'last' } }),
  };

  /** Nombres de barrio por id legacy, para un lote de suscriptores (una sola consulta). */
  private async nombresDeBarrio(refs: (string | null | undefined)[]) {
    const ids = [...new Set(refs.map(legacyRef).filter((n): n is number => n != null))];
    if (!ids.length) return new Map<number, string>();
    const filas = await this.prisma.neighborhood.findMany({
      where: { legacyId: { in: ids } },
      select: { legacyId: true, name: true },
    });
    return new Map(filas.flatMap((b) => (b.legacyId == null ? [] : [[b.legacyId, b.name] as const])));
  }

  /** Nombres de ciudad por id legacy. Igual que `nombresDeBarrio`: el catálogo son
   *  38 municipios de Casanare, así que resolverlo por página no cuesta nada. */
  private async nombresDeCiudad(refs: (string | null | undefined)[]) {
    const ids = [...new Set(refs.map(legacyRef).filter((n): n is number => n != null))];
    if (!ids.length) return new Map<number, string>();
    const filas = await this.prisma.city.findMany({
      where: { legacyId: { in: ids } },
      select: { legacyId: true, name: true },
    });
    return new Map(filas.flatMap((c) => (c.legacyId == null ? [] : [[c.legacyId, c.name] as const])));
  }

  /** Listado paginado con búsqueda y filtros. */
  async list(params: ListFilter, user?: AuthUser) {
    // Con plan cada fila cuesta más (servicios + respaldo de plan), así que ahí el
    // tope es más bajo. Sin plan se permite pedir la sede entera de un golpe: el
    // "Todos" del listado de grupos existe para eso (la mayor tiene ~9.700).
    const withPlan = params.withPlan === '1' || params.withPlan === 'true';
    const { page, pageSize } = paginacion(params, { maxPageSize: withPlan ? 500 : 20000 });

    const where = await this.computeWhere(params, user);

    const [rows, total] = await Promise.all([
      this.prisma.subscriber.findMany({
        where,
        orderBy: orden(params, SubscribersService.ORDEN_LISTA, { abonado: 'asc' }),
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          branch: { select: { name: true } },
          ...(withPlan ? { services: { select: { kind: true, planName: true, price: true, status: true, qty: true } } } : {}),
        },
      }),
      this.prisma.subscriber.count({ where }),
    ]);

    // A quien no se le copió el plan como servicio se le busca por las otras vías
    // (ver `serviciosDeRespaldo`): la lista tiene que decir qué tiene contratado.
    // Los PUNTOS son un accesorio del servicio, no un servicio: quien SOLO tiene
    // esa fila sigue necesitando el respaldo para saber qué plan tiene contratado.
    const conPlan = (r: any) => (r.services ?? []).filter((x: any) => x.kind !== 'PUNTOS');
    // Se consulta a quien le falta ALGUNO de los dos, no sólo a quien no tiene nada
    // (ver `conRespaldo`): un abonado con internet registrado y la televisión sin
    // fila salía en la lista como si no tuviera televisión.
    const leFalta = (r: any) => {
      const k = new Set(conPlan(r).map((x: any) => x.kind));
      return !k.has('INTERNET') || !k.has('TV');
    };
    const respaldo = withPlan
      ? await this.serviciosDeRespaldo(rows.filter(leFalta).map((r: any) => ({ id: r.id, pppProfile: r.pppProfile })))
      : new Map();

    // Resuelve el plan de Internet y de TV para la lista.
    const planOf = (s: any, kind: 'INTERNET' | 'TV') => {
      const svc = conPlan(s).find((x: any) => x.kind === kind)
        ?? (respaldo.get(s.id) ?? []).find((x: any) => x.kind === kind);
      return svc ? { plan: svc.planName ?? null, price: svc.price == null ? null : num(svc.price) } : null;
    };

    // Deuda real por cliente = Σ(total − pagado) de facturas sin pagar (NO el saldo a favor,
    // que es lo que guarda `subscriber.balance`). Se calcula siempre: la columna "Debe" de
    // los listados es la cifra que de verdad se mira, y son solo los ids de la página.
    const debtById = new Map<string, number>();
    if (rows.length) {
      const grouped = await this.prisma.subInvoice.groupBy({
        by: ['subscriberId'],
        where: { subscriberId: { in: rows.map((r) => r.id) }, status: { in: UNPAID_STATUSES } },
        _sum: { total: true, paidAmount: true },
      });
      for (const g of grouped) debtById.set(g.subscriberId, Math.max(0, num(g._sum.total) - num(g._sum.paidAmount)));
    }

    // El barrio y la ciudad se guardan como id del catálogo legacy: se resuelven a
    // nombre de una sola consulta para TODA la página (los catálogos son ~500 y 38
    // filas, así que ni con las páginas grandes del listado de grupos se paga de más).
    const [barrios, ciudades] = await Promise.all([
      this.nombresDeBarrio(rows.map((r: any) => r.neighborhood)),
      this.nombresDeCiudad(rows.map((r: any) => r.cityRef)),
    ]);

    return {
      items: rows.map((s) => ({
        id: s.id,
        legacyId: s.legacyId,
        abonado: s.abonado,
        name: displayName(s),
        docType: s.docType,
        docNumber: s.docNumber,
        phone: s.phone1,
        email: s.email,
        status: s.status,
        branch: s.branch?.name ?? null,
        neighborhood: barrios.get(legacyRef(s.neighborhood) ?? -1) ?? null,
        city: ciudades.get(legacyRef(s.cityRef) ?? -1) ?? null,
        // La dirección se ARMA de sus piezas (ver `direccionDe`): el campo
        // `addressLine` está vacío en 21.656 de 21.867 abonados y lo poco que
        // trae es basura de captura.
        address: direccionDe(s.nomenclature, s.addressLine),
        addressRef: referenciaDe(s.nomenclature),
        balance: num(s.balance),
        debt: debtById.get(s.id) ?? 0,
        installTech: s.installTech,
        // Datos de conexión: ya venían en la fila (el findMany usa `include`, no
        // `select`), solo no se exponían. Los pide el Excel de operaciones masivas,
        // que es con lo que se va a cortar en el router. La clave PPP NO sale.
        pppUsername: s.pppUsername,
        pppProfile: s.pppProfile,
        ipRemote: s.ipRemote,
        ...(withPlan ? { internet: planOf(s, 'INTERNET'), tv: planOf(s, 'TV') } : {}),
      })),
      total,
      page,
      pageSize,
      pages: Math.ceil(total / pageSize),
    };
  }

  /**
   * Filas para el export a Excel: el MISMO listado con los MISMOS filtros, pero
   * sin paginar. Se recorre por tandas de 1.000 con un tope sano de 25.000 filas
   * (la sede más grande no llega a 10.000) para no armar respuestas infinitas.
   */
  async exportRows(params: ListFilter, user?: AuthUser) {
    const tanda = 1000;
    const primera = await this.list({ ...params, withPlan: '0', page: 1, pageSize: tanda }, user);
    const filas = [...primera.items];
    for (let p = 2; p <= Math.min(primera.pages, 25); p++) {
      filas.push(...(await this.list({ ...params, withPlan: '0', page: p, pageSize: tanda }, user)).items);
    }
    return filas;
  }

  /**
   * Lo que el cliente PAGARÍA hoy por su cartera, con la promoción vigente puesta.
   *
   * La ficha decía 106.650 mientras la ventanilla cobraba 68.325: el descuento se
   * concede al cobrar (ver `promotions/descuento-al-cobrar.ts`) y hasta ahora sólo se
   * veía al abrir el modal de recaudo. Quien mira la ficha —o el cliente que llama a
   * preguntar cuánto debe— se llevaba la cifra sin rebajar.
   *
   * Se calcula con la MISMA función que la ventanilla, para que no haya dos cuentas
   * del mismo dinero. Es una promesa, no un hecho: el descuento sólo se concede a la
   * factura que el pago salda entera, así que supone que hoy lo paga todo. `receivable`
   * sigue siendo la deuda real, que es lo que la contabilidad tiene que ver.
   */
  private async descuentoDeCartera(
    id: string,
    pendientes: { id: string; tid: number; kind: string; invoiceDate: Date; subtotal: Prisma.Decimal; total: Prisma.Decimal; paidAmount: Prisma.Decimal; discount: Prisma.Decimal }[],
  ) {
    const vacio = { promoDiscount: 0, promoName: null as string | null, receivableWithDiscount: null as number | null };
    if (!pendientes.length) return vacio;

    const promos = await descuentosDePromocionPendientes(this.prisma, id, pendientes, hoyEnColombia());
    if (!promos.size) return vacio;

    const promoDiscount = round2([...promos.values()].reduce((a, b) => a + b.amount, 0));
    if (!(promoDiscount > 0)) return vacio;

    // La misma deuda que enseña la ficha (saldo por factura, sin restar sobrepagos
    // ajenos), para que «paga X hoy» no salga de una base distinta.
    const deuda = deudaPendiente(pendientes);
    // Con varias promociones a la vez se nombra la que más pesa: la ficha tiene una
    // línea, no una tabla, y el detalle factura a factura ya está en el recaudo.
    const nombres = [...promos.values()].sort((a, b) => b.amount - a.amount).map((p) => p.promotionName);
    return {
      promoDiscount,
      promoName: nombres[0] ?? null,
      receivableWithDiscount: round2(deuda - promoDiscount),
    };
  }

  /**
   * El técnico de campo sólo entra a la ficha de un cliente de SUS órdenes
   * (2026-09-10). Lanza 403 si no lo es; para todos los demás no hace nada.
   *
   * Vive aquí —y no en el controlador— porque es donde está `prisma`, y lo llama el
   * controlador en cada endpoint de `/:id` que el área `tecnicos` puede alcanzar. La
   * regla en sí está en `common/tecnico-scope.ts`, con el resto de "lo suyo".
   */
  async exigirSuCliente(user: AuthUser | undefined, subscriberId: string) {
    if (!esTecnicoDeCampo(user)) return;
    if (await esClienteDeSuOrden(this.prisma, user!, subscriberId)) return;
    throw new ForbiddenException(
      'Este cliente no corresponde a ninguna de tus órdenes: desde tu perfil sólo llegas a los clientes de las visitas que tienes asignadas.',
    );
  }

  /**
   * ¿Este técnico llega a este cliente DE PASO? (2026-09-12)
   *
   * Es el mismo corte de `exigirSuCliente` pero sin lanzar: `true` cuando es un
   * técnico de campo y el cliente no es de ninguna de sus órdenes. El controlador
   * lo usa para servirle la FICHA REDUCIDA en vez de un 403 — ver `fichaReducida`.
   */
  async fichaLimitada(user: AuthUser | undefined, subscriberId: string): Promise<boolean> {
    if (!esTecnicoDeCampo(user)) return false;
    return !(await esClienteDeSuOrden(this.prisma, user!, subscriberId));
  }

  /**
   * Ficha REDUCIDA: lo justo para fotografiar la vivienda de un cliente que no es
   * de sus órdenes (2026-09-12, a pedido del usuario: «todos los clientes tengan la
   * opción de tomar foto a la vivienda»).
   *
   * El cierre del 2026-09-10 dejó al técnico sólo con los clientes de sus visitas, y
   * con él se fue la foto de la casa: de 21.906 abonados, un técnico alcanza entre
   * 1.900 y 6.400 —el resto son cortes y reconexiones remotas que no se asignan a
   * nadie—, así que en la mayoría de las puertas la ficha respondía 403 y la pantalla
   * decía "Cliente no encontrado". Aquí se abre esa puerta y NADA MÁS: nombre, código
   * de abonado, dirección y sede, que es lo que hay que mirar para saber que se está
   * fotografiando la casa correcta. Fuera quedan teléfono, correo, documento, deuda,
   * facturas, equipos, red, historial y notas — lo que se cerró sigue cerrado.
   *
   * La sede se comprueba igual que en la ficha completa: de paso o no, nadie mira un
   * abonado de una sede que no es suya.
   */
  async fichaReducida(id: string, user?: AuthUser) {
    await exigirSedeSuscriptor(this.prisma, user, id);
    const s = await this.prisma.subscriber.findUnique({
      where: { id },
      select: {
        id: true, legacyId: true, abonado: true, firstName: true, secondName: true, lastName1: true, lastName2: true,
        companyName: true, fullName: true, addressLine: true, nomenclature: true, neighborhood: true,
        cityRef: true, gpsLat: true, gpsLng: true, branch: { select: { name: true } },
      },
    });
    if (!s) throw new NotFoundException('Suscriptor no encontrado');

    // Ciudad y barrio se guardan como id del legacy: enseñar "172" de barrio no le
    // dice nada a quien está buscando la casa (mismo resuelto que en `detail`).
    const [ciudad, barrio] = await Promise.all([
      legacyRef(s.cityRef) == null ? null
        : this.prisma.city.findUnique({ where: { legacyId: legacyRef(s.cityRef)! }, select: { name: true } }),
      legacyRef(s.neighborhood) == null ? null
        : this.prisma.neighborhood.findUnique({ where: { legacyId: legacyRef(s.neighborhood)! }, select: { name: true } }),
    ]);

    return {
      id: s.id,
      // El ID del legacy lo ve todo el mundo (2026-09-14): es el número por el que
      // se pregunta al otro sistema, no un dato sensible.
      legacyId: s.legacyId,
      abonado: s.abonado,
      name: displayName(s),
      companyName: s.companyName,
      address: direccionDe(s.nomenclature, s.addressLine),
      addressRef: referenciaDe(s.nomenclature),
      neighborhood: barrio?.name ?? null,
      city: ciudad?.name ?? null,
      branch: s.branch?.name ?? null,
      gps: s.gpsLat && s.gpsLng ? { lat: s.gpsLat, lng: s.gpsLng } : null,
      /** La bandera que hace que la pantalla se pinte reducida (y no a medio pintar). */
      limitado: true as const,
    };
  }

  /** Ficha completa de un suscriptor. */
  async detail(id: string, user?: AuthUser) {
    await exigirSedeSuscriptor(this.prisma, user, id);
    const s = await this.prisma.subscriber.findUnique({
      where: { id },
      include: {
        branch: { select: { name: true } },
        services: true,
        // 40 y no 20: el sync duplica cada cambio hecho aquí (ver `sinEcosDelSync`),
        // así que se piden de más y la lista se recorta a 20 CAMBIOS de verdad.
        statusHistory: { orderBy: { date: 'desc' }, take: 40 },
        // El orden lo pone `ORDEN_CRONOLOGICO`, no `created` a secas: es una fecha
        // sin hora y sin desempate las del mismo día salían barajadas (ver allí).
        //
        // El tope pasó de 30 a 200 porque 3.481 clientes tienen más de 30 órdenes y
        // la ficha se las comía sin decirlo —el contador de la pestaña decía "30"
        // aunque hubiera 45—. 200 cubre al que más tiene hoy (191); si algún día se
        // pasa, `workOrdersTotal` deja que la pantalla lo diga en vez de mentir.
        tickets: {
          orderBy: ORDEN_CRONOLOGICO,
          take: 200,
          select: {
            id: true, code: true, type: true, subject: true, status: true,
            created: true, finalDate: true, assigned: true, problem: true,
            createdAt: true, createdBySource: true, createdByName: true, resolvedAt: true,
            // A cuántas megas pasa la orden al cliente. Va en la lista y no solo en
            // la orden porque 'Subir megas' a secas no dice a cuánto: había que
            // abrir la orden una por una para saberlo.
            planToName: true, planToMegas: true, planFromMegas: true,
          },
        },
        invoices: {
          orderBy: { invoiceDate: 'desc' },
          take: 12,
          select: INVOICE_SELECT,
        },
        equipment: {
          orderBy: { arrival: 'desc' },
          select: {
            id: true, code: true, brand: true, serial: true, mac: true,
            installType: true, port: true, vlan: true, nat: true, status: true, observation: true, arrival: true, endDate: true,
            warehouse: { select: { id: true, name: true } },
          },
        },
        notes: { orderBy: { createdAt: 'desc' } },
        // Instalación en espera del pago de la afiliación: mientras exista, este
        // cliente NO tiene orden de instalación y nadie va a ir. Es lo primero que
        // pregunta quien abre la ficha de un INSTALAR que "lleva días esperando".
        pendingInstalls: {
          where: { fulfilledAt: null },
          take: 1,
          orderBy: { createdAt: 'desc' },
          select: {
            id: true, createdAt: true, lastError: true,
            invoice: { select: { id: true, tid: true, total: true, paidAmount: true, status: true } },
          },
        },
      },
    });
    if (!s) throw new NotFoundException('Suscriptor no encontrado');

    const [pendientes, estadoServicios, anticipo, totalOrdenes] = await Promise.all([
      // Las facturas pendientes, una por una: la cartera dice lo que DEBE y con esto se
      // calcula lo que PAGARÍA hoy si hay promoción vigente que lo alcance. Sin este
      // segundo número, la ficha decía 106.650 mientras la ventanilla cobraba 68.325.
      this.prisma.subInvoice.findMany({
        where: { subscriberId: id, status: { in: ['DUE', 'PARTIAL'] } },
        orderBy: [{ invoiceDate: 'asc' }, { tid: 'asc' }],
        select: {
          id: true, tid: true, kind: true, invoiceDate: true,
          subtotal: true, total: true, paidAmount: true, discount: true,
        },
      }),
      this.estadoPorServicio([id]),
      // Lo que pagó por adelantado y todavía no se ha imputado a ninguna factura.
      saldoAFavor(this.prisma, id),
      // Las órdenes van topadas arriba: el total se cuenta aparte para que la
      // pestaña diga cuántas tiene y no cuántas cupieron.
      this.prisma.ticket.count({ where: { subscriberId: id } }),
    ]);

    // La CARTERA de la ficha: factura por factura y sólo lo que falta de cada una.
    // Antes era `suma(total) − suma(pagado)` sobre las pendientes, y así el sobrepago
    // de una factura vieja tapaba la deuda nueva: el abonado 15 (MARIA DAZA) pagó
    // 120.000 en ago-2024 contra una factura de 30.000 —el legacy los cargó enteros y
    // no emitió los meses siguientes—, de modo que la ficha decía CARTERA $0 mientras
    // la ventanilla, el portal y el estado de cuenta le cobraban las tres facturas de
    // 2026 que sí debe. Por lo mismo, la que quedó sobrepagada no cuenta como
    // pendiente: no hay nada que cobrarle. Ver `common/money.ts`.
    const receivable = deudaPendiente(pendientes);
    const dueInvoices = pendientes.filter((i) => saldoPendiente(i) > 0).length;

    // LO QUE HAY QUE LLEVARLE (2026-09-04, a pedido del usuario): si tiene abierta una
    // instalación, un cambio de equipo, una migración o un "agregar internet", esa
    // visita sale con una caja del estante, y el sistema ya la apartó a su nombre al
    // abrir la orden (`EquipoReservaService`). Hasta hoy eso solo se veía abriendo la
    // orden; quien atiende al cliente en la ventanilla —que es quien entrega el
    // equipo— no tenía por dónde enterarse.
    //
    // Se preguntan sus órdenes ABIERTAS aparte y no se filtran las 200 de arriba: esa
    // lista va topada y ordenada por fecha, y un abonado con 191 órdenes podría dejar
    // fuera justo la que trae trabajo pendiente.
    const abiertas = await this.prisma.ticket.findMany({
      where: { subscriberId: id, status: { in: ['PENDIENTE', 'REALIZANDO'] } },
      select: { id: true, code: true, type: true, status: true, scheduledFor: true },
      orderBy: ORDEN_CRONOLOGICO,
    });
    const conEquipo = await equiposDeOrdenes(this.prisma, abiertas.map((t) => ({ ...t, subscriberId: id })));

    // Descuento de la promoción vigente sobre su cartera: el mismo cálculo que hace
    // el modal de recaudo, para que la ficha y la ventanilla no digan cifras
    // distintas del mismo cliente.
    const descuentoCartera = await this.descuentoDeCartera(id, pendientes);

    // Ciudad y barrio se guardan como ID legacy (ver `cityRef`/`neighborhood` en el
    // esquema), así que la ficha los resuelve a nombre: mostrar "172" como barrio no
    // le dice nada a quien atiende. Los ids que ya no existen en el catálogo caen a
    // null, no al número.
    const [ciudad, barrio] = await Promise.all([
      legacyRef(s.cityRef) == null ? null
        : this.prisma.city.findUnique({ where: { legacyId: legacyRef(s.cityRef)! }, select: { name: true } }),
      legacyRef(s.neighborhood) == null ? null
        : this.prisma.neighborhood.findUnique({ where: { legacyId: legacyRef(s.neighborhood)! }, select: { name: true } }),
    ]);

    // El historial, ya sin los ecos que mete el sync y con la nota partida en quién
    // y por qué: la pestaña de historial y el rótulo del estado leen de aquí.
    const historialEstados = sinEcosDelSync(s.statusHistory)
      .slice(0, 20)
      .map((h) => ({
        status: h.status,
        date: h.date,
        ticket: h.originTicketId,
        note: h.note,
        ...partirNotaDeEstado(h.note),
      }));
    // El motivo del estado ACTUAL: sólo si la ÚLTIMA entrada del historial es
    // justamente el estado en el que está hoy. Buscar hacia atrás la última vez que
    // estuvo así sería mentir: el legacy mueve estados sin historiarlos (12% de
    // desfase, ver `historial-estados-no-fiable`) y le colgaría al ACTIVO de hoy el
    // motivo de un ACTIVO de hace tres meses. Si no coinciden, no se sabe por qué
    // está así, y eso se dice callando.
    const ultimoCambio = historialEstados[0]?.status === s.status ? historialEstados[0] : null;
    const motivoDelEstadoActual = ultimoCambio?.reason
      ? { reason: ultimoCambio.reason, author: ultimoCambio.author, date: ultimoCambio.date }
      : null;

    // La caja NAP y el número de puerto de cada equipo, con nombre y no con los ids
    // del legacy: `equipos.nat` es `Nap.legacyId` y `equipos.puerto` es `Port.legacyId`
    // (ver `resolverPuertos` en support-write). La pestaña Equipos enseñaba "Caja Nat
    // 241 · Puerto Nat 2393", que no es ni la caja ni el puerto que hay rotulados.
    const napsDe = [...new Set(s.equipment.map((e) => e.nat).filter((v): v is number => !!v))];
    const puertosDe = [...new Set(s.equipment.map((e) => e.port).filter((v): v is number => !!v))];
    const [napsEq, puertosEq] = await Promise.all([
      napsDe.length
        ? this.prisma.nap.findMany({ where: { legacyId: { in: napsDe } }, select: { id: true, legacyId: true, name: true } })
        : [],
      puertosDe.length
        ? this.prisma.port.findMany({ where: { legacyId: { in: puertosDe } }, select: { id: true, legacyId: true, port: true, napLegacy: true } })
        : [],
    ]);

    return {
      id: s.id,
      legacyId: s.legacyId,
      abonado: s.abonado,
      suscripcion: s.suscripcion,
      name: displayName(s),
      companyName: s.companyName,
      docType: s.docType,
      docNumber: s.docNumber,
      email: s.email,
      phone1: s.phone1,
      phone2: s.phone2,
      birthDate: s.birthDate,
      contractDate: s.contractDate,
      entryDate: s.entryDate,
      estrato: s.estrato,
      branch: s.branch?.name ?? null,
      // `addressLine` sigue viajando porque es lo que edita el formulario, pero
      // lo que se ENSEÑA es `address`: la dirección armada de sus piezas.
      addressLine: s.addressLine,
      address: direccionDe(s.nomenclature, s.addressLine),
      addressRef: referenciaDe(s.nomenclature),
      nomenclature: s.nomenclature,
      neighborhood: barrio?.name ?? null,
      neighborhoodRef: s.neighborhood,
      city: ciudad?.name ?? null,
      gps: s.gpsLat && s.gpsLng ? { lat: s.gpsLat, lng: s.gpsLng } : null,
      status: s.status,
      previousStatus: s.previousStatus,
      statusChangedAt: s.statusChangedAt,
      // Red
      network: {
        pppUsername: s.pppUsername,
        // La clave PPPoE va en claro, como el usuario: es lo que hay que dictarle al
        // cliente o teclear en el equipo cuando se reinstala, y la ficha ya está
        // detrás de `exigirSedeSuscriptor` (nadie ve un cliente de otra sede). El
        // wizard de edición ya la devolvía así en `editForm`; esto sólo la enseña
        // donde se consulta.
        pppPassword: s.pppPassword,
        pppProfile: s.pppProfile,
        ipLocal: s.ipLocal,
        ipRemote: s.ipRemote,
        macEquipo: s.macEquipo,
        macOnt: s.macOnt,
        installTech: s.installTech,
        // El comentario del secret tal como lo escribió el legacy, con la VLAN
        // sacada aparte: es el único sitio donde consta por qué VLAN navega el
        // cliente (ver common/net-comment.ts).
        comment: s.netComment,
        vlan: vlanDeComentario(s.netComment),
      },
      // Dinero
      balance: num(s.balance),
      /** Pagado por adelantado: se aplica solo a la próxima factura (ver anticipos.ts). */
      advance: anticipo,
      debit: num(s.debitCache),
      credit: num(s.creditCache),
      receivable,
      dueInvoices,
      // Lo que pagaría HOY con la promoción vigente puesta. Es una promesa, no un
      // hecho —el descuento se concede al cobrar y sólo a la factura que el pago
      // salda entera—, así que va aparte de `receivable`, que sigue siendo la deuda
      // real. Ver `promotions/descuento-al-cobrar.ts`.
      ...descuentoCartera,
      // Facturación electrónica
      eInvoice: {
        enabled: s.eInvoice, tv: s.eInvoiceTv, internet: s.eInvoiceInternet, puntos: s.eInvoicePuntos,
      },
      // Tres fuentes, de la mejor a la última: el servicio registrado, lo que dice
      // su última factura y el perfil con el que navega. Lo que enseñe el legacy
      // sale de alguna de ellas. El ESTADO de cada línea (al aire / cortado) se
      // superpone aparte, porque no viene de la misma fuente que el plan.
      services: this.conEstadoDeServicio([
        ...(await this.conRespaldo(
          s.services.filter((sv) => sv.kind !== 'PUNTOS')
            .map((sv) => ({ kind: sv.kind as string, planName: sv.planName, status: sv.status as string | null, price: num(sv.price), qty: sv.qty, source: 'plan' })),
          { id: s.id, pppProfile: s.pppProfile },
        )),
        // Los puntos van al final y siempre: no son un plan y no compiten con él,
        // pero sí son parte de lo que el cliente tiene contratado.
        ...s.services.filter((sv) => sv.kind === 'PUNTOS')
          .map((sv) => ({ kind: sv.kind as string, planName: sv.planName, status: sv.status as string | null, price: num(sv.price), qty: sv.qty, source: 'plan' })),
      ], estadoServicios.get(s.id)),
      statusHistory: historialEstados,
      // POR QUÉ está el cliente en el estado en que está. Vive en el historial desde
      // siempre, pero ahí lo ve quien abre esa pestaña: la ficha lo enseña junto al
      // estado porque es lo primero que se pregunta al ver un EXONERADO o un CARTERA.
      statusReason: motivoDelEstadoActual,
      // `createdAt`/`resolvedAt` sólo viajan cuando son una hora de verdad (ver
      // `tieneHoraReal`): en las órdenes heredadas del legacy ese campo es la pasada
      // del sync que las importó, y pintarlo sería inventarle al usuario una hora
      // que nadie registró.
      workOrders: s.tickets.map((t) => ({
        id: t.id, code: t.code, type: t.type, subject: t.subject, status: t.status,
        created: t.created, finalDate: t.finalDate, assigned: t.assigned, problem: t.problem,
        createdAt: tieneHoraReal(t.createdBySource) ? t.createdAt : null,
        resolvedAt: t.resolvedAt,
        generadaPor: t.createdByName ?? null,
        // `null` en todo lo que no sea una orden de megas — y en las de megas que
        // nacieron sin decirlas (las del legacy y las que abre el chatbot).
        megas: t.planToName || t.planToMegas != null
          ? { plan: t.planToName, a: t.planToMegas, de: t.planFromMegas }
          : null,
      })),
      /** Cuántas tiene en total: `workOrders` va topado (ver el `take` de arriba). */
      workOrdersTotal: totalOrdenes,
      /**
       * Las órdenes abiertas que se atienden CON EQUIPO EN LA MANO, con la unidad que
       * ya está apartada a nombre de este cliente. `equipo` en null dentro de una de
       * ellas no es "no hace falta": es "hace falta y no hay ninguna apartada" (la
       * orden nació en el legacy, o la bodega de la sede se quedó sin unidades), que
       * es justo el caso en el que alguien tiene que ir por ella.
       *
       * Lista vacía = no hay nada que llevarle, que es lo normal.
       */
      equiposPorLlevar: abiertas.flatMap((t) => {
        const c = conEquipo.get(t.id);
        return c ? [{ ticketId: t.id, code: t.code, type: t.type, agendadaPara: t.scheduledFor, equipo: c.equipo }] : [];
      }),
      invoices: s.invoices.map(mapInvoice),
      equipment: s.equipment.map((e) => {
        const caja = e.nat ? napsEq.find((n) => n.legacyId === e.nat) ?? null : null;
        // Sólo vale si el puerto es DE esa caja: hay 353 equipos importados cuyo
        // `puerto` no casa con ningún `idp` de su NAP, y pintar el número de un
        // puerto de otra caja es peor que no pintar nada.
        const puerto = e.port ? puertosEq.find((p) => p.legacyId === e.port && (!e.nat || p.napLegacy === e.nat)) ?? null : null;
        return {
          id: e.id, code: e.code, brand: e.brand, serial: e.serial, mac: e.mac,
          installType: e.installType, port: e.port, vlan: e.vlan, nat: e.nat, status: e.status,
          observation: e.observation, arrival: e.arrival,
          /** Cuándo se le entregó (la asignación escribe `endDate`); `arrival` es la llegada a bodega. */
          assignedAt: e.endDate,
          warehouse: e.warehouse?.name ?? null, warehouseId: e.warehouse?.id ?? null,
          /** Cómo se llama la caja y qué puerto suyo es, para leerlo sin traducir ids. */
          napId: caja?.id ?? null, napName: caja?.name ?? null, portNumber: puerto?.port ?? null,
          /** Id de aquí del puerto: con él la pestaña abre el editor con la caja ya puesta. */
          portId: puerto?.id ?? null,
        };
      }),
      // `kind` es el tipo de observación que traía el legacy (Compromiso, Traslado,
      // Devolucion Equipo…): sin él, 28.000 observaciones importadas quedan como texto
      // suelto sin decir de qué hablan. Null en las notas escritas aquí.
      // `legacy` marca las observaciones importadas del sistema anterior: allá la fecha
      // se guarda sin hora, así que la ficha muestra sólo el día en vez de un "0:00"
      // que no significa nada.
      notes: s.notes.map((n) => ({
        id: n.id, kind: n.kind, body: n.body, author: n.authorName,
        createdAt: n.createdAt, legacy: n.legacyId != null,
      })),
      // La instalación que espera pago. `null` = no hay nada esperando (ni el cliente
      // es nuevo, ni ya se le abrió la orden).
      instalacionPendiente: s.pendingInstalls[0]
        ? {
            desde: s.pendingInstalls[0].createdAt,
            invoiceId: s.pendingInstalls[0].invoice.id,
            tid: s.pendingInstalls[0].invoice.tid,
            saldo: num(s.pendingInstalls[0].invoice.total) - num(s.pendingInstalls[0].invoice.paidAmount),
            // Una afiliación ANULADA no se va a pagar nunca: la espera se queda quieta
            // y hay que decirlo, o la ficha promete una orden que no va a llegar.
            estado: s.pendingInstalls[0].invoice.status,
            error: s.pendingInstalls[0].lastError,
          }
        : null,
    };
  }

  /**
   * Catálogo de sedes para filtros y formularios, acotado a las del usuario.
   *
   * Va con el usuario porque este catálogo es lo que rellena TODO selector de sede
   * de la aplicación (filtro de clientes, filtro de facturas, alta de cliente): si
   * devolviera las 8 sedes, la cajera acotada seguiría viendo las demás en la lista
   * aunque el dato de atrás ya venga filtrado.
   */
  async branches(user?: AuthUser) {
    const sedes = await sedesDe(this.prisma, user);
    return this.prisma.branch.findMany({
      where: sedes ? { legacyId: { in: sedes } } : undefined,
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });
  }

  /** WHERE compartido por la lista y por las operaciones masivas por filtro. */
  private buildListWhere(params: ListFilter): Prisma.SubscriberWhereInput {
    const where: Prisma.SubscriberWhereInput = {};
    const and: Prisma.SubscriberWhereInput[] = [];
    if (params.status) where.status = params.status as SubscriberStatus;
    if (params.branchId) where.branchId = params.branchId;

    // Servicio del cliente (según los servicios que tiene). Los tres valores son
    // excluyentes: "internet" y "tv" son solo-ese-servicio; quien tiene ambos
    // sale únicamente bajo "combo".
    if (params.servicio === 'internet') {
      and.push({ services: { some: { kind: 'INTERNET' } } });
      and.push({ services: { none: { kind: 'TV' } } });
    } else if (params.servicio === 'tv') {
      and.push({ services: { some: { kind: 'TV' } } });
      and.push({ services: { none: { kind: 'INTERNET' } } });
    } else if (params.servicio === 'combo') {
      and.push({ services: { some: { kind: 'INTERNET' } } });
      and.push({ services: { some: { kind: 'TV' } } });
    }

    // Un plan concreto del catálogo. Se mira el servicio contratado, que es de
    // donde sale el contador de abonados de /configuracion/planes: así el listado
    // devuelve exactamente los que ese número promete (ni más ni menos).
    if (params.planId) and.push({ services: { some: { planId: params.planId } } });

    // Tecnología: FTTH agrupa fibra; EOC aparte.
    if (params.tecnologia === 'FTTH') where.installTech = { in: ['GPON', 'EPON', 'FIBRA'] };
    else if (params.tecnologia === 'EOC') where.installTech = 'EOC';

    // Estado de la cuenta (deuda / al día / compromiso).
    if (params.cuenta === 'debe') and.push({ invoices: { some: { status: { in: UNPAID_STATUSES } } } });
    else if (params.cuenta === 'aldia') and.push({ invoices: { none: { status: { in: UNPAID_STATUSES } } } });
    else if (params.cuenta === 'compromiso') and.push({ status: 'COMPROMISO' });

    if (and.length) where.AND = and;
    const search = (params.search || '').trim();
    if (search) {
      /**
       * Un número CORTO (hasta 6 cifras) tecleado solo es casi siempre un código
       * de ABONADO, nunca un teléfono (celulares colombianos: 10 dígitos) ni una
       * cédula (6 a 10, casi siempre 7+). El abonado más alto que hay hoy son 5
       * cifras (57.520 de 21.882 clientes), así que 6 deja margen de sobra sin
       * dejar de excluir teléfonos y documentos reales.
       *
       * Por qué esto no era cosmético (2026-09-04, reportado por el usuario:
       * "aparece mucha info que no es"): buscar "6033" —el abonado de un cliente
       * real— hacía `docNumber CONTAINS '6033'` y `phone1 CONTAINS '6033'` contra
       * TODOS los demás. Un celular de 10 dígitos tiene 6033 en medio con más
       * frecuencia de la que parece, y el resultado se ordena por abonado
       * ascendente: los 6 primeros que devolvía el buscador (⌘K pide
       * `pageSize=6`) eran seis clientes SIN NINGUNA RELACIÓN, y el que se
       * buscaba —abonado 6033— quedaba fuera de la página entera.
       */
      const esAbonadoCorto = /^\d{1,6}$/.test(search);
      if (esAbonadoCorto) {
        where.abonado = Number(search);
        return where;
      }
      // Cada palabra debe calzar en algún campo (nombre partido en 4 columnas,
      // razón social, documento o teléfono) → permite buscar "María Daza".
      const tokens = search.split(/\s+/).filter(Boolean);
      const perToken = (tok: string): Prisma.SubscriberWhereInput => ({
        OR: [
          { firstName: { contains: tok, mode: 'insensitive' } },
          { secondName: { contains: tok, mode: 'insensitive' } },
          { lastName1: { contains: tok, mode: 'insensitive' } },
          { lastName2: { contains: tok, mode: 'insensitive' } },
          { companyName: { contains: tok, mode: 'insensitive' } },
          { docNumber: { contains: tok } },
          { phone1: { contains: tok } },
        ],
      });
      // `abonado` es un entero de 32 bits: un celular completo (3113886033) lo
      // desborda y Postgres RECHAZA la consulta entera —un 500, no "sin
      // resultados"—, encontrado al probar este mismo arreglo (2026-09-04). Mismo
      // guardia que ya usa `support.service.ts::enteroBuscable`.
      const n = enteroBuscable(search);
      where.OR = [
        { AND: tokens.map(perToken) },
        ...(n != null ? [{ abonado: n }] : []),
      ];
    }
    return where;
  }

  /**
   * IDs de abonados según deuda.
   *
   * Hay tres formas de preguntarlo y NO son la misma:
   *
   *  · '1' / 'gt2' cuentan FACTURAS sin pagar. Sirven para "cuántos papeles
   *    debe", pero mienten sobre la plata: una factura del legacy puede traer
   *    varios meses metidos en el total (ver [[factura-acumulada-legacy]]) y un
   *    abono parcial deja la factura sin pagar debiendo cuatro pesos.
   *
   *  · 'compromiso' es el caso concreto de "debe este mes + el pasado" (exactamente
   *    dos mensualidades, una de cada mes, cada una por el valor entero de su plan). Es la definición que usa la operación cuando dice
   *    "está en compromiso", y NO tiene que ver con `status = COMPROMISO`: de los
   *    65 de Yopal, 62 figuran ACTIVO y solo 8 llevan la marca de estado (que
   *    encima la llevan 75, de los cuales 67 solo deben el mes corriente).
   *
   *  · 'fija' compara PLATA: quién debe su mensualidad o más **ya vencida**. Es lo
   *    que hay que mirar para cortar, porque el corte se decide por lo que se debe
   *    y ya se pasó de plazo, no por cuántos documentos hay abiertos.
   */
  private async debtIds(deuda: string): Promise<string[]> {
    if (deuda === 'fija') {
      // La mensualidad sale del plan contratado; para quien no lo tiene cargado
      // (la mitad de los deudores: `SubscriberService` solo se pobló para
      // ACTIVO) se cae al total de su última factura recurrente, que es el
      // mismo respaldo que usa la corrida mensual. Quien no tiene ni lo uno ni
      // lo otro queda FUERA: sin saber cuánto es su fija, no hay con qué
      // comparar y cortar a ciegas no es una opción.
      //
      // SOLO CUENTA LA DEUDA YA VENCIDA (`dueDate < hoy`), y esto es la mitad del
      // filtro: la corrida del día 1 emite el mes corriente venciendo el 20 (ver
      // [[mes-que-factura-la-corrida]]), así que sin este corte el que está al día
      // "debe su mensualidad" desde el día 1 y sale en la lista de cortar. Pasó de
      // verdad en el legacy —que selecciona igual, solo por plata— el 2026-09-09:
      // de un lote de 17, nueve debían únicamente la factura de septiembre sin
      // vencer y hubo que reconectarlos a mano. Medido el 2026-09-10 sobre la base
      // viva: 6.883 abonados con la regla vieja → 3.297 con esta; de los 3.586 que
      // se salvan, 3.418 no tienen NI UNA factura vencida.
      // El borde va como texto 'YYYY-MM-DD'::date, regla de la casa para SQL crudo
      // (ver [[sql-crudo-fechas-date]]): atar un Date de JS corre el día.
      const hoy = hoyEnColombia().toISOString().slice(0, 10);
      const rows = await this.prisma.$queryRaw<{ subscriberId: string }[]>`
        WITH deuda AS (
          SELECT "subscriberId", sum(total - "paidAmount") AS debe
            FROM "SubInvoice"
           WHERE status IN ('DUE','PARTIAL') AND "dueDate" < ${hoy}::date
           GROUP BY 1
        ),
        mens AS (
          SELECT "subscriberId", sum(round(price * (1 + "taxRate"/100))) AS fija
            FROM "SubscriberService" WHERE price IS NOT NULL GROUP BY 1
        ),
        faltan AS (
          SELECT d."subscriberId" FROM deuda d
            LEFT JOIN mens m USING ("subscriberId") WHERE m.fija IS NULL
        ),
        ult AS (
          SELECT DISTINCT ON (i."subscriberId") i."subscriberId", i.total AS fija_ult
            FROM "SubInvoice" i JOIN faltan f ON f."subscriberId" = i."subscriberId"
           WHERE i.kind = 'RECURRENTE'
           ORDER BY i."subscriberId", i."invoiceDate" DESC, i.tid DESC
        )
        SELECT d."subscriberId" FROM deuda d
          LEFT JOIN mens m USING ("subscriberId")
          LEFT JOIN ult  u USING ("subscriberId")
         WHERE coalesce(m.fija, u.fija_ult) IS NOT NULL
           AND d.debe >= coalesce(m.fija, u.fija_ult)
      `;
      return rows.map((r) => r.subscriberId);
    }
    if (deuda === 'compromiso') {
      /**
       * COMPROMISO de verdad: debe la MENSUALIDAD de ESTE mes y la del mes PASADO,
       * las dos enteras, y nada más. Es la escalera de la cartera: 1 factura = al día del mes que
       * corre, 2 = compromiso, más de 2 = Cartera (ver [[paso-a-cartera-por-deuda]]).
       *
       * Las tres condiciones hacen falta, y cada una tapa un agujero medido:
       *
       *  · `count(*) = 2` sin más devuelve 275 en Yopal, pero 210 son deuda MUERTA
       *    de 2021-2023 (127 DEPURADO, 54 CARTERA, 1 RETIRADO) que no le interesa
       *    a nadie: dos facturas viejas no son un compromiso, son un cadáver.
       *
       *  · `>= primero del mes pasado` acota a la deuda VIVA → 70.
       *
       *  · `count(DISTINCT mes) = 2` exige que sea un mes cada una → 65. Los 5 que
       *    caen son clientes con DOS facturas del mes corriente (un cargo suelto
       *    junto a la mensualidad): deben dos papeles pero no deben el mes pasado,
       *    que es justo lo que define el compromiso.
       *
       *  · `sum(paidAmount) = 0` exige que las deba COMPLETAS → 33. Sin esto entra
       *    quien abonó y quedó debiendo una punta: el caso que lo destapó pagó
       *    $99.250 de una mensualidad de $110.000 y salía en la lista debiendo
       *    $10.750. Ése ya pagó su mes; cobrarle eso es otra conversación, no un
       *    corte. Con el filtro puesto, el saldo más bajo de la lista pasa de
       *    $10.750 a $60.000 —una mensualidad entera—, que es lo que se quiere ver.
       *
       *  · Sólo MENSUALIDADES (`kind = 'RECURRENTE'`), y cada una por el valor ENTERO
       *    de su plan (2026-09-11). Sin abonos todavía se colaba quien "debía dos" y
       *    una era el prorrateo del mes de la instalación —$161, $3.484, $18.158—,
       *    que la corrida emite como RECURRENTE: ése debe un mes y una punta, no dos
       *    meses. La vara es `mensualidadesCompletas`, lo que la corrida le facturaría
       *    hoy (su SubscriberService o, si no, el plan de sus facturas), y no el total
       *    de otra factura suya. Sin plan conocido queda fuera. Un cargo suelto (FIJA)
       *    ya no cuenta ni a favor ni en contra: no es un mes.
       *
       * Se mira la PLATA abonada y no `status`, porque los dos no concuerdan: hay 38
       * facturas en DUE con abonos encima y 9 en PARTIAL sin un peso. El estado viene
       * del legacy y miente; `paidAmount` es el dato.
       *
       * `date_trunc` sobre `invoiceDate` (el mes FACTURADO), no sobre `dueDate`: la
       * corrida del día 1 emite el mes corriente venciendo el 20 (ver
       * [[mes-que-factura-la-corrida]]), así que el vencimiento no dice qué mes es.
       *
       * El borde va como TEXTO `'YYYY-MM-DD'::date`, que es la regla de la casa para
       * SQL crudo (ver [[sql-crudo-fechas-date]]) y no una manía: atar un `Date` de JS
       * lo manda como `timestamptz` y Postgres sube la columna `date` a la zona de la
       * SESIÓN —que aquí corre en Europe/Berlin— antes de comparar, así que
       * `2026-08-01` pasa a valer `2026-07-31 22:00Z` y el `>=` se come el día del
       * borde. Medido en esta misma consulta: 25 clientes en vez de 381.
       */
      // Un peso de holgura: el legacy emitía al peso (77.000) y aquí la mensualidad con
      // la TV al 19 % da 77.000,11. Sin ella queda fuera quien debe su mes entero.
      const REDONDEO_LEGACY = 1;
      const hoy = hoyEnColombia();
      const mesActual = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), 1));
      const mesPasado = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() - 1, 1));
      const dia = (d: Date) => d.toISOString().slice(0, 10); // 'YYYY-MM-DD'
      const rows = await this.prisma.$queryRaw<{ subscriberId: string; menor: Prisma.Decimal }[]>`
        SELECT "subscriberId", min(total) AS menor FROM "SubInvoice"
         WHERE status IN ('DUE','PARTIAL') AND kind = 'RECURRENTE'
         GROUP BY "subscriberId"
        HAVING count(*) = 2
           AND min(date_trunc('month', "invoiceDate"))::date = ${dia(mesPasado)}::date
           AND max(date_trunc('month', "invoiceDate"))::date = ${dia(mesActual)}::date
           AND sum("paidAmount") = 0
      `;
      const plan = await mensualidadesCompletas(this.prisma, rows.map((r) => r.subscriberId), mesActual);
      return rows
        .filter((r) => {
          const mensualidad = plan.get(r.subscriberId);
          return mensualidad != null && num(r.menor) >= mensualidad - REDONDEO_LEGACY;
        })
        .map((r) => r.subscriberId);
    }
    const rows = deuda === 'gt2'
      ? await this.prisma.$queryRaw<{ subscriberId: string }[]>`SELECT "subscriberId" FROM "SubInvoice" WHERE status IN ('DUE','PARTIAL') GROUP BY "subscriberId" HAVING count(*) > 2`
      : await this.prisma.$queryRaw<{ subscriberId: string }[]>`SELECT "subscriberId" FROM "SubInvoice" WHERE status IN ('DUE','PARTIAL') GROUP BY "subscriberId" HAVING count(*) = 1`;
    return rows.map((r) => r.subscriberId);
  }

  /** WHERE final: base + filtro por nº de facturas (deuda) resuelto vía SQL. */
  private async computeWhere(params: ListFilter, user?: AuthUser): Promise<Prisma.SubscriberWhereInput> {
    const where = this.buildListWhere(params);
    // Acceso por sede. Va AQUÍ y no en cada método porque `computeWhere` es el embudo
    // único de `list`, `matchingIds` y, por tanto, de las operaciones masivas: filtrar
    // en un solo sitio evita que una masiva se salte el alcance que sí respeta el listado.
    const sede = whereSedeSuscriptor(await sedesDe(this.prisma, user));
    if (Object.keys(sede).length) Object.assign(where, sede);
    // Lista blanca: un valor que no esté aquí NO filtra, y el listado devolvería todos
    // los clientes como si el filtro no existiera —sin error y sin aviso—. Cada opción
    // nueva del select de Deuda tiene que sumarse a este juego.
    if (DEUDA_FILTROS.has(params.deuda ?? '')) {
      const ids = await this.debtIds(params.deuda!);
      const and = Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : [];
      and.push({ id: { in: ids } });
      where.AND = and;
    }
    return where;
  }

  /** Tope de seguridad para operaciones masivas por filtro (evita cortes catastróficos). */
  private static readonly MAX_BULK = 2000;

  /** IDs de todos los abonados que cumplen el filtro (sin paginar). */
  async matchingIds(filter: ListFilter, user?: AuthUser): Promise<string[]> {
    const rows = await this.prisma.subscriber.findMany({
      where: await this.computeWhere(filter, user),
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  private async resolveBulkIds(filter: ListFilter, user?: AuthUser): Promise<string[]> {
    // Con el usuario, para que una masiva NO pueda alcanzar sedes que el listado
    // no le deja ni ver. Sin esto, el filtro de sede sería puramente cosmético.
    const ids = await this.matchingIds(filter, user);
    if (ids.length === 0) throw new BadRequestException('No hay clientes que cumplan el filtro.');
    if (ids.length > SubscribersService.MAX_BULK) {
      throw new BadRequestException(`${ids.length} clientes exceden el máximo de ${SubscribersService.MAX_BULK} por operación. Afina el filtro (sede / estado).`);
    }
    return ids;
  }

  /** Corte masivo de TODOS los que cumplen el filtro (no depende de lo cargado en pantalla). */
  async cutByFilter(filter: ListFilter, user: AuthUser) {
    // El candado (compromiso vigente + nada vencido) lo pone `cutBatch`, que es por
    // donde pasan también los lotes de clientes elegidos a mano en la pantalla. Aquí
    // sólo se resuelve a quiénes alcanza el filtro. Ver `corte.policy.ts`.
    const ids = await this.resolveBulkIds(filter, user);
    return this.mikrotik.cutBatch(ids, user);
  }

  /** Reconexión masiva de TODOS los que cumplen el filtro. */
  async reconnectByFilter(filter: ListFilter, user: AuthUser) {
    const ids = await this.resolveBulkIds(filter, user);
    return this.mikrotik.reconnectBatch(ids, user);
  }

  /** Corte de TV masivo de TODOS los que cumplen el filtro (vía TR-069 u OLT por abonado). */
  async tvCutByFilter(filter: ListFilter, user: AuthUser) {
    // Mismo candado que el corte de internet, y por el mismo sitio: lo aplica el
    // lote (`candadoDeuda`), no este método, para que valga igual cuando los
    // clientes se eligen a mano en la pantalla.
    const ids = await this.resolveBulkIds(filter, user);
    return this.genieacs.tvBatchBySubscribers(ids, false, user, { candadoDeuda: true });
  }

  /** Alta de TV masiva de TODOS los que cumplen el filtro. */
  async tvRestoreByFilter(filter: ListFilter, user: AuthUser) {
    const ids = await this.resolveBulkIds(filter, user);
    return this.genieacs.tvBatchBySubscribers(ids, true, user);
  }

  /** WhatsApp masivo a TODOS los que cumplen el filtro. */
  async messageByFilter(filter: ListFilter, message: string, user?: AuthUser) {
    const ids = await this.resolveBulkIds(filter, user);
    return this.mikrotik.messageBatch(ids, message);
  }

  /** Sedes con conteo de abonados por estado (para el flujo sede-primero de cortes masivos). */
  async branchesStats(user?: AuthUser) {
    const sedes = await sedesDe(this.prisma, user);
    const [branches, grouped] = await Promise.all([
      this.prisma.branch.findMany({
        where: sedes ? { legacyId: { in: sedes } } : undefined,
        orderBy: { name: 'asc' },
        select: { id: true, name: true },
      }),
      this.prisma.subscriber.groupBy({
        by: ['branchId', 'status'],
        where: sedes ? { branch: { legacyId: { in: sedes } } } : undefined,
        _count: { _all: true },
      }),
    ]);
    const byBranch = new Map<string, Record<string, number>>();
    for (const g of grouped) {
      if (!g.branchId) continue;
      const bucket = byBranch.get(g.branchId) ?? {};
      bucket[g.status ?? 'SIN'] = (bucket[g.status ?? 'SIN'] ?? 0) + g._count._all;
      byBranch.set(g.branchId, bucket);
    }
    return branches.map((b) => {
      const byStatus = byBranch.get(b.id) ?? {};
      const total = Object.values(byStatus).reduce((s, n) => s + n, 0);
      return {
        id: b.id, name: b.name, total, byStatus,
        activos: byStatus['ACTIVO'] ?? 0,
        cortados: byStatus['CORTADO'] ?? 0,
        cartera: byStatus['CARTERA'] ?? 0,
      };
    });
  }

  /** Campos crudos editables (para precargar el wizard en modo edición). */
  async editForm(id: string, user?: AuthUser) {
    // Devuelve pppPassword en claro: sin este guard, un usuario acotado a la sede A
    // leía las credenciales PPPoE de un cliente de la sede B cambiando el id en la URL.
    await exigirSedeSuscriptor(this.prisma, user, id);
    const s = await this.prisma.subscriber.findUnique({
      where: { id },
      select: {
        id: true, abonado: true, firstName: true, secondName: true, lastName1: true, lastName2: true,
        companyName: true, customerType: true, docType: true, docNumber: true, email: true,
        phone1: true, phone2: true, birthDate: true, estrato: true, suscripcion: true, contractDate: true,
        departmentRef: true, cityRef: true, localityRef: true, neighborhood: true, addressLine: true,
        nomenclature: true, clausula: true, gpsLat: true, gpsLng: true, branchId: true,
        // Conectividad: sin esto el wizard mostraría los campos PPP vacíos al editar y
        // parecería que el cliente no los tiene.
        pppUsername: true, pppPassword: true, pppProfile: true, ipRemote: true, installTech: true,
        ipLocal: true, macEquipo: true, macOnt: true, netComment: true,
      },
    });
    if (!s) throw new NotFoundException('Suscriptor no encontrado');
    // La VLAN se sirve aparte, ya leída del comentario, para que el formulario la
    // enseñe en su propia casilla: dentro del texto nadie la corrige sin equivocarse.
    return { ...s, vlan: vlanDeComentario(s.netComment) };
  }

  /** Editar el perfil del cliente (pasos 1 y 2). Devuelve la ficha fresca. */
  async update(id: string, dto: UpdateSubscriberDto, user?: AuthUser) {
    await exigirSedeSuscriptor(this.prisma, user, id);
    // Y que no se lo lleve a una sede a la que no llega (ni lo deje sin sede).
    await exigirSedeDestino(this.prisma, user, dto.branchId);
    const s = await this.prisma.subscriber.findUnique({
      where: { id },
      select: {
        id: true, firstName: true, secondName: true, lastName1: true, lastName2: true,
        // Foto de la conexión ANTES de guardar: es con lo que se compara después para
        // saber qué hay que llevarle al Mikrotik (ver `aplicarEdicionDeFicha`).
        pppUsername: true, pppPassword: true, pppProfile: true,
        ipRemote: true, ipLocal: true, netComment: true,
      },
    });
    if (!s) throw new NotFoundException('Suscriptor no encontrado');

    // Mismo guard de colisión que en `create`: el usuario PPP también se puede cambiar
    // editando, y un duplicado rompe el secret en el router. Sólo se valida si el nombre
    // CAMBIA — si no, el chequeo contra el router encontraría su propio secret y bloquearía
    // cualquier edición del cliente.
    const newPpp = dto.pppUsername?.trim();
    if (newPpp && newPpp.toLowerCase() !== (s.pppUsername ?? '').trim().toLowerCase()) {
      const { db, router } = await this.pppUsernameTaken(newPpp, dto.branchId, dto.installTech, id);
      if (db) {
        throw new BadRequestException(
          `El nombre de usuario PPP "${newPpp}" ya lo usa el abonado ${db.abonado} (${db.fullName ?? 'sin nombre'}).`,
        );
      }
      if (router === 'taken') {
        throw new BadRequestException(
          `El nombre de usuario PPP "${newPpp}" ya existe como secret en el Mikrotik de la sede.`,
        );
      }
    }

    const data = buildProfileData(dto);

    // La VLAN no tiene columna: se escribe DENTRO del comentario de red, que es donde
    // el legacy la deja (ver common/net-comment.ts). Se aplica SOBRE el comentario que
    // vaya a quedar —el que manda el formulario si viene, el guardado si no—, para que
    // cambiar las dos cosas a la vez no se pise una a la otra.
    if (dto.vlan !== undefined) {
      const actual = dto.netComment !== undefined
        ? (dto.netComment || null)
        : (await this.prisma.subscriber.findUnique({ where: { id }, select: { netComment: true } }))?.netComment ?? null;
      data.netComment = conVlanEnComentario(actual, dto.vlan);
    }

    if (dto.branchId !== undefined) {
      data.branch = dto.branchId ? { connect: { id: dto.branchId } } : { disconnect: true };
    }
    // Recalcular fullName si cambió alguna parte del nombre.
    if (['firstName', 'secondName', 'lastName1', 'lastName2'].some((k) => (dto as any)[k] !== undefined)) {
      data.fullName = composeName(dto.firstName ?? s.firstName, dto.secondName ?? s.secondName, dto.lastName1 ?? s.lastName1, dto.lastName2 ?? s.lastName2);
    }

    // Sello de "editada aquí": a partir de este momento la sincronización deja de
    // pisarle el perfil con el del legacy y el writeback se lo lleva allá. Sin él, la
    // ida devolvía el dato viejo a los 15 minutos y la corrección parecía no haberse
    // guardado nunca. Ver `Subscriber.editedAt`.
    data.editedAt = new Date();
    await this.prisma.subscriber.update({ where: { id }, data });

    /**
     * Y lo que se acaba de corregir en «Plan y conexión», al ROUTER.
     *
     * Hasta ahora esto sólo se guardaba en la base: la ficha decía una IP remota o
     * un comentario y el `/ppp/secret` seguía con los de antes. Con la IP era doble
     * problema, porque el corte se hace metiendo ESA dirección en MOROSOS.
     *
     * Se compara contra lo que el ROUTER tiene, no contra lo que se acaba de teclear:
     * lo que se corrigió aquí antes de que esto existiera nunca llegó allá y en el
     * guardado siguiente no habría cambio que detectar (abonada 57458: IP local y
     * VLAN puestas en la ficha, secret sin `local-address` y con el comentario viejo).
     *
     * Las MAC quedan fuera a propósito (son inventario del equipo, el secret no
     * tiene dónde recibirlas) y un fallo del router NO tumba el guardado: la ficha
     * ya quedó bien y el resultado viaja en la respuesta para que la pantalla lo
     * cuente. Dry-run mientras MIKROTIK_LIVE esté apagado.
     */
    const tocaLaRed = ['pppUsername', 'pppPassword', 'pppProfile', 'ipRemote', 'ipLocal', 'netComment', 'vlan']
      .some((k) => (dto as any)[k] !== undefined);
    let router: MikrotikActionResult | null = null;
    if (tocaLaRed) {
      router = await this.mikrotik
        .aplicarEdicionDeFicha(id, {
          pppUsername: s.pppUsername, pppPassword: s.pppPassword, pppProfile: s.pppProfile,
          ipRemote: s.ipRemote, ipLocal: s.ipLocal, netComment: s.netComment,
        }, user)
        .catch((e) => ({
          ok: false, dryRun: true, action: 'EDIT' as const, subscriberId: id, steps: [],
          message: `Los datos quedaron guardados, pero no se llevaron al router: ${(e as Error).message}`,
          error: (e as Error).message,
        }));
    }

    const detalle = await this.detail(id);
    return router ? { ...detalle, router } : detalle;
  }

  /**
   * Cambio MANUAL de estado del abonado (Activo, Suspendido, Retirado, ...).
   * Es puramente administrativo: actualiza el cache de estado + historial, pero
   * NO toca el router — para cortar/reconectar de verdad está el modal de
   * Conexión (MikrotikService), que además marca CORTADO/ACTIVO por su cuenta.
   */
  async changeStatus(id: string, dto: ChangeStatusDto, user?: AuthUser) {
    await exigirSedeSuscriptor(this.prisma, user, id);
    const s = await this.prisma.subscriber.findUnique({
      where: { id }, select: { id: true, status: true },
    });
    if (!s) throw new NotFoundException('Suscriptor no encontrado');

    const next = dto.status as SubscriberStatus;
    if (s.status === next) throw new BadRequestException('El cliente ya está en ese estado.');

    // El historial no tiene columna de autor: el responsable va en la nota.
    const who = user?.name || user?.email || null;
    const extra = dto.note?.trim();
    const note = [`Cambio manual${who ? ` por ${who}` : ''}`, extra].filter(Boolean).join(': ');

    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.subscriber.update({
        where: { id },
        data: { previousStatus: s.status ?? undefined, status: next, statusChangedAt: now },
      }),
      this.prisma.subscriberStatusHistory.create({
        data: { subscriberId: id, status: next, date: now, note },
      }),
    ]);

    // Y el motivo también en las OBSERVACIONES, que es el pie de la ficha donde
    // quien atiende busca "qué pasó con este cliente". El historial ya lo guarda,
    // pero está en otra pestaña: un motivo que hay que ir a buscar es un motivo que
    // el de la ventanilla no lee. Misma decisión que en `cambiarEstadoDeServicio`.
    if (extra) {
      await this.prisma.subscriberNote
        .create({
          data: {
            subscriberId: id,
            body: `Estado: ${s.status ?? '—'} → ${next} (cambio manual) — ${extra}`,
            authorName: who,
          },
        })
        .catch(() => undefined);
    }

    return this.detail(id);
  }

  /**
   * Cambio MANUAL del estado de UN servicio: su internet o su televisión.
   *
   * Hacía falta porque el estado del ABONADO y el de cada SERVICIO no son lo mismo —se
   * puede tener la televisión suspendida y el internet navegando— y hasta ahora el
   * segundo sólo se movía cerrando una orden. Cuando esa orden no lo movía (o cuando el
   * corte lo hizo el legacy y aquí nadie se enteró) no había forma de arreglarlo:
   * la ficha seguía diciendo que la TV estaba al aire.
   *
   * DÓNDE se escribe: en la ÚLTIMA FACTURA RECURRENTE, que es de donde la ficha lee qué
   * está caído (`estadoPorServicio`), y de paso en el `SubscriberService` del mismo tipo
   * para los abonados que lo tienen poblado. Convención del legacy: NULL = al aire.
   *
   * Es ADMINISTRATIVO, igual que `changeStatus`: no corta ni enciende nada en los
   * equipos —para eso están el modal de Conexión (internet) y el cierre de la orden
   * (televisión)—. Dice lo que el cliente tiene, no lo ejecuta.
   */
  async cambiarEstadoDeServicio(id: string, dto: ChangeServiceStatusDto, user?: AuthUser) {
    await exigirSedeSuscriptor(this.prisma, user, id);
    const sub = await this.prisma.subscriber.findUnique({ where: { id }, select: { id: true } });
    if (!sub) throw new NotFoundException('Suscriptor no encontrado');

    const servicio = dto.servicio as 'INTERNET' | 'TV';
    const estado = dto.estado as 'ACTIVO' | 'CORTADO' | 'SUSPENDIDO';
    // NULL es como el legacy escribe "este servicio está al aire" (ver `estadoPorServicio`).
    const valor = estado === 'ACTIVO' ? null : (estado as ServiceStatus);
    const quien = user?.name || user?.email || null;

    // La factura VIGENTE y sólo ella: las anteriores son el rastro de cortes viejos.
    // Se salta las ANULADAS por lo mismo que la ficha (las fantasma del legacy
    // decidían el corte de 11 abonados).
    const vigente = await this.prisma.$queryRaw<{ id: string; serviceTv: string | null; serviceCombo: string | null }[]>`
      SELECT i.id, i."serviceTv", i."serviceCombo"
        FROM "SubInvoice" i
       WHERE i."subscriberId" = ${id}
         AND i.kind = 'RECURRENTE'
         AND i.status <> 'CANCELED'
       ORDER BY i."invoiceDate" DESC NULLS LAST, i.tid DESC
       LIMIT 1`;
    const factura = vigente[0];
    if (!factura) {
      throw new BadRequestException(
        'El abonado no tiene una factura recurrente donde anotar el estado del servicio.',
      );
    }
    // El mismo candado que la ficha: el estado sólo vale si esa factura NOMBRA el
    // servicio. Sin él se le podría marcar una televisión cortada a quien nunca la tuvo
    // —y la ficha ni siquiera lo pintaría, porque no lee el estado de un servicio que
    // la factura no nombra: el cambio parecería no haberse guardado.
    const nombrado = (v?: string | null) => {
      const t = (v ?? '').trim().toLowerCase();
      return !!t && t !== 'no' && t !== '-';
    };
    if (servicio === 'TV' && !nombrado(factura.serviceTv)) {
      throw new BadRequestException('La factura vigente del abonado no incluye televisión.');
    }
    if (servicio === 'INTERNET' && !nombrado(factura.serviceCombo)) {
      throw new BadRequestException('La factura vigente del abonado no incluye internet.');
    }

    await this.prisma.subInvoice.update({
      where: { id: factura.id },
      data: {
        ...(servicio === 'TV' ? { estadoTv: valor } : { estadoCombo: valor }),
        // La marca es lo que hace que el cambio SOBREVIVA: sin ella la ida devuelve el
        // valor del legacy a los 15 minutos y el trabajo se deshace solo. El writeback
        // la empuja y la borra en cuanto los dos lados coinciden (ver `serviceStatusAt`).
        serviceStatusAt: new Date(),
        serviceStatusBy: quien,
      },
    });

    // Y en el servicio registrado, para los abonados que lo tienen poblado (está a
    // medias: sólo se materializó para los ACTIVO). Los PUNTOS son decos de televisión
    // y corren su misma suerte.
    await this.prisma.subscriberService
      .updateMany({
        where: { subscriberId: id, kind: servicio === 'TV' ? { in: ['TV', 'PUNTOS'] } : 'INTERNET' },
        data: { status: estado },
      })
      .catch(() => undefined);

    // No hay historial POR SERVICIO donde dejar constancia, así que la constancia va
    // donde la busca quien atiende: las observaciones del cliente.
    const etiqueta = servicio === 'TV' ? 'Televisión' : 'Internet';
    const comoQueda = estado === 'ACTIVO' ? 'al aire' : estado.toLowerCase();
    await this.prisma.subscriberNote
      .create({
        data: {
          subscriberId: id,
          body: [`${etiqueta}: ${comoQueda} (cambio manual)`, dto.note?.trim()].filter(Boolean).join(' — '),
          authorName: quien,
        },
      })
      .catch(() => undefined);

    // Al legacy EN EL ACTO: su ida trae `estado_tv`/`estado_combo` cada 15 minutos.
    this.events?.emit(ESTADO_SERVICIO_EVENT, { subscriberId: id, servicio, estado } satisfies EstadoServicioEvent);

    // Y la constancia de que ese trabajo se hizo: la orden, ya cerrada.
    const orden = await this.registrarOrdenDeServicio(id, servicio, estado, quien, dto.note);

    return { ...(await this.detail(id, user)), orden };
  }

  /**
   * Deja la ORDEN del trabajo que se acaba de hacer A MANO: nace y se cierra en el
   * mismo acto.
   *
   * Nació de un corte de televisión real: el TR-069 sólo alcanza a una minoría de los
   * equipos —el resto ni siquiera están conectados— así que quien corta la TV va y la
   * corta por su cuenta, y aquí sólo viene a dejar dicho cómo quedó el cliente. Sin
   * orden ese trabajo no existe para nadie: no sale en la ficha, no lo ven los
   * informes de campo, no viaja al legacy —que es donde se consulta el historial del
   * abonado— y la señal de "¿sigue cortado?" (`cortesSegunOrdenes` en
   * `ReconexionService`) se queda mirando el último corte sin enterarse de nada.
   *
   * Se registra RESUELTA porque el trabajo YA está hecho: no hay visita que repartir,
   * y colgársela a un técnico le ensuciaría el tablero con visitas que no hizo. Si el
   * abonado tenía ABIERTA la orden de eso mismo —la del corte masivo que esperaba
   * técnico—, se cierra ESA en vez de abrir otra: el ciclo se cierra solo y nadie sale
   * a una casa donde ya no hay nada que hacer.
   *
   * NUNCA lanza ni deshace nada: el estado ya quedó guardado y viajando al legacy; que
   * la orden no se pueda escribir no puede tumbar el cambio que sí se hizo.
   */
  private async registrarOrdenDeServicio(
    subscriberId: string,
    servicio: 'INTERNET' | 'TV',
    estado: 'ACTIVO' | 'CORTADO' | 'SUSPENDIDO',
    quien: string | null,
    note?: string | null,
  ): Promise<OrdenAbierta | null> {
    if (!this.ordenes) return null;
    const etiqueta = servicio === 'TV' ? 'la televisión' : 'el internet';
    const hecho = estado === 'ACTIVO' ? `Se restableció ${etiqueta}` : `Se ${estado === 'CORTADO' ? 'cortó' : 'suspendió'} ${etiqueta}`;
    return this.ordenes.registrarResuelta({
      subscriberId,
      type: ORDEN_DE_ESTADO[servicio][estado],
      subject: 'servicio',
      problem: `${hecho} a mano desde la ficha del cliente.`,
      // El detalle largo dice POR QUÉ no lo hizo el sistema, que es lo primero que se
      // pregunta quien mire la orden y no vea rastro de los equipos.
      section: [
        'Trabajo hecho manualmente: no se ejecutó contra los equipos (el corte de TV por TR-069 no llega a todos los CPE).',
        quien ? `Lo registró ${quien}.` : null,
        note?.trim() || null,
      ].filter(Boolean).join(' '),
      // Firma la persona que lo movió, no "Sistema": el trabajo lo hizo alguien, y la
      // orden la abrió su cambio (mismo criterio que la reconexión al cobrar).
      autor: quien || 'Sistema',
    });
  }

  /**
   * Los planes que tiene HOY contratados, con sus megas. Es la lectura ligera que
   * hace falta ANTES de cambiárselos: la ficha entera (`detail`) trae facturas,
   * órdenes, equipos y notas, que para responder "¿cuántas megas tiene?" es media
   * pantalla de trabajo para el servidor.
   *
   * Lo usa el formulario de la orden de 'Subir megas' / 'Bajar megas', que tiene que
   * enseñar de cuánto viene el cliente antes de decir a cuánto va.
   *
   * `megas` sale del servicio y, si ahí no está —el snapshot viene vacío en los
   * abonados heredados del legacy—, del plan del catálogo.
   */
  async currentPlans(id: string, user?: AuthUser) {
    await exigirSedeSuscriptor(this.prisma, user, id);
    const sub = await this.prisma.subscriber.findUnique({ where: { id }, select: { id: true } });
    if (!sub) throw new NotFoundException('Suscriptor no encontrado');
    const services = await this.prisma.subscriberService.findMany({
      where: { subscriberId: id },
      select: {
        kind: true, planId: true, planName: true, megas: true, status: true, qty: true,
        price: true, plan: { select: { name: true, megas: true, active: true } },
      },
      orderBy: { kind: 'asc' },
    });
    return services.map((s) => ({
      kind: s.kind as string,
      planId: s.planId,
      planName: s.planName ?? s.plan?.name ?? null,
      megas: s.megas ?? s.plan?.megas ?? null,
      price: num(s.price),
      qty: s.qty,
      status: s.status as string | null,
    }));
  }

  /**
   * Cambia el plan del abonado desde el catálogo:
   *  1) actualiza el SubscriberService del mismo `kind` con name+price del plan
   *     (ese snapshot es lo que factura el cron mensual → precio nuevo automático);
   *  2) fija el pppProfile del abonado al perfil del plan;
   *  3) empuja el perfil al router (dry-run salvo MIKROTIK_LIVE=true).
   * No reprecia facturas ya emitidas; aplica desde la siguiente facturación.
   *
   * `pushRouter: false` hace sólo 1) y 2). Lo usa el alta de cliente: ahí el
   * secret todavía NO existe en el Mikrotik, así que empujarle el perfil sólo
   * devolvería un error confuso; el alta provisiona después, y `provision()` ya
   * crea el secret con el perfil que este paso acaba de dejar en la ficha.
   */
  async changePlan(
    subscriberId: string,
    planId: string,
    user?: AuthUser,
    opts: { pushRouter?: boolean; price?: number; bundleId?: string | null; allowInactive?: boolean } = {},
  ) {
    await exigirSedeSuscriptor(this.prisma, user, subscriberId);
    const [sub, plan] = await Promise.all([
      this.prisma.subscriber.findUnique({ where: { id: subscriberId }, select: { id: true } }),
      this.prisma.plan.findUnique({ where: { id: planId } }),
    ]);
    if (!sub) throw new NotFoundException('Suscriptor no encontrado');
    if (!plan) throw new NotFoundException('Plan no encontrado');
    // Un plan oculto no se le VENDE a nadie nuevo, pero sí se le puede dejar puesto a
    // quien ya lo paga: 72 de los 85 planes del catálogo están ocultos y sobre ellos
    // viven la mayoría de los abonados (2.179 en "100 Megas F-26"). Por eso "asignar
    // servicio" desde la factura —que es CORREGIR el plan a lo que ya se le cobra—
    // pasa `allowInactive`, y la venta desde la ficha sigue topada.
    if (!plan.active && !opts.allowInactive) {
      throw new BadRequestException('El plan está inactivo; actívalo antes de asignarlo.');
    }

    // `opts.price` lo manda un COMBO: dentro del paquete el plan vale menos que
    // suelto. El IVA no se toca —sigue siendo el del plan— porque lo fija el
    // tipo de servicio ante la DIAN, no la promoción comercial.
    const price = opts.price ?? num(plan.price);
    const taxRate = num(plan.taxRate);
    const bundleId = opts.bundleId ?? null;

    // 1) Snapshot del plan en el servicio (fuente de la próxima factura).
    const existing = await this.prisma.subscriberService.findFirst({
      where: { subscriberId, kind: plan.kind }, select: { id: true },
    });
    if (existing) {
      await this.prisma.subscriberService.update({
        where: { id: existing.id },
        data: { planId: plan.id, planName: plan.name, price, taxRate, megas: plan.megas, status: 'ACTIVO', bundleId },
      });
    } else {
      await this.prisma.subscriberService.create({
        data: { subscriberId, kind: plan.kind, planId: plan.id, planName: plan.name, price, taxRate, megas: plan.megas, status: 'ACTIVO', bundleId },
      });
    }

    // 2) Perfil PPP del abonado ← perfil del plan (si lo define).
    //
    // Con `editedAt`, y no es un adorno: `perfil` es una columna que baja del legacy
    // (`CUSTOMER_FIELD2COLS`), así que sin la marca el sync de ida devuelve el perfil
    // VIEJO en la próxima pasada de 15 minutos y el cliente queda pagando el plan
    // nuevo con la velocidad anterior en la ficha. Pasó con el abonado 2169 el
    // 07-09-2026: se le montó el internet a 300 Megas y siete minutos después su
    // ficha volvía a decir `perfil = '-'`. Con la marca manda nexus y el writeback lo
    // empuja allá (y suelta el sello cuando los dos lados dicen lo mismo).
    if (plan.pppProfile) {
      await this.prisma.subscriber.update({
        where: { id: subscriberId },
        data: { pppProfile: plan.pppProfile, editedAt: new Date() },
      });
    }

    // 3) Empuja el perfil al router. No revienta el cambio si el router falla.
    let router = null as Awaited<ReturnType<MikrotikService['applyProfile']>> | null;
    if (plan.pppProfile && opts.pushRouter !== false) {
      router = await this.mikrotik.applyProfile(subscriberId, plan.pppProfile, user).catch((e) => ({
        ok: false, dryRun: true, action: 'PROFILE' as const, subscriberId,
        steps: [], message: `No se empujó al router: ${(e as Error).message}`, error: (e as Error).message,
      }));
    }

    return {
      ok: true,
      plan: { id: plan.id, name: plan.name, price, pppProfile: plan.pppProfile },
      router,
    };
  }

  /**
   * Cuántos PUNTOS de TV adicionales tiene el abonado (televisores extra).
   *
   * No es un plan más: es una cantidad sobre el mismo servicio de televisión, y
   * por eso va aparte de `changePlan` —que asigna uno por `kind`— y vive en la
   * misma fila con su `qty`. El punto NO lleva IVA (es el mismo servicio de TV
   * repartido a otro televisor); la tarifa sale del catálogo.
   *
   * `qty = 0` borra la línea: deja de cobrarse el mes siguiente.
   *
   * El precio propio NO se pisa al cambiar la cantidad: hay abonados comerciales
   * con una tarifa negociada por punto y subirle un televisor no puede devolverlo
   * al precio de lista.
   */
  async setPuntos(subscriberId: string, qty: number, user?: AuthUser) {
    await exigirSedeSuscriptor(this.prisma, user, subscriberId);
    if (!Number.isInteger(qty) || qty < 0) throw new BadRequestException('La cantidad de puntos tiene que ser un entero de 0 en adelante.');
    if (qty > 200) throw new BadRequestException('Cantidad de puntos fuera de rango (máximo 200).');

    const sub = await this.prisma.subscriber.findUnique({ where: { id: subscriberId }, select: { id: true } });
    if (!sub) throw new NotFoundException('Suscriptor no encontrado');

    const existing = await this.prisma.subscriberService.findFirst({ where: { subscriberId, kind: 'PUNTOS' } });

    if (qty === 0) {
      if (existing) await this.prisma.subscriberService.delete({ where: { id: existing.id } });
      return { ok: true, qty: 0, price: null, total: 0 };
    }

    const plan = await this.prisma.plan.findFirst({ where: { kind: 'PUNTOS', active: true }, orderBy: { createdAt: 'asc' } });
    if (!existing && !plan) throw new BadRequestException('No hay un plan de puntos en el catálogo; créalo en Configuración ▸ Planes.');

    const price = existing?.price != null ? num(existing.price) : num(plan!.price);
    const taxRate = existing ? num(existing.taxRate) : num(plan!.taxRate);

    if (existing) {
      await this.prisma.subscriberService.update({ where: { id: existing.id }, data: { qty, status: 'ACTIVO' } });
    } else {
      await this.prisma.subscriberService.create({
        data: { subscriberId, kind: 'PUNTOS', planId: plan!.id, planName: plan!.name, price, taxRate, qty, status: 'ACTIVO' },
      });
    }
    return { ok: true, qty, price, total: Math.round(price * qty * 100) / 100 };
  }

  /**
   * Cambia varios planes del abonado en una sola operación (ej. Internet + TV).
   * Cada planId toca el servicio de su propio `kind`; si llegan dos del mismo
   * kind, manda el último. Devuelve un resultado por plan aplicado.
   *
   * `opts.remove` son los servicios que se DEJAN de contratar (la opción "No" del
   * selector del legacy): el cliente se queda sólo con internet, o sólo con TV, y el
   * mes que viene no se le cobra el otro. Se puede quitar sin cambiar ningún plan —de
   * ahí que `planIds` pueda venir vacío— y un mismo kind nunca se cambia y se quita a
   * la vez: quitar gana, que es lo que dice la pantalla.
   */
  async changePlans(
    subscriberId: string,
    planIds: string[],
    user?: AuthUser,
    opts: { pushRouter?: boolean; remove?: ServiceKind[] } = {},
  ) {
    await exigirSedeSuscriptor(this.prisma, user, subscriberId);
    const quitar = [...new Set(opts.remove ?? [])];
    const uniqueIds = [...new Set(planIds.filter(Boolean))];
    if (uniqueIds.length === 0 && quitar.length === 0) {
      throw new BadRequestException('Selecciona al menos un plan o un servicio que quitar.');
    }

    const plans = await this.prisma.plan.findMany({ where: { id: { in: uniqueIds } }, select: { id: true, kind: true } });
    if (plans.length !== uniqueIds.length) throw new NotFoundException('Uno o más planes no existen.');

    // Un solo plan por kind: si hay colisión, gana el último de la lista.
    const byKind = new Map<string, string>();
    for (const id of uniqueIds) {
      const p = plans.find((x) => x.id === id)!;
      byKind.set(p.kind, id);
    }
    for (const kind of quitar) byKind.delete(kind);

    // Quitar va PRIMERO: si en la misma tanda se cambia internet y se quita la TV, el
    // abonado no pasa ni un instante con los dos servicios repreciados a la vez.
    const removed: Awaited<ReturnType<SubscribersService['removeService']>>[] = [];
    for (const kind of quitar) removed.push(await this.removeService(subscriberId, kind, user));

    const results: Awaited<ReturnType<SubscribersService['changePlan']>>[] = [];
    for (const id of byKind.values()) {
      results.push(await this.changePlan(subscriberId, id, user, opts));
    }
    return { ok: true, results, removed };
  }

  /**
   * Aplica un COMBO al abonado: sus planes de una vez, cada uno con el precio
   * que tiene dentro del paquete (que es menor al de lista, ahí está la venta).
   *
   * No se factura el combo como un solo renglón: se dejan los servicios del
   * abonado con el precio rebajado y la corrida mensual sigue emitiendo una
   * línea por servicio con su IVA. Así la factura, la e-factura y la DIAN no se
   * enteran de que hubo un combo, que es justo lo que se quiere.
   */
  async applyBundle(
    subscriberId: string,
    bundleId: string,
    user?: AuthUser,
    opts: { pushRouter?: boolean } = {},
  ) {
    await exigirSedeSuscriptor(this.prisma, user, subscriberId);
    const bundle = await this.prisma.planBundle.findUnique({
      where: { id: bundleId },
      include: { items: { include: { plan: { select: { active: true, name: true } } } } },
    });
    if (!bundle) throw new NotFoundException('Combo no encontrado');
    if (!bundle.active) throw new BadRequestException('El combo está oculto; muéstralo antes de venderlo.');
    if (!bundle.items.length) throw new BadRequestException('El combo no tiene planes dentro.');
    const oculto = bundle.items.find((i) => !i.plan.active);
    if (oculto) {
      throw new BadRequestException(
        `El combo incluye el plan “${oculto.plan.name}”, que está oculto. Corrige el combo antes de venderlo.`,
      );
    }

    const results: Awaited<ReturnType<SubscribersService['changePlan']>>[] = [];
    for (const item of bundle.items) {
      results.push(
        await this.changePlan(subscriberId, item.planId, user, {
          ...opts, price: num(item.price), bundleId: bundle.id,
        }),
      );
    }
    return { ok: true, bundle: { id: bundle.id, name: bundle.name }, results };
  }

  /**
   * Quita un servicio contratado (la opción "No" del selector del legacy): el cliente
   * deja de tener TV, o deja de tener internet, y el mes siguiente ya no se le cobra.
   *
   * Borra la fila en vez de dejarla en estado SUSPENDIDO a propósito: `SubscriberService`
   * es la lista de lo que se factura, y un servicio "no contratado" no es un servicio
   * cortado —el cortado se sigue cobrando—. No toca el router: dar de baja la televisión
   * no puede apagarle el internet, y bajar el internet es una orden de retiro, no un
   * renglón menos en la factura.
   */
  async removeService(
    subscriberId: string,
    kind: ServiceKind,
    user?: AuthUser,
    opts: { snapshotLegacy?: boolean } = {},
  ) {
    await exigirSedeSuscriptor(this.prisma, user, subscriberId);
    const existing = await this.prisma.subscriberService.findFirst({
      where: { subscriberId, kind }, select: { id: true, planName: true },
    });
    if (existing) await this.prisma.subscriberService.delete({ where: { id: existing.id } });
    /**
     * La baja se escribe en la factura SIEMPRE, tenga fila o no.
     *
     * La mitad de los abonados no tiene `SubscriberService` (el hueco de la
     * migración): su plan sale DERIVADO de las facturas, aquí y en la corrida
     * mensual. A esos, quitarles la televisión no borraba nada —no había qué
     * borrar— y la operación se iba en blanco: la ficha se la seguía enseñando y el
     * mes siguiente se la volvía a cobrar. Es el caso del abonado 56130, al que se
     * la quitaron tres veces el 09-09-2026 y las tres veces siguió ahí.
     *
     * El `'no'` en la cabecera es la declaración de que el servicio NO se contrata, y
     * es lo único que tapa a lo derivado (aquí, en la corrida y en el legacy).
     */
    if (opts.snapshotLegacy !== false) await this.apagarServicioEnElLegacy(subscriberId, kind, user);
    return { ok: true, removed: !!existing, kind, planName: existing?.planName };
  }

  /**
   * Le dice al LEGACY que ese servicio ya no se contrata.
   *
   * Borrar el `SubscriberService` sólo apaga la facturación de ESTE sistema. Allá el plan
   * del abonado no vive en el cliente: la corrida mensual lo lee de la última factura
   * RECURRENTE (`combo`/`television`/`puntos` — el mismo criterio que
   * `facturaQueDictaElPlan` de facturas), así que sin esto el legacy le seguiría
   * facturando la televisión que aquí se acaba de quitar.
   *
   * `serviceAssignedAt` es lo que hace que el writeback empuje esas tres columnas y que
   * la ida del sync no las devuelva al valor viejo en la siguiente pasada de 15 minutos.
   *
   * Si el abonado no tiene ninguna recurrente (cliente nuevo, facturado sólo aquí) no hay
   * dónde escribirlo y no hace falta: el legacy no tiene de dónde leer el plan.
   */
  private async apagarServicioEnElLegacy(subscriberId: string, kind: ServiceKind, user?: AuthUser) {
    const columna =
      kind === 'TV' ? { serviceTv: 'no' }
      : kind === 'INTERNET' ? { serviceCombo: 'no' }
      : kind === 'PUNTOS' ? { puntos: 0 }
      : null;
    if (!columna) return;
    const dicta = await this.prisma.subInvoice.findFirst({
      where: { subscriberId, kind: 'RECURRENTE', status: { not: 'CANCELED' } },
      orderBy: [{ invoiceDate: 'desc' }, { tid: 'desc' }],
      select: { id: true },
    });
    if (!dicta) return;
    await this.prisma.subInvoice.update({
      where: { id: dicta.id },
      data: { ...columna, serviceAssignedAt: new Date(), serviceAssignedBy: user?.name ?? user?.email ?? null },
    });
  }

  /**
   * ¿El usuario PPP ya está tomado? Se consulta la BD (autoritativa) y, si se puede, el
   * router de la sede.
   *
   * El legacy (`Customers_model::validar_user_name`) consultaba SÓLO el Mikrotik y tenía el
   * `else` vacío: si el router no respondía devolvía null y el controller lo interpretaba
   * como "disponible" — fail-open en su única validación bloqueante, que es justo la causa
   * de las colisiones de secret. Aquí el router que no responde NUNCA se reporta como libre:
   * se devuelve `router: 'unreachable'` y la BD sigue mandando.
   */
  private async pppUsernameTaken(username: string, branchId?: string, installTech?: string | null, excludeId?: string) {
    const name = username.trim();
    const inDb = await this.prisma.subscriber.findFirst({
      // `excludeId`: al editar, el cliente no colisiona consigo mismo.
      where: { pppUsername: { equals: name, mode: 'insensitive' }, ...(excludeId ? { id: { not: excludeId } } : {}) },
      select: { id: true, abonado: true, fullName: true },
    });

    let router: 'free' | 'taken' | 'unreachable' | 'unknown' = 'unknown';
    if (branchId) {
      try {
        const branch = await this.prisma.branch.findUnique({ where: { id: branchId }, select: { legacyId: true } });
        if (branch) {
          const mk = await this.mikrotik.resolveRouter({
            id: '', legacyId: null, pppUsername: null, ipRemote: null,
            installTech: installTech ?? null, status: null, branch: { legacyId: branch.legacyId },
          } as any);
          const res = await this.mikrotikAdmin.secrets(mk.id, { search: name, pageSize: 200 });
          if (!res.ok) router = 'unreachable';
          else router = res.items.some((s: { name: string }) => s.name.toLowerCase() === name.toLowerCase()) ? 'taken' : 'free';
        }
      } catch {
        // Sin router para la sede / sede sin resolver: no podemos afirmar nada.
        router = 'unreachable';
      }
    }
    return { db: inDb, router };
  }

  /**
   * Chequeos de duplicados del alta, para que la pantalla avise antes de guardar.
   *
   * Paridad legacy: documento y dirección son ADVERTENCIA, no bloqueo. Las cédulas
   * repetidas son INTENCIONALES en este negocio — el flujo de facturación electrónica las
   * mapea a sucursales de Siigo (`sucursal_siigo` / `branch_office`), así que bloquearlas
   * rompería la emisión. El usuario PPP sí bloquea (ver `pppUsernameTaken`).
   */
  async checkDuplicates(dto: {
    docNumber?: string; branchId?: string; pppUsername?: string; installTech?: string;
    departmentRef?: string; cityRef?: string; localityRef?: string; neighborhood?: string; addressLine?: string;
  }) {
    const out: any = { document: null, address: null, pppUsername: null };

    if (dto.docNumber?.trim()) {
      const items = await this.prisma.subscriber.findMany({
        where: { docNumber: dto.docNumber.trim() },
        select: { id: true, abonado: true, fullName: true, status: true },
        take: 20,
      });
      out.document = {
        count: items.length, items, blocking: false,
        message: items.length
          ? `Ya existen ${items.length} cliente(s) con este documento. Se permite continuar: el mismo titular puede tener varias cuentas.`
          : null,
      };
    }

    // Dirección: igualdad exacta de los componentes, como el legacy.
    if (dto.addressLine?.trim() || dto.neighborhood) {
      const count = await this.prisma.subscriber.count({
        where: {
          departmentRef: dto.departmentRef ?? undefined,
          cityRef: dto.cityRef ?? undefined,
          localityRef: dto.localityRef ?? undefined,
          neighborhood: dto.neighborhood ?? undefined,
          addressLine: dto.addressLine?.trim() ?? undefined,
        },
      });
      out.address = {
        count, blocking: false,
        message: count ? `Ya hay ${count} cliente(s) registrado(s) en esta misma dirección.` : null,
      };
    }

    if (dto.pppUsername?.trim()) {
      const { db, router } = await this.pppUsernameTaken(dto.pppUsername, dto.branchId, dto.installTech);
      const taken = !!db || router === 'taken';
      out.pppUsername = {
        taken, blocking: true, router,
        message: db
          ? `Este nombre de usuario ya lo usa el abonado ${db.abonado} (${db.fullName ?? 'sin nombre'}).`
          : router === 'taken'
            ? 'Este nombre de usuario ya existe como secret en el Mikrotik de la sede.'
            : router === 'unreachable'
              ? 'Disponible en la base de datos, pero NO se pudo verificar contra el Mikrotik (router sin responder).'
              : 'Disponible.',
      };
    }
    return out;
  }

  /**
   * Credenciales PPPoE del alta.
   *
   * Ya no se piden en el formulario: salen del propio cliente (nombre completo
   * pegado en mayúsculas / número de documento), que es la convención de toda la
   * vida y la que traen los abonados importados del legacy. Si el nombre ya está
   * tomado —dos personas se llaman igual— se numera la variante en vez de
   * reventar el alta, que es lo que hacía el guard de colisión.
   *
   * Sólo se derivan cuando el alta no manda usuario: la edición de la ficha
   * (donde SÍ se puede escribir a mano, por los abonados viejos) no pasa por aquí.
   */
  private async credencialesPpp(dto: CreateSubscriberDto, installTech: string) {
    const base = usuarioPppDe(dto);
    if (!base) return { pppUsername: null, pppPassword: null };

    // 20 intentos es un tope de cortesía: con más homónimos que eso el problema
    // no es el sufijo. Se cae al último candidato en vez de dejarlo sin secret.
    let elegido = base;
    for (let n = 1; n <= 20; n++) {
      elegido = variantePpp(base, n);
      const { db, router } = await this.pppUsernameTaken(elegido, dto.branchId, installTech);
      if (!db && router !== 'taken') break;
    }
    return { pppUsername: elegido, pppPassword: clavePppDe(dto.docNumber) || null };
  }

  /** Crear un cliente nuevo (abonado autogenerado max+1, estado INSTALAR). */
  async create(dto: CreateSubscriberDto, user?: AuthUser) {
    // Un usuario acotado sólo da de alta en SUS sedes (y tiene que indicar una).
    await exigirSedeDestino(this.prisma, user, dto.branchId ?? null);
    // Guard de colisión de secret PPP. El legacy NO tenía validación de servidor en el alta
    // (`Customers::addcustomer` insertaba directo); la única comprobación vivía en el JS de
    // la vista y se saltaba con un POST directo. Documento y dirección siguen SIN bloquear
    // (ver `checkDuplicates`).
    if (dto.pppUsername?.trim()) {
      const { db, router } = await this.pppUsernameTaken(dto.pppUsername, dto.branchId, dto.installTech);
      if (db) {
        throw new BadRequestException(
          `El nombre de usuario PPP "${dto.pppUsername.trim()}" ya lo usa el abonado ${db.abonado} (${db.fullName ?? 'sin nombre'}).`,
        );
      }
      if (router === 'taken') {
        throw new BadRequestException(
          `El nombre de usuario PPP "${dto.pppUsername.trim()}" ya existe como secret en el Mikrotik de la sede.`,
        );
      }
    }

    const data: any = buildProfileData(dto);
    // Conectividad automática: hoy sólo se vende fibra, así que la tecnología no
    // se pregunta, y el secret se deriva del cliente (ver `credencialesPpp`).
    if (!data.installTech) data.installTech = TECNOLOGIA_FTTH;
    if (!data.pppUsername) {
      const cred = await this.credencialesPpp(dto, data.installTech);
      data.pppUsername = cred.pppUsername;
      if (!data.pppPassword) data.pppPassword = cred.pppPassword;
    }
    if (data.abonado == null) {
      // Secuencia de Postgres, no MAX+1: dos altas simultáneas obtenían el mismo
      // número y, al no haber restricción única en la columna, se duplicaba sin ruido.
      data.abonado = await nextTid(this.prisma, TID_SEQ.subscriberAbonado);
    }
    data.fullName = composeName(dto.firstName, dto.secondName, dto.lastName1, dto.lastName2) ?? dto.companyName ?? null;
    data.status = 'INSTALAR' as SubscriberStatus;
    if (dto.branchId) data.branch = { connect: { id: dto.branchId } };

    const created = await this.prisma.subscriber.create({ data: data as Prisma.SubscriberCreateInput });
    // El usuario PPP se devuelve porque puede haberlo puesto este método: el
    // alta lo necesita para el paso del router y para la orden de instalación.
    return { id: created.id, abonado: created.abonado, pppUsername: created.pppUsername };
  }

  /**
   * Le deja al abonado un usuario/clave PPPoE con los que se pueda crear el secret,
   * DERIVADOS de él mismo (la convención de siempre: nombre pegado en mayúsculas y
   * el documento como clave, ver `conexion-alta.ts`).
   *
   * Hace falta fuera del alta porque hay clientes que llegan al internet por otra
   * puerta: el que sólo tenía televisión y pide 'AgregarInternet'. Ése está en la
   * base desde el legacy con `name_s` sin valor de verdad, y sin usuario no hay
   * secret que crear en el Mikrotik (`provision` lo rechaza).
   *
   * NO pisa un usuario que ya sirve: un secret que funciona no se renombra nunca
   * —eso deja al cliente sin sesión y con un secret huérfano en el router—. Los
   * valores basura heredados ('0', '-', 'null') no cuentan como usuario: son 1.611
   * filas en las que el legacy escribió un relleno, no un nombre.
   */
  async asegurarCredencialesPpp(subscriberId: string, user?: AuthUser) {
    await exigirSedeSuscriptor(this.prisma, user, subscriberId);
    const s = await this.prisma.subscriber.findUnique({
      where: { id: subscriberId },
      select: {
        id: true, branchId: true, installTech: true, docNumber: true, pppUsername: true, pppPassword: true,
        firstName: true, secondName: true, lastName1: true, lastName2: true, companyName: true,
      },
    });
    if (!s) throw new NotFoundException('Suscriptor no encontrado');
    if (esUsuarioPppUtil(s.pppUsername)) {
      return { ok: true, creado: false, pppUsername: s.pppUsername!.trim() };
    }

    const base = usuarioPppDe(s);
    if (!base) {
      return { ok: false, creado: false, pppUsername: null, motivo: 'El cliente no tiene nombre del que derivar el usuario PPPoE: escríbelo en su ficha.' };
    }
    const installTech = s.installTech ?? TECNOLOGIA_FTTH;
    let elegido = base;
    for (let n = 1; n <= 20; n++) {
      elegido = variantePpp(base, n);
      const { db, router } = await this.pppUsernameTaken(elegido, s.branchId ?? undefined, installTech, subscriberId);
      if (!db && router !== 'taken') break;
    }
    const clave = (s.pppPassword ?? '').trim() || clavePppDe(s.docNumber) || null;
    await this.prisma.subscriber.update({
      where: { id: subscriberId },
      data: {
        pppUsername: elegido,
        pppPassword: clave,
        // El sync de ida devolvería el `name_s` vacío del legacy en la próxima pasada
        // de 15 minutos; con la marca manda nexus y el writeback lo empuja allá.
        editedAt: new Date(),
      },
    });
    return { ok: true, creado: true, pppUsername: elegido };
  }


  // ── Facturas ──────────────────────────────────────────────────

  /** Todas las facturas del cliente (para la pestaña con paginación en cliente). */
  async invoices(id: string, user?: AuthUser) {
    await exigirSedeSuscriptor(this.prisma, user, id);
    const rows = await this.prisma.subInvoice.findMany({
      where: { subscriberId: id },
      orderBy: { invoiceDate: 'desc' },
      select: INVOICE_SELECT,
    });
    return rows.map(mapInvoice);
  }

  // ── Facturas: editar / eliminar ───────────────────────────────

  /** Editar la cabecera de una factura del cliente (fecha, vencimiento, tipo, estado, notas). */
  async updateInvoice(subscriberId: string, invoiceId: string, dto: UpdateInvoiceDto, user?: AuthUser) {
    await exigirSedeSuscriptor(this.prisma, user, subscriberId);
    const inv = await this.prisma.subInvoice.findFirst({
      where: { id: invoiceId, subscriberId }, select: { id: true },
    });
    if (!inv) throw new NotFoundException('Factura no encontrada');

    const data: Prisma.SubInvoiceUpdateInput = {};
    if (dto.invoiceDate !== undefined) data.invoiceDate = new Date(dto.invoiceDate);
    if (dto.dueDate !== undefined) data.dueDate = new Date(dto.dueDate);
    if (dto.kind !== undefined) data.kind = dto.kind as InvoiceKind;
    if (dto.ron !== undefined) data.ron = (dto.ron || null) as InvoiceRon | null;
    if (dto.notes !== undefined) data.notes = dto.notes || null;

    await this.prisma.subInvoice.update({ where: { id: inv.id }, data });
    return this.detail(subscriberId);
  }

  /**
   * Eliminar una factura. Por seguridad SOLO si no tiene movimientos de dinero
   * asociados (pagos, servicios adicionales o e-factura). Los ítems caen en cascada.
   */
  async deleteInvoice(subscriberId: string, invoiceId: string, user?: AuthUser) {
    await exigirSedeSuscriptor(this.prisma, user, subscriberId);
    const inv = await this.prisma.subInvoice.findFirst({
      where: { id: invoiceId, subscriberId },
      select: {
        id: true, tid: true, legacyId: true,
        _count: { select: { transactions: true, receipts: true, additionalServices: true, electronicInvoices: true } },
      },
    });
    if (!inv) throw new NotFoundException('Factura no encontrada');

    const cnt = inv._count;
    const blockers: string[] = [];
    if (cnt.transactions) blockers.push(`${cnt.transactions} pago(s)`);
    if (cnt.receipts) blockers.push(`${cnt.receipts} recibo(s)`);
    if (cnt.additionalServices) blockers.push(`${cnt.additionalServices} servicio(s) adicional(es)`);
    if (cnt.electronicInvoices) blockers.push('e-factura');
    if (blockers.length) {
      throw new BadRequestException(
        `No se puede eliminar la factura #${inv.tid}: tiene ${blockers.join(', ')} asociado(s). Anúlalos primero.`,
      );
    }

    await anotarBorradoLegacy(this.prisma, 'subInvoice', inv, { label: `Factura #${inv.tid}` });
    await this.prisma.subInvoice.delete({ where: { id: inv.id } });
    return { ok: true, tid: inv.tid };
  }

  // ── Estado de cuenta ──────────────────────────────────────────

  /**
   * Ledger cronológico del cliente: cargos (facturas) y abonos (pagos vigentes),
   * con saldo acumulado. `pazysalvo = true` si no hay saldo pendiente.
   *
   * Además resuelve si el certificado de paz y salvo SE PUEDE EXPEDIR, que no es lo
   * mismo que no deber plata. Son CUATRO requisitos y se evalúan por separado para
   * poder decir cuál falta (2026-08-28):
   *
   *  1. saldo en cero;
   *  2. equipo devuelto —la ONT, el decodificador…, que son de la empresa y siguen en
   *     casa del cliente hasta que los entrega: firmar un "a paz y salvo por todo
   *     concepto" con un equipo afuera es renunciar por escrito a reclamarlo;
   *  3. la CARTA de retiro o suspensión entregada (adjunto `kind=CARTA_RETIRO`), que
   *     es la prueba de que la baja la pidió el cliente;
   *  4. la ORDEN de retiro o suspensión CERRADA (`RESUELTO`). Mientras siga abierta,
   *     el servicio se está prestando y se le va a seguir facturando: certificar ahí
   *     que no debe nada es certificar sobre una cuenta que todavía se mueve. Una
   *     orden ANULADA no cuenta — anular es deshacer la baja, no cumplirla.
   *
   * Ver `pazYSalvo` en el controlador: la ruta se cierra, no se expide un certificado
   * en negativo.
   */
  async statement(id: string, user?: AuthUser) {
    await exigirSedeSuscriptor(this.prisma, user, id);
    const s = await this.prisma.subscriber.findUnique({
      where: { id },
      select: {
        id: true, docType: true, docNumber: true, abonado: true, addressLine: true,
        firstName: true, secondName: true, lastName1: true, lastName2: true, companyName: true, fullName: true,
        branch: { select: { name: true } },
      },
    });
    if (!s) throw new NotFoundException('Suscriptor no encontrado');

    const [invoices, payments, equipos, carta, ordenesBaja] = await Promise.all([
      this.prisma.subInvoice.findMany({
        where: { subscriberId: id },
        select: { id: true, tid: true, invoiceDate: true, total: true },
      }),
      this.prisma.transaction.findMany({
        where: { subscriberId: id, type: 'INCOME', status: 'VIGENTE' },
        select: { id: true, date: true, credit: true, method: true, invoiceId: true },
      }),
      // Equipo aún a nombre del cliente. `subscriberId` es lo que suelta la devolución
      // (`returnEquipment`) y la desasignación; mientras haya filas, el equipo está afuera.
      this.prisma.equipment.findMany({
        where: { subscriberId: id },
        select: { id: true, code: true, mac: true, serial: true, brand: true },
        orderBy: { code: 'asc' },
      }),
      // La carta de retiro/suspensión: la última que se haya adjuntado a la ficha.
      this.prisma.subscriberFile.findFirst({
        where: { subscriberId: id, kind: KIND_CARTA_RETIRO },
        select: { id: true, originalName: true, createdAt: true, uploadedByName: true },
        orderBy: { createdAt: 'desc' },
      }),
      // Órdenes de baja del cliente. El filtro fino lo hace después
      // `esOrdenDeRetiroOSuspension`: `type` es texto libre heredado y en la base
      // conviven 'Suspension' y 'Suspencion'. Aquí sólo se acota a lo suyo.
      this.prisma.ticket.findMany({
        where: {
          subscriberId: id,
          OR: [
            { type: { contains: 'etiro', mode: 'insensitive' } },
            { type: { contains: 'uspen', mode: 'insensitive' } },
          ],
        },
        select: { id: true, code: true, type: true, status: true, finalDate: true, resolvedAt: true, created: true },
        orderBy: { created: 'desc' },
      }),
    ]);

    type Mov = { date: Date; kind: 'CARGO' | 'ABONO'; concept: string; ref: string | null; debit: number; credit: number };
    const movs: Mov[] = [];
    for (const i of invoices) movs.push({ date: i.invoiceDate, kind: 'CARGO', concept: `Factura #${i.tid}`, ref: String(i.tid), debit: num(i.total), credit: 0 });
    for (const p of payments) movs.push({ date: p.date, kind: 'ABONO', concept: `Pago${p.method ? ` (${p.method})` : ''}`, ref: null, debit: 0, credit: num(p.credit) });

    // Orden cronológico ascendente + saldo acumulado.
    movs.sort((a, b) => a.date.getTime() - b.date.getTime());
    let balance = 0;
    const rows = movs.map((m) => {
      balance += m.debit - m.credit;
      return { ...m, balance: Math.round(balance * 100) / 100 };
    });

    const totalCharges = rows.reduce((t, r) => t + r.debit, 0);
    const totalPayments = rows.reduce((t, r) => t + r.credit, 0);
    const finalBalance = Math.round((totalCharges - totalPayments) * 100) / 100;

    // Los dos requisitos, por separado: la pantalla y el bot tienen que poder decir
    // CUÁL de los dos falta, no un "no se puede" a secas.
    const alDia = finalBalance <= 0;
    const equiposPendientes = equipos.map((e) => ({
      id: e.id, code: e.code, mac: e.mac, serial: e.serial, brand: e.brand,
    }));
    // La carta y la orden de baja: los otros dos requisitos. Sólo cuentan las órdenes
    // que de verdad son de retiro o suspensión, y sólo cerradas (RESUELTO).
    const bajas = ordenesBaja.filter((t) => esOrdenDeRetiroOSuspension(t.type));
    const ordenBajaCerrada = bajas.find((t) => t.status === 'RESUELTO') ?? null;
    const ordenBajaAbierta = bajas.find((t) => t.status === 'PENDIENTE' || t.status === 'REALIZANDO') ?? null;
    const tieneCarta = carta != null;

    const motivos: string[] = [];
    if (!alDia) motivos.push(`tiene un saldo pendiente de ${copFmt(finalBalance)}`);
    if (equiposPendientes.length) {
      motivos.push(
        `no ha devuelto ${equiposPendientes.length === 1 ? 'el equipo' : `${equiposPendientes.length} equipos`}`
        + ` (${equiposPendientes.map((e) => `código ${e.code}${e.mac ? ` · MAC ${e.mac}` : ''}`).join('; ')})`,
      );
    }
    if (!tieneCarta) motivos.push('no ha entregado la carta de retiro o suspensión');
    if (!ordenBajaCerrada) {
      motivos.push(
        ordenBajaAbierta
          // Si la orden existe pero sigue abierta, el motivo dice CUÁL: lo que falta
          // es cerrarla, no abrir otra.
          ? `tiene la orden de ${(ordenBajaAbierta.type || 'retiro').toLowerCase()}`
            + `${ordenBajaAbierta.code ? ` #${ordenBajaAbierta.code}` : ''} sin cerrar`
          : 'no tiene una orden de retiro o suspensión cerrada',
      );
    }

    return {
      subscriber: {
        name: displayName(s), abonado: s.abonado, docType: s.docType, docNumber: s.docNumber,
        addressLine: s.addressLine, branch: s.branch?.name ?? null,
      },
      totalCharges, totalPayments, balance: finalBalance,
      pazysalvo: alDia, // compatibilidad: "sin saldo pendiente" (la insignia del estado de cuenta)
      alDia,
      equiposPendientes,
      /** La carta de retiro/suspensión que hay en la ficha, o null si no la han subido. */
      cartaRetiro: carta && {
        id: carta.id, name: carta.originalName, createdAt: carta.createdAt, uploadedBy: carta.uploadedByName,
      },
      /** La orden de baja CERRADA que habilita el certificado (null si no hay). */
      ordenRetiro: ordenBajaCerrada && {
        id: ordenBajaCerrada.id, code: ordenBajaCerrada.code, type: ordenBajaCerrada.type,
        closedAt: ordenBajaCerrada.resolvedAt ?? ordenBajaCerrada.finalDate,
      },
      /** La que sigue abierta, para que la pantalla mande a cerrarla. */
      ordenRetiroAbierta: ordenBajaAbierta && {
        id: ordenBajaAbierta.id, code: ordenBajaAbierta.code, type: ordenBajaAbierta.type,
        status: ordenBajaAbierta.status,
      },
      puedeEmitirPazYSalvo:
        alDia && equiposPendientes.length === 0 && tieneCarta && ordenBajaCerrada != null,
      motivosPazYSalvo: motivos,
      /** Los mismos motivos ya enumerados, para pegarlos en un mensaje. */
      motivosPazYSalvoTexto: enumerar(motivos),
      movements: rows.reverse(), // más recientes primero para la UI
    };
  }

  // ── Devolución de equipo (paridad legacy `Customers::dev_equipo`) ─────────────
  //
  // El equipo que estaba instalado en casa del cliente vuelve a la bodega. Es la
  // contraparte de la asignación: suelta al cliente, borra los datos de instalación
  // (tipo, vlan, nat, puerto) y deja escrito con qué estado volvió y por qué.
  //
  // Dos diferencias deliberadas con el legacy:
  //  · el legacy dejaba el equipo en la MISMA bodega y sólo le cambiaba el estado;
  //    aquí se mueve, que es lo que la gente espera al oír "devolver a bodega", y un
  //    "Depurado" va a la bodega de depurados en vez de quedarse contando como stock
  //    de la sede.
  //  · el motivo es obligatorio (allá era un `<input>` que se podía enviar vacío).
  //
  // OJO: `equipos` NO está en el sync con el legacy (ni ida ni writeback), así que
  // esta devolución vive sólo en nexus. Lo único que viaja es `macequipo` del
  // cliente, que sí está en `diffKeys` de `vestel-map.js`.

  /**
   * Día en que se recogió el equipo, listo para una columna `date` (medianoche UTC,
   * igual que `arrival`). Sin fecha = hoy en Colombia: entre las 7 PM y la medianoche
   * el "hoy" del servidor ya es mañana y la devolución quedaría fechada un día tarde.
   *
   * No se acepta el futuro —un equipo no se recoge mañana— ni más de un año atrás,
   * que es lo que caza el año mal tecleado (2025 por 2026) antes de que se convierta
   * en un dato imposible de distinguir de uno bueno.
   */
  private diaDeRecogida(texto?: string): Date {
    const hoy = hoyEnColombia();
    if (!texto?.trim()) return hoy;

    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(texto.trim());
    if (!m) throw new BadRequestException('La fecha de recogida no es una fecha válida (formato AAAA-MM-DD).');
    const [y, mes, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const dia = new Date(Date.UTC(y, mes - 1, d));
    // `Date.UTC(2026, 1, 31)` no falla: rueda al 3 de marzo. Sin esta comprobación, un
    // "31 de febrero" se guardaría como una fecha que nadie escribió.
    if (dia.getUTCFullYear() !== y || dia.getUTCMonth() !== mes - 1 || dia.getUTCDate() !== d) {
      throw new BadRequestException('La fecha de recogida no existe en el calendario.');
    }

    if (dia.getTime() > hoy.getTime()) {
      throw new BadRequestException('La fecha de recogida no puede ser futura: el equipo aún no se ha recogido.');
    }
    const haceUnAno = new Date(hoy.getTime() - 365 * 24 * 60 * 60 * 1000);
    if (dia.getTime() < haceUnAno.getTime()) {
      throw new BadRequestException('La fecha de recogida no puede ser de hace más de un año: revisa el año.');
    }
    return dia;
  }

  /** Bodega a la que vuelve el equipo según con qué estado lo devuelven. */
  private async bodegaDeDevolucion(
    dto: ReturnEquipmentDto,
    sedeLegacy: number | null,
    actual: { id: string; name: string; branchLegacy: number | null } | null,
    user?: AuthUser,
  ) {
    // Depurado = fuera de servicio. Va siempre a la bodega de depurados, y no se le
    // pide sede a nadie: no es un traslado entre sedes, es sacarlo del inventario
    // vivo (la bodega "Depurados" no tiene sede, ver `bodega-scope.ts`).
    if (dto.status === 'Depurado') {
      const dep = await this.prisma.equipmentWarehouse.findFirst({
        where: { name: { equals: 'Depurados', mode: 'insensitive' } },
        select: { id: true, name: true, legacyId: true, branchLegacy: true },
      });
      if (!dep) throw new BadRequestException('No existe la bodega "Depurados": créala en Red / Bodegas antes de depurar equipos.');
      return dep;
    }

    const sedes = await sedesDeUsuario(this.prisma, user as AuthUser);

    if (dto.warehouseId) {
      const wh = await this.prisma.equipmentWarehouse.findUnique({
        where: { id: dto.warehouseId },
        select: { id: true, name: true, legacyId: true, branchLegacy: true },
      });
      if (!wh) throw new NotFoundException('Bodega no encontrada');
      exigirBodegaDeSuSede(sedes, wh);
      return wh;
    }

    // Sin bodega elegida: la de la sede del cliente. Entre varias de la misma sede
    // gana la que se llama como la sede ("Villanueva" antes que "Almacen cabecera
    // Villanueva"), que es la bodega principal; si la sede no tiene ninguna, se
    // queda donde estaba.
    const deLaSede = sedeLegacy == null ? [] : await this.prisma.equipmentWarehouse.findMany({
      where: { branchLegacy: sedeLegacy },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, legacyId: true, branchLegacy: true },
    });
    const destino = deLaSede.find((w) => w.branchLegacy === sedeLegacy && !/almacen|cabecera/i.test(w.name))
      ?? deLaSede[0]
      ?? (actual ? await this.prisma.equipmentWarehouse.findUnique({
        where: { id: actual.id },
        select: { id: true, name: true, legacyId: true, branchLegacy: true },
      }) : null);
    if (!destino) throw new BadRequestException('No hay una bodega a la que devolver el equipo: elige una.');
    exigirBodegaDeSuSede(sedes, destino);
    return destino;
  }

  async returnEquipment(subscriberId: string, equipmentId: string, dto: ReturnEquipmentDto, user?: AuthUser) {
    await exigirSedeSuscriptor(this.prisma, user, subscriberId);

    const sub = await this.prisma.subscriber.findUnique({
      where: { id: subscriberId },
      select: { id: true, macEquipo: true, status: true, branch: { select: { legacyId: true } } },
    });
    if (!sub) throw new NotFoundException('Cliente no encontrado');

    const eq = await this.prisma.equipment.findUnique({
      where: { id: equipmentId },
      select: {
        id: true, code: true, mac: true, serial: true, subscriberId: true, port: true, nat: true,
        warehouse: { select: { id: true, name: true, branchLegacy: true } },
      },
    });
    // Se comprueba que el equipo esté REALMENTE asignado a este cliente antes de
    // tocar nada, igual que el legacy: si no, el cliente quedaría "sin equipo" y el
    // equipo seguiría asignado a otro.
    if (!eq || eq.subscriberId !== subscriberId) {
      throw new BadRequestException('Ese equipo no está asignado a este cliente.');
    }

    const destino = await this.bodegaDeDevolucion(dto, sub.branch?.legacyId ?? null, eq.warehouse, user);
    const motivo = dto.reason.trim();
    const quien = user?.name ?? user?.email ?? 'sistema';
    const retiro = dto.withdrawal === true;
    // El día en que el equipo salió de casa del cliente. Va aparte del "cuándo se
    // tecleó esto" que ya guarda la auditoría: el técnico trae el equipo y la
    // devolución se registra días después, y lo que hay que poder demostrar —para
    // el paz y salvo o para un reclamo— es la fecha de la recogida.
    const recogido = this.diaDeRecogida(dto.returnedAt);

    // El que queda como MAC del cliente: si le quedan otros equipos, el del primero;
    // si no le queda ninguno, 'sin asignar' (el texto exacto que escribe el legacy,
    // que además viaja de vuelta a `customers.macequipo` por el writeback).
    const restantes = await this.prisma.equipment.findMany({
      where: { subscriberId, id: { not: eq.id } },
      select: { mac: true, port: true },
      orderBy: { arrival: 'desc' },
    });
    const macNueva = restantes.find((r) => r.mac?.trim())?.mac?.trim() ?? 'sin asignar';

    await this.prisma.$transaction(async (tx) => {
      await tx.equipment.update({
        where: { id: eq.id },
        data: {
          subscriberId: null, assignedRaw: null,
          installType: null, port: null, vlan: null, nat: null,
          status: dto.status, observation: motivo,
          returnedAt: recogido,
          warehouseId: destino.id, warehouseLegacy: destino.legacyId,
          // El legacy no se entera de esta devolución (`equipos` no viaja de vuelta):
          // sin la marca, la sincronización se la devolvería al cliente. Ver Equipment.editedAt.
          editedAt: new Date(),
        },
      });

      // Liberar la conexión (legacy: `puertos` del cliente a 'Disponible'). Se libera
      // el puerto de ESTE equipo; sólo si el equipo no traía nap/puerto anotados y al
      // cliente no le queda nada instalado se liberan todos los suyos, como el legacy.
      //
      // `equipos.puerto` es el ID de la fila del puerto (`Port.legacyId`, el `idp` del
      // legacy) y NO su número: buscarlo por `port: eq.port` —como se hacía— sólo
      // acertaba de casualidad, y la caja se quedaba diciendo "ocupado" después de
      // recoger el equipo. Ver `resolverPuertos` en support-write.
      if (eq.nat != null && eq.port != null) {
        // Salvo que otro aparato del cliente siga colgado de ese mismo puerto.
        const compartido = restantes.some((r) => r.port === eq.port);
        if (!compartido) {
          await tx.port.updateMany({
            where: { subscriberId, napLegacy: eq.nat, legacyId: eq.port },
            data: { subscriberId: null, assignedLegacy: 0, status: 'Disponible' },
          });
        }
      } else if (!restantes.length) {
        await tx.port.updateMany({
          where: { subscriberId },
          data: { subscriberId: null, assignedLegacy: 0, status: 'Disponible' },
        });
      }

      await tx.subscriber.update({ where: { id: subscriberId }, data: { macEquipo: macNueva } });

      // Rastro visible en la ficha (el legacy lo dejaba en `historiales`). La
      // bitácora global de auditoría ya guarda el "quién/cuándo" aparte.
      await tx.subscriberNote.create({
        data: {
          subscriberId,
          body: `Devolución de equipo${retiro ? ' POR RETIRO' : ''} — Código ${eq.code}`
            + (eq.mac ? ` · MAC ${eq.mac}` : '')
            + (eq.serial ? ` · Serial ${eq.serial}` : '')
            + `. Recogido el ${diaEnTexto(recogido)}.`
            + ` Estado: ${dto.status}. Bodega: ${destino.name}. Motivo: ${motivo}`,
          authorName: quien,
        },
      });
    });

    // Devolución POR RETIRO: el equipo vuelve porque el cliente se va, así que la
    // devolución arrastra la baja. Mismo orden que la cascada de cierre de una orden
    // de retiro (`SupportWriteService.applyCloseCascade`): primero el corte —que por
    // su cuenta deja CORTADO— y después el estado definitivo RETIRADO.
    // El equipo salió de la casa: sale también de la OLT. En segundo plano (es una
    // sesión telnet/SSH de segundos) y sin poder deshacer la devolución; el resultado
    // queda anotado en la ficha. Ver `OnuAlDevolverService`.
    void this.onuAlDevolver?.desautenticar({
      serial: eq.serial, code: eq.code, subscriberId, motivo: `Devolución: ${motivo}`, user,
    });

    const withdrawal = retiro ? await this.retirarPorDevolucion(sub, motivo, quien, restantes.length, recogido, user) : undefined;

    return {
      ok: true,
      equipment: { id: eq.id, code: eq.code, mac: eq.mac, status: dto.status, returnedAt: recogido },
      warehouse: { id: destino.id, name: destino.name },
      macEquipo: macNueva,
      withdrawal,
    };
  }

  /**
   * Baja del cliente que acompaña a una devolución por retiro: corte en el router
   * (best-effort: sin PPPoE, sin router o con el router caído la devolución NO se
   * pierde) + RETIRADO con su fila de historial. Si ya estaba RETIRADO/DEPURADO no
   * se vuelve a tocar el estado, sólo se informa.
   */
  private async retirarPorDevolucion(
    sub: { id: string; status: SubscriberStatus | null },
    motivo: string,
    quien: string,
    equiposPendientes: number,
    recogido: Date,
    user?: AuthUser,
  ) {
    const res: {
      statusSet?: string; yaRetirado?: boolean; mikrotik?: unknown; note?: string; equiposPendientes: number;
    } = { equiposPendientes };

    try {
      res.mikrotik = await this.mikrotik.cut(sub.id, user);
    } catch (e) {
      res.note = `No se pudo cortar en el router: ${(e as Error).message}`;
    }

    if (sub.status === 'RETIRADO' || sub.status === 'DEPURADO') {
      res.yaRetirado = true;
      return res;
    }

    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.subscriber.update({
        where: { id: sub.id },
        data: { previousStatus: sub.status ?? undefined, status: 'RETIRADO' as SubscriberStatus, statusChangedAt: now },
      }),
      this.prisma.subscriberStatusHistory.create({
        data: {
          subscriberId: sub.id,
          status: 'RETIRADO',
          date: now,
          // La fecha de la fila es la de HOY (es cuando se da la baja), y la de la
          // recogida va en el texto: si se fecha atrás, el estado del cliente no
          // puede empezar a contar desde un día en el que aún tenía servicio.
          note: `Retiro por devolución de equipo recogido el ${diaEnTexto(recogido)}`
            + `${quien ? ` (${quien})` : ''}: ${motivo}`,
        },
      }),
    ]);
    res.statusSet = 'RETIRADO';
    return res;
  }
}
