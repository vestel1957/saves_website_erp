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
import { num, round2 } from '../common/money';
import { exigirSedeSuscriptor } from '../common/sede-scope';
import { diaDelPago, pagosAnterioresAlCorte } from './pago-anterior-al-corte';

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

/**
 * Cuánto tiempo después de que este sistema tocara el pago se sigue teniendo por "de
 * este pago" una orden de reconexión. Un cuarto de hora: la reconexión se dispara
 * dentro de la misma llamada, y el margen es para el lote (una pasada del puente puede
 * reconectar a cientos y las órdenes se van creando por el camino).
 */
const VENTANA_RECONEXION_MS = 15 * 60 * 1000;

/**
 * Margen para dar por bueno un recaudo que no trae la referencia de la pasarela. Cinco
 * días: el legacy llegó a imputar un pago del portal DOS días después (abonado 55200,
 * agosto de 2026) y el cargue de pagos por Excel se sube cuando el corresponsal manda
 * el archivo, no el día del pago.
 */
const VENTANA_PARECIDO_MS = 5 * 24 * 60 * 60 * 1000;

/**
 * Hasta cuándo vale el emparejamiento por parecido.
 *
 * Es el día en que el portal pasó a preguntarle a este sistema. A partir de ahí, TODO
 * pago aplicado desde aquí lleva su referencia en el movimiento, así que un aprobado sin
 * movimiento con esa referencia es un agujero de verdad y tiene que salir en rojo.
 *
 * El corte importa: el parecido es un emparejamiento flojo (mismo abonado, mismo valor,
 * ±5 días) y podría explicar un pago del portal con un recaudo de ventanilla del mismo
 * valor, apagando justo la alarma que hay que oír. Antes del corte compensa —tapaba dos
 * falsos positivos reales—; después, no.
 */
const PARECIDO_HASTA = new Date('2026-09-10T00:00:00Z');

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
    const todas = await this.pendientesDeReconexion(dias, opts.limite ?? LOTE_RECONEXION);

    // Un pago no levanta un corte que vino DESPUÉS de él (ver `pagosAnterioresAlCorte`).
    // Se sellan como mirados para que no vuelvan en cada pasada, y no se reconecta a nadie
    // por ellos; si ese abonado trae además un pago posterior al corte, ése sí cuenta.
    const anteriores = await this.anterioresAlCorte(todas);
    if (anteriores.size) {
      this.logger.log(`${anteriores.size} pago(s) del portal anteriores al último corte del abonado: no reconectan.`);
      if (!opts.dryRun) {
        await this.prisma.paymentOrder.updateMany({
          where: { id: { in: [...anteriores] } }, data: { appliedAt: new Date() },
        });
      }
    }
    const ordenes = todas.filter((o) => !anteriores.has(o.id));
    if (!ordenes.length) {
      return {
        candidatos: 0, reconectados: 0, internet: 0, tv: 0, ordenes: 0, dryRun: false,
        abonados: [] as string[], internetIds: [] as string[], tvIds: [] as string[],
        anterioresAlCorte: anteriores.size,
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
        anterioresAlCorte: anteriores.size,
      };
    }
    if (!toca.todos.length) {
      // Nadie estaba cortado: se sellan igual, ya se miraron.
      await this.prisma.paymentOrder.updateMany({
        where: { id: { in: ordenes.map((o) => o.id) } }, data: { appliedAt: new Date() },
      });
      return { candidatos: ordenes.length, reconectados: 0, internet: 0, tv: 0, ordenes: 0, dryRun: false, abonados: [], internetIds: [], tvIds: [], anterioresAlCorte: anteriores.size };
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
      anterioresAlCorte: anteriores.size,
    };
  }

  /** Órdenes cuyo abonado fue cortado en un día posterior al del pago. */
  private async anterioresAlCorte(ordenes: { id: string; subscriberId: string; diaPago: string }[]) {
    if (!ordenes.length) return new Set<string>();
    const primerDia = ordenes.reduce((m, o) => (o.diaPago < m ? o.diaPago : m), ordenes[0].diaPago);
    const cortes = await this.prisma.ticket.findMany({
      where: {
        subscriberId: { in: [...new Set(ordenes.map((o) => o.subscriberId))] },
        status: { not: 'ANULADA' },
        type: { startsWith: 'Corte' },
        created: { gt: new Date(`${primerDia}T00:00:00Z`) },
      },
      select: { subscriberId: true, created: true },
    });
    return pagosAnterioresAlCorte(ordenes, cortes);
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
      select: { id: true, reference: true, subscriberId: true, createdAt: true, rawInit: true },
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
    return ordenes
      .filter((o) => conPlata.has(o.reference))
      .map((o) => ({ id: o.id, reference: o.reference, subscriberId: o.subscriberId, diaPago: diaDelPago(o.rawInit, o.createdAt) }));
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
          gatewayTxId: true, appliedAt: true, appliedBy: true, transactionId: true, createdAt: true,
          subscriberId: true,
          subscriber: { select: SELECT_NOMBRE },
        },
      }),
    ]);

    const recaudo = await this.recaudoDeCadaReferencia(filas.map((f) => f.reference));
    const reconectados = await this.reconexionesDe(
      filas.map((f) => ({ reference: f.reference, subscriberId: f.subscriberId, appliedAt: f.appliedAt })),
    );
    // Los aprobados que no casan por referencia: se intenta el emparejamiento por
    // parecido antes de pintarlos en rojo. Ver `emparejadasPorParecido`.
    const porParecido = await this.emparejadasPorParecido(
      filas
        .filter((f) => f.status === 'APPROVED' && !recaudo.has(f.reference))
        .map((f) => ({ reference: f.reference, subscriberId: f.subscriberId, amount: Number(f.amount), createdAt: f.createdAt })),
    );
    const items = filas.map((f) => {
      const r = recaudo.get(f.reference);
      return {
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
        // La plata: si el movimiento no está por ningún lado, el cliente pagó y sigue
        // debiendo. Es LA alarma de esta pantalla.
        aplicado: !!r || porParecido.has(f.reference),
        // Si casó por referencia (lo normal) o si hubo que emparejarlo por valor y
        // fecha, que es más flojo y la pantalla lo dice.
        porReferencia: !!r,
        // A QUÉ fue a parar: las facturas que saldó y el recibo de caja. Es lo que
        // convierte la pantalla en algo que se puede cotejar con el cliente por teléfono.
        facturas: r?.facturas ?? [],
        recibo: r?.recibo ?? null,
        // Quién imputó la plata. Sale de la columna, no de mirar el movimiento: el
        // writeback adopta el gemelo del legacy y le pone su `legacyId`, así que un
        // recaudo nacido aquí acabaría pareciendo de allá. Lo aplicado antes de que
        // existiera la columna es LEGACY por definición (lo puso la migración).
        origen: f.appliedBy ? (f.appliedBy === 'NEXUS' ? 'nexus' : 'legacy') : (r ? 'legacy' : null),
        // El servicio. Antes esto era `appliedAt` a secas, que sólo decía que el puente
        // había pasado por la orden; desde que el pago se aplica aquí, `appliedAt` lo
        // lleva TODO pago, reconecte o no, y esa columna daba por reconectado a todo el
        // mundo. Ahora se mira si de verdad nació una orden de reconexión.
        reconectado: reconectados.has(f.reference),
        // Que este sistema ya se ocupó de la orden (aplicarla y/o reconectar).
        procesado: !!f.appliedAt,
      };
    });
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

  /**
   * Segunda pasada para los que NO casan por referencia: se emparejan por abonado,
   * valor y fecha.
   *
   * Existe porque el legacy no siempre escribía `transactions.id_orden_payu`, y sin ese
   * campo un pago perfectamente imputado sale en la pantalla como "sin aplicar". Dos
   * casos reales el 2026-09-10, y los dos falsa alarma: el abonado 55200 (73.150 el
   * 3-ago, imputado en WOMPI dos días después sin referencia) y el 55793 (75.500 el
   * 10-jul, que el legacy imputó contra la cuenta BANCOLOMBIA TELECOMUNICACIONES —entró
   * por el cargue de pagos por Excel—). Con esos dos dentro, "sin aplicar" volvía a ser
   * un número al que se le puede hacer caso, que es para lo que está la pantalla.
   *
   * Los pagos que aplica ESTE sistema siempre llevan la referencia, así que esta red
   * sólo pesca histórico.
   *
   * Es un emparejamiento por parecido y se dice como tal (`porReferencia: false`): mismo
   * abonado, mismo valor al peso y dentro de la ventana. No vale para conciliar contra
   * la pasarela, vale para no dar una alarma falsa.
   */
  private async emparejadasPorParecido(
    sinReferencia: { reference: string; subscriberId: string; amount: number; createdAt: Date }[],
  ) {
    const fuera = new Set<string>();
    // Sólo el histórico: ver `PARECIDO_HASTA`.
    const candidatas = sinReferencia.filter((o) => o.createdAt < PARECIDO_HASTA);
    if (!candidatas.length) return fuera;

    const desde = new Date(Math.min(...candidatas.map((o) => o.createdAt.getTime())) - VENTANA_PARECIDO_MS);
    const hasta = new Date(Math.max(...candidatas.map((o) => o.createdAt.getTime())) + VENTANA_PARECIDO_MS);
    const movs = await this.prisma.transaction.findMany({
      where: {
        subscriberId: { in: [...new Set(candidatas.map((o) => o.subscriberId))] },
        type: 'INCOME', status: 'VIGENTE',
        date: { gte: desde, lte: hasta },
      },
      select: { subscriberId: true, credit: true, date: true },
    });
    // Un movimiento sólo puede explicar UN pago: si no, dos intentos del mismo valor se
    // taparían con el mismo recaudo y la alarma que importa se apagaría sola.
    const usados = new Set<number>();
    for (const o of candidatas) {
      const i = movs.findIndex((m, idx) =>
        !usados.has(idx)
        && m.subscriberId === o.subscriberId
        && Math.abs(num(m.credit) - o.amount) < 1
        && Math.abs(m.date.getTime() - o.createdAt.getTime()) <= VENTANA_PARECIDO_MS);
      if (i >= 0) { usados.add(i); fuera.add(o.reference); }
    }
    return fuera;
  }

  /**
   * Qué pasó con la plata de cada referencia: a qué facturas fue, con qué recibo y
   * quién la aplicó.
   *
   * Todo EN BLOQUE (tres consultas para la página entera, no tres por fila): la
   * pantalla pagina de 50 en 50 y el listado se abre muchas veces al día.
   *
   * Quién aplicó el pago NO se resuelve aquí: lo dice `PaymentOrder.appliedBy`. Mirar el
   * movimiento no serviría —el writeback adopta el gemelo del legacy y le estampa su
   * `legacyId`, así que un recaudo nacido aquí acaba pareciendo traído de allá—.
   */
  private async recaudoDeCadaReferencia(referencias: string[]) {
    // La factura viaja con su `id` Y su `tid`: la pantalla enseña el consecutivo (#505096,
    // que es lo que el cliente lee) pero `/facturacion/:id` navega por el id.
    const vacio = new Map<string, {
      aplicado: boolean; movimientoId: string | null;
      facturas: { id: string; tid: number }[]; recibo: string | null; total: number;
    }>();
    if (!referencias.length) return vacio;

    const movs = await this.prisma.transaction.findMany({
      where: { payuOrderId: { in: referencias }, status: 'VIGENTE' },
      select: {
        id: true, payuOrderId: true, credit: true,
        invoice: { select: { id: true, tid: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    if (!movs.length) return vacio;

    // El recibo de caja se comparte entre los movimientos de un mismo recaudo (un pago
    // que salda dos facturas son dos movimientos y UN recibo).
    const enlaces = await this.prisma.receiptTransaction.findMany({
      where: { transactionId: { in: movs.map((m) => m.id) } },
      select: { transactionId: true, receipt: { select: { fileName: true } } },
    });
    const reciboDe = new Map(enlaces.map((e) => [e.transactionId, e.receipt?.fileName ?? null]));

    for (const m of movs) {
      const ref = m.payuOrderId!;
      const y = vacio.get(ref) ?? {
        aplicado: true, movimientoId: m.id,
        facturas: [] as { id: string; tid: number }[], recibo: null as string | null, total: 0,
      };
      if (m.invoice?.tid) y.facturas.push({ id: m.invoice.id, tid: m.invoice.tid });
      y.total = round2(y.total + num(m.credit));
      y.recibo = y.recibo ?? reciboDe.get(m.id) ?? null;
      vacio.set(ref, y);
    }
    return vacio;
  }

  /**
   * ¿A este pago le siguió una reconexión?
   *
   * No hay vínculo guardado entre el pago y la orden —`ReconexionService` atiende a la
   * caja, al cargue por Excel y al portal, y desde la orden las tres se ven igual—, así
   * que se empareja por abonado y por tiempo: una orden de reconexión creada en el
   * cuarto de hora siguiente a que este sistema tocara el pago es de este pago.
   *
   * Es una heurística y se cuenta como tal en la pantalla ("Reconectado"), no como un
   * dato contable. Se mira sólo lo que ya está sellado (`appliedAt`): sin eso no hay
   * instante contra el que emparejar.
   */
  private async reconexionesDe(
    ordenes: { reference: string; subscriberId: string; appliedAt: Date | null }[],
  ) {
    const conSello = ordenes.filter((o) => o.appliedAt);
    const fuera = new Set<string>();
    if (!conSello.length) return fuera;

    const desde = new Date(Math.min(...conSello.map((o) => o.appliedAt!.getTime())));
    const hasta = new Date(Math.max(...conSello.map((o) => o.appliedAt!.getTime())) + VENTANA_RECONEXION_MS);
    const tickets = await this.prisma.ticket.findMany({
      where: {
        subscriberId: { in: [...new Set(conSello.map((o) => o.subscriberId))] },
        type: { startsWith: 'Reconexion' },
        createdAt: { gte: desde, lte: hasta },
      },
      select: { subscriberId: true, createdAt: true },
    });
    for (const o of conSello) {
      const t0 = o.appliedAt!.getTime();
      if (tickets.some((t) => t.subscriberId === o.subscriberId
        && t.createdAt.getTime() >= t0 && t.createdAt.getTime() <= t0 + VENTANA_RECONEXION_MS)) {
        fuera.add(o.reference);
      }
    }
    return fuera;
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
      where: { ...where, status: 'APPROVED' },
      select: { reference: true, amount: true, subscriberId: true, createdAt: true },
    });
    const conPlata = await this.aplicadasEnCartera(aprobadas.map((a) => a.reference));
    // Mismo criterio que el listado: sin esto el contador acusaba de "sin aplicar" a
    // pagos que el legacy sí imputó, sólo que sin escribir la referencia.
    const porParecido = await this.emparejadasPorParecido(
      aprobadas
        .filter((a) => !conPlata.has(a.reference))
        .map((a) => ({ reference: a.reference, subscriberId: a.subscriberId, amount: Number(a.amount), createdAt: a.createdAt })),
    );
    const sinAplicar = aprobadas.filter((a) => !conPlata.has(a.reference) && !porParecido.has(a.reference));

    return {
      aprobados: bucket('APPROVED'),
      rechazados: bucket('DECLINED'),
      abandonados: bucket('PENDING'),
      sinAplicar: { cantidad: sinAplicar.length, monto: sinAplicar.reduce((s, a) => s + Number(a.amount), 0) },
    };
  }

  /**
   * Lo que una promoción le rebajó a las facturas que saldó este pago.
   *
   * Con el portal preguntándole a este sistema, el cliente paga MENOS que su deuda
   * cuando hay una campaña vigente ([[portal-pagos]]). Quien atienda una reclamación
   * tiene que poder decir cuánto y por qué campaña sin salir de aquí.
   *
   * Se cuentan sólo las vigentes: una aplicación con `revertedAt` es un descuento que
   * se retiró después (pagó fuera de la vigencia) y sumarla mentiría.
   */
  private async descuentoDePromocion(invoiceIds: string[]) {
    if (!invoiceIds.length) return null;
    const aplicaciones = await this.prisma.promotionApplication.findMany({
      where: { invoiceId: { in: invoiceIds }, revertedAt: null },
      select: { amount: true, percentage: true, promotion: { select: { name: true } } },
    });
    if (!aplicaciones.length) return null;
    return {
      monto: round2(aplicaciones.reduce((a, b) => a + num(b.amount), 0)),
      promocion: aplicaciones[0].promotion?.name ?? null,
      porcentaje: aplicaciones[0].percentage,
    };
  }

  /** Detalle de una orden: el recaudo al que fue a parar y qué se reconectó. */
  async detail(id: string) {
    const o = await this.prisma.paymentOrder.findUnique({
      where: { id },
      select: {
        id: true, reference: true, amount: true, status: true, method: true,
        gatewayTxId: true, appliedAt: true, appliedBy: true, transactionId: true, createdAt: true,
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
            createdAt: { gte: o.appliedAt, lte: new Date(o.appliedAt.getTime() + VENTANA_RECONEXION_MS) },
          },
          select: { id: true, code: true, type: true, status: true },
          orderBy: { createdAt: 'asc' },
        })
      : [];

    const recaudo = (await this.recaudoDeCadaReferencia([o.reference])).get(o.reference) ?? null;
    // El descuento de promoción que se concedió AL COBRAR este pago: son notas crédito
    // sobre las facturas que saldó, selladas en `PromotionApplication`.
    const descuento = recaudo?.facturas.length
      ? await this.descuentoDePromocion(recaudo.facturas.map((f) => f.id))
      : null;

    return {
      ...o,
      amount: Number(o.amount),
      subscriberName: subName(o.subscriber),
      abonado: o.subscriber?.abonado ?? null,
      subscriberStatus: o.subscriber?.status ?? null,
      movimiento: movimiento ? { ...movimiento, credit: Number(movimiento.credit) } : null,
      aplicado: !!recaudo,
      facturas: recaudo?.facturas ?? [],
      recibo: recaudo?.recibo ?? null,
      origen: o.appliedBy ? (o.appliedBy === 'NEXUS' ? 'nexus' : 'legacy') : (recaudo ? 'legacy' : null),
      // Lo que se le rebajó por una promoción vigente al pagar: el cliente ve un valor
      // más bajo que su deuda y alguien tiene que poder explicar por qué.
      descuento,
      // Reconectado = nació una orden de reconexión detrás de este pago (heurística por
      // abonado y tiempo, ver `reconexionesDe`). `procesado` es otra cosa: que este
      // sistema ya tocó la orden.
      reconectado: ordenes.length > 0,
      procesado: !!o.appliedAt,
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
      /**
       * El cuerpo distingue las dos maneras de responder 200 que tiene el portal:
       * `1` es el UPDATE hecho, y el cuerpo VACÍO es el `exit()` de
       * `Communication_model::sfgsagety785625x`, o sea que la llave no cuadró y cortó
       * antes de tocar nada. Se separa aquí a propósito: la comprobación de más abajo
       * también lo caza, pero diciendo "no quedó guardada", que manda a buscar el
       * problema al lado del cliente. Pasó el 2026-09-10: al rotar el secreto del
       * portal se cambiaron PORTAL_WS_* y estos dos se quedaron con el valor viejo.
       */
      const cuerpo = (await res.text()).trim();
      if (cuerpo !== '1') {
        throw new ServiceUnavailableException(
          'El portal de pagos rechazó la llave del servidor (PORTAL_CRM_TOKEN_USUARIO / ' +
            'PORTAL_CRM_TOKEN_CLAVE). No se cambió la contraseña: avisa a soporte, es ' +
            'configuración, no el cliente.',
        );
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
