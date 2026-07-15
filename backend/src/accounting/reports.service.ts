import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const num = (d: Prisma.Decimal | null | undefined) => (d == null ? 0 : Number(d));
const r2 = (n: number) => Math.round(n * 100) / 100;

interface Range { from?: string; to?: string }

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  private dateFilter(range?: Range): Prisma.DateTimeFilter | undefined {
    if (!range?.from && !range?.to) return undefined;
    const f: Prisma.DateTimeFilter = {};
    if (range.from) f.gte = new Date(range.from);
    if (range.to) f.lte = new Date(`${range.to}T23:59:59.999Z`);
    return f;
  }

  /** Movimientos agregados por cuenta (débito/crédito) sobre asientos POSTED. */
  private async balancesByAccount(range?: Range) {
    const date = this.dateFilter(range);
    const grouped = await this.prisma.journalLine.groupBy({
      by: ['accountId'],
      where: { entry: { status: 'POSTED', ...(date ? { date } : {}) } },
      _sum: { debit: true, credit: true },
    });
    return grouped.map((g) => ({ accountId: g.accountId, debit: num(g._sum.debit), credit: num(g._sum.credit) }));
  }

  /** Balance de comprobación (sumas y saldos). */
  async trialBalance(range?: Range) {
    const [balances, accounts] = await Promise.all([
      this.balancesByAccount(range),
      this.prisma.account.findMany({ select: { id: true, code: true, name: true, normalSide: true } }),
    ]);
    const byId = new Map(accounts.map((a) => [a.id, a]));
    const rows = balances
      .map((b) => {
        const acc = byId.get(b.accountId);
        if (!acc) return null;
        const net = r2(b.debit - b.credit);
        return {
          accountId: b.accountId, code: acc.code, name: acc.name,
          debit: r2(b.debit), credit: r2(b.credit),
          saldoDeudor: net > 0 ? net : 0,
          saldoAcreedor: net < 0 ? -net : 0,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null && (r.debit !== 0 || r.credit !== 0))
      .sort((a, b) => a.code.localeCompare(b.code));

    const totals = rows.reduce(
      (t, r) => ({
        debit: r2(t.debit + r.debit), credit: r2(t.credit + r.credit),
        saldoDeudor: r2(t.saldoDeudor + r.saldoDeudor), saldoAcreedor: r2(t.saldoAcreedor + r.saldoAcreedor),
      }),
      { debit: 0, credit: 0, saldoDeudor: 0, saldoAcreedor: 0 },
    );
    return { rows, totals, balanced: Math.abs(totals.debit - totals.credit) < 0.01 };
  }

  /** Estado de resultados (P&G). */
  async incomeStatement(range?: Range) {
    const [balances, accounts] = await Promise.all([
      this.balancesByAccount(range),
      this.prisma.account.findMany({ select: { id: true, code: true, name: true, type: true } }),
    ]);
    const byId = new Map(accounts.map((a) => [a.id, a]));
    const income: { code: string; name: string; amount: number }[] = [];
    const costs: typeof income = [];
    const expenses: typeof income = [];

    for (const b of balances) {
      const acc = byId.get(b.accountId);
      if (!acc) continue;
      if (acc.type === 'INCOME') {
        const amount = r2(b.credit - b.debit);
        if (amount !== 0) income.push({ code: acc.code, name: acc.name, amount });
      } else if (acc.type === 'COST') {
        const amount = r2(b.debit - b.credit);
        if (amount !== 0) costs.push({ code: acc.code, name: acc.name, amount });
      } else if (acc.type === 'EXPENSE') {
        const amount = r2(b.debit - b.credit);
        if (amount !== 0) expenses.push({ code: acc.code, name: acc.name, amount });
      }
    }
    const sum = (a: typeof income) => r2(a.reduce((s, x) => s + x.amount, 0));
    const totalIncome = sum(income), totalCosts = sum(costs), totalExpenses = sum(expenses);
    const grossProfit = r2(totalIncome - totalCosts);
    const netIncome = r2(grossProfit - totalExpenses);
    [income, costs, expenses].forEach((a) => a.sort((x, y) => x.code.localeCompare(y.code)));
    return { income, costs, expenses, totals: { totalIncome, totalCosts, grossProfit, totalExpenses, netIncome } };
  }

  /** Balance general (situación financiera). Incluye la utilidad del ejercicio en el patrimonio. */
  async balanceSheet(range?: Range) {
    const [balances, accounts, pyg] = await Promise.all([
      this.balancesByAccount(range),
      this.prisma.account.findMany({ select: { id: true, code: true, name: true, type: true } }),
      this.incomeStatement(range),
    ]);
    const byId = new Map(accounts.map((a) => [a.id, a]));
    const assets: { code: string; name: string; amount: number }[] = [];
    const liabilities: typeof assets = [];
    const equity: typeof assets = [];

    for (const b of balances) {
      const acc = byId.get(b.accountId);
      if (!acc) continue;
      if (acc.type === 'ASSET') {
        const amount = r2(b.debit - b.credit);
        if (amount !== 0) assets.push({ code: acc.code, name: acc.name, amount });
      } else if (acc.type === 'LIABILITY') {
        const amount = r2(b.credit - b.debit);
        if (amount !== 0) liabilities.push({ code: acc.code, name: acc.name, amount });
      } else if (acc.type === 'EQUITY') {
        const amount = r2(b.credit - b.debit);
        if (amount !== 0) equity.push({ code: acc.code, name: acc.name, amount });
      }
    }
    const sum = (a: typeof assets) => r2(a.reduce((s, x) => s + x.amount, 0));
    const netIncome = pyg.totals.netIncome;
    const totalAssets = sum(assets);
    const totalLiabilities = sum(liabilities);
    const totalEquity = r2(sum(equity) + netIncome); // la utilidad se acumula en patrimonio
    [assets, liabilities, equity].forEach((a) => a.sort((x, y) => x.code.localeCompare(y.code)));
    return {
      assets, liabilities, equity, netIncome,
      totals: {
        totalAssets, totalLiabilities, totalEquity,
        liabilitiesPlusEquity: r2(totalLiabilities + totalEquity),
      },
      balanced: Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.01,
    };
  }

  /** Libro mayor de una cuenta: saldo inicial + movimientos + saldo final. */
  async ledger(accountId: string, range?: Range) {
    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
      select: { id: true, code: true, name: true, normalSide: true },
    });
    if (!account) throw new NotFoundException('Cuenta no encontrada');
    const sign = account.normalSide === 'DEBIT' ? 1 : -1;

    // Saldo inicial: movimientos anteriores al 'from'
    let opening = 0;
    if (range?.from) {
      const prev = await this.prisma.journalLine.aggregate({
        _sum: { debit: true, credit: true },
        where: { accountId, entry: { status: 'POSTED', date: { lt: new Date(range.from) } } },
      });
      opening = r2((num(prev._sum.debit) - num(prev._sum.credit)) * sign);
    }

    const date = this.dateFilter(range);
    const lines = await this.prisma.journalLine.findMany({
      where: { accountId, entry: { status: 'POSTED', ...(date ? { date } : {}) } },
      include: { entry: { select: { number: true, date: true, description: true } } },
      orderBy: [{ entry: { date: 'asc' } }, { entry: { number: 'asc' } }],
    });

    let balance = opening, totalDebit = 0, totalCredit = 0;
    const rows = lines.map((l) => {
      const debit = num(l.debit), credit = num(l.credit);
      totalDebit = r2(totalDebit + debit);
      totalCredit = r2(totalCredit + credit);
      balance = r2(balance + (debit - credit) * sign);
      return {
        lineId: l.id, number: l.entry.number, date: l.entry.date.toISOString(),
        description: l.description || l.entry.description, debit, credit, balance,
      };
    });
    return { account, openingBalance: opening, lines: rows, totalDebit, totalCredit, closingBalance: balance };
  }

  /**
   * Flujo de caja simplificado: entradas/salidas sobre las cuentas de efectivo
   * (tipo ASSET cuyo código empieza en 11 — disponible del PUC).
   */
  async cashFlow(range?: Range) {
    const cashAccounts = await this.prisma.account.findMany({
      where: { type: 'ASSET', code: { startsWith: '11' } }, select: { id: true },
    });
    const ids = cashAccounts.map((a) => a.id);
    if (!ids.length) return { opening: 0, inflows: 0, outflows: 0, netChange: 0, closing: 0 };

    let opening = 0;
    if (range?.from) {
      const prev = await this.prisma.journalLine.aggregate({
        _sum: { debit: true, credit: true },
        where: { accountId: { in: ids }, entry: { status: 'POSTED', date: { lt: new Date(range.from) } } },
      });
      opening = r2(num(prev._sum.debit) - num(prev._sum.credit));
    }
    const date = this.dateFilter(range);
    const agg = await this.prisma.journalLine.aggregate({
      _sum: { debit: true, credit: true },
      where: { accountId: { in: ids }, entry: { status: 'POSTED', ...(date ? { date } : {}) } },
    });
    const inflows = r2(num(agg._sum.debit));
    const outflows = r2(num(agg._sum.credit));
    const netChange = r2(inflows - outflows);
    return { opening, inflows, outflows, netChange, closing: r2(opening + netChange) };
  }

  /** Resumen mensual de ingresos vs gastos para gráficas del panel. */
  async monthlySummary(months = 6) {
    const n = Math.min(24, Math.max(1, Number(months) || 6));
    const accounts = await this.prisma.account.findMany({
      where: { type: { in: ['INCOME', 'COST', 'EXPENSE'] } }, select: { id: true, type: true },
    });
    const typeById = new Map(accounts.map((a) => [a.id, a.type]));
    const ids = accounts.map((a) => a.id);

    const lines = await this.prisma.journalLine.findMany({
      where: { accountId: { in: ids }, entry: { status: 'POSTED' } },
      select: { accountId: true, debit: true, credit: true, entry: { select: { date: true } } },
    });

    const labels: string[] = [];
    const income: number[] = [];
    const expenses: number[] = [];
    const idx = new Map<string, number>();
    // meses recientes (sin Date.now: derivamos del máximo de fechas presentes)
    const allDates = lines.map((l) => l.entry.date).sort((a, b) => a.getTime() - b.getTime());
    const last = allDates.length ? allDates[allDates.length - 1] : null;
    if (!last) return { months: [], income: [], expenses: [] };
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth() - i, 1));
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      idx.set(key, labels.length);
      labels.push(key);
      income.push(0);
      expenses.push(0);
    }
    for (const l of lines) {
      const d = l.entry.date;
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      const i = idx.get(key);
      if (i === undefined) continue;
      const type = typeById.get(l.accountId);
      if (type === 'INCOME') income[i] = r2(income[i] + (num(l.credit) - num(l.debit)));
      else expenses[i] = r2(expenses[i] + (num(l.debit) - num(l.credit)));
    }
    return { months: labels, income, expenses };
  }
}
