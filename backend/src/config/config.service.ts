import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsOptional, IsString, MinLength } from 'class-validator';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const num = (d: Prisma.Decimal | number | null | undefined) => (d == null ? 0 : Number(d));

export class UpdateBranchDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() summary?: string;
  @IsOptional() @IsString() dir?: string;
}
export class CategoryDto {
  @IsString() @MinLength(2) name!: string;
}
export class UpdateCompanyDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() region?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() email?: string;
  @IsOptional() @IsString() taxId?: string;
}

@Injectable()
export class ConfigDataService {
  constructor(private readonly prisma: PrismaService) {}

  /** Cajas / cuentas bancarias. */
  async cashAccounts() {
    const [rows, branches] = await Promise.all([
      this.prisma.cashAccount.findMany({ orderBy: { holder: 'asc' } }),
      this.prisma.branch.findMany({ select: { legacyId: true, name: true } }),
    ]);
    const branchByLegacy = new Map(branches.map((b) => [b.legacyId, b.name]));
    return rows.map((a) => ({
      id: a.id, holder: a.holder, accountNumber: a.accountNumber, balance: num(a.balance),
      sede: a.branchLegacy && a.branchLegacy > 0 ? (branchByLegacy.get(a.branchLegacy) ?? `Sede ${a.branchLegacy}`) : 'Banco',
      phone: a.phone, address: a.address, code: a.code,
    }));
  }

  /** Sedes (branches) con conteo de abonados. */
  async branches() {
    const rows = await this.prisma.branch.findMany({ orderBy: { name: 'asc' }, include: { _count: { select: { subscribers: true } } } });
    return rows.map((b) => ({ id: b.id, name: b.name, summary: b.summary, dir: b.dir, subscribers: b._count.subscribers }));
  }
  async updateBranch(id: string, dto: UpdateBranchDto) {
    const b = await this.prisma.branch.findUnique({ where: { id } });
    if (!b) throw new NotFoundException('Sede no encontrada');
    return this.prisma.branch.update({ where: { id }, data: { name: dto.name, summary: dto.summary, dir: dto.dir } });
  }

  /** Geografía: departamentos con conteo de ciudades + totales. */
  async geography() {
    const [deps, cities, locs, hoods] = await Promise.all([
      this.prisma.department.findMany({ orderBy: { name: 'asc' } }),
      this.prisma.city.groupBy({ by: ['departmentLegacy'], _count: { _all: true } }),
      this.prisma.locality.count(),
      this.prisma.neighborhood.count(),
    ]);
    const cityCount = new Map(cities.map((c) => [c.departmentLegacy, c._count._all]));
    return {
      totals: { departamentos: deps.length, ciudades: cities.reduce((a, c) => a + c._count._all, 0), localidades: locs, barrios: hoods },
      departamentos: deps.map((d) => ({ id: d.id, name: d.name, ciudades: cityCount.get(d.legacyId ?? -1) ?? 0 })),
    };
  }

  /** Ciudades de un departamento (por legacyId del departamento). */
  async cities(departmentId: string) {
    const dep = await this.prisma.department.findUnique({ where: { id: departmentId } });
    if (!dep) throw new NotFoundException('Departamento no encontrado');
    const rows = await this.prisma.city.findMany({ where: { departmentLegacy: dep.legacyId }, orderBy: { name: 'asc' } });
    return rows.map((c) => ({ id: c.id, name: c.name }));
  }

  /** Empresa (CompanyInfo, fila única). */
  async company() {
    const c = await this.prisma.companyInfo.findFirst();
    if (!c) return null;
    return { id: c.id, name: c.name, address: c.address, city: c.city, region: c.region, country: c.country, phone: c.phone, email: c.email, taxId: c.taxId, currency: c.currency, prefix: c.prefix };
  }
  async updateCompany(dto: UpdateCompanyDto) {
    const c = await this.prisma.companyInfo.findFirst();
    if (!c) throw new NotFoundException('No hay datos de empresa');
    return this.prisma.companyInfo.update({ where: { id: c.id }, data: { ...dto } });
  }

  /** Categorías de transacción (tesorería) con conteo de uso. */
  async categories() {
    const cats = await this.prisma.transactionCategory.findMany({ orderBy: { name: 'asc' } });
    const usage = await this.prisma.transaction.groupBy({
      by: ['category'],
      _count: { _all: true },
    });
    const byName = new Map(usage.map((u) => [u.category, u._count._all]));
    return cats.map((c) => ({ id: c.id, name: c.name, usage: byName.get(c.name) ?? 0 }));
  }

  async createCategory(dto: CategoryDto) {
    const name = dto.name.trim();
    const dup = await this.prisma.transactionCategory.findFirst({ where: { name } });
    if (dup) throw new BadRequestException('Ya existe una categoría con ese nombre.');
    // legacyId es requerido y único: los registros creados por la app toman max+1.
    const max = await this.prisma.transactionCategory.aggregate({ _max: { legacyId: true } });
    const legacyId = (max._max.legacyId ?? 0) + 1;
    const c = await this.prisma.transactionCategory.create({ data: { name, legacyId } });
    return { id: c.id, name: c.name, usage: 0 };
  }

  async updateCategory(id: string, dto: CategoryDto) {
    const cat = await this.prisma.transactionCategory.findUnique({ where: { id } });
    if (!cat) throw new NotFoundException('Categoría no encontrada');
    const name = dto.name.trim();
    const dup = await this.prisma.transactionCategory.findFirst({ where: { name, id: { not: id } } });
    if (dup) throw new BadRequestException('Ya existe una categoría con ese nombre.');
    // Renombrar en cascada las transacciones que usan el nombre anterior.
    if (name !== cat.name) {
      await this.prisma.transaction.updateMany({ where: { category: cat.name }, data: { category: name } });
    }
    const c = await this.prisma.transactionCategory.update({ where: { id }, data: { name } });
    const usage = await this.prisma.transaction.count({ where: { category: name } });
    return { id: c.id, name: c.name, usage };
  }

  async deleteCategory(id: string) {
    const cat = await this.prisma.transactionCategory.findUnique({ where: { id } });
    if (!cat) throw new NotFoundException('Categoría no encontrada');
    const inUse = await this.prisma.transaction.count({ where: { category: cat.name } });
    if (inUse > 0) {
      throw new BadRequestException(`No se puede eliminar: ${inUse} transacción(es) usan esta categoría.`);
    }
    await this.prisma.transactionCategory.delete({ where: { id } });
    return { id, deleted: true };
  }
}
