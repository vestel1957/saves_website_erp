import { BadRequestException, NotFoundException } from '../../core/http/errores';
import { Logger } from '../../core/logger';
import { createTransport, type Transporter } from 'nodemailer';
import { PrismaService } from '../../prisma/prisma.service';
import { SettingsService } from '../../settings/settings.service';

export type MailAttachment = { filename: string; content: Buffer; contentType?: string };
export type SendMailInput = { to: string; subject: string; html: string; text?: string; attachments?: MailAttachment[] };

/** Plantillas de correo por defecto (se crean la primera vez que se consultan). */
const DEFAULT_TEMPLATES: { kind: string; name: string; subject: string; bodyHtml: string }[] = [
  {
    kind: 'INVOICE_AVAILABLE', name: 'Factura disponible',
    subject: 'Tu factura N° {{factura}} ya está disponible — {{empresa}}',
    bodyHtml: '<p>Hola {{nombre}},</p><p>Tu factura <b>N° {{factura}}</b> por <b>{{total}}</b> ya está disponible. Fecha de vencimiento: <b>{{vence}}</b>.</p><p>Adjuntamos el PDF. Gracias por preferirnos.</p><p>{{empresa}}</p>',
  },
  {
    kind: 'REMINDER', name: 'Recordatorio de pago',
    subject: 'Recordatorio de pago — {{empresa}}',
    bodyHtml: '<p>Hola {{nombre}},</p><p>Te recordamos que tienes un saldo pendiente de <b>{{deuda}}</b>. Evita la suspensión del servicio realizando tu pago.</p><p>{{empresa}}</p>',
  },
  {
    kind: 'OVERDUE', name: 'Factura vencida',
    subject: 'Factura vencida — {{empresa}}',
    bodyHtml: '<p>Hola {{nombre}},</p><p>Tu cuenta presenta un saldo <b>vencido</b> de <b>{{deuda}}</b>. Por favor regulariza tu pago para evitar el corte del servicio.</p><p>{{empresa}}</p>',
  },
  {
    kind: 'RECEIPT', name: 'Recibo de pago',
    subject: 'Recibo de tu pago — {{empresa}}',
    bodyHtml: '<p>Hola {{nombre}},</p><p>Hemos recibido tu pago. ¡Gracias!</p><p>{{empresa}}</p>',
  },
  {
    kind: 'GENERIC', name: 'Mensaje general',
    subject: '{{empresa}}',
    bodyHtml: '<p>Hola {{nombre}},</p><p>{{mensaje}}</p><p>{{empresa}}</p>',
  },
];

/**
 * Servicio de correo saliente (SMTP vía nodemailer). Lee la configuración de
 * `settings` (grupo smtp.*). Tolerante: si no está configurado, degrada a log y
 * devuelve `sent:false` (no rompe crons ni el arranque). Gestiona además las
 * plantillas de correo editables (factura disponible, recordatorio, vencida…).
 */
export class MailService {
  private readonly logger = new Logger('MailService');
  private transporter: Transporter | null = null;
  private transporterKey = '';

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  /** Config SMTP actual (secretos en claro para el transporter). */
  private async smtpConfig() {
    const s = await this.settings.raw('smtp');
    return {
      host: s['smtp.host'] || '',
      port: Number(s['smtp.port'] || 587),
      user: s['smtp.user'] || '',
      password: s['smtp.password'] || '',
      from: s['smtp.from'] || s['smtp.user'] || '',
      secure: (s['smtp.secure'] || 'false') === 'true',
    };
  }

  private async getTransporter(): Promise<{ tx: Transporter; from: string } | null> {
    const cfg = await this.smtpConfig();
    if (!cfg.host || !cfg.user) return null;
    const key = `${cfg.host}:${cfg.port}:${cfg.user}:${cfg.secure}`;
    if (!this.transporter || this.transporterKey !== key) {
      this.transporter = createTransport({
        host: cfg.host, port: cfg.port, secure: cfg.secure,
        auth: { user: cfg.user, pass: cfg.password },
      });
      this.transporterKey = key;
    }
    return { tx: this.transporter, from: cfg.from };
  }

  /** Estado para diagnóstico. */
  async status() {
    const cfg = await this.smtpConfig();
    return { enabled: !!cfg.host && !!cfg.user, host: cfg.host, port: cfg.port, from: cfg.from, secure: cfg.secure };
  }

  /** Envía un correo. Degrada a log si SMTP no está configurado. */
  async sendMail(input: SendMailInput): Promise<{ sent: boolean; error?: string }> {
    const to = (input.to || '').trim();
    if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
      return { sent: false, error: 'Correo del destinatario inválido' };
    }
    const t = await this.getTransporter();
    if (!t) {
      this.logger.log(`[no enviado · SMTP no configurado] → ${to}: ${input.subject}`);
      return { sent: false, error: 'SMTP no configurado' };
    }
    try {
      await t.tx.sendMail({
        from: t.from, to, subject: input.subject, html: input.html, text: input.text,
        attachments: input.attachments?.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
      });
      return { sent: true };
    } catch (e) {
      this.logger.warn(`Error SMTP enviando a ${to}: ${(e as Error).message}`);
      return { sent: false, error: (e as Error).message };
    }
  }

  // ---------- Plantillas ----------

  /** Asegura que existan las plantillas por defecto y devuelve todas. */
  async listTemplates() {
    const existing = await this.prisma.emailTemplate.findMany();
    const have = new Set(existing.map((t) => t.kind));
    const missing = DEFAULT_TEMPLATES.filter((d) => !have.has(d.kind));
    if (missing.length) {
      await this.prisma.emailTemplate.createMany({ data: missing.map((d) => ({ ...d, active: true })) });
    }
    return this.prisma.emailTemplate.findMany({ orderBy: { kind: 'asc' } });
  }

  async getTemplate(kind: string) {
    await this.listTemplates(); // asegura defaults
    return this.prisma.emailTemplate.findUnique({ where: { kind } });
  }

  async updateTemplate(id: string, data: { name?: string; subject?: string; bodyHtml?: string; active?: boolean }) {
    const t = await this.prisma.emailTemplate.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('Plantilla no encontrada');
    return this.prisma.emailTemplate.update({
      where: { id },
      data: {
        name: data.name ?? t.name, subject: data.subject ?? t.subject,
        bodyHtml: data.bodyHtml ?? t.bodyHtml, active: data.active ?? t.active,
      },
    });
  }

  /** Sustituye {{clave}} por su valor (vacío si no existe). */
  render(text: string, ctx: Record<string, string>): string {
    return text.replace(/\{\{(\w+)\}\}/g, (_m, k) => (ctx[k] ?? ''));
  }

  /**
   * Envía un correo usando una plantilla por su `kind`. Devuelve sent:false si la
   * plantilla está inactiva o SMTP no está configurado.
   */
  async sendTemplate(kind: string, to: string, ctx: Record<string, string>, attachments?: MailAttachment[]) {
    const tpl = await this.getTemplate(kind);
    if (!tpl) throw new BadRequestException(`Plantilla de correo '${kind}' no existe`);
    if (!tpl.active) return { sent: false, error: 'Plantilla inactiva' };
    return this.sendMail({
      to, subject: this.render(tpl.subject, ctx), html: this.render(tpl.bodyHtml, ctx), attachments,
    });
  }
}
