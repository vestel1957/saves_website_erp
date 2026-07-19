import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsArray, IsInt, IsNumber, IsOptional, IsString, Min, MinLength, ValidateNested } from 'class-validator';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/current-user.decorator';
import { num, round2 } from '../common/money';
import { nextTid, TID_SEQ } from '../common/tid';

const dateOnly = (s?: string) => { const d = s ? new Date(s) : new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); };

export class ReturnItemDto {
  @IsString() materialId!: string;
  @IsInt() @Min(1) qty!: number;
  @IsNumber() @Min(0) price!: number;
}
export class CreateReturnDto {
  @IsString() supplierId!: string;
  @IsOptional() @IsString() date?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() updateStock?: boolean;
  @IsArray() @ValidateNested({ each: true }) @Type(() => ReturnItemDto) items!: ReturnItemDto[];
}

/** Pago/abono de una devolución (crédito del proveedor). */
export class PayReturnDto {
  @IsNumber() @Min(1) amount!: number;
  @IsString() method!: string;
  @IsOptional() @IsInt() cashAccountId?: number;
  @IsOptional() @IsString() accountName?: string;
  @IsOptional() @IsString() date?: string;
  @IsOptional() @IsString() note?: string;
}

@Injectable()
export class ReturnsService {
  constructor(private readonly prisma: PrismaService) {}

  async stats() {
    const [byStatus, agg] = await Promise.all([
      this.prisma.stockReturn.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.stockReturn.aggregate({ _sum: { total: true }, _count: { _all: true } }),
    ]);
    const status: Record<string, number> = {}; for (const r of byStatus) status[r.status] = r._count._all;
    return { total: agg._count._all, montoTotal: num(agg._sum.total), status };
  }

  async list(params: { search?: string; status?: string; page?: number; pageSize?: number }) {
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(params.pageSize) || 25));
    const where: Prisma.StockReturnWhereInput = {};
    if (params.status) where.status = params.status;
    const search = (params.search || '').trim();
    if (search) {
      const asNum = Number(search);
      where.OR = [...(Number.isFinite(asNum) ? [{ tid: asNum }] : []), { supplier: { is: { name: { contains: search, mode: 'insensitive' as const } } } }];
    }
    const [rows, total] = await Promise.all([
      this.prisma.stockReturn.findMany({ where, orderBy: { date: 'desc' }, skip: (page - 1) * pageSize, take: pageSize, include: { supplier: true } }),
      this.prisma.stockReturn.count({ where }),
    ]);
    return {
      items: rows.map((r) => ({ id: r.id, tid: r.tid, supplier: r.supplier?.name ?? '—', date: r.date, total: num(r.total), status: r.status, itemsCount: r.itemsCount })),
      total, page, pageSize, pages: Math.ceil(total / pageSize),
    };
  }

  async detail(id: string) {
    const r = await this.prisma.stockReturn.findUnique({ where: { id }, include: { supplier: true, items: { include: { material: true } } } });
    if (!r) throw new NotFoundException('Devolución no encontrada');
    return {
      id: r.id, tid: r.tid, status: r.status, date: r.date, total: num(r.total), subtotal: num(r.subtotal), tax: num(r.tax), notes: r.notes,
      supplier: r.supplier ? { id: r.supplier.id, name: r.supplier.name, nit: r.supplier.nit } : null,
      items: r.items.map((it) => ({ id: it.id, product: it.product ?? it.material?.name, qty: it.qty, price: num(it.price), subtotal: num(it.subtotal) })),
    };
  }

  /** Consecutivo de devolución. Secuencia de Postgres. Ver common/tid.ts. */
  private nextTid(tx: Prisma.TransactionClient) {
    return nextTid(tx, TID_SEQ.stockReturn);
  }

  /** Crear devolución: resta stock del material (si updateStock). */
  async create(dto: CreateReturnDto, user: AuthUser) {
    if (!dto.items?.length) throw new BadRequestException('La devolución no tiene ítems');
    const supplier = await this.prisma.supplier.findUnique({ where: { id: dto.supplierId } });
    if (!supplier) throw new NotFoundException('Proveedor no encontrado');
    const rows = dto.items.map((it) => ({ ...it, qty: Math.round(it.qty), price: round2(it.price), subtotal: round2(Math.round(it.qty) * round2(it.price)) }));
    const subtotal = round2(rows.reduce((s, r) => s + r.subtotal, 0));
    const updateStock = dto.updateStock !== false; // por defecto sí

    return this.prisma.$transaction(async (tx) => {
      const tid = await this.nextTid(tx);
      const r = await tx.stockReturn.create({
        data: {
          tid, supplierId: supplier.id, supplierLegacy: supplier.legacyId ?? null, date: dateOnly(dto.date),
          subtotal, total: subtotal, status: 'pending', notes: dto.notes ?? null, itemsCount: rows.length,
          items: { create: rows.map((r2) => ({ materialId: r2.materialId, product: undefined, qty: r2.qty, price: r2.price, subtotal: r2.subtotal })) },
        },
        include: { items: true },
      });
      // Enriquecer nombre de producto + restar stock
      for (const it of r.items) {
        if (!it.materialId) continue;
        const mat = await tx.material.findUnique({ where: { id: it.materialId } });
        if (mat) {
          await tx.stockReturnItem.update({ where: { id: it.id }, data: { product: mat.name } });
          if (updateStock) await tx.material.update({ where: { id: mat.id }, data: { qty: Math.max(0, mat.qty - it.qty) } });
        }
      }
      return { id: r.id, tid: r.tid, total: subtotal };
    });
  }

  async remove(id: string) {
    const r = await this.prisma.stockReturn.findUnique({ where: { id }, include: { items: true } });
    if (!r) throw new NotFoundException('Devolución no encontrada');
    // Reponer stock
    await this.prisma.$transaction(async (tx) => {
      for (const it of r.items) {
        if (it.materialId) {
          const mat = await tx.material.findUnique({ where: { id: it.materialId } });
          if (mat) await tx.material.update({ where: { id: mat.id }, data: { qty: mat.qty + it.qty } });
        }
      }
      await tx.stockReturn.delete({ where: { id } });
    });
    return { id, deleted: true };
  }

  /** Registra el pago/crédito de una devolución: ingreso en tesorería + saldo. */
  async pay(id: string, dto: PayReturnDto, user: AuthUser) {
    const amount = round2(Number(dto.amount));
    if (amount <= 0) throw new BadRequestException('El monto debe ser mayor a cero');

    return this.prisma.$transaction(async (tx) => {
      // Igual que en el abono a orden de compra: leer dentro de la transacción y con
      // la fila bloqueada, o dos créditos simultáneos pierden uno de los dos abonos
      // dejando los dos ingresos creados. La validación del saldo va dentro también.
      await tx.$queryRaw`SELECT id FROM "StockReturn" WHERE id = ${id} FOR UPDATE`;
      const r = await tx.stockReturn.findUnique({ where: { id } });
      if (!r) throw new NotFoundException('Devolución no encontrada');
      const balance = round2(num(r.total) - num(r.paidAmount));
      if (amount > balance + 0.01) throw new BadRequestException(`El abono (${amount}) supera el saldo de la devolución (${balance}).`);

      const t = await tx.transaction.create({
        data: {
          type: 'INCOME', category: 'Devolución proveedor', credit: amount, debit: 0,
          method: dto.method ?? 'Cash', date: dateOnly(dto.date),
          cashAccountId: dto.cashAccountId ?? null, accountName: dto.accountName ?? null,
          ext: true, status: 'VIGENTE', issuerUserId: null,
          note: dto.note ?? `Crédito devolución #${r.tid}`,
          stockReturnId: r.id, supplierId: r.supplierId,
        },
      });
      const newPaid = round2(num(r.paidAmount) + amount);
      const status = newPaid >= num(r.total) ? 'paid' : 'partial';
      await tx.stockReturn.update({ where: { id }, data: { paidAmount: newPaid, status } });
      return { ok: true, transactionId: t.id, paidAmount: newPaid, status };
    });
  }
}
