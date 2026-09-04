import { Logger } from '../core/logger';
import { SubscriberStatus } from '@prisma/client';
import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { FacturasService } from '../billing/facturas.service';
import { MailService } from '../common/mail/mail.service';
import { WhatsappRemindersService } from '../common/whatsapp/whatsapp-reminders.service';
import { AuthUser } from '../auth/current-user.decorator';
import { MetricsService } from '../reports/metrics.service';
import { ResponsibilityNotifierService } from '../responsibilities/responsibility-notifier.service';
import { OnlinePaymentsService } from '../online-payments/online-payments.service';
import { AltaClienteService } from '../subscribers/alta.service';
import { inicioDelMes, whereExigible } from '../billing/factura-exigible';
import { arrastrarAlDiaDeHoy } from '../support/agenda-arrastre';
import { hoyEnColombia } from '../common/fecha-colombia';
import { barrerDescuentosDelPortal, PORTAL_PRECONCEDER_LIVE } from '../promotions/descuento-portal';

const cop = (n: number) => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n || 0);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Todas las programadas se anclan a la hora de Colombia, no a la TZ del servidor.
// Sin esto, "día 1 a las 02:00" se corría en la zona del SO: facturar o pasar a
// cartera en la hora equivocada (incluso el día equivocado) es un riesgo fiscal.
const TZ = 'America/Bogota';

/** Cuántas facturas pendientes se toleran antes de mandar al abonado a Cartera.
 *  Con 2, el paso ocurre al llegar a la TERCERA sin pagar. Configurable en
 *  `AppSetting['cartera.maxFacturasPendientes']`. */
const MAX_FACTURAS_PENDIENTES = 2;

/** Estados desde los que un abonado puede caer en Cartera por deuda.
 *
 *  Quedan fuera a propósito: RETIRADO / DEPURADO / POR_RETIRAR / INACTIVO (ya
 *  dados de baja — una deuda vieja no los reclasifica), EXONERADO / EVENTO /
 *  INSTALAR (no deben plata por servicio) y REPORTADO (ese corte ya escaló a
 *  centrales de riesgo; devolverlo a Cartera perdería esa información). */
const ESTADOS_QUE_CAEN_EN_CARTERA: SubscriberStatus[] = ['ACTIVO', 'COMPROMISO', 'CORTADO'];

/** Días que se guardan los latidos de ubicación. Ver `runGeoPurge`. */
const RETENCION_LATIDOS_D = 90;

/**
 * Automatizaciones programadas — porta `Cronjob.php` del legacy saves-vestel:
 *   · RECURRING_BILLING → genera las facturas recurrentes del mes (desde el plan).
 *   · CARTERA           → pasa a "Cartera" a quien deba más de N facturas.
 *   · EXCHANGE_RATE      → actualización de tasa (stub; la operación es en COP).
 *
 * ⚠️ Las tareas PROGRAMADAS solo corren si `CRONS_ENABLED=true` (evita generar
 * miles de facturas sin querer en un entorno de trabajo). El disparo MANUAL vía
 * endpoint siempre ejecuta (acción explícita de un usuario). Todo queda auditado
 * en `CronRun`.
 */
export class CronService {
  private readonly logger = new Logger('CronService');
  private readonly enabled = process.env.CRONS_ENABLED === 'true';

  constructor(
    private prisma: PrismaService,
    private facturas: FacturasService,
    private mail: MailService,
    private waReminders: WhatsappRemindersService,
    private metrics: MetricsService,
    private notifier: ResponsibilityNotifierService,
    private alta: AltaClienteService,
    private pagosEnLinea: OnlinePaymentsService,
  ) {}

  get isEnabled() {
    return this.enabled;
  }

  private systemUser(name = 'Cron'): AuthUser {
    return { id: 'system', email: 'cron@vestel', name, roles: [], permissions: ['system.admin'] };
  }

  /** Tope de facturas pendientes tolerado antes de pasar a Cartera. Se acota a
   *  1..12: en 0 mandaría a Cartera a todo el que tenga la factura del mes
   *  todavía sin pagar, y por encima de 12 la tarea deja de servir de algo. */
  private async maxFacturasPendientes(): Promise<number> {
    const row = await this.prisma.appSetting.findUnique({ where: { key: 'cartera.maxFacturasPendientes' } });
    const n = Number(row?.value);
    return Number.isFinite(n) && n >= 1 && n <= 12 ? Math.trunc(n) : MAX_FACTURAS_PENDIENTES;
  }

  // ------------------------------------------------------------------
  // Programadas
  // ------------------------------------------------------------------
  /**
   * Día 1 de cada mes, 02:00 — factura recurrente del MES CORRIENTE.
   *
   * Cada mes lleva su factura: el 1 de septiembre nace la de septiembre, con
   * vencimiento el día 20 de ese mismo mes. Es lo que hacía el legacy y a lo que se
   * volvió el 2026-09-01.
   *
   * Entre el 2026-08-28 y el 2026-09-01 se probó emitir el mes SIGUIENTE (el 1 de
   * agosto la de septiembre) para premiar con un 5% a quien pagara antes de que el mes
   * empezara. Se revirtió por dos motivos: el cliente quedaba con dos mensualidades
   * abiertas a la vez, y sobre todo porque cambiar el mes que se factura SIN una
   * corrida puente deja un mes sin emitir. Eso fue justo lo que pasó: la corrida del
   * 1 de agosto salió con la regla vieja (agosto) y la del 1 de septiembre con la
   * nueva (octubre), y septiembre no lo facturó nadie — 4.875 abonados, ~333 M COP.
   *
   * ⚠️ Si algún día vuelve a moverse el mes que se factura, la corrida puente del mes
   * que queda en medio va en el MISMO despliegue. No es opcional.
   *
   * La corrida del legacy queda de red de seguridad: su `generar_facturas_logica`
   * salta al cliente que ya tiene factura de ese mes (`Invoices_model.php:1157`), así
   * que si corre encontrará la nuestra y no duplicará — siempre que el writeback ya
   * la haya empujado allá.
   */
  async scheduledRecurringBilling() {
    if (!this.enabled) return this.logger.log('[recurring-billing] omitido (CRONS_ENABLED != true)');
    await this.runRecurringBilling({ manual: false });
  }

  /**
   * Diario 00:20 (hora de Colombia) — la FOTO del día que acaba de cerrar.
   *
   * Corre ANTES que los demás y de madrugada a propósito: fotografía el día anterior
   * ya terminado, antes de que el paso a Cartera de las 03:00 y la facturación
   * recurrente muevan los estados. Si se hiciera después, la foto del día 30 llevaría
   * ya los cambios del 31.
   *
   * A diferencia del resto de tareas, esta corre AUNQUE `CRONS_ENABLED` esté en false:
   * no toca nada, solo lee y guarda un puñado de cifras. Apagarla no evita ningún
   * riesgo y en cambio abre un hueco en el histórico que NO se puede rellenar después
   * — la foto de un día perdido no se recupera.
   */
  async scheduledMetrics() {
    await this.runMetrics({ manual: false });
  }

  async runMetrics(opts: { manual: boolean; user?: AuthUser; fecha?: string }) {
    const run = await this.prisma.cronRun.create({
      data: { job: 'METRICS_SNAPSHOT', ok: false, manual: opts.manual, userName: opts.user?.name ?? 'Cron' },
    });
    try {
      // Sin fecha explícita: AYER en hora de Colombia (el día cerrado).
      const fecha = opts.fecha ?? new Date(Date.now() - 86400_000).toLocaleDateString('en-CA', { timeZone: TZ });
      const r = await this.metrics.fotoDelDia(fecha);
      const detail = `foto de ${r.fecha}: ${r.metricas} indicador(es)`;
      await this.prisma.cronRun.update({
        where: { id: run.id },
        data: { ok: true, count: r.metricas, detail, finishedAt: new Date() },
      });
      this.logger.log(`[metrics] ${detail}`);
      return { ok: true, ...r };
    } catch (e) {
      const detail = (e as Error).message;
      await this.prisma.cronRun.update({
        where: { id: run.id }, data: { ok: false, detail, finishedAt: new Date() },
      });
      this.logger.error(`[metrics] falló: ${detail}`);
      throw e;
    }
  }

  /** Todos los días 03:00 — quien deba más de N facturas → Cartera. */
  async scheduledCartera() {
    if (!this.enabled) return this.logger.log('[cartera] omitido (CRONS_ENABLED != true)');
    await this.runCartera({ manual: false });
  }

  /**
   * Diario 00:05 — lo que quedó sin resolver pasa al día siguiente.
   *
   * A las 00:05 y no a media mañana: la agenda tiene que estar puesta antes de que el
   * primer técnico abra su panel. Va la primera de la madrugada y no toca dinero, así
   * que no compite con la facturación de las 02:00.
   *
   * Ver `support/agenda-arrastre.ts` para el porqué del orden en que quedan las
   * visitas (lo arrastrado delante) y de que el día original se guarde aparte.
   */
  async scheduledAgendaArrastre() {
    if (!this.enabled) return this.logger.log('[agenda-arrastre] omitido (CRONS_ENABLED != true)');
    await this.runAgendaArrastre({ manual: false });
  }

  /**
   * Diario 03:40 — poda de latidos de ubicación viejos.
   *
   * Desde que la app del técnico reporta su posición cada minuto, `GeoPing` pasó
   * de crecer por acciones (unas pocas al día) a crecer por reloj: del orden de
   * 500 registros por técnico y jornada, ~15.000 al día con la cuadrilla
   * completa. Sin poda, en un Postgres compartido por seis aplicaciones eso son
   * millones de filas para responder siempre lo mismo: cuál fue el ÚLTIMO punto
   * de cada uno.
   *
   * Solo se borran los `heartbeat`. Los puntos de acciones reales —cerrar una
   * orden, subir evidencia, capturar el GPS de un cliente— son la prueba de que
   * alguien estuvo en un sitio y no se tocan nunca: son justo lo que se va a
   * consultar el día que se discuta si una visita se hizo.
   */
  async scheduledGeoPurge() {
    if (!this.enabled) return this.logger.log('[geo-purge] omitido (CRONS_ENABLED != true)');
    await this.runGeoPurge({ manual: false });
  }

  /** Diario 04:00 — tasa de cambio (stub). */
  async scheduledExchangeRate() {
    if (!this.enabled) return;
    await this.runExchangeRate({ manual: false });
  }

  /** Diario 06:00 — recordatorios de cartera por correo. */
  async scheduledReminders() {
    if (!this.enabled) return this.logger.log('[reminders] omitido (CRONS_ENABLED != true)');
    await this.runReminders({ manual: false });
  }

  /**
   * Diario 09:00 — recordatorios de cartera por WhatsApp. A las 9 y no a las 6
   * como el correo: un WhatsApp de cobro suena el teléfono, y despertar a un
   * cliente para cobrarle empieza mal la conversación.
   *
   * Interruptor propio (`whatsapp.remindersEnabled`, apagado por defecto) además
   * de CRONS_ENABLED: esto le escribe a clientes reales y cuesta cuota de Meta,
   * así que encenderlo tiene que ser una decisión explícita y no un efecto
   * colateral de activar las automatizaciones de facturación.
   */
  async scheduledWaReminders() {
    if (!this.enabled) return this.logger.log('[wa-reminders] omitido (CRONS_ENABLED != true)');
    const cfg = await this.waReminders.config();
    if (!cfg.enabled) return this.logger.log('[wa-reminders] omitido (interruptor apagado)');
    await this.runWaReminders({ manual: false });
  }

  /**
   * Cada 15 min — sincronización incremental desde la BD VIVA del legacy
   * (admin_vestel). Los dos sistemas van de la mano: el legacy sigue siendo la
   * fuente de verdad y este stack se mantiene fresco como respaldo operable.
   * Gate propio (LEGACY_SYNC_ENABLED), independiente de CRONS_ENABLED: la
   * sincronización debe poder correr aun con la facturación programada apagada.
   */
  async scheduledLegacySync() {
    if (process.env.LEGACY_SYNC_ENABLED !== 'true')
      return this.logger.log('[legacy-sync] omitido (LEGACY_SYNC_ENABLED != true)');
    await this.runLegacySync({ manual: false });
  }

  /**
   * Minutos :05/:10/:20/:25/… — pasada LIGERA (sólo `transactions`), intercalada con
   * la completa para dejar el libro al día cada 5 minutos.
   *
   * La ventanilla lo necesita: el estado "caja abierta" se deduce del libro
   * (`CobranzasService.actividadDelDia`) porque el legacy no tiene apertura que
   * copiar. Con la pasada completa sola, la caja se veía SIN ABRIR hasta 15 minutos
   * después del primer cobro del día. Comparte el cerrojo `legacySyncRunning` con la
   * completa: nunca corren las dos a la vez.
   */
  async scheduledLegacyCajaSync() {
    if (process.env.LEGACY_SYNC_ENABLED !== 'true') return;
    await this.runLegacyCajaSync();
  }

  /**
   * Cada 5 minutos, en :02/:07/:12/… (intercalado con las dos idas, que ocupan
   * :00/:15/:30/:45 y :05/:10/:20/…) — retro-sync nuevo→legacy: lo capturado en este
   * stack se refleja en el MySQL vivo, para poder conmutar al legacy sin perder datos
   * si este sistema falla.
   *
   * Estaba cada 15 min y se bajó a 5 el 2026-08-25: con las altas viajando, 15 minutos
   * de retardo es que la cajera dé de alta un cliente aquí y no lo encuentre allá.
   * No se baja más porque la pasada relee `customers` entero (21.000 filas) contra el
   * MySQL de producción y tarda ~25 s; a 2 minutos sería carga constante sobre la BD
   * que factura. El cerrojo `legacyWritebackRunning` evita solapes de todos modos.
   */
  async scheduledLegacyWriteback() {
    // Basta con que UNO de los gates esté abierto. `LEGACY_WRITEBACK_TICKETS_LIVE` deja
    // viajar las órdenes y `LEGACY_WRITEBACK_CAJA_LIVE` la caja (movimientos, recibos,
    // anulaciones y el enlace del comprobante), mientras clientes y facturas siguen
    // retenidos. Sin esta condición el cron no corría y no llegaba nada aunque su gate
    // estuviera abierto.
    const live = process.env.LEGACY_WRITEBACK_LIVE === 'true';
    const ticketsLive = process.env.LEGACY_WRITEBACK_TICKETS_LIVE === 'true';
    const cajaLive = process.env.LEGACY_WRITEBACK_CAJA_LIVE === 'true';
    const altasLive = process.env.LEGACY_WRITEBACK_ALTAS_LIVE === 'true';
    if (!live && !ticketsLive && !cajaLive && !altasLive)
      return this.logger.log('[legacy-writeback] omitido (ningún gate de writeback abierto)');
    await this.runLegacyWriteback({ manual: false });
  }

  /**
   * Diaria, 21:00 — conciliación de caja contra el MySQL vivo.
   *
   * Detecta los pagos que el legacy BORRÓ de `transactions` y que aquí siguen
   * contados. No corrige nada (ver el encabezado de `conciliar-caja-legacy.js`):
   * avisa, que es justo lo que faltaba. El 24-ago la diferencia de 2,6 M en el cierre
   * de Villanueva la encontró una persona a ojo, tres días después de empezar.
   *
   * Sólo tiene sentido mientras el legacy siga vivo: si la ida está apagada (Modo B)
   * no hay dos libros que cuadrar.
   */
  async scheduledConciliacionCaja() {
    if (process.env.LEGACY_SYNC_ENABLED !== 'true')
      return this.logger.log('[conciliacion-caja] omitido (LEGACY_SYNC_ENABLED != true)');
    await this.runConciliacionCaja({ manual: false });
  }

  /**
   * Cada 5 minutos — abre la orden de instalación de quien ya pagó su afiliación.
   *
   * Es la red de seguridad del disparo inmediato (`treasury.pago.aplicado` →
   * `AltaClienteService.alPagarAfiliacion`): cubre los pagos que se registran EN EL
   * LEGACY, que entran por el sync sin pasar por el recaudo de aquí y por tanto sin
   * emitir ningún evento, y los intentos que fallaron y hay que reintentar.
   *
   * Corre aunque `CRONS_ENABLED` esté en false, igual que la foto de métricas: no
   * factura ni mueve dinero ni toca equipos —abre la orden de un trabajo que el
   * cliente ya pagó—, y apagarla sólo consigue que el técnico no se entere.
   */
  async scheduledInstalacionesPagadas() {
    await this.runInstalacionesPagadas({ manual: false });
  }

  /**
   * Cada 5 min — puente con el PORTAL DE PAGOS EN LÍNEA.
   *
   * Trae del portal las órdenes de pago y le devuelve el servicio a quien pagó por
   * ahí. Gate propio (`PORTAL_PAGOS_ENABLED`), como el del sync del legacy: esto sale
   * a tocar routers y OLTs, y quien apaga los crons de facturación no está pidiendo
   * necesariamente dejar a los clientes cortados. Ver `OnlinePaymentsService`.
   */
  async scheduledPagosEnLinea() {
    if (!this.pagosEnLinea.habilitado)
      return this.logger.log('[pagos-en-linea] omitido (PORTAL_PAGOS_ENABLED != true)');
    await this.runPagosEnLinea({ manual: false });
  }

  /**
   * Cada hora — deja la cartera ya rebajada para el PORTAL DE PAGOS.
   *
   * El portal cobra lo que digan las facturas del legacy y no sabe de promociones de
   * este lado (ver `promotions/descuento-portal.ts`): la única forma de que allá se
   * vea el valor con descuento es concederlo por adelantado, y ésta es la pasada que
   * lo hace —y la que lo RETIRA cuando la promoción vence sin que el cliente pague—.
   *
   * Cada hora y no cada 5 minutos porque no hay prisa: lo que cambia entre pasadas es
   * que a alguien lo pasen a Cartera o le nazca una factura, no un pago. Y el barrido
   * recorre cliente por cliente.
   *
   * Gate propio `PROMO_PORTAL_PRECONCEDER_LIVE`: con él cerrado la pasada calcula y
   * anota cuánto sería, pero no escribe ninguna nota crédito. Regalar la mitad de la
   * cartera no puede depender de que alguien se deje una promoción marcada.
   */
  async scheduledDescuentoPortal() {
    await this.runDescuentoPortal({ manual: false });
  }

  // ------------------------------------------------------------------
  // Ejecuciones (reutilizadas por el disparo manual)
  // ------------------------------------------------------------------

  /** Pasada del descuento por adelantado del portal. Ver `scheduledDescuentoPortal`. */
  async runDescuentoPortal(opts: { manual: boolean; user?: AuthUser; dryRun?: boolean }) {
    try {
      const live = opts.dryRun ? false : PORTAL_PRECONCEDER_LIVE;
      const r = await barrerDescuentosDelPortal(this.prisma, { live });
      // Sin campaña marcada no hay nada que decir: a 24 pasadas al día, anotar cada
      // una vacía enterraría el histórico de `CronRun`.
      const huboAlgo = r.beneficiados > 0 || r.retirados.clientes > 0 || r.errores.length > 0;
      if (huboAlgo || opts.manual) {
        await this.prisma.cronRun.create({
          data: {
            job: 'DESCUENTO_PORTAL', ok: !r.errores.length, manual: opts.manual,
            detail: `${live ? '' : '[simulación] '}${r.beneficiados} clientes · ${r.facturas} facturas`
              + ` · ${cop(r.monto)}${r.retirados.clientes ? ` · retirados ${r.retirados.clientes}` : ''}`
              + `${r.errores.length ? ` · ${r.errores.length} con error` : ''}`,
          },
        });
      }
      this.logger.log(`[descuento-portal] ${live ? 'EN VIVO' : 'simulación'}:`
        + ` ${r.beneficiados}/${r.candidatos} clientes · ${r.facturas} facturas · ${cop(r.monto)}`);
      return r;
    } catch (e) {
      this.logger.error(`[descuento-portal] falló: ${(e as Error).message}`);
      throw e;
    }
  }

  /** Pasada del puente con el portal de pagos. Ver `scheduledPagosEnLinea`. */
  async runPagosEnLinea(opts: { manual: boolean; user?: AuthUser; dryRun?: boolean }) {
    try {
      const r = await this.pagosEnLinea.sincronizar({ dryRun: opts.dryRun });
      // Igual que el barrido de instalaciones: a 288 pasadas al día, anotar cada
      // pasada vacía enterraría el histórico de `CronRun` bajo filas sin noticia.
      const huboAlgo = r.ingestadas > 0 || r.actualizadas > 0 || r.reconectados > 0;
      if (huboAlgo || opts.manual) {
        await this.prisma.cronRun.create({
          data: {
            job: 'PAGOS_EN_LINEA', ok: true, manual: opts.manual,
            userName: opts.user?.name ?? 'Cron', count: r.reconectados,
            detail: r.detalle.slice(0, 1900), finishedAt: new Date(),
          },
        });
      }
      return { ok: true, ...r };
    } catch (e) {
      const error = (e as Error).message;
      this.logger.error(`[pagos-en-linea] ${error}`);
      await this.prisma.cronRun.create({
        data: {
          job: 'PAGOS_EN_LINEA', ok: false, manual: opts.manual,
          userName: opts.user?.name ?? 'Cron', detail: error.slice(0, 1900), finishedAt: new Date(),
        },
      });
      return { ok: false, error };
    }
  }

  /** Barrido de instalaciones con la afiliación ya pagada. Ver `scheduledInstalacionesPagadas`. */
  async runInstalacionesPagadas(opts: { manual: boolean; user?: AuthUser }) {
    try {
      const { creadas, adoptadas } = await this.alta.barrerInstalacionesPagadas();
      // Sólo se deja rastro cuando hubo algo que hacer: a 288 pasadas al día, anotar
      // cada barrido vacío enterraría el histórico de `CronRun` bajo filas sin noticia.
      if (creadas > 0 || adoptadas > 0 || opts.manual) {
        // Las ADOPTADAS son las que ya había abierto el sistema anterior (el pago por
        // el portal se aplica allá): no se abre una segunda, se sella contra la suya.
        const adoptadasTxt = adoptadas ? ` · ${adoptadas} ya existían y se adoptaron` : '';
        await this.prisma.cronRun.create({
          data: {
            job: 'INSTALACIONES_PAGADAS', ok: true, manual: opts.manual,
            userName: opts.user?.name ?? 'Cron', count: creadas,
            detail: `${creadas} orden(es) de instalación abiertas tras el pago de la afiliación${adoptadasTxt}`,
            finishedAt: new Date(),
          },
        });
      }
      return { ok: true, creadas, adoptadas };
    } catch (e) {
      const error = (e as Error).message;
      this.logger.error(`[instalaciones-pagadas] ${error}`);
      await this.prisma.cronRun.create({
        data: {
          job: 'INSTALACIONES_PAGADAS', ok: false, manual: opts.manual,
          userName: opts.user?.name ?? 'Cron', detail: error, finishedAt: new Date(),
        },
      });
      return { ok: false, error };
    }
  }

  async runRecurringBilling(opts: {
    manual: boolean;
    user?: AuthUser;
    limit?: number;
    branchId?: string;
    /** 'YYYY-MM-DD' para forzar el mes que se factura. Por defecto, el mes corriente. */
    invoiceDate?: string;
  }) {
    const run = await this.prisma.cronRun.create({
      data: { job: 'RECURRING_BILLING', ok: false, manual: opts.manual, userName: opts.user?.name ?? 'Cron' },
    });
    try {
      // El mes que se factura es el CORRIENTE, y siempre con fecha del día 1 (no la de
      // hoy): la factura tiene que llevar la fecha del mes que cubre, porque de ahí
      // salen el periodo del recibo, el vencimiento (día 20 de ese mes) y el
      // anti-duplicado. `opts.invoiceDate` permite forzar otro mes desde el disparo
      // manual — es la vía de la corrida puente cuando un mes queda sin emitir.
      const invoiceDate = opts.invoiceDate
        ?? inicioDelMes(hoyEnColombia()).toISOString().slice(0, 10);
      // Sin `limit`: la corrida del mes debe cubrir a TODOS los facturables. Antes
      // pasaba 2000 fijo y `generate` además capaba en 2000, así que el mes quedaba
      // a medias (~2000 de ~4800) y el CronRun lo reportaba como éxito.
      const res = await this.facturas.generate(
        { invoiceDate, limit: opts.limit, branchId: opts.branchId } as any,
        opts.user ?? this.systemUser(),
      );
      const detail = `mes ${invoiceDate.slice(0, 7)} · objetivo ${res.targeted} · generadas ${res.generated}`
        + ` · omitidas ${res.skipped}` + (res.failed ? ` · FALLIDAS ${res.failed}` : '');
      // Con facturas fallidas el mes quedó incompleto: no se marca ok, o el fallo
      // pasa inadvertido hasta el cuadre de fin de mes.
      const ok = res.failed === 0;
      await this.prisma.cronRun.update({
        where: { id: run.id },
        data: { ok, count: res.generated, detail, finishedAt: new Date() },
      });
      if (ok) this.logger.log(`[recurring-billing] ${detail}`);
      else this.logger.error(`[recurring-billing] ${detail}`);
      return { ok, ...res };
    } catch (e) {
      const msg = (e as Error).message;
      await this.prisma.cronRun.update({
        where: { id: run.id },
        data: { ok: false, detail: `ERROR: ${msg}`.slice(0, 1900), finishedAt: new Date() },
      });
      this.logger.error(`[recurring-billing] ${msg}`);
      return { ok: false, error: msg };
    }
  }

  async runCartera(opts: { manual: boolean; user?: AuthUser }) {
    const run = await this.prisma.cronRun.create({
      data: { job: 'CARTERA', ok: false, manual: opts.manual, userName: opts.user?.name ?? 'Cron' },
    });
    try {
      // El disparador es la DEUDA, no el tiempo: quien acumule más de N facturas
      // sin pagar pasa a Cartera. Antes era "Cortado hace ≥ 2 meses", que dejaba
      // colgado al que debe tres meses pero nadie cortó, y mandaba a Cartera al
      // cortado que no debía nada (corte por daño, por traslado, por petición).
      const maxPendientes = await this.maxFacturasPendientes();
      // Solo lo EXIGIBLE: un anticipo o una corrida manual pueden dejarle al abonado
      // una factura abierta de un mes que aún no empieza, y eso no es mora. Contarla
      // mandaría a Cartera a quien va por delante. Ver `factura-exigible`.
      const pendientes = new Map(
        (await this.prisma.subInvoice.groupBy({
          by: ['subscriberId'],
          where: { status: { in: ['DUE', 'PARTIAL'] }, ...whereExigible(hoyEnColombia()) },
          _count: { _all: true },
        }))
          .filter((p) => p._count._all > maxPendientes)
          .map((p) => [p.subscriberId, p._count._all] as const),
      );

      // Se cruza contra los estados que sí admiten el paso, en vez de mandar los
      // miles de ids morosos en un `IN` gigante.
      const targets = (await this.prisma.subscriber.findMany({
        where: { status: { in: ESTADOS_QUE_CAEN_EN_CARTERA } },
        select: { id: true, status: true },
      })).filter((s) => pendientes.has(s.id));

      // Mientras el legacy sea la fuente de verdad, el estado del abonado lo pisa
      // `sync-legacy-vivo` cada 15 min desde `customers.usu_estado`. Escribir aquí
      // no duraría un cuarto de hora Y dejaría un registro de cambio de estado por
      // abonado CADA DÍA en el historial (que ya arrastra un 12% de desfase). Así
      // que en modo legacy-activo la tarea calcula y reporta, pero no escribe.
      const soloInforme = process.env.LEGACY_SYNC_ENABLED === 'true';
      let moved = 0;
      if (targets.length && !soloInforme) {
        const ahora = new Date();
        // `previousStatus` tiene que ser el estado real de CADA abonado (ahora
        // entran activos, no solo cortados), así que se actualiza por grupos.
        const porEstado = new Map<SubscriberStatus, string[]>();
        for (const t of targets) {
          const prev = t.status ?? 'ACTIVO';
          if (!porEstado.has(prev)) porEstado.set(prev, []);
          porEstado.get(prev)!.push(t.id);
        }
        for (const [prev, ids] of porEstado) {
          const r = await this.prisma.subscriber.updateMany({
            where: { id: { in: ids } },
            data: { previousStatus: prev, status: 'CARTERA', statusChangedAt: ahora },
          });
          moved += r.count;
        }
        // El cambio se REGISTRA, como lo hace cualquier cambio de estado hecho a
        // mano (`SubscribersService.cambiarEstado`). Esta tarea llevaba tiempo
        // moviendo clientes a Cartera en silencio, y por eso el historial dejó de
        // cuadrar con la realidad: hoy 1.482 de 12.142 abonados con historial (12%)
        // tienen un último estado registrado que ya no es el suyo, y con ese desfase
        // no se puede contestar "cuántos activos había en tal fecha". Esto no repara
        // el pasado, pero corta la fuga.
        await this.prisma.subscriberStatusHistory.createMany({
          data: targets.map((t) => ({
            subscriberId: t.id, status: 'CARTERA' as const, date: ahora,
            note: `Paso automático a Cartera (cron): ${pendientes.get(t.id)} facturas pendientes`,
          })),
        });
      }
      const regla = `más de ${maxPendientes} facturas pendientes`;
      const detail = soloInforme
        ? `SOLO INFORME (el legacy manda el estado): ${targets.length} abonados cumplen la regla (${regla}) y no se movieron`
        : `clientes movidos a Cartera: ${moved} (${regla})`;
      await this.prisma.cronRun.update({
        where: { id: run.id },
        data: { ok: true, count: soloInforme ? targets.length : moved, detail, finishedAt: new Date() },
      });
      this.logger.log(`[cartera] ${detail}`);
      return { ok: true, moved, candidatos: targets.length, soloInforme, maxPendientes };
    } catch (e) {
      const msg = (e as Error).message;
      await this.prisma.cronRun.update({
        where: { id: run.id },
        data: { ok: false, detail: `ERROR: ${msg}`.slice(0, 1900), finishedAt: new Date() },
      });
      this.logger.error(`[cartera] ${msg}`);
      return { ok: false, error: msg };
    }
  }

  /**
   * Borra los latidos de ubicación anteriores a `RETENCION_LATIDOS_D`.
   *
   * 90 días es bastante más de lo que se usa (el mapa mira 12 horas y el
   * recorrido de un día se audita cuando el reclamo está fresco), y a la vez
   * deja margen para revisar un mes cerrado que se discute tarde. Al ritmo
   * actual la tabla se estabiliza en torno a 1,3 millones de latidos; si algún
   * día estorba, lo que hay que bajar es esta retención, no el latido.
   */
  async runGeoPurge(opts: { manual: boolean; user?: AuthUser }) {
    const corte = new Date(Date.now() - RETENCION_LATIDOS_D * 86400_000);
    const { count } = await this.prisma.geoPing.deleteMany({
      where: { reason: 'heartbeat', createdAt: { lt: corte } },
    });
    await this.prisma.cronRun.create({
      data: {
        job: 'GEO_PURGE',
        ok: true,
        manual: opts.manual,
        count,
        detail: `${count} latidos anteriores a ${corte.toISOString().slice(0, 10)}`,
        userName: opts.user?.name ?? 'Cron',
        finishedAt: new Date(),
      },
    });
    this.logger.log(`[geo-purge] ${count} latidos borrados`);
    return { ok: true, count };
  }

  /**
   * Reagenda para HOY todo lo que quedó abierto en días anteriores.
   *
   * Sólo anota corrida si movió algo: la mayoría de días no hay nada que arrastrar y
   * un historial con 300 líneas de "0 órdenes" esconde el día que sí pasó algo.
   */
  async runAgendaArrastre(opts: { manual: boolean; user?: AuthUser }) {
    const hoy = hoyEnColombia();
    const r = await arrastrarAlDiaDeHoy(this.prisma, hoy);
    if (r.movidas) {
      await this.prisma.cronRun.create({
        data: {
          job: 'AGENDA_ARRASTRE',
          ok: true,
          manual: opts.manual,
          count: r.movidas,
          detail: `${r.movidas} visitas sin resolver pasadas a ${hoy.toISOString().slice(0, 10)}`
            + ` (${r.tecnicos} ${r.tecnicos === 1 ? 'técnico' : 'técnicos'}`
            + `${r.masVieja ? `, la más vieja del ${r.masVieja}` : ''})`,
          userName: opts.user?.name ?? 'Cron',
          finishedAt: new Date(),
        },
      });
      this.logger.log(`[agenda-arrastre] ${r.movidas} visitas pasadas a hoy (${r.tecnicos} técnicos)`);
    }
    return { ok: true, ...r };
  }

  async runExchangeRate(opts: { manual: boolean; user?: AuthUser }) {
    // Stub: la operación de Vestel es en COP; se registra la corrida sin acción real.
    await this.prisma.cronRun.create({
      data: {
        job: 'EXCHANGE_RATE',
        ok: true,
        manual: opts.manual,
        detail: 'sin acción (operación en COP)',
        userName: opts.user?.name ?? 'Cron',
        finishedAt: new Date(),
      },
    });
    return { ok: true, note: 'sin acción (COP)' };
  }

  /**
   * Recordatorios de cartera por correo: clientes con correo y con al menos una
   * factura vencida (dueDate pasado, saldo pendiente), que no hayan recibido un
   * recordatorio en los últimos 7 días. Tope de 300 por corrida para no saturar
   * el SMTP. Marca `lastEmailReminderAt` para no reenviar.
   */
  async runReminders(opts: { manual: boolean; user?: AuthUser }) {
    const run = await this.prisma.cronRun.create({
      data: { job: 'REMINDERS', ok: false, manual: opts.manual, userName: opts.user?.name ?? 'Cron' },
    });
    try {
      const mailStatus = await this.mail.status();
      if (!mailStatus.enabled) {
        await this.prisma.cronRun.update({
          where: { id: run.id },
          data: { ok: true, count: 0, detail: 'omitido: SMTP no configurado', finishedAt: new Date() },
        });
        return { ok: true, sent: 0, note: 'SMTP no configurado' };
      }
      const now = new Date();
      const dedupe = new Date(now);
      dedupe.setDate(dedupe.getDate() - 7);

      const subs = await this.prisma.subscriber.findMany({
        where: {
          email: { not: null },
          OR: [{ lastEmailReminderAt: null }, { lastEmailReminderAt: { lt: dedupe } }],
          invoices: { some: { status: { in: ['DUE', 'PARTIAL'] }, dueDate: { lt: now } } },
        },
        select: {
          id: true, email: true, abonado: true,
          firstName: true, secondName: true, lastName1: true, lastName2: true, companyName: true, fullName: true,
        },
        take: 300,
      });
      const ids = subs.map((s) => s.id);
      const debtRows = ids.length
        ? await this.prisma.subInvoice.groupBy({
            // Sin la factura adelantada: el correo dice "debes X" y ese mes aún no empieza.
            by: ['subscriberId'], where: { subscriberId: { in: ids }, status: { in: ['DUE', 'PARTIAL'] }, ...whereExigible(hoyEnColombia()) },
            _sum: { total: true, paidAmount: true },
          })
        : [];
      const debt: Record<string, number> = {};
      for (const r of debtRows) if (r.subscriberId) debt[r.subscriberId] = Math.max(0, Number(r._sum.total ?? 0) - Number(r._sum.paidAmount ?? 0));
      const company = await this.prisma.companyInfo.findFirst({ select: { name: true } });

      let sent = 0, failed = 0;
      for (const s of subs) {
        const email = (s.email || '').trim();
        const name = (s.fullName && s.fullName.trim())
          || [s.firstName, s.secondName, s.lastName1, s.lastName2].map((p) => (p || '').trim()).filter(Boolean).join(' ')
          || (s.companyName || '').trim() || 'Cliente';
        const res = await this.mail.sendTemplate('OVERDUE', email, {
          nombre: name, abonado: String(s.abonado ?? ''), deuda: cop(debt[s.id] ?? 0), empresa: company?.name ?? 'Vestel',
        });
        // Solo marcar el dedupe si el correo SALIÓ. Marcarlo también en el fallo
        // suprimía el reintento 7 días: un SMTP con hipo dejaba al moroso sin aviso.
        if (res.sent) {
          await this.prisma.subscriber.update({ where: { id: s.id }, data: { lastEmailReminderAt: new Date() } });
          sent++;
        } else {
          failed++;
        }
        await sleep(120);
      }
      const detail = `recordatorios enviados: ${sent}${failed ? `, fallidos: ${failed}` : ''} (candidatos: ${subs.length})`;
      await this.prisma.cronRun.update({
        where: { id: run.id }, data: { ok: true, count: sent, detail, finishedAt: new Date() },
      });
      this.logger.log(`[reminders] ${detail}`);
      return { ok: true, sent, failed, candidates: subs.length };
    } catch (e) {
      const msg = (e as Error).message;
      await this.prisma.cronRun.update({
        where: { id: run.id }, data: { ok: false, detail: `ERROR: ${msg}`.slice(0, 1900), finishedAt: new Date() },
      });
      this.logger.error(`[reminders] ${msg}`);
      return { ok: false, error: msg };
    }
  }

  /**
   * Recordatorios de cartera por WhatsApp. La lógica (a quién, con qué plantilla,
   * el dry-run y el tope de Meta) vive en `WhatsappRemindersService`; aquí solo se
   * envuelve en `CronRun` para que salga en el panel de automatizaciones y en el
   * historial, igual que las demás.
   */
  async runWaReminders(opts: { manual: boolean; user?: AuthUser; limit?: number; status?: string }) {
    const run = await this.prisma.cronRun.create({
      data: { job: 'WA_REMINDERS', ok: false, manual: opts.manual, userName: opts.user?.name ?? 'Cron' },
    });
    try {
      const r = await this.waReminders.run({
        manual: opts.manual,
        limit: opts.limit,
        status: opts.status,
        userName: opts.user?.name,
      });
      await this.prisma.cronRun.update({
        where: { id: run.id },
        data: { ok: true, count: r.enviados, detail: r.detail.slice(0, 1900), finishedAt: new Date() },
      });
      return r;
    } catch (e) {
      const msg = (e as Error).message;
      await this.prisma.cronRun.update({
        where: { id: run.id },
        data: { ok: false, detail: `ERROR: ${msg}`.slice(0, 1900), finishedAt: new Date() },
      });
      this.logger.error(`[wa-reminders] ${msg}`);
      return { ok: false, error: msg };
    }
  }

  /** Interruptor, modo real/simulación y tope de los recordatorios por WhatsApp. */
  setWaRemindersConfig(patch: { enabled?: boolean; live?: boolean; cap?: number }, user?: AuthUser) {
    return this.waReminders.setConfig(patch, user?.name ?? user?.email);
  }

  // ------------------------------------------------------------------
  // Sincronización con el legacy (scripts/sync-legacy-vivo.js)
  // ------------------------------------------------------------------
  private legacySyncRunning = false;

  /** Los scripts viven fuera de dist/: resolver contra cwd y contra __dirname compilado. */
  private legacyScriptPath(name: string) {
    const candidates = [
      join(process.cwd(), 'scripts', name),
      join(__dirname, '..', '..', '..', 'scripts', name), // dist/src/cron → raíz
      join(__dirname, '..', '..', 'scripts', name),
    ];
    return candidates.find((p) => existsSync(p));
  }

  /** Corre el script en proceso aparte (aísla los ~400 MB de la huella de facturas). */
  private execLegacyScript(args: string[], scriptName = 'sync-legacy-vivo.js'): Promise<any> {
    const script = this.legacyScriptPath(scriptName);
    if (!script) return Promise.reject(new Error(`scripts/${scriptName} no encontrado`));
    return new Promise((resolve, reject) => {
      execFile(
        process.execPath,
        ['--max-old-space-size=2048', script, ...args],
        { maxBuffer: 32 * 1024 * 1024, timeout: 15 * 60 * 1000, env: process.env },
        (err, stdout) => {
          // El script SIEMPRE imprime un JSON en la última línea, incluso al fallar.
          const line = (stdout || '').trim().split('\n').pop() || '';
          try { resolve(JSON.parse(line)); } catch { reject(err ?? new Error(`salida ilegible: ${line.slice(0, 200)}`)); }
        },
      );
    });
  }

  async runLegacySync(opts: { manual: boolean; user?: AuthUser; dry?: boolean }) {
    if (this.legacySyncRunning) return { ok: false, error: 'ya hay una sincronización en curso' };
    this.legacySyncRunning = true;
    const run = await this.prisma.cronRun.create({
      data: { job: 'LEGACY_SYNC', ok: false, manual: opts.manual, userName: opts.user?.name ?? 'Cron' },
    });
    try {
      const res = await this.execLegacyScript(opts.dry ? ['--dry'] : []);
      if (!res.ok) throw new Error(res.error || 'fallo sin detalle');
      const c = (o: any) => Object.values(o ?? {}).map(Number).filter((n) => !isNaN(n)).reduce((a, b) => a + b, 0);
      const total = c(res.customers) + c(res.estados) + (res.invoices?.nuevas ?? 0) + (res.invoices?.actualizadas ?? 0)
        + c(res.transactions) + c(res.recibos) + c(res.anulaciones) + c(res.serviciosAdicionales) + c(res.facturacionElectronica)
        // `tickets` no entra por `c()`: su resumen trae `ventana` (cuántas se
        // MIRARON), que no es trabajo hecho y dispararía el total a miles cada pasada.
        + (res.tickets?.nuevas ?? 0) + (res.tickets?.actualizadas ?? 0) + c(res.ticketsTh);
      const detail = `clientes +${res.customers?.nuevos ?? 0}/~${res.customers?.actualizados ?? 0}`
        + ` · facturas +${res.invoices?.nuevas ?? 0}/~${res.invoices?.actualizadas ?? 0}`
        + ` · trans +${res.transactions?.nuevas ?? 0} · recibos +${res.recibos?.nuevos ?? 0}`
        + ` · anulaciones +${res.anulaciones?.nuevas ?? 0}`
        + ` · órdenes +${res.tickets?.nuevas ?? 0}/~${res.tickets?.actualizadas ?? 0}`
        + ` · aperturas +${res.aperturas?.nuevas ?? 0}`
        + ` · ${Math.round((res.ms ?? 0) / 1000)}s`
        + (res.invoices?.conflictosTid?.length ? ` · ⚠️ tid en conflicto: ${res.invoices.conflictosTid.join(',')}` : '');
      await this.prisma.cronRun.update({
        where: { id: run.id },
        data: { ok: true, count: total, detail: detail.slice(0, 1900), finishedAt: new Date() },
      });
      this.logger.log(`[legacy-sync] ${detail}`);
      return { ok: true, ...res };
    } catch (e) {
      const msg = (e as Error).message;
      await this.prisma.cronRun.update({
        where: { id: run.id },
        data: { ok: false, detail: `ERROR: ${msg}`.slice(0, 1900), finishedAt: new Date() },
      });
      this.logger.error(`[legacy-sync] ${msg}`);
      return { ok: false, error: msg };
    } finally {
      this.legacySyncRunning = false;
    }
  }

  /**
   * Pasada ligera legacy→nuevo (sólo `transactions`), para que la caja del día no vaya
   * por detrás del legacy. Corre cada 5 min, así que NO deja rastro en `CronRun` cuando
   * no trae nada: 288 filas diarias en blanco taparían el registro de los demás jobs.
   * Se anota lo que sí importa: lo que trajo y los fallos.
   */
  async runLegacyCajaSync() {
    // Si la completa está corriendo, esta pasada sobra: ya va a traer el libro.
    if (this.legacySyncRunning) return { ok: true, omitido: 'sync-en-curso' };
    this.legacySyncRunning = true;
    try {
      const res = await this.execLegacyScript(['--mode=caja']);
      if (!res.ok) throw new Error(res.error || 'fallo sin detalle');
      const nuevas = res.transactions?.nuevas ?? 0;
      // La apertura cuenta como trabajo hecho igual que un movimiento: a las 7 de la
      // mañana suele ser lo ÚNICO que trae la pasada, y sin esto abrir la caja no
      // dejaría rastro en Automatizaciones —que es donde se mira cuando algo no cuadra.
      const aperturas = res.aperturas?.nuevas ?? 0;
      if (nuevas > 0 || aperturas > 0) {
        const detail = [
          nuevas > 0 ? `trans +${nuevas}` : null,
          aperturas > 0 ? `aperturas +${aperturas}` : null,
          `${Math.round((res.ms ?? 0) / 1000)}s`,
        ].filter(Boolean).join(' · ');
        await this.prisma.cronRun.create({
          data: {
            job: 'LEGACY_SYNC_CAJA', ok: true, manual: false, userName: 'Cron',
            count: nuevas + aperturas, detail, finishedAt: new Date(),
          },
        });
        this.logger.log(`[legacy-sync-caja] ${detail}`);
      }
      return { ok: true, ...res };
    } catch (e) {
      const msg = (e as Error).message;
      await this.prisma.cronRun.create({
        data: {
          job: 'LEGACY_SYNC_CAJA', ok: false, manual: false, userName: 'Cron',
          detail: `ERROR: ${msg}`.slice(0, 1900), finishedAt: new Date(),
        },
      });
      this.logger.error(`[legacy-sync-caja] ${msg}`);
      return { ok: false, error: msg };
    } finally {
      this.legacySyncRunning = false;
    }
  }

  /** Vigilancia de deriva: conteos MySQL vivo vs Postgres, por tabla clave. */
  legacyDrift() {
    return this.execLegacyScript(['--mode=drift']);
  }

  private conciliacionRunning = false;

  /**
   * Corre `conciliar-caja-legacy.js` y deja el resultado en `CronRun`. Si hay pagos
   * borrados, avisa al cargo de Contabilidad (que responde también por las cajas).
   *
   * El aviso se agrupa por día con `groupKey`: si el mismo hallazgo sigue ahí mañana
   * —y va a seguir, porque esto no se corrige solo— no se acumulan avisos nuevos
   * hasta que alguien lo lea. Un detector que grita todos los días se silencia, y
   * entonces deja de detectar.
   */
  async runConciliacionCaja(opts: { manual: boolean; user?: AuthUser; dias?: number }) {
    if (this.conciliacionRunning) return { ok: false, error: 'ya hay una conciliación en curso' };
    this.conciliacionRunning = true;
    const run = await this.prisma.cronRun.create({
      data: { job: 'CONCILIACION_CAJA', ok: false, manual: opts.manual, userName: opts.user?.name ?? 'Cron' },
    });
    try {
      const res = await this.execLegacyScript(
        [`--dias=${opts.dias ?? 7}`], 'conciliar-caja-legacy.js',
      );
      if (!res.ok) throw new Error(res.error || 'fallo sin detalle');

      const n = res.borradasEnLegacy ?? 0;
      const monto = res.montoBorrado ?? 0;
      const cajas = Object.entries(res.porCaja ?? {})
        .map(([k, v]: [string, any]) => `${k}: ${v.n} (${cop(v.monto)})`)
        .join(' · ');
      const detail = n
        ? `⚠️ ${n} pagos borrados en el legacy · ${cop(monto)} COP`
          + (res.conFacturaPagaAlla ? ` · ${res.conFacturaPagaAlla} con la factura aún PAGA allá` : '')
          + (cajas ? ` · ${cajas}` : '')
          + ` · ${res.revisadas ?? 0} movimientos revisados`
        : `sin borrados · ${res.revisadas ?? 0} movimientos revisados en ${res.dias ?? 7} días`;

      await this.prisma.cronRun.update({
        where: { id: run.id },
        data: { ok: true, count: n, detail: detail.slice(0, 1900), finishedAt: new Date() },
      });
      this.logger.log(`[conciliacion-caja] ${detail}`);

      if (n) {
        await this.notifier.notifyPost('contabilidad', {
          kind: 'caja.borrados',
          title: `${n} pagos desaparecieron del legacy (${cop(monto)})`,
          body: `El cobro sí ocurrió —la factura sigue paga allá y el recibo está emitido—, `
            + `pero el asiento se borró de su libro, así que su cierre queda corto. ${cajas}`,
          link: '/configuracion/automatizaciones',
          groupKey: `caja.borrados.${new Date().toISOString().slice(0, 10)}`,
        });
      }
      return { ok: true, ...res };
    } catch (e) {
      const msg = (e as Error).message;
      await this.prisma.cronRun.update({
        where: { id: run.id },
        data: { ok: false, detail: `ERROR: ${msg}`.slice(0, 1900), finishedAt: new Date() },
      });
      this.logger.error(`[conciliacion-caja] ${msg}`);
      return { ok: false, error: msg };
    } finally {
      this.conciliacionRunning = false;
    }
  }

  // ── Empuje INMEDIATO de la caja al legacy ──────────────────────────────────
  //
  // El cron de writeback corre cada 5 minutos y hace la pasada completa (25 s: relee
  // `customers` e `invoices` enteras). Para que un cobro se vea en el legacy AL MOMENTO
  // hace falta otra cosa: la pasada corta (`--solo=caja`, ~0,6 s) disparada por el
  // propio cobro. Las dos conviven: ésta adelanta la caja, la completa sigue llevando
  // clientes, facturas, estados y órdenes.
  private wbCajaTimer: NodeJS.Timeout | null = null;
  private wbCajaRunning = false;
  private wbCajaPendiente = false;

  /**
   * Pide un empuje de caja al legacy. La llama el evento de pago, así que puede llegar
   * en ráfaga (una cajera cobrando seguido): se agrupan 2 segundos y sale UNA pasada
   * por ráfaga, no una por pago. Si ya hay una corriendo se anota y se repite al final,
   * porque lo cobrado durante esa pasada no lo vio.
   */
  empujarCajaAlLegacy(): void {
    if (this.wbCajaTimer) return;
    this.wbCajaTimer = setTimeout(() => {
      this.wbCajaTimer = null;
      void this.runLegacyWritebackCaja();
    }, 2000);
  }

  async runLegacyWritebackCaja(): Promise<{ ok: boolean; error?: string }> {
    const abierto = process.env.LEGACY_WRITEBACK_LIVE === 'true'
      || process.env.LEGACY_WRITEBACK_CAJA_LIVE === 'true';
    if (!abierto) return { ok: true };
    // La completa ya empuja la caja: si está corriendo, ésta sobra y además pelearían
    // por las mismas filas (las dos leen `legacyId: null` y insertarían dos veces).
    if (this.legacyWritebackRunning || this.wbCajaRunning) { this.wbCajaPendiente = true; return { ok: true }; }
    this.wbCajaRunning = true;
    try {
      const res = await this.execLegacyScript(['--solo=caja'], 'writeback-legacy.js');
      if (!res.ok) throw new Error(res.error || 'fallo sin detalle');
      const n = (res.transactions?.insertadas ?? 0) + (res.transactions?.adoptadas ?? 0)
        + (res.recibos?.insertados ?? 0) + (res.anulaciones?.insertadas ?? 0)
        + (res.comprobantes?.enlazados ?? 0) + (res.aperturas?.abiertas ?? 0);
      // Sólo deja rastro cuando movió algo: si no, llenaría el historial de filas vacías.
      if (n > 0) {
        const detail = (res.aperturas?.abiertas ? `aperturas +${res.aperturas.abiertas} · ` : '')
          + `trans +${res.transactions?.insertadas ?? 0}`
          + (res.transactions?.adoptadas ? `/${res.transactions.adoptadas} adoptadas` : '')
          + ` · recibos +${res.recibos?.insertados ?? 0} · anulaciones +${res.anulaciones?.insertadas ?? 0}`
          + ` · ${Math.round((res.ms ?? 0) / 1000)}s`;
        await this.prisma.cronRun.create({
          data: { job: 'LEGACY_WRITEBACK_CAJA', ok: true, manual: false, userName: 'Cobro', count: n, detail, finishedAt: new Date() },
        });
        this.logger.log(`[legacy-writeback-caja] ${detail}`);
      }
      return { ok: true };
    } catch (e) {
      const msg = (e as Error).message;
      this.logger.error(`[legacy-writeback-caja] ${msg}`);
      return { ok: false, error: msg };
    } finally {
      this.wbCajaRunning = false;
      if (this.wbCajaPendiente) { this.wbCajaPendiente = false; this.empujarCajaAlLegacy(); }
    }
  }

  // ── Empuje INMEDIATO de la RECONEXIÓN al legacy ───────────────────────────
  //
  // Hermana de la de arriba y por una razón más apremiante: la IDA del sync vuelve a
  // traer `customers.usu_estado` cada 15 minutos, así que una reconexión que no llegue
  // al legacy antes de esa pasada se BORRA sola —el cliente navegando y las dos
  // pantallas diciendo "Cortado"—. Por eso sale en el acto (`--solo=reconexion`, ~1 s)
  // y no espera al writeback completo de los 5 minutos.
  private wbReconexionTimer: NodeJS.Timeout | null = null;
  private wbReconexionRunning = false;
  private wbReconexionPendiente = false;

  /** Pide un empuje de reconexión al legacy. Agrupa ráfagas igual que el de caja. */
  empujarReconexionAlLegacy(): void {
    if (this.wbReconexionTimer) return;
    this.wbReconexionTimer = setTimeout(() => {
      this.wbReconexionTimer = null;
      void this.runLegacyWritebackReconexion();
    }, 2000);
  }

  async runLegacyWritebackReconexion(): Promise<{ ok: boolean; error?: string }> {
    const abierto = process.env.LEGACY_WRITEBACK_LIVE === 'true'
      || process.env.LEGACY_WRITEBACK_RECONEXION_LIVE === 'true';
    if (!abierto) return { ok: true };
    if (this.legacyWritebackRunning || this.wbReconexionRunning) { this.wbReconexionPendiente = true; return { ok: true }; }
    this.wbReconexionRunning = true;
    try {
      const res = await this.execLegacyScript(['--solo=reconexion'], 'writeback-legacy.js');
      if (!res.ok) throw new Error(res.error || 'fallo sin detalle');
      const n = res.reconexiones?.aplicados ?? 0;
      // Igual que la de caja: sólo deja rastro cuando movió algo.
      if (n > 0) {
        const detail = `clientes ${n} · facturas ${res.reconexiones?.facturas ?? 0}`
          + ` · ${Math.round((res.ms ?? 0) / 1000)}s`;
        await this.prisma.cronRun.create({
          data: { job: 'LEGACY_WRITEBACK_RECONEXION', ok: true, manual: false, userName: 'Reconexión', count: n, detail, finishedAt: new Date() },
        });
        this.logger.log(`[legacy-writeback-reconexion] ${detail}`);
      }
      return { ok: true };
    } catch (e) {
      const msg = (e as Error).message;
      this.logger.error(`[legacy-writeback-reconexion] ${msg}`);
      return { ok: false, error: msg };
    } finally {
      this.wbReconexionRunning = false;
      if (this.wbReconexionPendiente) { this.wbReconexionPendiente = false; this.empujarReconexionAlLegacy(); }
    }
  }

  // ── Empuje INMEDIATO de la BAJA al legacy ─────────────────────────────────
  //
  // La misma urgencia que la reconexión, del revés: la ida trae `customers.usu_estado`
  // cada 15 minutos, así que un retiro que no llegue antes al legacy se DESHACE solo y
  // el cliente retirado reaparece ACTIVO (orden #504994, 31-08-2026).
  private wbBajasTimer: NodeJS.Timeout | null = null;
  private wbBajasRunning = false;
  private wbBajasPendiente = false;

  /** Pide un empuje de bajas al legacy. Agrupa ráfagas igual que el de caja. */
  empujarBajaAlLegacy(): void {
    if (this.wbBajasTimer) return;
    this.wbBajasTimer = setTimeout(() => {
      this.wbBajasTimer = null;
      void this.runLegacyWritebackBajas();
    }, 2000);
  }

  async runLegacyWritebackBajas(): Promise<{ ok: boolean; error?: string }> {
    const abierto = process.env.LEGACY_WRITEBACK_LIVE === 'true'
      || process.env.LEGACY_WRITEBACK_BAJAS_LIVE === 'true';
    if (!abierto) return { ok: true };
    if (this.legacyWritebackRunning || this.wbBajasRunning) { this.wbBajasPendiente = true; return { ok: true }; }
    this.wbBajasRunning = true;
    try {
      const res = await this.execLegacyScript(['--solo=bajas'], 'writeback-legacy.js');
      if (!res.ok) throw new Error(res.error || 'fallo sin detalle');
      const n = res.bajas?.aplicados ?? 0;
      // Igual que las otras cortas: sólo deja rastro cuando movió algo.
      if (n > 0) {
        const detail = `clientes ${n} · facturas ${res.bajas?.facturas ?? 0}`
          + ` · ${Math.round((res.ms ?? 0) / 1000)}s`;
        await this.prisma.cronRun.create({
          data: { job: 'LEGACY_WRITEBACK_BAJAS', ok: true, manual: false, userName: 'Baja', count: n, detail, finishedAt: new Date() },
        });
        this.logger.log(`[legacy-writeback-bajas] ${detail}`);
      }
      return { ok: true };
    } catch (e) {
      const msg = (e as Error).message;
      this.logger.error(`[legacy-writeback-bajas] ${msg}`);
      return { ok: false, error: msg };
    } finally {
      this.wbBajasRunning = false;
      if (this.wbBajasPendiente) { this.wbBajasPendiente = false; this.empujarBajaAlLegacy(); }
    }
  }

  // ── Empuje INMEDIATO del ESTADO DE UN SERVICIO al legacy ──────────────────
  //
  // Mismo motivo que la baja y la reconexión, un escalón más abajo: `estado_tv` y
  // `estado_combo` de la factura también los trae la ida cada 15 minutos, así que una
  // suspensión de televisión hecha aquí —cerrando la orden o a mano desde la ficha—
  // se deshace sola si no llega antes al legacy (orden #502150, 31-08-2026).
  private wbEstadoServicioTimer: NodeJS.Timeout | null = null;
  private wbEstadoServicioRunning = false;
  private wbEstadoServicioPendiente = false;

  /** Pide un empuje del estado de servicio al legacy. Agrupa ráfagas como los demás. */
  empujarEstadoServicioAlLegacy(): void {
    if (this.wbEstadoServicioTimer) return;
    this.wbEstadoServicioTimer = setTimeout(() => {
      this.wbEstadoServicioTimer = null;
      void this.runLegacyWritebackEstadoServicio();
    }, 2000);
  }

  async runLegacyWritebackEstadoServicio(): Promise<{ ok: boolean; error?: string }> {
    // Se apoya en los gates que YA gobiernan esta escritura: cortar/suspender es una
    // baja y levantar el corte es una reconexión, y son las mismas dos columnas que
    // `pushBajas` y `pushReconexiones` escriben. No hace falta un interruptor nuevo.
    const abierto = process.env.LEGACY_WRITEBACK_LIVE === 'true'
      || process.env.LEGACY_WRITEBACK_BAJAS_LIVE === 'true'
      || process.env.LEGACY_WRITEBACK_RECONEXION_LIVE === 'true';
    if (!abierto) return { ok: true };
    if (this.legacyWritebackRunning || this.wbEstadoServicioRunning) { this.wbEstadoServicioPendiente = true; return { ok: true }; }
    this.wbEstadoServicioRunning = true;
    try {
      const res = await this.execLegacyScript(['--solo=estado-servicio'], 'writeback-legacy.js');
      if (!res.ok) throw new Error(res.error || 'fallo sin detalle');
      const n = res.estadoServicio?.aplicados ?? 0;
      if (n > 0) {
        const detail = `facturas ${n} · ${Math.round((res.ms ?? 0) / 1000)}s`;
        await this.prisma.cronRun.create({
          data: { job: 'LEGACY_WRITEBACK_ESTADO_SERVICIO', ok: true, manual: false, userName: 'Estado de servicio', count: n, detail, finishedAt: new Date() },
        });
        this.logger.log(`[legacy-writeback-estado-servicio] ${detail}`);
      }
      return { ok: true };
    } catch (e) {
      const msg = (e as Error).message;
      this.logger.error(`[legacy-writeback-estado-servicio] ${msg}`);
      return { ok: false, error: msg };
    } finally {
      this.wbEstadoServicioRunning = false;
      if (this.wbEstadoServicioPendiente) { this.wbEstadoServicioPendiente = false; this.empujarEstadoServicioAlLegacy(); }
    }
  }

  private wbOrdenesTimer: NodeJS.Timeout | null = null;
  private wbOrdenesRunning = false;
  private wbOrdenesPendiente = false;

  /**
   * Pide un empuje de ÓRDENES al legacy. Lo llaman la creación y la asignación, así que
   * llega en ráfaga (la cajera reparte la mañana de un técnico de una sentada): se
   * agrupan 2 segundos y sale UNA pasada, igual que la de caja.
   *
   * Mientras los técnicos trabajen en el legacy, esperar al cron de los 5 minutos es
   * dejar sin trabajo a quien ya está en la calle. Y hay un motivo de datos además del
   * operativo: el legacy reparte su consecutivo de órdenes con `MAX(codigo)+1`, así que
   * cuanto más tarde en enterarse de la nuestra, más probable es que le dé ese mismo
   * número a otra y haya que renumerar la de aquí.
   */
  empujarOrdenesAlLegacy(): void {
    if (this.wbOrdenesTimer) return;
    this.wbOrdenesTimer = setTimeout(() => {
      this.wbOrdenesTimer = null;
      void this.runLegacyWritebackOrdenes();
    }, 2000);
  }

  async runLegacyWritebackOrdenes(): Promise<{ ok: boolean; error?: string }> {
    const abierto = process.env.LEGACY_WRITEBACK_LIVE === 'true'
      || process.env.LEGACY_WRITEBACK_TICKETS_LIVE === 'true';
    if (!abierto) return { ok: true };
    // La completa ya empuja las órdenes: si está corriendo, ésta sobra y además
    // pelearían por las mismas filas (las dos leen `legacyId: null`).
    if (this.legacyWritebackRunning || this.wbOrdenesRunning) { this.wbOrdenesPendiente = true; return { ok: true }; }
    this.wbOrdenesRunning = true;
    try {
      const res = await this.execLegacyScript(['--solo=ordenes'], 'writeback-legacy.js');
      if (!res.ok) throw new Error(res.error || 'fallo sin detalle');
      const n = (res.tickets?.insertadas ?? 0) + (res.ticketsUpd?.aplicados ?? 0)
        + (res.ticketsAsignado?.aplicados ?? 0);
      // Sólo deja rastro cuando movió algo: si no, llenaría el historial de filas vacías.
      if (n > 0) {
        const renum = res.tickets?.renumeradas?.length ?? 0;
        const detail = `órdenes +${res.tickets?.insertadas ?? 0}`
          + (renum ? ` (${renum} renumeradas: el legacy ya había usado su código)` : '')
          + ` · cambios ${res.ticketsUpd?.aplicados ?? 0}`
          + (res.ticketsAsignado?.aplicados ? ` · técnico realineado en ${res.ticketsAsignado.aplicados}` : '')
          + (res.ticketsAsignado?.sinUsuarioEnLegacy?.length ? ` · ⚠️ sin usuario en el legacy: ${res.ticketsAsignado.sinUsuarioEnLegacy.join(", ")}` : '')
          + (res.tickets?.sinCliente ? ` · ⚠️ ${res.tickets.sinCliente} sin abonado en el legacy` : '')
          + ` · ${Math.round((res.ms ?? 0) / 1000)}s`;
        await this.prisma.cronRun.create({
          data: { job: 'LEGACY_WRITEBACK_ORDENES', ok: true, manual: false, userName: 'Orden', count: n, detail, finishedAt: new Date() },
        });
        this.logger.log(`[legacy-writeback-ordenes] ${detail}`);
      }
      return { ok: true };
    } catch (e) {
      const msg = (e as Error).message;
      this.logger.error(`[legacy-writeback-ordenes] ${msg}`);
      return { ok: false, error: msg };
    } finally {
      this.wbOrdenesRunning = false;
      if (this.wbOrdenesPendiente) { this.wbOrdenesPendiente = false; this.empujarOrdenesAlLegacy(); }
    }
  }

  private legacyWritebackRunning = false;

  /**
   * Retro-sync nuevo→legacy (writeback): empuja al MySQL vivo lo creado aquí.
   * Sin LEGACY_WRITEBACK_LIVE=true el script corre en seco (reporta el plan).
   * Con la ida activa (LEGACY_SYNC_ENABLED) los UPDATES quedan retenidos: solo
   * en Modo B (nuevo activo, ida apagada) se reflejan cambios sobre filas legacy.
   */
  async runLegacyWriteback(opts: { manual: boolean; user?: AuthUser }) {
    if (this.legacyWritebackRunning) return { ok: false, error: 'ya hay un writeback en curso' };
    this.legacyWritebackRunning = true;
    const run = await this.prisma.cronRun.create({
      data: { job: 'LEGACY_WRITEBACK', ok: false, manual: opts.manual, userName: opts.user?.name ?? 'Cron' },
    });
    try {
      const res = await this.execLegacyScript([], 'writeback-legacy.js');
      if (!res.ok) throw new Error(res.error || 'fallo sin detalle');
      const total = (res.customers?.insertados ?? 0) + (res.invoices?.insertadas ?? 0) + (res.items?.insertados ?? 0)
        + (res.transactions?.insertadas ?? 0) + (res.recibos?.insertados ?? 0) + (res.anulaciones?.insertadas ?? 0)
        + (res.estados?.insertados ?? 0) + (res.customersUpd?.aplicados ?? 0) + (res.invoicesUpd?.aplicados ?? 0)
        + (res.bajas?.aplicados ?? 0)
        + (res.tickets?.insertadas ?? 0) + (res.ticketsUpd?.aplicados ?? 0)
        + (res.aperturas?.abiertas ?? 0);
      // Ojo con el rótulo: con los gates parciales el writeback va en seco para todo
      // MENOS lo que ese gate abre, así que un "SECO (plan)" a secas sería mentira.
      const abierto = [res.ordenesEnVivo ? 'órdenes' : null, res.cajaEnVivo ? 'caja' : null,
        res.altasEnVivo ? 'altas' : null, res.inventarioEnVivo ? 'inventario' : null,
        res.bajasEnVivo ? 'bajas' : null,
        res.edicionesEnVivo ? 'ediciones' : null].filter(Boolean);
      const modo = !res.dry ? '' : abierto.length ? `SECO salvo ${abierto.join(' y ')} · ` : 'SECO (plan) · ';
      const detail = `${modo}clientes +${res.customers?.insertados ?? 0}`
        + ` · facturas +${res.invoices?.insertadas ?? 0} · trans +${res.transactions?.insertadas ?? 0}`
        + ` · recibos +${res.recibos?.insertados ?? 0}`
        + (res.transactions?.adoptadas ? ` (${res.transactions.adoptadas} adoptadas del legacy)` : '')
        + (res.transactions?.duplicadasEnNexus?.length
          ? ` · ⚠️ ${res.transactions.duplicadasEnNexus.length} movimientos duplicados aquí (facturas `
            + `${res.transactions.duplicadasEnNexus.map((d: { factura: number }) => d.factura).join(',')})`
          : '')
        + ` · aperturas +${res.aperturas?.abiertas ?? 0}`
        // La deriva del otro lado se nombra aquí a propósito: una caja abierta allá y
        // no aquí no la arregla el writeback, pero callarla es cómo se vive semanas
        // con un hueco (la lección de las órdenes que no contaba el resumen).
        + (res.aperturas?.abiertasSoloEnLegacy?.length
          ? ` (⚠️ ${res.aperturas.abiertasSoloEnLegacy.length} abiertas sólo en el legacy: `
            + `${res.aperturas.abiertasSoloEnLegacy.map((u: { usuario: string }) => u.usuario).join(',')})`
          : '')
        + (res.aperturas?.sinUsuarioEnLegacy?.length
          ? ` (⚠️ ${res.aperturas.sinUsuarioEnLegacy.length} sin usuario en el legacy)` : '')
        + ` · órdenes +${res.tickets?.insertadas ?? 0}/~${res.ticketsUpd?.aplicados ?? 0}`
        + (res.tickets?.sinCliente ? ` (${res.tickets.sinCliente} sin abonado)` : '')
        // Retiros y suspensiones: se nombran aunque vayan a cero, que es justamente
        // como se vivió tres días sin notar que el legacy los estaba deshaciendo.
        + ` · bajas ${res.bajas?.aplicados ?? 0}/${res.bajas?.facturas ?? 0} fact.`
        // Inventario y fichas editadas: los dos sentidos nuevos del 2026-08-27. Se
        // nombran aunque vayan a cero — un resumen que calla un paso es como no tenerlo.
        + ` · inventario mat +${res.inventario?.material?.insertados ?? 0}/~${res.inventario?.material?.aplicados ?? 0}`
        + ` eq +${res.inventario?.equipos?.insertados ?? 0}/~${res.inventario?.equipos?.aplicados ?? 0}`
        + ` ord +${res.inventario?.ordenes?.insertadas ?? 0}/~${res.inventario?.ordenes?.aplicados ?? 0}`
        + (res.inventario?.material?.sinDimension?.length
          ? ` (⚠️ ${res.inventario.material.sinDimension.length} sin bodega/categoría allá)` : '')
        + (res.inventario?.ordenes?.conflictosTid?.length
          ? ` (⚠️ consecutivo en conflicto: ${res.inventario.ordenes.conflictosTid.join(',')})` : '')
        + ` · fichas editadas ~${res.customersEdit?.aplicados ?? 0}`
        + ` · updates ${res.updatesEnVivo ? `${(res.customersUpd?.aplicados ?? 0) + (res.invoicesUpd?.aplicados ?? 0)} aplicados` : `${(res.customersUpd?.pendientes ?? 0) + (res.invoicesUpd?.pendientes ?? 0)} retenidos`}`
        + ` · ${Math.round((res.ms ?? 0) / 1000)}s`
        // Las facturas ya no chocan: el número se lo pide el writeback al propio legacy
        // antes de insertar, así que aquí se cuenta cuántas se renumeraron (todas las
        // que viajan) en vez de cuántas se quedaron fuera por tid ocupado.
        + (res.invoices?.renumeradas?.length
          ? ` · ${res.invoices.renumeradas.length} facturas renumeradas al consecutivo del legacy` : '')
        // Renumerar NO es un fallo: es el legacy repartiendo su propio consecutivo con
        // `MAX(codigo)+1` mientras nosotros creábamos. Se cuenta porque si sube mucho es
        // que la orden está tardando en viajar (el empuje inmediato dejó de dispararse).
        + (res.tickets?.renumeradas?.length
          ? ` · ${res.tickets.renumeradas.length} órdenes renumeradas al consecutivo del legacy` : '')
        + (res.ticketsAsignado?.aplicados ? ` · técnico realineado en ${res.ticketsAsignado.aplicados}` : '')
        + (res.ticketsAsignado?.sinUsuarioEnLegacy?.length
          ? ` · ⚠️ técnico sin usuario en el legacy (sus órdenes no le salen allá): ${res.ticketsAsignado.sinUsuarioEnLegacy.join(', ')}` : '');
      await this.prisma.cronRun.update({
        where: { id: run.id },
        data: { ok: true, count: total, detail: detail.slice(0, 1900), finishedAt: new Date() },
      });
      this.logger.log(`[legacy-writeback] ${detail}`);
      return { ok: true, ...res };
    } catch (e) {
      const msg = (e as Error).message;
      await this.prisma.cronRun.update({
        where: { id: run.id },
        data: { ok: false, detail: `ERROR: ${msg}`.slice(0, 1900), finishedAt: new Date() },
      });
      this.logger.error(`[legacy-writeback] ${msg}`);
      return { ok: false, error: msg };
    } finally {
      this.legacyWritebackRunning = false;
    }
  }

  // ------------------------------------------------------------------
  // Estado / historial
  // ------------------------------------------------------------------
  async status() {
    const jobs = ['RECURRING_BILLING', 'CARTERA', 'GEO_PURGE', 'EXCHANGE_RATE', 'REMINDERS', 'WA_REMINDERS', 'LEGACY_SYNC', 'LEGACY_SYNC_CAJA', 'LEGACY_WRITEBACK', 'LEGACY_WRITEBACK_CAJA', 'LEGACY_WRITEBACK_ORDENES', 'CONCILIACION_CAJA', 'INSTALACIONES_PAGADAS', 'PAGOS_EN_LINEA', 'AGENDA_ARRASTRE'];
    const last: Record<string, any> = {};
    for (const j of jobs) {
      last[j] = await this.prisma.cronRun.findFirst({ where: { job: j }, orderBy: { startedAt: 'desc' } });
    }
    return {
      enabled: this.enabled,
      legacySyncEnabled: process.env.LEGACY_SYNC_ENABLED === 'true',
      schedules: {
        AGENDA_ARRASTRE: 'diario 00:05 — lo que quedó sin resolver pasa al día siguiente (queda de primero en la jornada del técnico); anota sólo si movió algo',
        RECURRING_BILLING: 'día 1 de cada mes, 02:00',
        CARTERA: `diario 03:00 — a Cartera con más de ${await this.maxFacturasPendientes()} facturas pendientes`,
        GEO_PURGE: `diario 03:40 — borra latidos de ubicación de más de ${RETENCION_LATIDOS_D} días (los puntos de acciones no se tocan)`,
        EXCHANGE_RATE: 'diario 04:00',
        REMINDERS: 'diario 06:00',
        WA_REMINDERS: 'diario 09:00',
        LEGACY_SYNC: 'cada 15 minutos (BD viva del legacy → este sistema)',
        LEGACY_WRITEBACK: 'cada 5 minutos, en :02/:07/:12/… (este sistema → BD viva del legacy)',
        LEGACY_SYNC_CAJA: 'cada 20 segundos, sólo transacciones (para que la caja del legacy se vea al momento); anota sólo si trae algo',
        LEGACY_WRITEBACK_CAJA: 'al instante, disparado por cada cobro (pasada corta ~0,6 s); anota sólo si empuja algo',
        LEGACY_WRITEBACK_ORDENES: 'al instante, al crear o asignar una orden (el técnico la atiende desde el legacy); anota sólo si empuja algo',
        CONCILIACION_CAJA: 'diario 21:00 — cuadra nuestra caja contra la del legacy (7 días atrás) y avisa de los pagos que allá se borraron',
        PAGOS_EN_LINEA: 'cada 5 minutos — trae los pagos del portal en línea (vestel.com.co/crm) y reconecta internet y TV a quien pagó por ahí; anota sólo si trae o reconecta algo',
        INSTALACIONES_PAGADAS: 'cada 5 minutos — abre la orden de instalación de quien ya pagó su factura de afiliación (la de aquí nace al instante con el cobro; esto recoge lo pagado en el legacy); anota sólo si abre alguna',
      },
      legacyWritebackEnabled: process.env.LEGACY_WRITEBACK_LIVE === 'true',
      /** Interruptor + modo (real/simulación) + tope de los recordatorios por WhatsApp. */
      waReminders: await this.waReminders.config(),
      lastRuns: last,
    };
  }

  history(limit = 50) {
    return this.prisma.cronRun.findMany({ orderBy: { startedAt: 'desc' }, take: Math.min(limit, 200) });
  }
}
