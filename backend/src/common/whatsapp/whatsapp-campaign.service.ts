import type { OnApplicationBootstrap } from '../../core/ciclo-vida';
import { BadRequestException, NotFoundException } from '../../core/http/errores';
import { Logger } from '../../core/logger';
import { Prisma, SubscriberStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { normalizePhone } from '../phone.util';
import { whereExigible } from '../../billing/factura-exigible';
import { hoyEnColombia } from '../fecha-colombia';
import { WhatsappService } from './whatsapp.service';
import { WHATSAPP_STATUS_EVENT, type WhatsappStatusUpdate } from './whatsapp.types';
import {
  CampaignFilterDto, CampaignPreviewDto, CampaignTestDto, CreateCampaignDto, TemplateDto, TemplateVariableDto,
} from './dto/campaign.dto';

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
/**
 * Teléfono al que se le escribe por WhatsApp. Prefiere el que PARECE un móvil
 * colombiano sobre el orden phone1→phone2: WhatsApp solo existe en móviles, y en
 * la BD hay fichas con el fijo en phone1 y el celular en phone2 (24 al escribir
 * esto) — con el orden a secas esas quedaban condenadas a FAILED.
 *
 * Si ninguno parece móvil se devuelve el primero que tenga pinta de teléfono, como
 * siempre: hay números viejos guardados raro que sí funcionan, y decidir aquí que
 * no se les escribe cambiaría en silencio el alcance de las campañas masivas.
 * Quien necesite la garantía de móvil usa `esMovilColombiano`.
 */
export function esMovilColombiano(normalized: string | null): boolean {
  return !!normalized && /^573\d{9}$/.test(normalized);
}

function subPhone(s: SubRow): string | null {
  const candidatos = [s.phone1, s.phone2].map((p) => normalizePhone(p)).filter((p): p is string => !!p);
  return candidatos.find(esMovilColombiano) ?? candidatos.find((p) => p.length >= 7) ?? null;
}
function subMovil(s: SubRow): string | null {
  return [s.phone1, s.phone2].map((p) => normalizePhone(p)).find((p): p is string => esMovilColombiano(p)) ?? null;
}
const copFmt = (n: number) => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n || 0);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Clientes ÚNICOS a los que Meta deja iniciar conversación en 24 h, por tier del
 * número. Pasarse no da error al enviar: Meta acepta el mensaje y lo descarta, o
 * castiga la calidad del número. Por eso el tope se aplica aquí, antes de enviar.
 */
const CUPO_POR_TIER: Record<string, number> = {
  TIER_50: 50, TIER_250: 250, TIER_1K: 1_000, TIER_2K: 2_000,
  TIER_10K: 10_000, TIER_100K: 100_000, TIER_UNLIMITED: 1_000_000,
};
/**
 * Parte del cupo que pueden gastar las campañas. El resto queda para lo que sale
 * sin pasar por aquí y cuenta igual para Meta: el bot reabriendo ventanas con
 * `aviso_general`, las alertas internas y los mensajes de la bandeja.
 */
const MARGEN_CUPO = 0.9;
/** Si Meta no dice el tier, se asume el más bajo de un número verificado. */
const CUPO_SIN_DATO = 250;
/** Cada cuánto se mira si ya hay cupo para las campañas que quedaron esperando. */
const REANUDAR_CADA_MS = 10 * 60_000;
/** Cada cuántos envíos se vuelve a contar el cupo (por si corren dos campañas a la vez). */
const RECONTAR_CUPO_CADA = 25;

type Destinatario = { sub: SubRow; phone: string; deuda: number };

/** Público de una campaña y cuántos se cayeron en cada filtro, en orden. */
type Audiencia = {
  destinatarios: Destinatario[];
  coinciden: number;
  fueraPorDeuda: number;
  sinTelefono: number;
  enAtencion: number;
  telefonoRepetido: number;
};

/**
 * Envío masivo de WhatsApp por PLANTILLA (paridad con Clientgroup::sendGroupWhatsapp
 * del legacy). Gestiona plantillas locales (referencia a las aprobadas en Meta),
 * lanza campañas asíncronas con throttle, renderiza las variables por cliente y
 * persiste el estado de cada envío (QUEUED→SENT→DELIVERED→READ / FAILED) que el
 * webhook va actualizando.
 *
 * Estados de campaña: `running` (enviando), `waiting` (se acabó el cupo de 24 h;
 * sigue sola cuando haya cupo) y `done`.
 */
export class WhatsappCampaignService implements OnApplicationBootstrap {
  private readonly logger = new Logger('WhatsappCampaign');
  /** Pausa entre envíos (ms) para respetar el rate-limit de la Cloud API. */
  private readonly throttleMs = Number(process.env.WHATSAPP_THROTTLE_MS ?? 250);
  /** Campañas ejecutándose en ESTE proceso (evita doble envío si se relanza una en curso). */
  private readonly running = new Set<string>();
  /** Evita que dos vueltas del temporizador reanuden a la vez. */
  private reanudando = false;
  /** Backoff (ms) entre reintentos cuando Meta devuelve rate-limit. */
  private static readonly RETRY_BACKOFF_MS = [5_000, 15_000, 45_000];

  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsapp: WhatsappService,
  ) {}

  /**
   * Reanuda campañas que quedaron a medias por un reinicio del backend: el
   * procesamiento vive en memoria (`void runCampaign`), así que un restart de PM2
   * dejaba la campaña en `running` con envíos QUEUED huérfanos para siempre.
   * Y cada rato, las que esperaban cupo.
   */
  onApplicationBootstrap() {
    setTimeout(() => void this.resumeStuckCampaigns(), 10_000);
    setInterval(() => void this.reanudarEsperandoCupo(), REANUDAR_CADA_MS).unref();
  }

  private async resumeStuckCampaigns() {
    try {
      const stuck = await this.prisma.whatsappCampaign.findMany({
        where: { status: 'running', sends: { some: { status: 'QUEUED' } } },
        select: { id: true, name: true },
      });
      for (const c of stuck) {
        this.logger.warn(`Reanudando campaña interrumpida por reinicio: ${c.name} (${c.id})`);
        void this.runCampaign(c.id).catch((e) => this.logger.error(`Campaña ${c.id}: ${e.message}`));
      }
      // Sin pendientes pero marcada running = terminó y no alcanzó a cerrarse.
      const done = await this.prisma.whatsappCampaign.findMany({
        where: { status: 'running', sends: { none: { status: 'QUEUED' } } },
        select: { id: true },
      });
      for (const c of done) {
        await this.recomputeCampaign(c.id);
        await this.prisma.whatsappCampaign.update({
          where: { id: c.id }, data: { status: 'done', finishedAt: new Date() },
        });
      }
    } catch (e) {
      this.logger.error(`No se pudieron reanudar campañas: ${(e as Error).message}`);
    }
  }

  /** Retoma, de la más vieja a la más nueva, las campañas que se quedaron sin cupo. */
  private async reanudarEsperandoCupo() {
    if (this.reanudando) return;
    this.reanudando = true;
    try {
      const esperando = await this.prisma.whatsappCampaign.findMany({
        where: { status: 'waiting', sends: { some: { status: 'QUEUED' } } },
        orderBy: { createdAt: 'asc' },
        select: { id: true, name: true },
      });
      for (const c of esperando) {
        if (this.running.has(c.id)) continue;
        const { disponibles } = await this.cupo();
        if (disponibles <= 0) break;
        this.logger.log(`Hay cupo otra vez: sigue la campaña ${c.name} (${c.id})`);
        await this.prisma.whatsappCampaign.update({ where: { id: c.id }, data: { status: 'running' } });
        await this.runCampaign(c.id);
      }
    } catch (e) {
      this.logger.error(`No se pudieron reanudar campañas en espera de cupo: ${(e as Error).message}`);
    } finally {
      this.reanudando = false;
    }
  }

  // ---------- Cupo de 24 h ----------

  /** Teléfonos a los que ya les salió una plantilla en las últimas 24 h. */
  private async telefonosContactados(): Promise<Set<string>> {
    const rows = await this.prisma.whatsappSend.findMany({
      where: { sentAt: { gte: new Date(Date.now() - 86_400_000) }, status: { in: ['SENT', 'DELIVERED', 'READ'] } },
      select: { phone: true },
      distinct: ['phone'],
    });
    return new Set(rows.map((r) => r.phone));
  }

  /**
   * Cuántos clientes nuevos se pueden contactar todavía. Escribirle otra vez a
   * quien ya recibió algo hoy no gasta cupo: Meta cuenta clientes únicos.
   * `WHATSAPP_DAILY_CAP` baja el tope a mano (nunca lo sube por encima del de Meta).
   */
  private async cupo() {
    const probe = await this.whatsapp.probe();
    const tier = probe.ok ? (probe.tier ?? null) : null;
    const limiteMeta = (tier && CUPO_POR_TIER[tier.toUpperCase()]) || CUPO_SIN_DATO;
    const aMano = Number(process.env.WHATSAPP_DAILY_CAP);
    const limite = aMano > 0 ? Math.min(aMano, limiteMeta) : Math.floor(limiteMeta * MARGEN_CUPO);
    const contactados = await this.telefonosContactados();
    return { tier, limiteMeta, limite, usadas: contactados.size, disponibles: Math.max(0, limite - contactados.size), contactados };
  }

  /** Salud del número (Kapso/Meta) + cuánto cupo de hoy queda. */
  async salud() {
    const [probe, cupo] = await Promise.all([this.whatsapp.probe(), this.cupo()]);
    const { contactados: _omitir, ...resumen } = cupo;
    return { ...probe, cupo: resumen };
  }

  // ---------- Plantillas ----------

  /**
   * Plantillas locales + estado real en Meta (`metaStatus`): APPROVED/PENDING/
   * REJECTED, 'NO_EXISTE' si la WABA no la tiene, o null si Meta no respondió.
   * Solo las APPROVED pueden iniciar conversación.
   */
  async listTemplates() {
    const [rows, meta] = await Promise.all([
      this.prisma.whatsappTemplate.findMany({ orderBy: { name: 'asc' } }),
      this.whatsapp.metaTemplateStatuses(),
    ]);
    return rows.map((t) => ({ ...t, metaStatus: meta ? (meta[t.name] ?? 'NO_EXISTE') : null }));
  }

  /** Valores de ejemplo por fuente de variable (Meta exige un sample por {{n}}). */
  private exampleFor(v: TemplateVariableDto): string {
    switch (v.source) {
      case 'name': return 'Juan Pérez';
      case 'firstName': return 'Juan';
      case 'abonado': return '12345';
      case 'phone': return '3110000000';
      case 'deuda': return '$50.000';
      default: return v.value?.trim() || 'ejemplo';
    }
  }

  async createTemplate(dto: TemplateDto) {
    const name = dto.name.trim();
    const exists = await this.prisma.whatsappTemplate.findUnique({ where: { name } });
    if (exists) throw new BadRequestException('Ya existe una plantilla con ese nombre');
    if (dto.submitToMeta) {
      const vars = [...(dto.variables ?? [])].sort((a, b) => a.index - b.index);
      const res = await this.whatsapp.createMetaTemplate({
        name, language: dto.language?.trim() || 'es', category: dto.category,
        bodyText: dto.bodyText, headerText: dto.headerText,
        examples: vars.map((v) => this.exampleFor(v)),
      });
      if (!res.ok) throw new BadRequestException(`Meta rechazó la plantilla: ${res.error}`);
    }
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

  /**
   * Una plantilla que Meta no tiene APROBADA sale FAILED en cada envío: se corta
   * antes de encolar a miles. Si Meta no responde se deja pasar (el envío dirá).
   */
  private async exigirAprobada(templateName: string) {
    const meta = await this.whatsapp.metaTemplateStatuses();
    if (!meta) return;
    const estado = meta[templateName];
    if (estado !== 'APPROVED') {
      throw new BadRequestException(
        estado
          ? `La plantilla «${templateName}» está ${estado === 'PENDING' ? 'en revisión' : estado} en Meta: todavía no se puede enviar.`
          : `La plantilla «${templateName}» no existe en la cuenta de WhatsApp.`,
      );
    }
  }

  // ---------- Público ----------

  /** Resuelve los destinatarios (por ids explícitos o por filtro). */
  private async resolveRecipients(dto: { subscriberIds?: string[]; filter?: CampaignFilterDto }): Promise<SubRow[]> {
    const where: Prisma.SubscriberWhereInput = {};
    if (dto.subscriberIds?.length) {
      where.id = { in: dto.subscriberIds };
    } else if (dto.filter) {
      const f = dto.filter;
      // Un estado que no existe haría reventar a Prisma con un 500: se ignora.
      const validos = new Set<string>(Object.values(SubscriberStatus));
      const estados = [...(f.statuses ?? []), ...(f.status ? [f.status] : [])].filter((s) => validos.has(s));
      if (estados.length) where.status = { in: estados as SubscriberStatus[] };
      const sedes = [...(f.branchIds ?? []), ...(f.branchId ? [f.branchId] : [])];
      if (sedes.length) where.branchId = { in: sedes };
      if (f.planIds?.length) where.services = { some: { planId: { in: f.planIds } } };
      const s = (f.search || '').trim();
      if (s) where.OR = [
        { fullName: { contains: s, mode: 'insensitive' } },
        { docNumber: { contains: s } },
        { phone1: { contains: s } },
      ];
    } else {
      throw new BadRequestException('Indica destinatarios (subscriberIds) o un filtro.');
    }
    return this.prisma.subscriber.findMany({ where, select: SUB_NAME_SELECT, orderBy: { abonado: 'asc' } });
  }

  /**
   * Mapa subscriberId → deuda pendiente (para la variable {{deuda}} y el filtro).
   * Solo lo EXIGIBLE: la factura del mes que viene no es deuda todavía (ver
   * `factura-exigible`), y cobrarla por WhatsApp es cobrar un mes que no empezó.
   * En tandas: con todos los clientes son ~22.000 ids y Postgres no acepta tantos
   * parámetros en una sola consulta.
   */
  private async debtMap(ids: string[]): Promise<Record<string, number>> {
    const map: Record<string, number> = {};
    const exigible = whereExigible(hoyEnColombia());
    for (let i = 0; i < ids.length; i += 5_000) {
      const rows = await this.prisma.subInvoice.groupBy({
        by: ['subscriberId'],
        where: { subscriberId: { in: ids.slice(i, i + 5_000) }, status: { in: ['DUE', 'PARTIAL'] }, ...exigible },
        _sum: { total: true, paidAmount: true },
      });
      for (const r of rows) {
        if (!r.subscriberId) continue;
        map[r.subscriberId] = Math.max(0, Number(r._sum.total ?? 0) - Number(r._sum.paidAmount ?? 0));
      }
    }
    return map;
  }

  /**
   * Teléfonos (últimos 10 dígitos) cuya conversación está escalada a una persona.
   * Mismo criterio que los recordatorios: meterle un mensaje masivo a quien está
   * esperando que alguien le conteste es lo que no hay que hacer.
   */
  private async telefonosEnAtencion(): Promise<Set<string>> {
    const filas = await this.prisma.chatbotSession.findMany({
      where: { handoffAt: { not: null } },
      select: { convKey: true },
    });
    return new Set(filas.map((f) => f.convKey.replace(/\D/g, '').slice(-10)).filter(Boolean));
  }

  /**
   * Público final de una campaña. Los filtros se aplican en este orden, y cada
   * contador dice cuántos cayeron en ese paso: deuda → teléfono → en atención →
   * teléfono repetido. El teléfono repetido se descarta SIEMPRE (varias fichas de
   * la misma persona = un solo mensaje, no dos seguidos).
   */
  private async audiencia(dto: { subscriberIds?: string[]; filter?: CampaignFilterDto }): Promise<Audiencia> {
    const subs = await this.resolveRecipients(dto);
    const f = dto.subscriberIds?.length ? undefined : dto.filter;
    const [deudas, enAtencion] = await Promise.all([
      this.debtMap(subs.map((s) => s.id)),
      f?.omitirEnAtencion ? this.telefonosEnAtencion() : Promise.resolve(new Set<string>()),
    ]);
    const deudaMin = Math.max(1, Number(f?.deudaMin) || 1);

    const aud: Audiencia = {
      destinatarios: [], coinciden: subs.length, fueraPorDeuda: 0, sinTelefono: 0, enAtencion: 0, telefonoRepetido: 0,
    };
    const vistos = new Set<string>();
    for (const sub of subs) {
      const deuda = deudas[sub.id] ?? 0;
      if ((f?.deuda === 'con' && deuda < deudaMin) || (f?.deuda === 'sin' && deuda > 0)) { aud.fueraPorDeuda++; continue; }
      const phone = f?.soloMoviles ? subMovil(sub) : subPhone(sub);
      if (!phone) { aud.sinTelefono++; continue; }
      if (enAtencion.has(phone.slice(-10))) { aud.enAtencion++; continue; }
      if (vistos.has(phone)) { aud.telefonoRepetido++; continue; }
      vistos.add(phone);
      aud.destinatarios.push({ sub, phone, deuda });
    }
    return aud;
  }

  /** Sedes, planes activos y estados (con cuántos clientes hay en cada uno). */
  async opcionesCampana() {
    const [sedes, planes, porEstado] = await Promise.all([
      this.prisma.branch.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } }),
      this.prisma.plan.findMany({
        where: { active: true }, orderBy: [{ kind: 'asc' }, { name: 'asc' }], select: { id: true, name: true, kind: true },
      }),
      this.prisma.subscriber.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);
    const cuantos = new Map(porEstado.map((g) => [g.status, g._count._all]));
    return {
      sedes,
      planes,
      estados: Object.values(SubscriberStatus).map((s) => ({ value: s, count: cuantos.get(s) ?? 0 })),
    };
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

  /** En cuántos días sale una campaña de `total` con el cupo de hoy y el diario. */
  private reparto(total: number, disponiblesHoy: number, limite: number) {
    const hoy = Math.min(total, disponiblesHoy);
    const resto = total - hoy;
    return { hoy, dias: (hoy > 0 ? 1 : 0) + Math.ceil(resto / Math.max(1, limite)) };
  }

  /** Lo que haría la campaña, sin crearla: público, descartes, mensaje de ejemplo y reparto. */
  async previewCampaign(dto: CampaignPreviewDto) {
    const [aud, cupo, template, meta] = await Promise.all([
      this.audiencia(dto),
      this.cupo(),
      dto.templateName ? this.prisma.whatsappTemplate.findUnique({ where: { name: dto.templateName } }) : Promise.resolve(null),
      dto.templateName ? this.whatsapp.metaTemplateStatuses() : Promise.resolve(null),
    ]);
    const vars = (template?.variables ?? []) as unknown as TemplateVariableDto[];
    const total = aud.destinatarios.length;
    const primero = aud.destinatarios[0];
    const { contactados: _omitir, ...cupoResumen } = cupo;

    return {
      coinciden: aud.coinciden,
      destinatarios: total,
      descartes: {
        fueraPorDeuda: aud.fueraPorDeuda,
        sinTelefono: aud.sinTelefono,
        enAtencion: aud.enAtencion,
        telefonoRepetido: aud.telefonoRepetido,
      },
      deudaTotal: aud.destinatarios.reduce((a, d) => a + d.deuda, 0),
      muestra: aud.destinatarios.slice(0, 8).map((d) => ({
        subscriberId: d.sub.id, nombre: subName(d.sub), abonado: d.sub.abonado, telefono: d.phone, deuda: d.deuda,
      })),
      plantilla: template
        ? { name: template.name, category: template.category, metaStatus: meta ? (meta[template.name] ?? 'NO_EXISTE') : null }
        : null,
      ejemplo: template && primero
        ? {
            subscriberId: primero.sub.id,
            nombre: subName(primero.sub),
            cabecera: template.headerText,
            cuerpo: this.renderBody(template.bodyText, this.renderParams(vars, primero.sub, primero.deuda)),
          }
        : null,
      cupo: cupoResumen,
      reparto: this.reparto(total, cupo.disponibles, cupo.limite),
    };
  }

  /**
   * Manda la plantilla a UN celular (el de quien arma la campaña) con los datos de
   * un cliente real, para ver cómo le llega antes de soltarla a miles. Queda en
   * `WhatsappSend` sin campaña ni cliente: la recibió el que probó, no el cliente.
   */
  async testCampaign(dto: CampaignTestDto, user: AuthLike) {
    const phone = normalizePhone(dto.phone);
    if (!esMovilColombiano(phone)) throw new BadRequestException('Escribe un celular colombiano válido (10 dígitos, empieza por 3).');
    const template = await this.prisma.whatsappTemplate.findUnique({ where: { name: dto.templateName } });
    if (!template) throw new NotFoundException('Plantilla no encontrada');
    await this.exigirAprobada(template.name);

    const vars = (template.variables ?? []) as unknown as TemplateVariableDto[];
    const sub = dto.subscriberId
      ? await this.prisma.subscriber.findUnique({ where: { id: dto.subscriberId }, select: SUB_NAME_SELECT })
      : null;
    const params = sub
      ? this.renderParams(vars, sub, (await this.debtMap([sub.id]))[sub.id] ?? 0)
      : [...vars].sort((a, b) => a.index - b.index).map((v) => this.exampleFor(v));
    const body = this.renderBody(template.bodyText, params);

    const res = await this.whatsapp.sendTemplate(phone!, template.name, template.language, params);
    await this.prisma.whatsappSend.create({
      data: {
        phone: phone!, templateName: template.name, body,
        status: res.ok ? 'SENT' : 'FAILED',
        waMessageId: res.ok ? (res.messageId ?? null) : null,
        error: res.ok ? null : (res.error ?? 'Error').slice(0, 400),
        sentAt: res.ok ? new Date() : null,
      },
    });
    this.logger.log(`Prueba de campaña «${template.name}» a ${phone} por ${user?.name || user?.email || 'desconocido'}: ${res.ok ? 'enviada' : res.error}`);
    return { ok: res.ok, error: res.ok ? null : res.error, cuerpo: body };
  }

  // ---------- Campañas ----------

  /**
   * Crea la campaña + los envíos en cola y lanza el procesamiento asíncrono.
   *
   * `autoStart: false` la deja creada y en cola sin arrancar, para quien necesite
   * ESPERAR el resultado (el cron de recordatorios marca el dedupe solo sobre los
   * que salieron de verdad, así que no puede soltar el envío y olvidarse). Ese
   * llamador se encarga de invocar `runCampaign`; si no lo hace, la campaña queda
   * `running` con envíos QUEUED y la reanuda `resumeStuckCampaigns` al arrancar.
   */
  async createCampaign(dto: CreateCampaignDto, user: AuthLike, opts: { autoStart?: boolean } = {}) {
    // La plantilla local es opcional (define las variables); si no, se usan las del dto.
    const template = dto.templateId
      ? await this.prisma.whatsappTemplate.findUnique({ where: { id: dto.templateId } })
      : await this.prisma.whatsappTemplate.findUnique({ where: { name: dto.templateName } }).catch(() => null);
    const language = dto.language?.trim() || template?.language || 'es';

    if (!dto.subscriberIds?.length && dto.filter) {
      const f = dto.filter;
      if (!f.status && !f.statuses?.length) {
        throw new BadRequestException('Elige al menos un estado de cliente: sin eso la campaña también les escribiría a retirados y depurados.');
      }
    }
    await this.exigirAprobada(dto.templateName.trim());

    const { destinatarios } = await this.audiencia(dto);
    if (!destinatarios.length) throw new BadRequestException('Ningún destinatario tiene teléfono válido.');

    const campaign = await this.prisma.whatsappCampaign.create({
      data: {
        name: dto.name.trim(),
        templateId: template?.id ?? null,
        templateName: dto.templateName.trim(),
        language,
        filterJson: dto.filter ? (dto.filter as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
        total: destinatarios.length,
        status: 'running',
        createdByName: user?.name || user?.email || null,
        sends: {
          create: destinatarios.map((d) => ({
            subscriberId: d.sub.id, phone: d.phone, templateName: dto.templateName.trim(), status: 'QUEUED' as const,
          })),
        },
      },
    });

    // Procesamiento en background (no bloquea la respuesta HTTP).
    if (opts.autoStart !== false) {
      void this.runCampaign(campaign.id).catch((e) => this.logger.error(`Campaña ${campaign.id}: ${e.message}`));
    }
    return { campaignId: campaign.id, total: destinatarios.length };
  }

  /**
   * Procesa (o reanuda) los envíos QUEUED de una campaña con throttle.
   * `sinEspera`: si se acaba el cupo, lo que falta queda FAILED en vez de esperar.
   */
  async runCampaign(campaignId: string, opts: { sinEspera?: boolean } = {}) {
    if (this.running.has(campaignId)) return; // ya hay un loop enviando esta campaña
    this.running.add(campaignId);
    try {
      await this.processCampaign(campaignId, opts);
    } finally {
      this.running.delete(campaignId);
    }
  }

  private async processCampaign(campaignId: string, opts: { sinEspera?: boolean }) {
    const campaign = await this.prisma.whatsappCampaign.findUnique({
      where: { id: campaignId }, include: { template: true },
    });
    if (!campaign) return;
    const vars = (campaign.template?.variables ?? []) as unknown as TemplateVariableDto[];
    const bodyText = campaign.template?.bodyText ?? '';

    const queued = await this.prisma.whatsappSend.findMany({
      where: { campaignId, status: 'QUEUED' },
      select: { id: true, subscriberId: true, phone: true },
      orderBy: { createdAt: 'asc' },
    });
    const subIds = queued.map((q) => q.subscriberId).filter((x): x is string => !!x);
    const subs = subIds.length
      ? await this.prisma.subscriber.findMany({ where: { id: { in: subIds } }, select: SUB_NAME_SELECT })
      : [];
    const subMap = new Map(subs.map((s) => [s.id, s]));
    const debts = await this.debtMap(subIds);

    let cupo = await this.cupo();
    let sinCupo = false;
    for (const [i, q] of queued.entries()) {
      if (i > 0 && i % RECONTAR_CUPO_CADA === 0) cupo = await this.cupo();
      // Al que ya se le escribió hoy no gasta cupo nuevo.
      const nuevo = !cupo.contactados.has(q.phone);
      if (nuevo && cupo.disponibles <= 0) { sinCupo = true; break; }

      const sub = q.subscriberId ? subMap.get(q.subscriberId) : undefined;
      const params = sub ? this.renderParams(vars, sub, debts[sub.id] ?? 0) : [];
      const body = bodyText ? this.renderBody(bodyText, params) : null;
      const res = await this.sendWithRetry(q.phone, campaign.templateName, campaign.language, params);
      await this.prisma.whatsappSend.update({
        where: { id: q.id },
        data: res.ok
          ? { status: 'SENT', waMessageId: res.messageId ?? null, body, sentAt: new Date() }
          : { status: 'FAILED', error: (res.error ?? 'Error').slice(0, 400), body },
      });
      if (res.ok && nuevo) {
        cupo.contactados.add(q.phone);
        cupo.disponibles--;
      }
      await sleep(this.throttleMs);
    }

    if (sinCupo && !opts.sinEspera) {
      await this.recomputeCampaign(campaignId);
      await this.prisma.whatsappCampaign.update({ where: { id: campaignId }, data: { status: 'waiting' } });
      this.logger.warn(`Campaña ${campaign.name} (${campaignId}): se acabó el cupo de 24 h (${cupo.limite}); sigue sola cuando haya cupo.`);
      return;
    }
    if (sinCupo) {
      await this.prisma.whatsappSend.updateMany({
        where: { campaignId, status: 'QUEUED' },
        data: { status: 'FAILED', error: `Sin cupo diario de WhatsApp (${cupo.limite} clientes / 24 h).` },
      });
    }

    await this.recomputeCampaign(campaignId);
    await this.prisma.whatsappCampaign.update({
      where: { id: campaignId }, data: { status: 'done', finishedAt: new Date() },
    });
  }

  /**
   * Envía con reintento SOLO ante errores transitorios (rate-limit de Meta o fallo
   * de red): antes un 429 marcaba el envío FAILED de una, y en campañas grandes eso
   * quemaba la cola justo cuando Meta pedía bajar el ritmo. El backoff pausa el loop
   * completo (es secuencial), que es exactamente lo que el rate-limit pide.
   */
  private async sendWithRetry(phone: string, templateName: string, language: string, params: string[]) {
    let res = await this.whatsapp.sendTemplate(phone, templateName, language, params);
    for (const backoff of WhatsappCampaignService.RETRY_BACKOFF_MS) {
      if (res.ok || !res.retryable) return res;
      this.logger.warn(`Rate-limit/transitorio enviando a ${phone} (${res.error}); reintento en ${backoff / 1000}s`);
      await sleep(backoff);
      res = await this.whatsapp.sendTemplate(phone, templateName, language, params);
    }
    return res;
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
