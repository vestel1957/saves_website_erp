import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AccountType, NormalSide } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateAccountDto, UpdateAccountDto } from './dto/accounting.dto';

/** Lado natural (naturaleza) de la cuenta según su tipo PUC. */
export function naturalSide(type: AccountType): NormalSide {
  return type === 'ASSET' || type === 'COST' || type === 'EXPENSE' ? 'DEBIT' : 'CREDIT';
}

export interface AccountNode {
  id: string; code: string; name: string; type: AccountType; normalSide: NormalSide;
  parentId: string | null; level: number; isPostable: boolean; isActive: boolean; currency: string;
  children: AccountNode[];
}

@Injectable()
export class AccountsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Plan de cuentas plano, ordenado por código. */
  list(includeInactive = false) {
    return this.prisma.account.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: { code: 'asc' },
    });
  }

  /** Plan de cuentas como árbol (padre → hijos), ordenado por código. */
  async tree(includeInactive = false): Promise<AccountNode[]> {
    const flat = await this.list(includeInactive);
    const byId = new Map<string, AccountNode>();
    flat.forEach((a) => byId.set(a.id, { ...a, children: [] }));
    const roots: AccountNode[] = [];
    for (const node of byId.values()) {
      if (node.parentId && byId.has(node.parentId)) byId.get(node.parentId)!.children.push(node);
      else roots.push(node);
    }
    return roots;
  }

  async get(id: string) {
    const acc = await this.prisma.account.findUnique({ where: { id } });
    if (!acc) throw new NotFoundException('Cuenta no encontrada');
    return acc;
  }

  async create(dto: CreateAccountDto) {
    const code = dto.code.trim();
    const exists = await this.prisma.account.findUnique({ where: { code } });
    if (exists) throw new ConflictException(`Ya existe una cuenta con el código ${code}`);

    let level = 1;
    if (dto.parentId) {
      const parent = await this.prisma.account.findUnique({ where: { id: dto.parentId } });
      if (!parent) throw new NotFoundException('Cuenta padre no encontrada');
      if (parent.type !== dto.type) throw new BadRequestException('La cuenta hija debe ser del mismo tipo que su padre');
      level = parent.level + 1;
      // un padre con movimientos no puede tener hijos; al agregar hijos deja de ser imputable
      if (parent.isPostable) await this.prisma.account.update({ where: { id: parent.id }, data: { isPostable: false } });
    }

    return this.prisma.account.create({
      data: {
        code, name: dto.name.trim(), type: dto.type,
        normalSide: dto.normalSide ?? naturalSide(dto.type),
        parentId: dto.parentId ?? null, level,
        isPostable: dto.isPostable ?? true,
        currency: dto.currency ?? 'COP',
      },
    });
  }

  async update(id: string, dto: UpdateAccountDto) {
    await this.get(id);
    return this.prisma.account.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.isPostable !== undefined ? { isPostable: dto.isPostable } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
    });
  }

  /** Desactiva una cuenta (soft). No se permite si tiene movimientos contabilizados. */
  async deactivate(id: string) {
    await this.get(id);
    const used = await this.prisma.journalLine.count({ where: { accountId: id } });
    if (used > 0) throw new BadRequestException('La cuenta tiene movimientos y no puede eliminarse; se marcó como inactiva');
    return this.prisma.account.update({ where: { id }, data: { isActive: false } });
  }
}
