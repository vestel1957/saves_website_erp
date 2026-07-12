import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { WHATSAPP_INBOUND_EVENT, WHATSAPP_OUTBOUND_EVENT, type InboundWhatsappMessage } from './whatsapp.types';

/**
 * Persiste el historial de WhatsApp (Kapso): mensajes entrantes (vía el evento
 * que emite el transporte) y salientes. Resuelve el cliente por teléfono para
 * dejar la conversación ligada al abonado.
 */
@Injectable()
export class WhatsappLogService {
  private readonly logger = new Logger('WhatsappLog');

  constructor(private prisma: PrismaService) {}

  @OnEvent(WHATSAPP_INBOUND_EVENT)
  async onInbound(msg: InboundWhatsappMessage) {
    await this.persist('IN', msg.from, msg.text || '(nota de voz)', !!msg.audio, msg.messageId);
  }

  @OnEvent(WHATSAPP_OUTBOUND_EVENT)
  async onOutbound(evt: { to: string; text: string; messageId?: string }) {
    await this.persist('OUT', evt.to, evt.text, false, evt.messageId);
  }

  private async persist(direction: 'IN' | 'OUT', phone: string, body: string, hasAudio: boolean, waMessageId?: string) {
    const digits = (phone || '').replace(/\D/g, '');
    if (!digits) return;
    const last10 = digits.slice(-10);
    let subscriberId: string | null = null;
    if (last10) {
      const sub = await this.prisma.subscriber
        .findFirst({ where: { OR: [{ phone1: { contains: last10 } }, { phone2: { contains: last10 } }] }, select: { id: true } })
        .catch(() => null);
      subscriberId = sub?.id ?? null;
    }
    await this.prisma.whatsappMessage
      .create({ data: { direction, phone: digits, body: (body || '').slice(0, 4000), hasAudio, waMessageId: waMessageId ?? null, subscriberId } })
      .catch((e) => this.logger.warn(`No se pudo registrar mensaje WhatsApp: ${e.message}`));
  }

  async list(params: { search?: string; direction?: string; page?: number; pageSize?: number }) {
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(params.pageSize) || 40));
    const where: Prisma.WhatsappMessageWhereInput = {};
    if (params.direction === 'IN' || params.direction === 'OUT') where.direction = params.direction;
    const s = (params.search || '').trim();
    if (s) where.OR = [{ phone: { contains: s } }, { body: { contains: s, mode: 'insensitive' } }];
    const [rows, total] = await Promise.all([
      this.prisma.whatsappMessage.findMany({
        where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize,
        include: { subscriber: { select: { id: true, fullName: true, firstName: true, lastName1: true, companyName: true, abonado: true } } },
      }),
      this.prisma.whatsappMessage.count({ where }),
    ]);
    return {
      items: rows.map((r) => ({
        id: r.id, direction: r.direction, phone: r.phone, body: r.body, hasAudio: r.hasAudio, createdAt: r.createdAt,
        subscriberId: r.subscriber?.id ?? null,
        subscriberName: r.subscriber ? (r.subscriber.fullName || [r.subscriber.firstName, r.subscriber.lastName1].filter(Boolean).join(' ') || r.subscriber.companyName || null) : null,
        abonado: r.subscriber?.abonado ?? null,
      })),
      total, page, pageSize, pages: Math.ceil(total / pageSize),
    };
  }
}
