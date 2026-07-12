import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsArray, IsInt, IsNumber, IsOptional, IsString, Min, MinLength, ValidateNested } from 'class-validator';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/current-user.decorator';

const num = (d: Prisma.Decimal | number | null | undefined) => (d == null ? 0 : Number(d));
const round2 = (n: number) => Math.round(n * 100) / 100;
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

  private async nextTid(tx: Prisma.TransactionClient) {
    const max = await tx.stockReturn.aggregate({ _max: { tid: true } });
    return (max._max.tid ?? 1000) + 1;
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
}
