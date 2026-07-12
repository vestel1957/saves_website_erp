import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const money = (d: Prisma.Decimal | number | null | undefined) => (d == null ? 0 : Number(d));

/** Lógica de solo lectura expuesta a terceros vía la API pública. */
@Injectable()
export class PublicService {
  constructor(private readonly prisma: PrismaService) {}

  private clientShape(s: any) {
    return {
      id: s.id,
      abonado: s.abonado,
      documento: s.docNumber,
      tipoDocumento: s.docType,
      nombre: s.fullName ?? [s.firstName, s.lastName1, s.lastName2].filter(Boolean).join(' ').trim(),
      email: s.email && s.email !== 'NULL' ? s.email : null,
      telefono: s.phone1 ?? s.phone2 ?? null,
      direccion: s.addressLine ?? null,
      sede: s.branch?.name ?? null,
      estado: s.status ?? null,
      plan: s.pppProfile ?? null,
      creado: s.createdAt ?? null,
    };
  }

  async clients(params: { page?: number; pageSize?: number; search?: string }) {
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(params.pageSize) || 50));
    const search = (params.search ?? '').trim();
    const where: Prisma.SubscriberWhereInput = search
      ? {
          OR: [
            { fullName: { contains: search, mode: 'insensitive' } },
            { docNumber: { contains: search } },
            { email: { contains: search, mode: 'insensitive' } },
            { phone1: { contains: search } },
          ],
        }
      : {};
    const [total, rows] = await Promise.all([
      this.prisma.subscriber.count({ where }),
      this.prisma.subscriber.findMany({
        where, include: { branch: { select: { name: true } } },
        orderBy: { abonado: 'asc' }, skip: (page - 1) * pageSize, take: pageSize,
      }),
    ]);
    return { total, page, pageSize, items: rows.map((s) => this.clientShape(s)) };
  }

  async clientById(id: string) {
    // Acepta id (cuid), abonado numérico o legacyId.
    const asNum = Number(id);
    const s = await this.prisma.subscriber.findFirst({
      where: {
        OR: [
          { id },
          ...(Number.isFinite(asNum) ? [{ abonado: asNum }, { legacyId: asNum }] : []),
        ],
      },
      include: { branch: { select: { name: true } } },
    });
    if (!s) throw new NotFoundException('Cliente no encontrado.');
    return this.clientShape(s);
  }

  async clientInvoices(id: string, params: { page?: number; pageSize?: number }) {
    const asNum = Number(id);
    const s = await this.prisma.subscriber.findFirst({
      where: { OR: [{ id }, ...(Number.isFinite(asNum) ? [{ abonado: asNum }, { legacyId: asNum }] : [])] },
      select: { id: true },
    });
    if (!s) throw new NotFoundException('Cliente no encontrado.');
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(params.pageSize) || 50));
    const [total, rows] = await Promise.all([
      this.prisma.subInvoice.count({ where: { subscriberId: s.id } }),
      this.prisma.subInvoice.findMany({
        where: { subscriberId: s.id }, orderBy: { dueDate: 'desc' },
        skip: (page - 1) * pageSize, take: pageSize,
      }),
    ]);
    return {
      total, page, pageSize,
      items: rows.map((i) => ({
        id: i.id,
        vence: i.dueDate,
        subtotal: money(i.subtotal),
        total: money(i.total),
        pagado: money(i.paidAmount),
        saldo: money(i.total) - money(i.paidAmount),
        estado: i.status,
        creado: i.createdAt,
      })),
    };
  }
}
