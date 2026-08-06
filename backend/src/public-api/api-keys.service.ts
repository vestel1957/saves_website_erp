import { BadRequestException, NotFoundException } from '../core/http/errores';
import { PrismaService } from '../prisma/prisma.service';
import { generateApiKey } from './api-key.util';

/** Scopes disponibles para una clave de API pública. */
export const ALL_SCOPES: { key: string; label: string }[] = [
  { key: 'clients:read', label: 'Leer clientes' },
  { key: 'invoices:read', label: 'Leer facturas' },
];
const SCOPE_KEYS = new Set(ALL_SCOPES.map((s) => s.key));

export interface CreateApiKeyDto {
  name?: string;
  scopes?: string[];
  rateLimit?: number;
  ipAllowlist?: string[];
  ignoreLimits?: boolean;
}

export class ApiKeysService {
  constructor(private readonly prisma: PrismaService) {}

  async list() {
    const rows = await this.prisma.apiKey.findMany({ orderBy: { createdAt: 'desc' } });
    return rows.map((k) => ({
      id: k.id,
      name: k.name,
      keyPrefix: k.keyPrefix,
      scopes: k.scopes,
      active: k.active && !k.revokedAt,
      revoked: !!k.revokedAt,
      rateLimit: k.rateLimit,
      ignoreLimits: k.ignoreLimits,
      ipAllowlist: k.ipAllowlist,
      lastUsedAt: k.lastUsedAt,
      lastUsedIp: k.lastUsedIp,
      usageCount: k.usageCount,
      createdByName: k.createdByName,
      createdAt: k.createdAt,
      legacy: k.legacyId != null,
    }));
  }

  async create(dto: CreateApiKeyDto, createdByName?: string) {
    const name = (dto.name ?? '').trim();
    if (!name) throw new BadRequestException('Ponle un nombre a la clave (para reconocer al tercero).');
    const scopes = (dto.scopes?.length ? dto.scopes : ['clients:read']).filter((s) => SCOPE_KEYS.has(s));
    if (scopes.length === 0) throw new BadRequestException('Selecciona al menos un permiso válido.');
    const { key, keyHash, keyPrefix } = generateApiKey();
    const created = await this.prisma.apiKey.create({
      data: {
        name, keyHash, keyPrefix, scopes,
        rateLimit: Number.isFinite(dto.rateLimit) ? Math.max(0, Math.trunc(dto.rateLimit!)) : 500,
        ipAllowlist: (dto.ipAllowlist ?? []).map((s) => s.trim()).filter(Boolean),
        ignoreLimits: !!dto.ignoreLimits,
        createdByName,
      },
    });
    // La clave en claro se devuelve UNA sola vez; no se vuelve a poder ver.
    return { id: created.id, name: created.name, key, keyPrefix: created.keyPrefix, scopes: created.scopes };
  }

  async setActive(id: string, active: boolean) {
    const k = await this.prisma.apiKey.findUnique({ where: { id } });
    if (!k) throw new NotFoundException('Clave no encontrada.');
    return this.prisma.apiKey.update({ where: { id }, data: { active } }).then(() => ({ ok: true }));
  }

  async revoke(id: string) {
    const k = await this.prisma.apiKey.findUnique({ where: { id } });
    if (!k) throw new NotFoundException('Clave no encontrada.');
    await this.prisma.apiKey.update({ where: { id }, data: { active: false, revokedAt: new Date() } });
    return { ok: true };
  }
}
