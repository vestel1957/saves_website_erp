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
  /** Día 1 de cada mes, 02:00 — factura recurrente del mes. */
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
   * Minutos :07/:22/:37/:52 (intercalado con la ida) — retro-sync nuevo→legacy:
   * lo capturado en este stack se refleja en el MySQL vivo, para poder conmutar
   * al legacy sin perder datos si este sistema falla.
   */
  async scheduledLegacyWriteback() {
    if (process.env.LEGACY_WRITEBACK_LIVE !== 'true')
      return this.logger.log('[legacy-writeback] omitido (LEGACY_WRITEBACK_LIVE != true)');
    await this.runLegacyWriteback({ manual: false });
  }

  // ------------------------------------------------------------------
  // Ejecuciones (reutilizadas por el disparo manual)
  // ------------------------------------------------------------------
  async runRecurringBilling(opts: {
    manual: boolean;
    user?: AuthUser;
    limit?: number;
    branchId?: string;
  }) {
    const run = await this.prisma.cronRun.create({
      data: { job: 'RECURRING_BILLING', ok: false, manual: opts.manual, userName: opts.user?.name ?? 'Cron' },
    });
    try {
      const today = new Date();
      const invoiceDate = today.toISOString().slice(0, 10);
      // Sin `limit`: la corrida del mes debe cubrir a TODOS los facturables. Antes
      // pasaba 2000 fijo y `generate` además capaba en 2000, así que el mes quedaba
      // a medias (~2000 de ~4800) y el CronRun lo reportaba como éxito.
      const res = await this.facturas.generate(
        { invoiceDate, limit: opts.limit, branchId: opts.branchId } as any,
        opts.user ?? this.systemUser(),
      );
      const detail = `objetivo ${res.targeted} · generadas ${res.generated} · omitidas ${res.skipped}`
        + (res.failed ? ` · FALLIDAS ${res.failed}` : '');
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
      const pendientes = new Map(
        (await this.prisma.subInvoice.groupBy({
          by: ['subscriberId'],
          where: { status: { in: ['DUE', 'PARTIAL'] } },
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
            by: ['subscriberId'], where: { subscriberId: { in: ids }, status: { in: ['DUE', 'PARTIAL'] } },
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
        + c(res.transactions) + c(res.recibos) + c(res.anulaciones) + c(res.serviciosAdicionales) + c(res.facturacionElectronica);
      const detail = `clientes +${res.customers?.nuevos ?? 0}/~${res.customers?.actualizados ?? 0}`
        + ` · facturas +${res.invoices?.nuevas ?? 0}/~${res.invoices?.actualizadas ?? 0}`
        + ` · trans +${res.transactions?.nuevas ?? 0} · recibos +${res.recibos?.nuevos ?? 0}`
        + ` · anulaciones +${res.anulaciones?.nuevas ?? 0} · ${Math.round((res.ms ?? 0) / 1000)}s`
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
      if (nuevas > 0) {
        const detail = `trans +${nuevas} · ${Math.round((res.ms ?? 0) / 1000)}s`;
        await this.prisma.cronRun.create({
          data: {
            job: 'LEGACY_SYNC_CAJA', ok: true, manual: false, userName: 'Cron',
            count: nuevas, detail, finishedAt: new Date(),
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
        + (res.estados?.insertados ?? 0) + (res.customersUpd?.aplicados ?? 0) + (res.invoicesUpd?.aplicados ?? 0);
      const detail = `${res.dry ? 'SECO (plan) · ' : ''}clientes +${res.customers?.insertados ?? 0}`
        + ` · facturas +${res.invoices?.insertadas ?? 0} · trans +${res.transactions?.insertadas ?? 0}`
        + ` · recibos +${res.recibos?.insertados ?? 0}`
        + ` · updates ${res.updatesEnVivo ? `${(res.customersUpd?.aplicados ?? 0) + (res.invoicesUpd?.aplicados ?? 0)} aplicados` : `${(res.customersUpd?.pendientes ?? 0) + (res.invoicesUpd?.pendientes ?? 0)} retenidos`}`
        + ` · ${Math.round((res.ms ?? 0) / 1000)}s`
        + (res.invoices?.conflictosTid?.length ? ` · ⚠️ tid en conflicto: ${res.invoices.conflictosTid.join(',')}` : '');
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
    const jobs = ['RECURRING_BILLING', 'CARTERA', 'GEO_PURGE', 'EXCHANGE_RATE', 'REMINDERS', 'WA_REMINDERS', 'LEGACY_SYNC', 'LEGACY_SYNC_CAJA', 'LEGACY_WRITEBACK'];
    const last: Record<string, any> = {};
    for (const j of jobs) {
      last[j] = await this.prisma.cronRun.findFirst({ where: { job: j }, orderBy: { startedAt: 'desc' } });
    }
    return {
      enabled: this.enabled,
      legacySyncEnabled: process.env.LEGACY_SYNC_ENABLED === 'true',
      schedules: {
        RECURRING_BILLING: 'día 1 de cada mes, 02:00',
        CARTERA: `diario 03:00 — a Cartera con más de ${await this.maxFacturasPendientes()} facturas pendientes`,
        GEO_PURGE: `diario 03:40 — borra latidos de ubicación de más de ${RETENCION_LATIDOS_D} días (los puntos de acciones no se tocan)`,
        EXCHANGE_RATE: 'diario 04:00',
        REMINDERS: 'diario 06:00',
        WA_REMINDERS: 'diario 09:00',
        LEGACY_SYNC: 'cada 15 minutos (BD viva del legacy → este sistema)',
        LEGACY_SYNC_CAJA: 'cada 5 minutos, sólo transacciones (para la caja del día); anota sólo si trae algo',
        LEGACY_WRITEBACK: 'minutos :07/:22/:37/:52 (este sistema → BD viva del legacy)',
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
