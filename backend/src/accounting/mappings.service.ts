import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpsertMappingDto } from './dto/accounting.dto';

/** Claves de mapeo conocidas por el motor (documento origen → cuenta contable). */
export const MAPPING_KEYS = [
  'SALES_AR', 'SALES_REVENUE', 'SALES_TAX',
  'PURCHASE_AP', 'PURCHASE_EXPENSE', 'PURCHASE_TAX',
  'BANK_DEFAULT', 'CASH_DEFAULT', 'COGS', 'INVENTORY',
  'RETAINED_EARNINGS', 'INCOME_SUMMARY',
] as const;
export type MappingKey = (typeof MAPPING_KEYS)[number];

@Injectable()
export class MappingsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Lista todas las claves conocidas con su cuenta asignada (o null si falta configurar). */
  async list() {
    const rows = await this.prisma.accountMapping.findMany({ include: { account: { select: { code: true, name: true } } } });
    const byKey = new Map(rows.map((r) => [r.key, r]));
    return MAPPING_KEYS.map((key) => {
      const m = byKey.get(key);
      return {
        key,
        accountId: m?.accountId ?? null,
        account: m?.account ?? null,
        description: m?.description ?? null,
      };
    });
  }

  async upsert(dto: UpsertMappingDto) {
    const acc = await this.prisma.account.findUnique({ where: { id: dto.accountId } });
    if (!acc) throw new NotFoundException('Cuenta no encontrada');
    return this.prisma.accountMapping.upsert({
      where: { key: dto.key },
      update: { accountId: dto.accountId, description: dto.description ?? null },
      create: { key: dto.key, accountId: dto.accountId, description: dto.description ?? null },
    });
  }

  /** Resuelve la cuenta de una clave; lanza si no está configurada. */
  async resolve(key: MappingKey): Promise<string> {
    const m = await this.prisma.accountMapping.findUnique({ where: { key } });
    if (!m) throw new NotFoundException(`Falta configurar el mapeo contable "${key}" (Configuración → Mapeo de cuentas)`);
    return m.accountId;
  }

  /** Resuelve varias claves a la vez. */
  async resolveMany(keys: MappingKey[]): Promise<Record<string, string>> {
    const rows = await this.prisma.accountMapping.findMany({ where: { key: { in: keys } } });
    const byKey = new Map(rows.map((r) => [r.key, r.accountId]));
    const out: Record<string, string> = {};
    for (const k of keys) {
      const id = byKey.get(k);
      if (!id) throw new NotFoundException(`Falta configurar el mapeo contable "${k}"`);
      out[k] = id;
    }
    return out;
  }
}
