import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { FacturasService } from '../billing/facturas.service';
import { AuthUser } from '../auth/current-user.decorator';

/**
 * Automatizaciones programadas — porta `Cronjob.php` del legacy saves-vestel:
 *   · RECURRING_BILLING → genera las facturas recurrentes del mes (clona la última).
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
      const res = await this.facturas.generate(
        { invoiceDate, limit: opts.limit ?? 2000, branchId: opts.branchId } as any,
        opts.user ?? this.systemUser(),
      );
      const detail = `objetivo ${res.targeted} · generadas ${res.generated} · omitidas ${res.skipped}`;
      await this.prisma.cronRun.update({
        where: { id: run.id },
        data: { ok: true, count: res.generated, detail, finishedAt: new Date() },
      });
      this.logger.log(`[recurring-billing] ${detail}`);
      return { ok: true, ...res };
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

  // ------------------------------------------------------------------
  // Estado / historial
  // ------------------------------------------------------------------
  async status() {
    const jobs = ['RECURRING_BILLING', 'CARTERA', 'EXCHANGE_RATE'];
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
      },
      lastRuns: last,
    };
  }

  history(limit = 50) {
    return this.prisma.cronRun.findMany({ orderBy: { startedAt: 'desc' }, take: Math.min(limit, 200) });
  }
}
