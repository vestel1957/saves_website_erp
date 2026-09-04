import mysql from 'mysql2/promise';
import { hashSync } from 'bcryptjs';
import { Logger } from '../core/logger';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/current-user.decorator';
import { ReconexionService } from '../network/reconexion.service';
import { Prisma } from '@prisma/client';
import { paginacion } from '../common/pagination-params';
import { subName } from '../common/subscriber-name';
import { BadRequestException, NotFoundException, ServiceUnavailableException } from '../core/http/errores';
import { exigirSedeSuscriptor } from '../common/sede-scope';

/**
 * Puente con el PORTAL DE PAGOS EN LÍNEA (`vestel.com.co/crm`).
 *
 * El portal es una aplicación aparte —CodeIgniter, base MySQL propia `crm_vestel`—
 * por la que entran ~1.400 pagos y ~100 M COP al mes. Su recorrido hoy es:
 *
 *   Wompi → webhook `crm/tickets/data_reception_wompi` → `pagar_mydic()`
 *         → HTTP al legacy `Servicio/pay_due_customer` → `Customers_model::pay_invoices()`
 *
 * y ahí acaba. `pay_invoices` imputa las facturas y crea el movimiento en la cuenta
 * WOMPI (acid 23), que este sistema recibe por el sync del legacy: LA PLATA SÍ SE VE
 * AQUÍ (comprobado día a día, 1 a 1). Lo que NO pasa es el servicio:
 *
 *  · Internet lo reconecta el legacy en el Mikrotik, pero SOLO si la última factura
 *    es del mes corriente (`$mes2===$mes1` en `pay_invoices`); fuera de esa ventana
 *    no hace nada de nada.
 *  · La TELEVISIÓN no la reconecta NUNCA: deja una orden `Reconexion Television` en
 *    Pendiente para que alguien vaya a la casa. Medido el 2026-08-27: 39 abonados que
 *    pagaron por el portal entre el 24 y el 27 seguían con `estadoTv = Cortado`.
 *
 * Y la reconexión automática de este sistema tampoco los alcanza, porque cuelga de
 * `CobranzasService.collect()` y sus únicos llamadores son la caja y el cargue de
 * pagos: un pago que entra por el sync no pasa por ahí y no emite ningún evento (el
 * mismo agujero que tapa `AltaService.barrerInstalacionesPagadas`).
 *
 * Este servicio cierra las dos mitades sin tocar ni el PHP del portal ni el legacy:
 *
 *  1. LEE la base del portal (solo lectura) y trae cada orden de pago a `PaymentOrder`,
 *     para que los pagos en línea existan aquí COMO TALES —con su método, su ID de
 *     Wompi y su estado— y no solo como un ingreso «Bank/WOMPI» anónimo. Eso saca a la
 *     luz lo que hoy no ve nadie: los intentos abandonados y, sobre todo, el pago
 *     aprobado en Wompi que el legacy no llegó a aplicar (raro, 1 en 30 días, pero es
 *     plata cobrada al cliente que no le bajó la deuda).
 *  2. Por cada pago APROBADO cuya plata ya está contabilizada aquí, dispara la
 *     reconexión COMPLETA de este sistema (`ReconexionService`): internet por Mikrotik
 *     y TV por TR-069 / puerto CATV de la OLT, con sus órdenes automáticas.
 *
 * La plata sigue entrando exactamente por donde entraba: aquí no se aplica ni un peso.
 */

/** Estados de `wompi_data_orden.estado` → estado de `PaymentOrder`. */
const ESTADO: Record<string, string> = {
  'Inicial': 'PENDING',
  'Finalizada con Exito': 'APPROVED',
  'Finalizada sin Exito': 'DECLINED',
};

/**
 * Cuántos días atrás mira el barrido de reconexión.
 *
 * No es un capricho: sin ventana, la primera pasada saldría a reconectar meses de
 * historia —gente que ya se retiró, que volvió a deber, o que un técnico ya atendió—.
 * Tres días cubre de sobra el hueco entre el pago y la siguiente pasada (que corre
 * cada 5 minutos) más cualquier caída del proceso durante un fin de semana.
 * La pasada RETROACTIVA de 30 días es un trabajo aparte y explícito
 * (`scripts/reconectar-pagos-portal.ts`), no algo que ocurra solo.
 */
const RECONEXION_DIAS = Number(process.env.PORTAL_PAGOS_RECONEXION_DIAS || 3);

/** Tope de filas por pasada, para que una pasada nunca se vuelva un maratón. */
const LOTE_INGESTA = 500;
const LOTE_RECONEXION = 200;

/**
 * Desde cuándo se trae historia del portal la PRIMERA vez.
 *
 * `wompi_data_orden` lleva 75.910 filas desde 2022. Traerlas todas no aporta nada
 * —la pantalla mira el mes— y ataría cada orden a un abonado que quizá ya no existe.
 */
const HISTORIA_DESDE = process.env.PORTAL_PAGOS_DESDE || '2026-07-01';

/**
 * Servicio del portal por el que se le fija la contraseña a un abonado.
 *
 * Es EXACTAMENTE el mismo que llama el legacy desde la ficha del cliente
 * (`Notas_model::update_7878` → `crm/Servicio::update_user`): así el portal sigue
 * siendo el dueño de su propia base y aquí no se le escribe una fila a mano —esta
 * aplicación abre `crm_vestel` en SOLO LECTURA y eso no cambia—.
 *
 * Los dos tokens son la llave compartida que su controlador exige antes de hacer
 * nada (`Communication_model::sfgsagety785625x`, md5 de dos frases fijas). Viven en
 * el `.env` y no en el código: es el secreto de OTRA aplicación y no tiene por qué
 * quedar escrito en este repositorio.
 */
const PORTAL_CRM_URL = process.env.PORTAL_CRM_URL || 'https://vestel.com.co/crm/servicio/';
const PORTAL_CRM_TOKEN_USUARIO = process.env.PORTAL_CRM_TOKEN_USUARIO || '';
const PORTAL_CRM_TOKEN_CLAVE = process.env.PORTAL_CRM_TOKEN_CLAVE || '';
const PORTAL_CRM_TIMEOUT_MS = 15_000;

/**
 * Coste del bcrypt: el mismo que `PASSWORD_DEFAULT` de PHP, para que un hash puesto
 * desde aquí sea indistinguible de uno puesto desde el legacy.
 *
 * El prefijo se reescribe a `$2y$` (bcryptjs emite `$2b$`). Son el mismo algoritmo
 * —cambia sólo la etiqueta— pero el `crypt_blowfish` de PHP reconoce `$2y$`, que es
 * lo que `password_verify` va a leer del otro lado.
 */
const BCRYPT_COST = 10;
const CLAVE_MIN = 6;
/** bcrypt sólo mira los primeros 72 bytes: más allá, dos claves distintas entrarían igual. */
const CLAVE_MAX = 72;

/** Campos con los que `subName` arma el nombre visible del abonado. */
const SELECT_NOMBRE = {
  abonado: true, fullName: true, firstName: true, secondName: true,
  lastName1: true, lastName2: true, companyName: true,
} as const;

/** Marca de agua de la ingesta, en `AppSetting`. Mismo patrón que `legacySync.state`. */
const CLAVE_ESTADO = 'portalPagos.state';

type EstadoPuente = { lastId?: number };

/** Fila de `crm_vestel.wompi_data_orden`. */
type OrdenPortal = {
  id: number;
  reference: string;
  debe: number;
  estado: string;
  cid_user: number;
  fecha: string;
  metodo_pago: string | null;
  id_wompi: string | null;
};

/**
 * Fila de `crm_vestel.users`: la cuenta del abonado en el portal.
 *
 * `cid` es el id del cliente en el legacy Y el nombre de usuario con el que se entra
 * (ver `credencialPortal`). La casilla del formulario dice "email" y el campo `email`
 * existe, pero el login NO lo mira.
 */
type FilaPortalUsuario = {
  users_id: number;
  cid: number;
  name: string | null;
  email: string | null;
  password: string | null;
  status: string | null;
  is_deleted: string | null;
};

export type ResumenPuente = {
  ingestadas: number;
  actualizadas: number;
  sinAbonado: number;
  reconectados: number;
  internet: number;
  tv: number;
  ordenes: number;
  dryRun: boolean;
  detalle: string;
};

export class OnlinePaymentsService {
  private readonly logger = new Logger('OnlinePaymentsService');

  constructor(
    private prisma: PrismaService,
    private reconexion: ReconexionService,
  ) {}

  /**
   * Datos de conexión al portal. Por defecto reutiliza el mismo MySQL del legacy
   * (viven en el mismo servidor y el usuario `admin_vestel` ya lee `crm_vestel`);
   * las `PORTAL_DB_*` están para el día en que el portal se mude.
   */
  private get conexion() {
    return {
      host: process.env.PORTAL_DB_HOST || process.env.LEGACY_DB_HOST || '127.0.0.1',
      port: Number(process.env.PORTAL_DB_PORT || process.env.LEGACY_DB_PORT || 3306),
      user: process.env.PORTAL_DB_USER || process.env.LEGACY_DB_USER,
      password: process.env.PORTAL_DB_PASSWORD || process.env.LEGACY_DB_PASSWORD,
      database: process.env.PORTAL_DB_NAME || 'crm_vestel',
      dateStrings: true as const,
    };
  }

  get habilitado() {
    return process.env.PORTAL_PAGOS_ENABLED === 'true';
  }

  /** Quien firma lo que hace el puente. No es una persona y no debe parecerlo. */
  private usuarioSistema(): AuthUser {
    return {
      id: 'system',
      email: 'cron@vestel',
      name: 'Sistema (pago en línea)',
      roles: [],
      permissions: ['system.admin'],
    };
  }

  private async leerEstado(): Promise<EstadoPuente> {
    const row = await this.prisma.appSetting.findUnique({ where: { key: CLAVE_ESTADO } });
    if (!row?.value) return {};
    try {
      return JSON.parse(row.value) as EstadoPuente;
    } catch {
      return {};
    }
  }

  private async guardarEstado(estado: EstadoPuente) {
    const value = JSON.stringify(estado);
    await this.prisma.appSetting.upsert({
      where: { key: CLAVE_ESTADO },
      create: { key: CLAVE_ESTADO, value },
      update: { value },
    });
  }

  // ------------------------------------------------------------------
  // 1. Ingesta: portal → PaymentOrder
  // ------------------------------------------------------------------

  /**
   * Trae del portal las órdenes nuevas y RELEE las que aquí siguen en PENDING.
   *
   * Lo segundo importa tanto como lo primero: la fila nace en `Inicial` cuando el
   * cliente pulsa "Pagar" y solo cambia de estado cuando Wompi devuelve el webhook,
   * minutos después. Sin la relectura, todo pago aprobado quedaría aquí como intento
   * abandonado para siempre.
   */
  async ingest(): Promise<{ ingestadas: number; actualizadas: number; sinAbonado: number }> {
    const estado = await this.leerEstado();
    const cn = await mysql.createConnection(this.conexion);
    let filas: OrdenPortal[] = [];
    try {
      const [nuevas] = estado.lastId
        ? await cn.query<any[]>(
            'SELECT id, reference, debe, estado, cid_user, fecha, metodo_pago, id_wompi ' +
              'FROM wompi_data_orden WHERE id > ? ORDER BY id ASC LIMIT ?',
            [estado.lastId, LOTE_INGESTA],
          )
        : await cn.query<any[]>(
            'SELECT id, reference, debe, estado, cid_user, fecha, metodo_pago, id_wompi ' +
              'FROM wompi_data_orden WHERE fecha >= ? ORDER BY id ASC LIMIT ?',
            [HISTORIA_DESDE, LOTE_INGESTA],
          );
      filas = nuevas as OrdenPortal[];

      // Relectura de las que aquí siguen sin resolver (por referencia, no por id: es
      // la única llave que comparten los dos sistemas).
      const pendientes = await this.prisma.paymentOrder.findMany({
        // 15 días: el webhook de Wompi llega en minutos, así que lo que sigue abierto
        // pasada esa raya es un intento abandonado y no va a cambiar nunca más.
        where: { gateway: 'wompi', status: 'PENDING', createdAt: { gte: this.desdeDias(15) } },
        select: { reference: true },
        orderBy: { createdAt: 'desc' },
        take: LOTE_INGESTA,
      });
      if (pendientes.length) {
        const [releidas] = await cn.query<any[]>(
          'SELECT id, reference, debe, estado, cid_user, fecha, metodo_pago, id_wompi ' +
            'FROM wompi_data_orden WHERE reference IN (?)',
          [pendientes.map((p) => p.reference)],
        );
        filas = filas.concat(releidas as OrdenPortal[]);
      }
    } finally {
      await cn.end();
    }

    if (!filas.length) return { ingestadas: 0, actualizadas: 0, sinAbonado: 0 };

    // El `cid_user` del portal es `customers.id` del legacy, que aquí es
    // `Subscriber.legacyId`. Se resuelve en bloque: una consulta, no una por fila.
    const legacyIds = [...new Set(filas.map((f) => Number(f.cid_user)).filter(Boolean))];
    const abonados = await this.prisma.subscriber.findMany({
      where: { legacyId: { in: legacyIds } },
      select: { id: true, legacyId: true },
    });
    const porLegacy = new Map(abonados.map((s) => [s.legacyId!, s.id]));

    let sinAbonado = 0;
    let maxId = estado.lastId ?? 0;

    const preparadas = [];
    for (const f of filas) {
      maxId = Math.max(maxId, Number(f.id));
      const subscriberId = porLegacy.get(Number(f.cid_user));
      if (!subscriberId) {
        // Pasa con fichas depuradas del legacy. Se cuenta y se sigue: `PaymentOrder`
        // exige abonado y no vamos a inventar uno.
        sinAbonado++;
        continue;
      }
      preparadas.push({
        reference: f.reference,
        subscriberId,
        gateway: 'wompi',
        method: f.metodo_pago || null,
        amount: Number(f.debe),
        currency: 'COP',
        status: ESTADO[f.estado] ?? 'PENDING',
        gatewayTxId: f.id_wompi || null,
        rawInit: { portalId: Number(f.id), estadoPortal: f.estado, fecha: f.fecha, cidUser: Number(f.cid_user) },
        createdAt: new Date(f.fecha),
      });
    }

    // En BLOQUE, no fila a fila: la primera carga son 8.000 órdenes y el barrido
    // relee cientos de intentos abiertos en cada pasada. Con un `findUnique` + un
    // `update` por fila eso son ~17.000 idas y vueltas a Postgres, que es la
    // diferencia entre una pasada de segundos y una de minutos.
    const existentes = new Map(
      (await this.prisma.paymentOrder.findMany({
        where: { reference: { in: preparadas.map((p) => p.reference) } },
        select: { reference: true, status: true, gatewayTxId: true },
      })).map((e) => [e.reference, e]),
    );

    const nuevas = preparadas.filter((p) => !existentes.has(p.reference));
    if (nuevas.length) await this.prisma.paymentOrder.createMany({ data: nuevas, skipDuplicates: true });

    // Solo se reescribe lo que de verdad cambió: la inmensa mayoría de las relecturas
    // son intentos que siguen exactamente igual.
    const cambiadas = preparadas.filter((p) => {
      const e = existentes.get(p.reference);
      return e && (e.status !== p.status || (p.gatewayTxId && e.gatewayTxId !== p.gatewayTxId));
    });
    for (const c of cambiadas) {
      const { reference, createdAt, ...datos } = c;
      await this.prisma.paymentOrder.update({ where: { reference }, data: datos });
    }
    const ingestadas = nuevas.length;
    const actualizadas = cambiadas.filter((c) => existentes.get(c.reference)!.status !== c.status).length;

    if (maxId > (estado.lastId ?? 0)) await this.guardarEstado({ ...estado, lastId: maxId });
    return { ingestadas, actualizadas, sinAbonado };
  }

  private desdeDias(dias: number) {
    return new Date(Date.now() - dias * 24 * 60 * 60 * 1000);
  }

  // ------------------------------------------------------------------
  // 2. Reconexión de lo aprobado
  // ------------------------------------------------------------------

  /**
   * Reconecta a quien pagó por el portal y sigue cortado.
   *
   * Solo entran los pagos APROBADOS **cuya plata ya está contabilizada aquí** —el
   * movimiento del legacy llegó por el sync y trae la referencia en `payuOrderId`—.
   * La condición no es burocracia: si el legacy no llegó a aplicar el pago, el cliente
   * sigue debiendo y reconectarlo sería regalar el servicio; ese caso sale en la
   * pantalla como "aprobado sin aplicar" para que alguien lo mire.
   *
   * `appliedAt` marca "el puente ya se ocupó de esta orden" y es lo que impide
   * reconectar dos veces al mismo abonado en pasadas seguidas.
   *
   * @param dias  ventana hacia atrás. El cron usa `RECONEXION_DIAS`; la pasada
   *              retroactiva la abre a mano.
   */
  async reconectar(opts: { dias?: number; dryRun?: boolean; limite?: number } = {}) {
    const dias = opts.dias ?? RECONEXION_DIAS;
    const ordenes = await this.pendientesDeReconexion(dias, opts.limite ?? LOTE_RECONEXION);
    if (!ordenes.length) {
      return {
        candidatos: 0, reconectados: 0, internet: 0, tv: 0, ordenes: 0, dryRun: false,
        abonados: [] as string[], internetIds: [] as string[], tvIds: [] as string[],
      };
    }

    const subscriberIds = [...new Set(ordenes.map((o) => o.subscriberId))];

    // La inmensa mayoría de quienes pagan por el portal están al día: pagan su factura
    // del mes y no hay nada que reconectarles. Se le pregunta a `ReconexionService`
    // —el único que decide quién está cortado— antes de mandarle el lote entero, para
    // que lo que se anuncia en una simulación sea EXACTAMENTE lo que va a pasar.
    const toca = await this.reconexion.aQuienLeToca(subscriberIds);
    if (opts.dryRun) {
      return {
        candidatos: ordenes.length, reconectados: 0,
        internet: toca.internet.length, tv: toca.tv.length + toca.tvSinEquipo.length,
        ordenes: 0, dryRun: true, abonados: toca.todos,
        internetIds: toca.internet, tvIds: [...toca.tv, ...toca.tvSinEquipo],
      };
    }
    if (!toca.todos.length) {
      // Nadie estaba cortado: se sellan igual, ya se miraron.
      await this.prisma.paymentOrder.updateMany({
        where: { id: { in: ordenes.map((o) => o.id) } }, data: { appliedAt: new Date() },
      });
      return { candidatos: ordenes.length, reconectados: 0, internet: 0, tv: 0, ordenes: 0, dryRun: false, abonados: [], internetIds: [], tvIds: [] };
    }

    // En lote a propósito: reconectar de a uno abre una conexión al router y una
    // sesión SSH a la OLT por pago (ver el porqué en `ReconexionService.porPagoLote`).
    const r = await this.reconexion.porPagoLote(toca.todos, this.usuarioSistema());

    // Se sella DESPUÉS del intento. Si la reconexión falla, `ReconexionService` ya deja
    // la orden de servicio abierta: volver a intentarlo en la pasada siguiente solo
    // duplicaría trabajo contra unos equipos que ya dijeron que no.
    await this.prisma.paymentOrder.updateMany({
      where: { id: { in: ordenes.map((o) => o.id) } },
      data: { appliedAt: new Date() },
    });

    return {
      candidatos: ordenes.length,
      reconectados: r.internet + r.tv,
      internet: r.internet,
      tv: r.tv,
      ordenes: r.ordenes,
      dryRun: r.dryRun,
      abonados: toca.todos,
      internetIds: toca.internet,
      tvIds: [...toca.tv, ...toca.tvSinEquipo],
    };
  }

  /** Órdenes aprobadas, con la plata ya contabilizada aquí, que el puente no ha tocado. */
  private async pendientesDeReconexion(dias: number, limite: number) {
    const ordenes = await this.prisma.paymentOrder.findMany({
      where: {
        gateway: 'wompi',
        status: 'APPROVED',
        appliedAt: null,
        createdAt: { gte: this.desdeDias(dias) },
      },
      select: { id: true, reference: true, subscriberId: true },
      orderBy: { createdAt: 'asc' },
      take: limite,
    });
    if (!ordenes.length) return [];

    const movimientos = await this.prisma.transaction.findMany({
      where: { payuOrderId: { in: ordenes.map((o) => o.reference) } },
      select: { id: true, payuOrderId: true },
    });
    const conPlata = new Map(movimientos.map((t) => [t.payuOrderId!, t.id]));

    // De paso se deja apuntado el recaudo al que corresponde cada orden: es lo que la
    // pantalla enseña al abrir el detalle.
    for (const o of ordenes) {
      const txId = conPlata.get(o.reference);
      if (txId) await this.prisma.paymentOrder.update({ where: { id: o.id }, data: { transactionId: txId } });
    }
    return ordenes.filter((o) => conPlata.has(o.reference));
  }

  // ------------------------------------------------------------------
  // Pasada completa (la que dispara el cron)
  // ------------------------------------------------------------------

  async sincronizar(opts: { dryRun?: boolean } = {}): Promise<ResumenPuente> {
    const ing = await this.ingest();
    const rec = await this.reconectar({ dryRun: opts.dryRun });
    const detalle =
      `${ing.ingestadas} orden(es) nuevas · ${ing.actualizadas} con estado nuevo` +
      (ing.sinAbonado ? ` · ${ing.sinAbonado} sin abonado` : '') +
      ` · ${rec.candidatos} pago(s) a reconectar` +
      (rec.candidatos ? ` (internet ${rec.internet}, TV ${rec.tv}, ${rec.ordenes} orden/es de visita)` : '') +
      (rec.dryRun ? ' · SIMULACIÓN' : '');
    if (rec.candidatos) this.logger.log(`[pagos-en-linea] ${detalle}`);
    return {
      ingestadas: ing.ingestadas,
      actualizadas: ing.actualizadas,
      sinAbonado: ing.sinAbonado,
      reconectados: rec.reconectados,
      internet: rec.internet,
      tv: rec.tv,
      ordenes: rec.ordenes,
      dryRun: rec.dryRun,
      detalle,
    };
  }

  // ------------------------------------------------------------------
  // Consulta (la pantalla /tesoreria/pagos-en-linea)
  // ------------------------------------------------------------------

  /**
   * Listado de pagos del portal.
   *
   * `estado` acepta además del estado de la pasarela un cuarto valor propio,
   * `SIN_APLICAR`: aprobado por Wompi y sin movimiento en cartera. No es un estado del
   * portal, es el cruce que nadie estaba haciendo — y es el único de los cuatro donde
   * hay plata cobrada al cliente que no le bajó la deuda.
   */
  async list(params: {
    estado?: string; search?: string; from?: string; to?: string;
    page?: number; pageSize?: number;
  }) {
    const { page, pageSize, skip, take } = paginacion(params);
    const where: Prisma.PaymentOrderWhereInput = { gateway: 'wompi' };
    if (params.from || params.to) {
      where.createdAt = {
        ...(params.from ? { gte: new Date(`${params.from}T00:00:00`) } : {}),
        ...(params.to ? { lte: new Date(`${params.to}T23:59:59.999`) } : {}),
      };
    }
    if (params.estado && params.estado !== 'TODOS' && params.estado !== 'SIN_APLICAR') {
      where.status = params.estado;
    }
    if (params.estado === 'SIN_APLICAR') where.status = 'APPROVED';
    if (params.search?.trim()) {
      const q = params.search.trim();
      const abonado = Number(q.replace(/\D/g, ''));
      where.OR = [
        { reference: { contains: q, mode: 'insensitive' } },
        { gatewayTxId: { contains: q, mode: 'insensitive' } },
        { subscriber: { fullName: { contains: q, mode: 'insensitive' } } },
        { subscriber: { companyName: { contains: q, mode: 'insensitive' } } },
        ...(Number.isFinite(abonado) && abonado > 0 ? [{ subscriber: { abonado } }] : []),
      ];
    }

    const [total, filas] = await Promise.all([
      this.prisma.paymentOrder.count({ where }),
      this.prisma.paymentOrder.findMany({
        where, orderBy: { createdAt: 'desc' }, skip, take,
        select: {
          id: true, reference: true, amount: true, status: true, method: true,
          gatewayTxId: true, appliedAt: true, transactionId: true, createdAt: true,
          subscriberId: true,
          subscriber: { select: SELECT_NOMBRE },
        },
      }),
    ]);

    const aplicadas = await this.aplicadasEnCartera(filas.map((f) => f.reference));
    const items = filas.map((f) => ({
      id: f.id,
      reference: f.reference,
      amount: Number(f.amount),
      status: f.status,
      method: f.method,
      gatewayTxId: f.gatewayTxId,
      fecha: f.createdAt,
      subscriberId: f.subscriberId,
      abonado: f.subscriber?.abonado ?? null,
      subscriberName: subName(f.subscriber),
      // La plata: si el movimiento no está, el cliente pagó y sigue debiendo.
      aplicado: aplicadas.has(f.reference),
      // El servicio: si el puente ya se ocupó de devolvérselo.
      reconectado: !!f.appliedAt,
    }));
    const visibles = params.estado === 'SIN_APLICAR' ? items.filter((i) => !i.aplicado) : items;
    return { items: visibles, total, page, pageSize, pages: Math.ceil(total / pageSize) };
  }

  /** Referencias que YA tienen su movimiento de caja aquí. */
  private async aplicadasEnCartera(referencias: string[]) {
    if (!referencias.length) return new Set<string>();
    const movs = await this.prisma.transaction.findMany({
      where: { payuOrderId: { in: referencias } },
      select: { payuOrderId: true },
    });
    return new Set(movs.map((m) => m.payuOrderId!).filter(Boolean));
  }

  /** Cifras de cabecera de la pantalla, sobre la ventana pedida. */
  async summary(params: { from?: string; to?: string }) {
    const where: Prisma.PaymentOrderWhereInput = { gateway: 'wompi' };
    if (params.from || params.to) {
      where.createdAt = {
        ...(params.from ? { gte: new Date(`${params.from}T00:00:00`) } : {}),
        ...(params.to ? { lte: new Date(`${params.to}T23:59:59.999`) } : {}),
      };
    }
    const grupos = await this.prisma.paymentOrder.groupBy({
      by: ['status'], where, _count: { _all: true }, _sum: { amount: true },
    });
    const de = (s: string) => grupos.find((g) => g.status === s);
    const bucket = (s: string) => ({
      cantidad: de(s)?._count._all ?? 0,
      monto: Number(de(s)?._sum.amount ?? 0),
    });

    // Los aprobados que no llegaron a cartera. Es el número que justifica la pantalla:
    // si algún día deja de ser ~0, hay plata cobrada que nadie está viendo.
    const aprobadas = await this.prisma.paymentOrder.findMany({
      where: { ...where, status: 'APPROVED' }, select: { reference: true, amount: true },
    });
    const conPlata = await this.aplicadasEnCartera(aprobadas.map((a) => a.reference));
    const sinAplicar = aprobadas.filter((a) => !conPlata.has(a.reference));

    return {
      aprobados: bucket('APPROVED'),
      rechazados: bucket('DECLINED'),
      abandonados: bucket('PENDING'),
      sinAplicar: { cantidad: sinAplicar.length, monto: sinAplicar.reduce((s, a) => s + Number(a.amount), 0) },
    };
  }

  /** Detalle de una orden: el recaudo al que fue a parar y qué se reconectó. */
  async detail(id: string) {
    const o = await this.prisma.paymentOrder.findUnique({
      where: { id },
      select: {
        id: true, reference: true, amount: true, status: true, method: true,
        gatewayTxId: true, appliedAt: true, transactionId: true, createdAt: true,
        rawInit: true, subscriberId: true,
        subscriber: { select: { ...SELECT_NOMBRE, status: true } },
      },
    });
    if (!o) throw new NotFoundException('No existe ese pago en línea.');

    const movimiento = await this.prisma.transaction.findFirst({
      where: { payuOrderId: o.reference },
      select: { id: true, credit: true, date: true, note: true, invoiceId: true, method: true },
    });
    // Las órdenes de reconexión que salieron de este pago: se buscan por abonado y
    // fecha porque `ReconexionService` no guarda de qué pago vino (viene de la caja,
    // del cargue por Excel o de aquí, y todas se ven igual desde la orden).
    const ordenes = o.appliedAt
      ? await this.prisma.ticket.findMany({
          where: {
            subscriberId: o.subscriberId,
            type: { startsWith: 'Reconexion' },
            createdAt: { gte: o.appliedAt, lte: new Date(o.appliedAt.getTime() + 10 * 60 * 1000) },
          },
          select: { id: true, code: true, type: true, status: true },
          orderBy: { createdAt: 'asc' },
        })
      : [];

    return {
      ...o,
      amount: Number(o.amount),
      subscriberName: subName(o.subscriber),
      abonado: o.subscriber?.abonado ?? null,
      subscriberStatus: o.subscriber?.status ?? null,
      movimiento: movimiento ? { ...movimiento, credit: Number(movimiento.credit) } : null,
      aplicado: !!movimiento,
      reconectado: !!o.appliedAt,
      ordenes,
    };
  }

  // ------------------------------------------------------------------
  // 3. Contraseña del abonado en el PORTAL (migra `customers/changepassword`)
  // ------------------------------------------------------------------

  /**
   * Lee un usuario del portal por su `cid`. Solo lectura, como todo lo demás.
   *
   * Se ordena por `users_id` ASC a propósito: si algún día hubiera dos filas con el
   * mismo `cid`, el login del portal se queda con la primera que devuelve la
   * consulta (`User_model::auth_user()` usa `$result[0]`), así que esa es la que
   * manda y la que hay que enseñar. Hoy no hay ninguna repetida.
   */
  private async filaPortal(cid: number): Promise<FilaPortalUsuario | null> {
    const cn = await mysql.createConnection(this.conexion);
    try {
      const [filas] = await cn.query<any[]>(
        'SELECT users_id, cid, name, email, password, status, is_deleted ' +
          'FROM users WHERE cid = ? ORDER BY users_id ASC LIMIT 1',
        [cid],
      );
      return (filas[0] as FilaPortalUsuario) ?? null;
    } finally {
      await cn.end();
    }
  }

  /**
   * ¿Tiene este abonado cuenta en el portal de pagos, y con qué usuario entra?
   *
   * EL USUARIO ES EL `cid`, es decir el id del cliente en el legacy —no el correo,
   * no el número de abonado y no el documento—. Está en el propio login del portal:
   * `User_model::auth_user()` consulta `where is_deleted='0' AND cid='$email'` sobre
   * la casilla que en pantalla se llama "email". Es la pregunta que llega a la
   * ventanilla ("¿cuál es mi usuario?") y hasta ahora había que ir a buscarla al
   * otro sistema.
   *
   * Por lo mismo, un cliente creado aquí y que todavía no ha viajado al legacy no
   * puede tener clave: no tendría usuario con el que entrar.
   */
  async credencialPortal(subscriberId: string, user: AuthUser) {
    await exigirSedeSuscriptor(this.prisma, user, subscriberId);
    const sub = await this.prisma.subscriber.findUnique({
      where: { id: subscriberId },
      select: { id: true, legacyId: true, email: true, ...SELECT_NOMBRE },
    });
    if (!sub) throw new NotFoundException('El cliente no existe');

    const ultimo = await this.prisma.auditLog.findFirst({
      where: { entity: 'Subscriber', entityId: subscriberId, action: 'PORTAL_PASSWORD' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true, user: { select: { name: true } } },
    });
    const cambio = ultimo
      ? { fecha: ultimo.createdAt, porQuien: ultimo.user?.name ?? null }
      : null;

    if (sub.legacyId == null) {
      return {
        usuario: null,
        tieneCuenta: false,
        puede: false,
        motivo:
          'Este cliente todavía no existe en el sistema anterior, y el usuario del portal es ' +
          'justamente ese número. Podrá tener clave en cuanto el alta viaje allá.',
        nombre: subName(sub),
        email: sub.email ?? null,
        activa: false,
        ultimoCambio: cambio,
      };
    }

    const fila = await this.filaPortal(sub.legacyId);
    return {
      usuario: String(sub.legacyId),
      tieneCuenta: !!fila,
      puede: true,
      motivo: null,
      nombre: fila?.name?.trim() || subName(sub),
      email: fila?.email?.trim() || sub.email || null,
      /**
       * El portal exige `status='active'` e `is_deleted='0'` para dejar entrar. Hoy
       * las 7.143 cuentas cumplen las dos, pero si alguna no lo hiciera, cambiarle la
       * clave no la dejaría entrar y hay que decirlo en vez de dar el cambio por
       * bueno: `update_user` no toca esos dos campos cuando la fila ya existe.
       */
      activa: !fila || (fila.status === 'active' && String(fila.is_deleted ?? '0') === '0'),
      ultimoCambio: cambio,
    };
  }

  /**
   * Le fija al abonado la contraseña con la que entra a pagar en línea.
   *
   * Hace lo mismo que el botón "Change Password" de la ficha del legacy y por el
   * mismo camino: se calcula el bcrypt aquí y se manda al servicio del portal, que
   * inserta la cuenta si no existía y la actualiza si ya estaba. NO se escribe en
   * `crm_vestel` desde este sistema.
   *
   * Dos cosas que el legacy no hacía y aquí sí:
   *
   *  · **Se comprueba que quedó.** `Servicio::update_user` responde `1` con sólo
   *    haber ejecutado el UPDATE, y responde 200 hasta cuando la llave no cuadra y
   *    corta la petición antes de tocar nada. Así que después de escribir se vuelve
   *    a leer la fila y se compara el hash: si no coincide, esto es un error, no un
   *    "listo" que el cliente descubre al no poder entrar.
   *  · **Queda registrado quién la cambió** (`AuditLog`), que es lo que se pregunta
   *    cuando un cliente dice que su clave dejó de servir. La clave en sí no se
   *    guarda en ningún sitio, ni en claro ni cifrada.
   */
  async cambiarClavePortal(subscriberId: string, claveCruda: string, user: AuthUser) {
    await exigirSedeSuscriptor(this.prisma, user, subscriberId);
    const sub = await this.prisma.subscriber.findUnique({
      where: { id: subscriberId },
      select: { id: true, legacyId: true, email: true, ...SELECT_NOMBRE },
    });
    if (!sub) throw new NotFoundException('El cliente no existe');
    if (sub.legacyId == null) {
      throw new BadRequestException(
        'Este cliente todavía no existe en el sistema anterior, y el usuario del portal es ese ' +
          'número. Podrá tener clave en cuanto el alta viaje allá.',
      );
    }
    if (!PORTAL_CRM_TOKEN_USUARIO || !PORTAL_CRM_TOKEN_CLAVE) {
      throw new ServiceUnavailableException(
        'Falta la llave del portal en la configuración del servidor (PORTAL_CRM_TOKEN_USUARIO / PORTAL_CRM_TOKEN_CLAVE).',
      );
    }

    /**
     * Se recortan los espacios de los extremos: la clave se dicta en la ventanilla y
     * un espacio final invisible es una llamada de soporte garantizada. Los de en
     * medio se respetan.
     */
    const clave = (claveCruda ?? '').trim();
    if (clave.length < CLAVE_MIN || clave.length > CLAVE_MAX) {
      throw new BadRequestException(`La contraseña debe tener entre ${CLAVE_MIN} y ${CLAVE_MAX} caracteres.`);
    }
    /**
     * Sólo ASCII imprimible. No es purismo: fuera de ese rango el bcrypt de PHP y el
     * de aquí dejan de ser intercambiables byte a byte, y la clave con tilde que se
     * fija hoy podría no abrir mañana. Mejor negarla al teclearla que después.
     */
    if (!/^[\x20-\x7E]+$/.test(clave)) {
      throw new BadRequestException(
        'La contraseña sólo admite letras sin tilde, números y signos corrientes (no lleva ñ ni acentos).',
      );
    }

    const hash = '$2y$' + hashSync(clave, BCRYPT_COST).slice(4);
    const previa = await this.filaPortal(sub.legacyId);

    /**
     * `update_user` pisa nombre y correo con lo que le llegue, así que lo que no
     * tengamos aquí se le devuelve tal cual estaba: cambiar una clave no puede
     * vaciarle el correo a la cuenta del portal.
     */
    const nombre = subName(sub) || previa?.name?.trim() || '';
    const email = (sub.email ?? '').trim() || previa?.email || '';
    const autor = await this.prisma.staff.findFirst({
      where: { email: { equals: user.email, mode: 'insensitive' } },
      select: { legacyId: true },
    });

    const ctrl = new AbortController();
    const reloj = setTimeout(() => ctrl.abort(), PORTAL_CRM_TIMEOUT_MS);
    try {
      const res = await fetch(`${PORTAL_CRM_URL.replace(/\/+$/, '')}/update_user`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json;charset=utf-8', Accept: 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify({
          '24q5ewqas': PORTAL_CRM_TOKEN_USUARIO,
          '112415qwturf': PORTAL_CRM_TOKEN_CLAVE,
          cid: sub.legacyId,
          name: nombre,
          email,
          ps: hash,
          userid: String(autor?.legacyId ?? ''),
        }),
      });
      if (!res.ok) {
        throw new ServiceUnavailableException(`El portal de pagos respondió ${res.status}. No se cambió la contraseña.`);
      }
    } catch (e: any) {
      if (e instanceof ServiceUnavailableException) throw e;
      const causa = e?.name === 'AbortError' ? 'no respondió a tiempo' : 'no se pudo contactar';
      throw new ServiceUnavailableException(`El portal de pagos ${causa}. No se cambió la contraseña.`);
    } finally {
      clearTimeout(reloj);
    }

    // La comprobación: el portal contesta 200 aunque no haya hecho nada.
    const ahora = await this.filaPortal(sub.legacyId);
    if (!ahora || ahora.password !== hash) {
      throw new ServiceUnavailableException(
        'El portal aceptó la petición pero la contraseña no quedó guardada. Avisa a soporte antes de dársela al cliente.',
      );
    }

    try {
      await this.prisma.auditLog.create({
        data: {
          action: 'PORTAL_PASSWORD',
          entity: 'Subscriber',
          entityId: subscriberId,
          userId: user.id && user.id !== 'system' ? user.id : null,
          // Nunca la clave: sólo a qué cuenta del portal se le cambió y si nació aquí.
          after: { usuario: String(sub.legacyId), creada: !previa },
        },
      });
    } catch (e) {
      this.logger.warn(`No se pudo auditar el cambio de clave del portal (${subscriberId}): ${(e as Error).message}`);
    }

    return {
      ok: true,
      usuario: String(sub.legacyId),
      creada: !previa,
      activa: ahora.status === 'active' && String(ahora.is_deleted ?? '0') === '0',
    };
  }
}
