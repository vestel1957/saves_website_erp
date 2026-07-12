import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

function subName(s: { firstName: string | null; lastName1: string | null; companyName: string | null; fullName: string | null } | null): string | null {
  if (!s) return null;
  return (s.fullName?.trim()) || [s.firstName, s.lastName1].filter(Boolean).join(' ').trim() || s.companyName || null;
}

@Injectable()
export class ExtrasService {
  constructor(private prisma: PrismaService) {}

  // --- PlayHub / IPTV ---
  async playhub(params: { search?: string; page?: number; pageSize?: number }) {
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(params.pageSize) || 30));
    const where: Prisma.PlayhubSubscriptionWhereInput = {};
    const s = (params.search || '').trim();
    if (s) where.OR = [{ nameS: { contains: s, mode: 'insensitive' } }, { productName: { contains: s, mode: 'insensitive' } }, { voucher: { contains: s, mode: 'insensitive' } }];
    const [rows, total, byProduct] = await Promise.all([
      this.prisma.playhubSubscription.findMany({
        where, orderBy: { syncedAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize,
        include: { subscriber: { select: { firstName: true, lastName1: true, companyName: true, fullName: true, abonado: true, id: true } } },
      }),
      this.prisma.playhubSubscription.count({ where }),
      this.prisma.playhubSubscription.groupBy({ by: ['productName'], _count: { _all: true }, orderBy: { _count: { productName: 'desc' } }, take: 6 }),
    ]);
    return {
      items: rows.map((r) => ({
        id: r.id, nameS: r.nameS, externalName: r.externalName, productId: r.productId,
        productName: r.productName, voucher: r.voucher, syncedAt: r.syncedAt,
        subscriberId: r.subscriber?.id ?? null, subscriberName: subName(r.subscriber), abonado: r.subscriber?.abonado ?? null,
      })),
      total, page, pageSize, pages: Math.ceil(total / pageSize),
      byProduct: byProduct.map((b) => ({ product: b.productName ?? '—', count: b._count._all })),
    };
  }

  // --- Mensajería interna ---
  async messages(params: { search?: string; page?: number; pageSize?: number }) {
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(params.pageSize) || 30));
    const where: Prisma.InternalMessageWhereInput = {};
    const s = (params.search || '').trim();
    if (s) where.OR = [{ campaignName: { contains: s, mode: 'insensitive' } }, { body: { contains: s, mode: 'insensitive' } }];
    const [rows, total] = await Promise.all([
      this.prisma.internalMessage.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      this.prisma.internalMessage.count({ where }),
    ]);
    return { items: rows, total, page, pageSize, pages: Math.ceil(total / pageSize) };
  }

  // --- Gestor documental ---
  async documents() {
    const [folders, docs] = await Promise.all([
      this.prisma.docFolder.findMany({ orderBy: { name: 'asc' } }),
      this.prisma.document.findMany({ orderBy: { createdAt: 'desc' } }),
    ]);
    return {
      folders: folders.map((f) => ({ id: f.id, name: f.name, count: docs.filter((d) => d.folderId === f.id).length })),
      documents: docs.map((d) => ({
        id: d.id, title: d.title, fileName: d.fileName, folderId: d.folderId,
        docDate: d.docDate, downloadable: !!d.storedName, createdAt: d.createdAt,
      })),
    };
  }

  async createDocument(data: { title: string; fileName: string; storedName: string; folderId?: string }) {
    return this.prisma.document.create({ data: { title: data.title, fileName: data.fileName, storedName: data.storedName, folderId: data.folderId ?? null } });
  }

  async getDocument(id: string) {
    const d = await this.prisma.document.findUnique({ where: { id } });
    if (!d) throw new NotFoundException('Documento no encontrado');
    return d;
  }

  async createFolder(name: string) {
    return this.prisma.docFolder.create({ data: { name } });
  }
}
