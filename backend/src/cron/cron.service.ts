import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { FacturasService } from '../billing/facturas.service';
import { MailService } from '../common/mail/mail.service';
import { AuthUser } from '../auth/current-user.decorator';

const cop = (n: number) => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n || 0);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Automatizaciones programadas — porta `Cronjob.php` del legacy saves-vestel:
 *   · RECURRING_BILLING → genera las facturas recurrentes del mes (desde el plan).
 *   · CARTERA           → pasa a "Cartera" los clientes Cortados hace ≥ 2 meses.
 *   · EXCHANGE_RATE      → actualización de tasa (stub; la operación es en COP).
 *
 * ⚠️ Las tareas PROGRAMADAS solo corren si `CRONS_ENABLED=true` (evita generar
 * miles de facturas sin querer en un entorno de trabajo). El disparo MANUAL vía
 * endpoint siempre ejecuta (acción explícita de un usuario). Todo queda auditado
 * en `CronRun`.
 */
@Injectable()
export class CronService {
  private readonly logger = new Logger('CronService');
  private readonly enabled = process.env.CRONS_ENABLED === 'true';

  constructor(
    private prisma: PrismaService,
    private facturas: FacturasService,
    private mail: MailService,
  ) {}

  get isEnabled() {
    return this.enabled;
  }

  private systemUser(name = 'Cron'): AuthUser {
    return { id: 'system', email: 'cron@vestel', name, roles: [], permissions: ['system.admin'] };
  }

  // ------------------------------------------------------------------
  // Programadas
  // ------------------------------------------------------------------
  /** Día 1 de cada mes, 02:00 — factura recurrente del mes. */
  @Cron('0 2 1 * *', { name: 'recurring-billing' })
  async scheduledRecurringBilling() {
    if (!this.enabled) return this.logger.log('[recurring-billing] omitido (CRONS_ENABLED != true)');
    await this.runRecurringBilling({ manual: false });
  }

  /** Todos los días 03:00 — Cortado (≥2 meses) → Cartera. */
  @Cron('0 3 * * *', { name: 'cartera' })
  async scheduledCartera() {
    if (!this.enabled) return this.logger.log('[cartera] omitido (CRONS_ENABLED != true)');
    await this.runCartera({ manual: false });
  }

  /** Diario 04:00 — tasa de cambio (stub). */
  @Cron(CronExpression.EVERY_DAY_AT_4AM, { name: 'exchange-rate' })
  async scheduledExchangeRate() {
    if (!this.enabled) return;
    await this.runExchangeRate({ manual: false });
  }

  /** Diario 06:00 — recordatorios de cartera por correo. */
  @Cron('0 6 * * *', { name: 'reminders' })
  async scheduledReminders() {
    if (!this.enabled) return this.logger.log('[reminders] omitido (CRONS_ENABLED != true)');
    await this.runReminders({ manual: false });
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
      const cutoff = new Date();
      cutoff.setMonth(cutoff.getMonth() - 2);
      // Cortados con último cambio de estado hace ≥ 2 meses → Cartera.
      const targets = await this.prisma.subscriber.findMany({
        where: { status: 'CORTADO', statusChangedAt: { lte: cutoff } },
        select: { id: true },
      });
      let moved = 0;
      if (targets.length) {
        const r = await this.prisma.subscriber.updateMany({
          where: { id: { in: targets.map((t) => t.id) } },
          data: { previousStatus: 'CORTADO', status: 'CARTERA', statusChangedAt: new Date() },
        });
        moved = r.count;
      }
      const detail = `clientes movidos a Cartera: ${moved}`;
      await this.prisma.cronRun.update({
        where: { id: run.id },
        data: { ok: true, count: moved, detail, finishedAt: new Date() },
      });
      this.logger.log(`[cartera] ${detail}`);
      return { ok: true, moved };
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
        await this.prisma.subscriber.update({ where: { id: s.id }, data: { lastEmailReminderAt: new Date() } });
        if (res.sent) sent++; else failed++;
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

  // ------------------------------------------------------------------
  // Estado / historial
  // ------------------------------------------------------------------
  async status() {
    const jobs = ['RECURRING_BILLING', 'CARTERA', 'EXCHANGE_RATE', 'REMINDERS'];
    const last: Record<string, any> = {};
    for (const j of jobs) {
      last[j] = await this.prisma.cronRun.findFirst({ where: { job: j }, orderBy: { startedAt: 'desc' } });
    }
    return {
      enabled: this.enabled,
      schedules: {
        RECURRING_BILLING: 'día 1 de cada mes, 02:00',
        CARTERA: 'diario 03:00',
        EXCHANGE_RATE: 'diario 04:00',
        REMINDERS: 'diario 06:00',
      },
      lastRuns: last,
    };
  }

  history(limit = 50) {
    return this.prisma.cronRun.findMany({ orderBy: { startedAt: 'desc' }, take: Math.min(limit, 200) });
  }
}
