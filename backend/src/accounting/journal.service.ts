import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PeriodsService } from './periods.service';
import { CreateJournalEntryDto } from './dto/accounting.dto';
import { num, round2 } from '../common/money';


/** Línea de asiento para contabilización (usada por asientos manuales y automáticos). */
export interface PostLine {
  accountId: string;
  costCenterId?: string | null;
  debit: number;
  credit: number;
  description?: string | null;
}

export interface PostEntryInput {
  date: Date;
  description: string;
  reference?: string | null;
  lines: PostLine[];
  type?: 'MANUAL' | 'AUTOMATIC' | 'RECURRING' | 'CLOSING';
  sourceType?: string | null;
  sourceId?: string | null;
  createdBy?: string | null;
}

@Injectable()
export class JournalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly periods: PeriodsService,
  ) {}

  private serialize(entry: any) {
    return {
      ...entry,
      lines: (entry.lines ?? []).map((l: any) => ({
        ...l,
        debit: num(l.debit).toFixed(2),
        credit: num(l.credit).toFixed(2),
      })),
    };
  }

  async list(params: { from?: string; to?: string; status?: string; take?: number } = {}) {
    const where: Prisma.JournalEntryWhereInput = {};
    if (params.status) where.status = params.status as any;
    if (params.from || params.to) {
      where.date = {};
      if (params.from) (where.date as any).gte = new Date(params.from);
      if (params.to) (where.date as any).lte = new Date(`${params.to}T23:59:59.999Z`);
    }
    const entries = await this.prisma.journalEntry.findMany({
      where, orderBy: [{ date: 'desc' }, { number: 'desc' }],
      take: Math.min(500, Number(params.take) || 200),
      include: {
        lines: {
          orderBy: { lineOrder: 'asc' },
          include: { account: { select: { code: true, name: true } }, costCenter: { select: { name: true } } },
        },
      },
    });
    return entries.map((e) => this.serialize(e));
  }

  async get(id: string) {
    const e = await this.prisma.journalEntry.findUnique({
      where: { id },
      include: {
        lines: { orderBy: { lineOrder: 'asc' }, include: { account: { select: { code: true, name: true } }, costCenter: { select: { name: true } } } },
      },
    });
    if (!e) throw new NotFoundException('Asiento no encontrado');
    return this.serialize(e);
  }

  /** Valida partida doble y contabiliza. Núcleo compartido por asientos manuales y automáticos. */
  async post(input: PostEntryInput) {
    const lines = (input.lines || []).map((l) => ({
      ...l,
      debit: round2(l.debit),
      credit: round2(l.credit),
    }));

    if (lines.length < 2) throw new BadRequestException('Un asiento requiere al menos dos líneas');

    let totalDebit = 0, totalCredit = 0;
    for (const l of lines) {
      if (l.debit < 0 || l.credit < 0) throw new BadRequestException('Los valores no pueden ser negativos');
      if (l.debit > 0 && l.credit > 0) throw new BadRequestException('Una línea no puede tener débito y crédito a la vez');
      if (l.debit === 0 && l.credit === 0) throw new BadRequestException('Cada línea debe tener débito o crédito');
      totalDebit += l.debit;
      totalCredit += l.credit;
    }
    totalDebit = round2(totalDebit);
    totalCredit = round2(totalCredit);
    if (totalDebit !== totalCredit) {
      throw new BadRequestException(`El asiento no cuadra: débitos ${totalDebit.toFixed(2)} ≠ créditos ${totalCredit.toFixed(2)}`);
    }
    if (totalDebit === 0) throw new BadRequestException('El asiento no puede ser por valor cero');

    // Las cuentas deben existir, estar activas y ser imputables (hoja del árbol)
    const accountIds = [...new Set(lines.map((l) => l.accountId))];
    const accounts = await this.prisma.account.findMany({ where: { id: { in: accountIds } } });
    const byId = new Map(accounts.map((a) => [a.id, a]));
    for (const id of accountIds) {
      const a = byId.get(id);
      if (!a) throw new BadRequestException(`Cuenta ${id} no existe`);
      if (!a.isActive) throw new BadRequestException(`La cuenta ${a.code} está inactiva`);
      if (!a.isPostable) throw new BadRequestException(`La cuenta ${a.code} no es imputable (es cuenta mayor)`);
    }

    // El periodo de la fecha debe estar abierto
    const period = await this.periods.assertOpenForDate(input.date);

    // Idempotencia: un documento origen genera un solo asiento
    if (input.sourceType && input.sourceId) {
      const existing = await this.prisma.journalEntry.findUnique({
        where: { sourceType_sourceId: { sourceType: input.sourceType, sourceId: input.sourceId } },
      });
      if (existing) return this.get(existing.id);
    }

    const entry = await this.prisma.$transaction(async (tx) => {
      const last = await tx.journalEntry.findFirst({ orderBy: { number: 'desc' }, select: { number: true } });
      const number = (last?.number ?? 0) + 1;
      return tx.journalEntry.create({
        data: {
          number, date: input.date, periodId: period?.id ?? null,
          type: input.type ?? 'MANUAL', status: 'POSTED',
          description: input.description, reference: input.reference ?? null,
          sourceType: input.sourceType ?? null, sourceId: input.sourceId ?? null,
          createdBy: input.createdBy ?? null,
          lines: {
            create: lines.map((l, i) => ({
              accountId: l.accountId, costCenterId: l.costCenterId ?? null,
              debit: l.debit, credit: l.credit, description: l.description ?? null, lineOrder: i,
            })),
          },
        },
      });
    });
    return this.get(entry.id);
  }

  /** Asiento manual desde el frontend. */
  createManual(dto: CreateJournalEntryDto, createdBy?: string | null) {
    return this.post({
      date: new Date(dto.date),
      description: dto.description,
      reference: dto.reference ?? null,
      type: 'MANUAL',
      createdBy: createdBy ?? null,
      lines: dto.lines.map((l) => ({
        accountId: l.accountId, costCenterId: l.costCenterId ?? null,
        debit: l.debit, credit: l.credit, description: l.description ?? null,
      })),
    });
  }

  /**
   * Reverso: crea un asiento espejo (débitos↔créditos) y marca el original como REVERSED.
   * No borra nada — mantiene la trazabilidad contable.
   */
  async reverse(id: string, createdBy?: string | null) {
    const original = await this.prisma.journalEntry.findUnique({ where: { id }, include: { lines: true } });
    if (!original) throw new NotFoundException('Asiento no encontrado');
    if (original.status === 'REVERSED') throw new BadRequestException('El asiento ya fue reversado');
    if (original.reversedById) throw new BadRequestException('El asiento ya tiene un reverso');

    await this.periods.assertOpenForDate(original.date);

    const reversal = await this.prisma.$transaction(async (tx) => {
      const last = await tx.journalEntry.findFirst({ orderBy: { number: 'desc' }, select: { number: true } });
      const number = (last?.number ?? 0) + 1;
      const rev = await tx.journalEntry.create({
        data: {
          number, date: new Date(), periodId: original.periodId, type: original.type, status: 'POSTED',
          description: `Reverso de asiento #${original.number} — ${original.description}`,
          reference: original.reference, sourceType: 'REVERSAL', sourceId: original.id, createdBy: createdBy ?? null,
          lines: {
            create: original.lines
              .sort((a, b) => a.lineOrder - b.lineOrder)
              .map((l, i) => ({
                accountId: l.accountId, costCenterId: l.costCenterId,
                debit: l.credit, credit: l.debit, description: l.description, lineOrder: i,
              })),
          },
        },
      });
      await tx.journalEntry.update({ where: { id: original.id }, data: { status: 'REVERSED', reversedById: rev.id } });
      return rev;
    });
    return this.get(reversal.id);
  }
}
