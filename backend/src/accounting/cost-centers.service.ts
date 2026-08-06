import { BadRequestException, ConflictException, NotFoundException } from '../core/http/errores';
import { PrismaService } from '../prisma/prisma.service';

export class CostCentersService {
  constructor(private readonly prisma: PrismaService) {}

  list(includeInactive = false) {
    return this.prisma.costCenter.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: { code: 'asc' },
      select: { id: true, code: true, name: true, parentId: true, isActive: true },
    });
  }

  async create(dto: { code: string; name: string; parentId?: string | null }) {
    const code = (dto.code || '').trim();
    const name = (dto.name || '').trim();
    if (!code || !name) throw new BadRequestException('Código y nombre son obligatorios');
    const dup = await this.prisma.costCenter.findUnique({ where: { code } });
    if (dup) throw new ConflictException(`Ya existe un centro de costo con el código ${code}`);
    return this.prisma.costCenter.create({ data: { code, name, parentId: dto.parentId ?? null } });
  }

  async setActive(id: string, isActive: boolean) {
    const cc = await this.prisma.costCenter.findUnique({ where: { id } });
    if (!cc) throw new NotFoundException('Centro de costo no encontrado');
    return this.prisma.costCenter.update({ where: { id }, data: { isActive } });
  }
}
