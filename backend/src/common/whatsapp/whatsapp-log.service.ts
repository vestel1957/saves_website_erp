import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { guardarNotaDeVoz } from './whatsapp-audio.store';
import {
  WHATSAPP_INBOUND_EVENT, WHATSAPP_OUTBOUND_EVENT, WHATSAPP_STATUS_EVENT,
  type InboundWhatsappMessage, type WhatsappStatusUpdate,
} from './whatsapp.types';
import { WhatsappInboxService } from './whatsapp-inbox.service';
import { WhatsappService } from './whatsapp.service';

/**
 * Persiste el historial de WhatsApp (Kapso): mensajes entrantes (vía el evento
 * que emite el transporte) y salientes. Resuelve el cliente por teléfono para
 * dejar la conversación ligada al abonado.
 */
@Injectable()
export class WhatsappLogService {
  private readonly logger = new Logger('WhatsappLog');

  constructor(
    private prisma: PrismaService,
    private inbox: WhatsappInboxService,
  ) {}

  @OnEvent(WHATSAPP_INBOUND_EVENT)
  async onInbound(msg: InboundWhatsappMessage) {
    // El binario se guarda ANTES de crear la fila: si el disco falla no queda una
    // fila apuntando a un archivo que no existe (que en la bandeja se vería como un
    // reproductor roto, peor que no ofrecerlo).
    const audio = msg.audio ? guardarNotaDeVoz(msg.audio) : null;
    await this.persist('IN', msg.from, msg.text || '(nota de voz)', !!msg.audio, msg.messageId, {
      rawPhone: msg.from,
      audioPath: audio?.path,
      audioMime: audio?.mime,
    });
  }

  @OnEvent(WHATSAPP_OUTBOUND_EVENT)
  async onOutbound(evt: { to: string; text: string; messageId?: string; sentById?: string }) {
    await this.persist('OUT', evt.to, evt.text, false, evt.messageId, { sentById: evt.sentById });
  }

  /**
   * Cuánto tardó de verdad en llegar un CÓDIGO al teléfono.
   *
   * Es el único tramo que no se ve desde el servidor: sabemos lo que tardamos
   * nosotros y lo que tardó la pasarela en aceptarlo, pero de ahí a que suene el
   * teléfono manda Meta. Sin este número, "el código se demoró" no se puede ni
   * confirmar ni desmentir. Se anota solo para los códigos (van con el cuerpo
   * oculto) para no llenar el log con cada mensaje del bot.
   */
  @OnEvent(WHATSAPP_STATUS_EVENT)
  async onStatus(evt: WhatsappStatusUpdate) {
    if (evt.status !== 'delivered' && evt.status !== 'failed') return;
    const msg = await this.prisma.whatsappMessage
      .findFirst({ where: { waMessageId: evt.messageId }, select: { body: true, phone: true, createdAt: true } })
      .catch(() => null);
    if (!msg || msg.body !== WhatsappService.OCULTO) return;

    const segundos = ((Date.now() - msg.createdAt.getTime()) / 1000).toFixed(1);
    const destino = `••••${msg.phone.slice(-4)}`;
    if (evt.status === 'failed') this.logger.error(`Código a ${destino} NO ENTREGADO tras ${segundos} s: ${evt.error ?? 'sin detalle'}`);
    else this.logger.log(`Código a ${destino} entregado en ${segundos} s desde que salió.`);
  }

  private async persist(
    direction: 'IN' | 'OUT',
    phone: string,
    body: string,
    hasAudio: boolean,
    waMessageId?: string,
    extra: { rawPhone?: string; sentById?: string; audioPath?: string; audioMime?: string } = {},
  ) {
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
    const texto = (body || '').slice(0, 4000);
    await this.prisma.whatsappMessage
      .create({
        data: {
          direction, phone: digits, body: texto, hasAudio,
          waMessageId: waMessageId ?? null, subscriberId, sentById: extra.sentById ?? null,
          audioPath: extra.audioPath ?? null, audioMime: extra.audioMime ?? null,
        },
      })
      .catch((e) => this.logger.warn(`No se pudo registrar mensaje WhatsApp: ${e.message}`));

    // La bandeja se mantiene al día aquí, en el mismo sitio donde ya se registraba
    // todo: cualquier vía de envío (bot, alerta, campaña o persona) pasa por este
    // evento, así que ninguna deja la conversación desactualizada.
    await this.inbox.touch({ direction, phone: digits, body: texto, subscriberId, rawPhone: extra.rawPhone, sentById: extra.sentById });
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
