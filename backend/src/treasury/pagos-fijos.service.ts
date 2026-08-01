import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { IsInt, IsNumber, IsOptional, IsString, Matches, Max, Min, MinLength } from 'class-validator';
import { Type } from 'class-transformer';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/current-user.decorator';
import { CobranzasService } from './cobranzas.service';
import { alcanceDe, esCajera } from './caja-scope';
import { hoyEnColombia } from '../common/fecha-colombia';
import { num } from '../common/money';

export class PagoFijoDto {
  @IsString() @MinLength(3) name!: string;
  @IsString() @MinLength(2) category!: string;
  @Type(() => Number) @IsNumber() @Min(1) amount!: number;
  @Type(() => Number) @IsInt() cashAccountId!: number;
  @Type(() => Number) @IsInt() @Min(1) @Max(31) dayOfMonth!: number;
  @IsOptional() @IsString() beneficiary?: string;
  @IsOptional() @IsString() note?: string;
}

export class UpdatePagoFijoDto {
  @IsOptional() @IsString() @MinLength(3) name?: string;
  @IsOptional() @IsString() @MinLength(2) category?: string;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(1) amount?: number;
  @IsOptional() @Type(() => Number) @IsInt() cashAccountId?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(31) dayOfMonth?: number;
  @IsOptional() @IsString() beneficiary?: string;
  @IsOptional() @IsString() note?: string;
  @IsOptional() active?: boolean;
}

export class EjecutarPagoFijoDto {
  /** Periodo que cubre ('YYYY-MM'). Sin él, el mes en curso. */
  @IsOptional() @Matches(/^\d{4}-\d{2}$/) period?: string;
  /** Monto realmente pagado, si difiere del programado (un recibo de luz varía). */
  @IsOptional() @Type(() => Number) @IsNumber() @Min(1) amount?: number;
}

/**
 * Pagos fijos programados (2026-07-31).
 *
 * El flujo es de dos manos: CONTABILIDAD define el pago (qué, cuánto, de qué caja
 * y qué día del mes) y la CAJERA de esa caja registra la ejecución cuando paga.
 * Registrar la ejecución NO es un asiento aparte: crea un egreso en EFECTIVO por
 * `CobranzasService.createExpense`, así que cae solo al cierre de caja del día,
 * con las mismas reglas de alcance de siempre, y el comprobante se adjunta a esa
 * transacción (`/treasury/transactions/:id/attach`, el mismo camino que ya usa
 * el modal de egresos).
 */
@Injectable()
export class PagosFijosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cobranzas: CobranzasService,
  ) {}

  /** 'YYYY-MM' del mes en curso, en hora de Colombia. */
  private periodoActual(): string {
    return hoyEnColombia().toISOString().slice(0, 7);
  }

  /** Valida que la caja exista y sea una caja de sede (no un banco). */
  private async exigirCaja(cashAccountId: number) {
    const caja = await this.prisma.cashAccount.findUnique({
      where: { legacyId: cashAccountId },
      select: { holder: true, branchLegacy: true },
    });
    if (!caja) throw new BadRequestException('Esa caja no existe.');
    // Un pago fijo es plata que sale del CAJÓN de una ventanilla; atarlo a un
    // banco lo dejaría sin cajera que lo ejecute.
    if (caja.branchLegacy === 0) throw new BadRequestException('El pago fijo va atado a una caja de sede, no a un banco.');
    return caja;
  }

  /**
   * Listado con el estado del periodo en curso. La cajera ve SOLO los de su caja;
   * contabilidad y administración los ven todos.
   */
  async list(user: AuthUser) {
    const periodo = this.periodoActual();
    let where = {};
    if (esCajera(user)) {
      const a = await alcanceDe(this.prisma, user);
      // Cajera sin caja asignada: no le corresponde ejecutar ninguno.
      where = { cashAccountId: a.caja ?? -1 };
    }
    const [pagos, cuentas] = await Promise.all([
      this.prisma.scheduledPayment.findMany({
        where,
        orderBy: [{ active: 'desc' }, { dayOfMonth: 'asc' }, { name: 'asc' }],
        include: { runs: { where: { period: periodo } } },
      }),
      this.prisma.cashAccount.findMany({ select: { legacyId: true, holder: true } }),
    ]);
    const nombreCaja = new Map(cuentas.map((c) => [c.legacyId, c.holder]));
    return {
      periodo,
      items: pagos.map((p) => ({
        id: p.id,
        name: p.name,
        category: p.category,
        amount: num(p.amount),
        cashAccountId: p.cashAccountId,
        caja: nombreCaja.get(p.cashAccountId) ?? `Caja ${p.cashAccountId}`,
        dayOfMonth: p.dayOfMonth,
        beneficiary: p.beneficiary,
        note: p.note,
        active: p.active,
        createdByName: p.createdByName,
        // La ejecución del periodo en curso (o null = pendiente de pagar este mes).
        ejecucion: p.runs[0]
          ? {
              id: p.runs[0].id,
              amount: num(p.runs[0].amount),
              transactionId: p.runs[0].transactionId,
              executedByName: p.runs[0].executedByName,
              executedAt: p.runs[0].executedAt,
            }
          : null,
      })),
    };
  }

  /** Historial de ejecuciones de un pago (consulta). */
  async runs(id: string) {
    const p = await this.prisma.scheduledPayment.findUnique({ where: { id }, select: { id: true, name: true } });
    if (!p) throw new NotFoundException('Pago fijo no encontrado');
    const runs = await this.prisma.scheduledPaymentRun.findMany({
      where: { paymentId: id },
      orderBy: { period: 'desc' },
      take: 36,
    });
    return runs.map((r) => ({
      id: r.id, period: r.period, amount: num(r.amount),
      transactionId: r.transactionId, executedByName: r.executedByName, executedAt: r.executedAt,
    }));
  }

  async create(dto: PagoFijoDto, user: AuthUser) {
    await this.exigirCaja(dto.cashAccountId);
    const p = await this.prisma.scheduledPayment.create({
      data: {
        name: dto.name.trim(),
        category: dto.category.trim(),
        amount: dto.amount,
        cashAccountId: dto.cashAccountId,
        dayOfMonth: dto.dayOfMonth,
        beneficiary: dto.beneficiary?.trim() || null,
        note: dto.note?.trim() || null,
        createdById: user.id ?? null,
        createdByName: user.name ?? null,
      },
    });
    return { id: p.id };
  }

  async update(id: string, dto: UpdatePagoFijoDto) {
    const p = await this.prisma.scheduledPayment.findUnique({ where: { id }, select: { id: true } });
    if (!p) throw new NotFoundException('Pago fijo no encontrado');
    if (dto.cashAccountId !== undefined) await this.exigirCaja(dto.cashAccountId);
    await this.prisma.scheduledPayment.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.category !== undefined ? { category: dto.category.trim() } : {}),
        ...(dto.amount !== undefined ? { amount: dto.amount } : {}),
        ...(dto.cashAccountId !== undefined ? { cashAccountId: dto.cashAccountId } : {}),
        ...(dto.dayOfMonth !== undefined ? { dayOfMonth: dto.dayOfMonth } : {}),
        ...(dto.beneficiary !== undefined ? { beneficiary: dto.beneficiary.trim() || null } : {}),
        ...(dto.note !== undefined ? { note: dto.note.trim() || null } : {}),
        ...(dto.active !== undefined ? { active: !!dto.active } : {}),
      },
    });
    return { ok: true };
  }

  /** Borrar solo lo que nunca se ejecutó; con historial se DESACTIVA, no se borra. */
  async remove(id: string) {
    const p = await this.prisma.scheduledPayment.findUnique({
      where: { id },
      select: { id: true, _count: { select: { runs: true } } },
    });
    if (!p) throw new NotFoundException('Pago fijo no encontrado');
    if (p._count.runs > 0) {
      throw new BadRequestException('Este pago ya tiene ejecuciones registradas: desactívalo en vez de borrarlo, o su rastro en los cierres quedaría huérfano.');
    }
    await this.prisma.scheduledPayment.delete({ where: { id } });
    return { ok: true };
  }

  /**
   * Registrar la ejecución del pago para un periodo. Crea el egreso en efectivo
   * (cae al cierre del día de HOY) y deja el enlace pago↔egreso. Devuelve el
   * `transactionId` para que la UI le adjunte el comprobante acto seguido.
   */
  async ejecutar(id: string, dto: EjecutarPagoFijoDto, user: AuthUser) {
    const p = await this.prisma.scheduledPayment.findUnique({ where: { id } });
    if (!p) throw new NotFoundException('Pago fijo no encontrado');
    if (!p.active) throw new BadRequestException('Este pago fijo está desactivado.');

    // La cajera solo ejecuta los pagos de SU caja. (Para contabilidad y
    // administración, `createExpense` aplica su alcance normal.)
    if (esCajera(user)) {
      const a = await alcanceDe(this.prisma, user);
      if (a.caja !== p.cashAccountId) {
        throw new ForbiddenException('Este pago fijo pertenece a otra caja.');
      }
    }

    const period = dto.period ?? this.periodoActual();
    const ya = await this.prisma.scheduledPaymentRun.findUnique({
      where: { paymentId_period: { paymentId: p.id, period } },
    });
    if (ya) throw new BadRequestException(`El periodo ${period} ya está registrado como pagado.`);

    const amount = dto.amount ?? num(p.amount);
    // El egreso va por el camino normal: método EFECTIVO (es plata del cajón),
    // categoría del pago, y nota que deja claro de qué pago fijo y periodo viene.
    const tx = await this.cobranzas.createExpense(
      {
        amount,
        category: p.category,
        method: 'Cash',
        cashAccountId: p.cashAccountId,
        payerName: p.beneficiary ?? undefined,
        note: `Pago fijo: ${p.name} (${period})`,
      } as any,
      user,
    );

    const run = await this.prisma.scheduledPaymentRun.create({
      data: {
        paymentId: p.id,
        period,
        amount,
        transactionId: (tx as any)?.id ?? null,
        executedById: user.id ?? null,
        executedByName: user.name ?? null,
      },
    });
    return { id: run.id, transactionId: (tx as any)?.id ?? null, period, amount };
  }
}
