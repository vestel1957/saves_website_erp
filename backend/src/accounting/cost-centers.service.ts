import { BadRequestException, ConflictException, NotFoundException } from '../core/http/errores';
import { PrismaService } from '../prisma/prisma.service';
import { invalidarCacheCentros } from '../common/centro-costo';

export class CostCentersService {
  constructor(private readonly prisma: PrismaService) {}

  list(includeInactive = false) {
    return this.prisma.costCenter.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: { code: 'asc' },
      // `kind` y la sede vinculada: la pantalla de tesorería sugiere con ellos el centro de la caja.
      select: {
        id: true, code: true, name: true, parentId: true, isActive: true, kind: true,
        branch: { select: { legacyId: true, name: true } },
      },
    });
  }

  /**
   * Las sedes con su centro (o sin él), para enlazarlas desde la pantalla de centros de
   * costo. Todas, sin acotar por sede: es un catálogo de contabilidad, no datos de clientes.
   */
  sedes() {
    return this.prisma.branch.findMany({
      orderBy: { legacyId: 'asc' },
      select: { legacyId: true, name: true, costCenter: { select: { id: true, code: true, name: true } } },
    });
  }

  async create(dto: { code: string; name: string; parentId?: string | null }) {
    const code = (dto.code || '').trim();
    const name = (dto.name || '').trim();
    if (!code || !name) throw new BadRequestException('Código y nombre son obligatorios');
    const dup = await this.prisma.costCenter.findUnique({ where: { code } });
    if (dup) throw new ConflictException(`Ya existe un centro de costo con el código ${code}`);
    const cc = await this.prisma.costCenter.create({ data: { code, name, parentId: dto.parentId ?? null } });
    invalidarCacheCentros();
    return cc;
  }

  /**
   * Edita nombre, estado y sede vinculada. El código no se toca: es la llave con la que el
   * sembrado (`scripts/sembrar-centros-costo.ts`) reconoce los centros.
   *
   * Sede (`branchLegacyId`, el `gid`): `null` la desenlaza; un número la enlaza. Una sede
   * sólo tiene un centro, así que si ya está enlazada con OTRO se rechaza (hay que
   * desenlazarla allí primero: mover una sede de centro cambia a dónde van sus asientos y
   * no debe pasar sin querer). Enlazar marca el centro como de sede y desenlazar lo deja
   * como «otro»; «Administración general» no se puede enlazar con una sede.
   */
  async update(id: string, dto: { name?: string; isActive?: boolean; branchLegacyId?: number | null }) {
    const cc = await this.prisma.costCenter.findUnique({
      where: { id },
      select: { id: true, kind: true, branch: { select: { id: true, legacyId: true } } },
    });
    if (!cc) throw new NotFoundException('Centro de costo no encontrado');

    const data: { name?: string; isActive?: boolean; kind?: 'SEDE' | 'OTRO' } = {};
    if (dto.name !== undefined) {
      const name = typeof dto.name === 'string' ? dto.name.trim() : '';
      if (!name) throw new BadRequestException('El nombre no puede quedar vacío');
      data.name = name;
    }
    if (dto.isActive !== undefined) {
      if (typeof dto.isActive !== 'boolean') throw new BadRequestException('isActive debe ser verdadero o falso');
      data.isActive = dto.isActive;
    }

    // Sede: undefined = no se toca.
    let enlazar: { branchId: string } | null = null;
    let desenlazar = false;
    if (dto.branchLegacyId !== undefined) {
      const actual = cc.branch?.legacyId ?? null;
      if (dto.branchLegacyId === null) {
        desenlazar = actual !== null;
        if (desenlazar && cc.kind === 'SEDE') data.kind = 'OTRO';
      } else {
        const gid = Number(dto.branchLegacyId);
        if (!Number.isInteger(gid) || gid <= 0) throw new BadRequestException('Sede inválida');
        if (gid !== actual) {
          if (cc.kind === 'GENERAL') {
            throw new BadRequestException('«Administración general» no se enlaza con una sede');
          }
          const sede = await this.prisma.branch.findUnique({
            where: { legacyId: gid },
            select: { id: true, name: true, costCenter: { select: { id: true, code: true } } },
          });
          if (!sede) throw new NotFoundException('Sede no encontrada');
          if (sede.costCenter && sede.costCenter.id !== id) {
            throw new ConflictException(
              `La sede ${sede.name} ya está enlazada con el centro ${sede.costCenter.code}. Desenlácela allí primero.`,
            );
          }
          enlazar = { branchId: sede.id };
          desenlazar = actual !== null;
          data.kind = 'SEDE';
        }
      }
    }

    const actualizado = await this.prisma.$transaction(async (tx) => {
      if (desenlazar && cc.branch) {
        await tx.branch.update({ where: { id: cc.branch.id }, data: { costCenterId: null } });
      }
      if (enlazar) await tx.branch.update({ where: { id: enlazar.branchId }, data: { costCenterId: id } });
      return tx.costCenter.update({
        where: { id },
        data,
        select: {
          id: true, code: true, name: true, parentId: true, isActive: true, kind: true,
          branch: { select: { legacyId: true, name: true } },
        },
      });
    });
    invalidarCacheCentros();
    return actualizado;
  }

  async setActive(id: string, isActive: boolean) {
    const cc = await this.prisma.costCenter.findUnique({ where: { id } });
    if (!cc) throw new NotFoundException('Centro de costo no encontrado');
    const actualizado = await this.prisma.costCenter.update({ where: { id }, data: { isActive } });
    invalidarCacheCentros();
    return actualizado;
  }
}
