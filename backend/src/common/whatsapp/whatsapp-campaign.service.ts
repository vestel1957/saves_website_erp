import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { WhatsappService } from './whatsapp.service';
import { WHATSAPP_STATUS_EVENT, type WhatsappStatusUpdate } from './whatsapp.types';
import { CreateCampaignDto, TemplateDto, TemplateVariableDto } from './dto/campaign.dto';

type AuthLike = { name?: string | null; email?: string | null };

const SUB_NAME_SELECT = {
  id: true, abonado: true, phone1: true, phone2: true,
  firstName: true, secondName: true, lastName1: true, lastName2: true, companyName: true, fullName: true,
} as const;

type SubRow = {
  id: string; abonado: number | null; phone1: string | null; phone2: string | null;
  firstName: string | null; secondName: string | null; lastName1: string | null;
  lastName2: string | null; companyName: string | null; fullName: string | null;
};

function subName(s: SubRow): string {
  if (s.fullName && s.fullName.trim()) return s.fullName.trim();
  const person = [s.firstName, s.secondName, s.lastName1, s.lastName2].map((p) => (p || '').trim()).filter(Boolean).join(' ');
  return person || (s.companyName || '').trim() || 'Cliente';
}
function subPhone(s: SubRow): string | null {
  const p = (s.phone1 || s.phone2 || '').replace(/\D/g, '');
  return p.length >= 7 ? p : null;
}
const copFmt = (n: number) => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n || 0);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Envío masivo de WhatsApp por PLANTILLA (paridad con Clientgroup::sendGroupWhatsapp
 * del legacy). Gestiona plantillas locales (referencia a las aprobadas en Meta),
 * lanza campañas asíncronas con throttle, renderiza las variables por cliente y
 * persiste el estado de cada envío (QUEUED→SENT→DELIVERED→READ / FAILED) que el
 * webhook va actualizando.
 */
@Injectable()
export class WhatsappCampaignService {
  private readonly logger = new Logger('WhatsappCampaign');
  /** Pausa entre envíos (ms) para respetar el rate-limit de la Cloud API. */
  private readonly throttleMs = Number(process.env.WHATSAPP_THROTTLE_MS ?? 250);

  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsapp: WhatsappService,
  ) {}

  // ---------- Plantillas ----------

  listTemplates() {
    return this.prisma.whatsappTemplate.findMany({ orderBy: { name: 'asc' } });
  }

  async createTemplate(dto: TemplateDto) {
    const name = dto.name.trim();
    const exists = await this.prisma.whatsappTemplate.findUnique({ where: { name } });
    if (exists) throw new BadRequestException('Ya existe una plantilla con ese nombre');
    return this.prisma.whatsappTemplate.create({
      data: {
        name, language: dto.language?.trim() || 'es', category: dto.category ?? null,
        bodyText: dto.bodyText, headerText: dto.headerText ?? null,
        variables: (dto.variables ?? []) as unknown as Prisma.InputJsonValue,
        active: dto.active ?? true,
      },
    });
  }

  async updateTemplate(id: string, dto: TemplateDto) {
    const t = await this.prisma.whatsappTemplate.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('Plantilla no encontrada');
    return this.prisma.whatsappTemplate.update({
      where: { id },
      data: {
        name: dto.name.trim(), language: dto.language?.trim() || t.language, category: dto.category ?? null,
        bodyText: dto.bodyText, headerText: dto.headerText ?? null,
        variables: (dto.variables ?? []) as unknown as Prisma.InputJsonValue,
        active: dto.active ?? t.active,
      },
    });
  }

  async deleteTemplate(id: string) {
    const t = await this.prisma.whatsappTemplate.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('Plantilla no encontrada');
    await this.prisma.whatsappTemplate.delete({ where: { id } });
    return { id, deleted: true };
  }

  // ---------- Campañas ----------

  /** Resuelve los destinatarios (por ids explícitos o por filtro simple). */
  private async resolveRecipients(dto: CreateCampaignDto): Promise<SubRow[]> {
    const where: Prisma.SubscriberWhereInput = {};
    if (dto.subscriberIds?.length) {
      where.id = { in: dto.subscriberIds };
    } else if (dto.filter) {
      if (dto.filter.status) where.status = dto.filter.status as any;
      if (dto.filter.branchId) where.branchId = dto.filter.branchId;
      const s = (dto.filter.search || '').trim();
      if (s) where.OR = [
        { fullName: { contains: s, mode: 'insensitive' } },
        { docNumber: { contains: s } },
        { phone1: { contains: s } },
      ];
    } else {
      throw new BadRequestException('Indica destinatarios (subscriberIds) o un filtro.');
    }
    return this.prisma.subscriber.findMany({ where, select: SUB_NAME_SELECT });
  }

  /** Mapa subscriberId → deuda pendiente (para la variable {{deuda}}). */
  private async debtMap(ids: string[]): Promise<Record<string, number>> {
    if (!ids.length) return {};
    const rows = await this.prisma.subInvoice.groupBy({
      by: ['subscriberId'],
      where: { subscriberId: { in: ids }, status: { in: ['DUE', 'PARTIAL'] } },
      _sum: { total: true, paidAmount: true },
    });
    const map: Record<string, number> = {};
    for (const r of rows) {
      if (!r.subscriberId) continue;
      map[r.subscriberId] = Math.max(0, Number(r._sum.total ?? 0) - Number(r._sum.paidAmount ?? 0));
    }
    return map;
  }

  /** Renderiza los parámetros de la plantilla (en orden de index) para un cliente. */
  private renderParams(vars: TemplateVariableDto[], s: SubRow, debt: number): string[] {
    return [...vars]
      .sort((a, b) => a.index - b.index)
      .map((v) => {
        switch (v.source) {
          case 'name': return subName(s);
          case 'firstName': return (s.firstName || subName(s).split(' ')[0] || '').trim();
          case 'abonado': return String(s.abonado ?? '');
          case 'phone': return subPhone(s) ?? '';
          case 'deuda': return copFmt(debt);
          case 'custom': return v.value ?? '';
          default: return v.value ?? '';
        }
      });
  }

  /** Renderiza el cuerpo (para auditoría/preview) sustituyendo {{n}} por los params. */
  private renderBody(bodyText: string, params: string[]): string {
    return bodyText.replace(/\{\{(\d+)\}\}/g, (_m, n) => params[Number(n) - 1] ?? `{{${n}}}`);
  }

  /** Crea la campaña + los envíos en cola y lanza el procesamiento asíncrono. */
  async createCampaign(dto: CreateCampaignDto, user: AuthLike) {
    // La plantilla local es opcional (define las variables); si no, se usan las del dto.
    const template = dto.templateId
      ? await this.prisma.whatsappTemplate.findUnique({ where: { id: dto.templateId } })
      : await this.prisma.whatsappTemplate.findUnique({ where: { name: dto.templateName } }).catch(() => null);
    const language = dto.language?.trim() || template?.language || 'es';

    const recipients = await this.resolveRecipients(dto);
    const withPhone = recipients.filter((r) => subPhone(r));
    if (!withPhone.length) throw new BadRequestException('Ningún destinatario tiene teléfono válido.');

    const campaign = await this.prisma.whatsappCampaign.create({
      data: {
        name: dto.name.trim(),
        templateId: template?.id ?? null,
        templateName: dto.templateName.trim(),
        language,
        filterJson: dto.filter ? (dto.filter as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
        total: withPhone.length,
        status: 'running',
        createdByName: user?.name || user?.email || null,
        sends: {
          create: withPhone.map((r) => ({
            subscriberId: r.id, phone: subPhone(r)!, templateName: dto.templateName.trim(), status: 'QUEUED' as const,
          })),
        },
      },
    });

    // Procesamiento en background (no bloquea la respuesta HTTP).
    void this.runCampaign(campaign.id).catch((e) => this.logger.error(`Campaña ${campaign.id}: ${e.message}`));
    return { campaignId: campaign.id, total: withPhone.length };
  }

  /** Procesa (o reanuda) los envíos QUEUED de una campaña con throttle. */
  async runCampaign(campaignId: string) {
    const campaign = await this.prisma.whatsappCampaign.findUnique({
      where: { id: campaignId }, include: { template: true },
    });
    if (!campaign) return;
    const vars = (campaign.template?.variables ?? []) as unknown as TemplateVariableDto[];
    const bodyText = campaign.template?.bodyText ?? '';

    const queued = await this.prisma.whatsappSend.findMany({
      where: { campaignId, status: 'QUEUED' },
      select: { id: true, subscriberId: true, phone: true },
    });
    const subIds = queued.map((q) => q.subscriberId).filter((x): x is string => !!x);
    const subs = subIds.length
      ? await this.prisma.subscriber.findMany({ where: { id: { in: subIds } }, select: SUB_NAME_SELECT })
      : [];
    const subMap = new Map(subs.map((s) => [s.id, s]));
    const debts = await this.debtMap(subIds);

    for (const q of queued) {
      const sub = q.subscriberId ? subMap.get(q.subscriberId) : undefined;
      const params = sub ? this.renderParams(vars, sub, debts[sub.id] ?? 0) : [];
      const body = bodyText ? this.renderBody(bodyText, params) : null;
      const res = await this.whatsapp.sendTemplate(q.phone, campaign.templateName, campaign.language, params);
      await this.prisma.whatsappSend.update({
        where: { id: q.id },
        data: res.ok
          ? { status: 'SENT', waMessageId: res.messageId ?? null, body, sentAt: new Date() }
          : { status: 'FAILED', error: (res.error ?? 'Error').slice(0, 400), body },
      });
      await sleep(this.throttleMs);
    }

    await this.recomputeCampaign(campaignId);
    await this.prisma.whatsappCampaign.update({
      where: { id: campaignId }, data: { status: 'done', finishedAt: new Date() },
    });
  }

  /** Recalcula los contadores de una campaña a partir de sus envíos. */
  private async recomputeCampaign(campaignId: string) {
    const grouped = await this.prisma.whatsappSend.groupBy({
      by: ['status'], where: { campaignId }, _count: { _all: true },
    });
    const c: Record<string, number> = {};
    for (const g of grouped) c[g.status] = g._count._all;
    const sent = (c.SENT ?? 0) + (c.DELIVERED ?? 0) + (c.READ ?? 0);
    const delivered = (c.DELIVERED ?? 0) + (c.READ ?? 0);
    const read = c.READ ?? 0;
    const failed = c.FAILED ?? 0;
    await this.prisma.whatsappCampaign.update({ where: { id: campaignId }, data: { sent, delivered, read, failed } });
  }

  /** Webhook: actualiza el estado de entrega de un envío por su waMessageId. */
  @OnEvent(WHATSAPP_STATUS_EVENT)
  async onStatus(evt: WhatsappStatusUpdate) {
    try {
      const send = await this.prisma.whatsappSend.findUnique({ where: { waMessageId: evt.messageId } });
      if (!send) return;
      const rank: Record<string, number> = { QUEUED: 0, SENT: 1, DELIVERED: 2, READ: 3, FAILED: 1 };
      const next = evt.status.toUpperCase() as 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';
      // No retroceder de estado (salvo a FAILED).
      if (next !== 'FAILED' && rank[next] <= rank[send.status]) return;
      await this.prisma.whatsappSend.update({
        where: { id: send.id },
        data: { status: next, error: next === 'FAILED' ? (evt.error ?? send.error) : send.error },
      });
      if (send.campaignId) await this.recomputeCampaign(send.campaignId);
    } catch (e) {
      this.logger.warn(`No se pudo actualizar estado de envío: ${(e as Error).message}`);
    }
  }

  // ---------- Reportes ----------

  async listCampaigns(params: { page?: number; pageSize?: number }) {
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(params.pageSize) || 25));
    const [rows, total] = await Promise.all([
      this.prisma.whatsappCampaign.findMany({ orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      this.prisma.whatsappCampaign.count(),
    ]);
    return { items: rows, total, page, pageSize, pages: Math.ceil(total / pageSize) };
  }

  async campaignReport(id: string, params: { status?: string; page?: number; pageSize?: number }) {
    const campaign = await this.prisma.whatsappCampaign.findUnique({ where: { id } });
    if (!campaign) throw new NotFoundException('Campaña no encontrada');
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(params.pageSize) || 50));
    const where: Prisma.WhatsappSendWhereInput = { campaignId: id };
    if (params.status) where.status = params.status as any;
    const [sends, total] = await Promise.all([
      this.prisma.whatsappSend.findMany({
        where, orderBy: { createdAt: 'asc' }, skip: (page - 1) * pageSize, take: pageSize,
        include: { subscriber: { select: { id: true, abonado: true, fullName: true, firstName: true, lastName1: true, companyName: true } } },
      }),
      this.prisma.whatsappSend.count({ where }),
    ]);
    return {
      campaign,
      sends: sends.map((s) => ({
        id: s.id, phone: s.phone, status: s.status, error: s.error, sentAt: s.sentAt,
        subscriberId: s.subscriber?.id ?? null,
        name: s.subscriber ? (s.subscriber.fullName || [s.subscriber.firstName, s.subscriber.lastName1].filter(Boolean).join(' ') || s.subscriber.companyName || null) : null,
        abonado: s.subscriber?.abonado ?? null,
      })),
      total, page, pageSize, pages: Math.ceil(total / pageSize),
    };
  }

  /** Reintenta los envíos FAILED de una campaña (los re-encola y relanza). */
  async retryFailed(id: string) {
    const campaign = await this.prisma.whatsappCampaign.findUnique({ where: { id } });
    if (!campaign) throw new NotFoundException('Campaña no encontrada');
    const r = await this.prisma.whatsappSend.updateMany({
      where: { campaignId: id, status: 'FAILED' }, data: { status: 'QUEUED', error: null },
    });
    if (r.count > 0) {
      await this.prisma.whatsappCampaign.update({ where: { id }, data: { status: 'running', finishedAt: null } });
      void this.runCampaign(id).catch((e) => this.logger.error(`Reintento campaña ${id}: ${e.message}`));
    }
    return { requeued: r.count };
  }
}
