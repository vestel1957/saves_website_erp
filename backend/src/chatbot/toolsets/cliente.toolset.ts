import { Injectable, Logger } from '@nestjs/common';
import type { Toolset, ToolContext, ToolDef } from '@s4gk/wa-agent';
import { PERMISSION_DENIED } from '@s4gk/wa-agent';
import { SubscribersService } from '../../subscribers/subscribers.service';
import { CobranzasService } from '../../treasury/cobranzas.service';
import { BillingService } from '../../billing/billing.service';
import { SupportWriteService } from '../../support/support-write.service';
import { invoicePdfBuffer } from '../../billing/billing-pdf';
import type { AuthUser } from '../../auth/current-user.decorator';
import { CHAT_CLIENTE_PERMISSION, subscriberIdOf } from '../chatbot.identity';
import { ChatbotSessionStore } from '../chatbot-session.store';
import { cop, fecha, safe } from './toolset.util';

/**
 * Actor con el que el bot crea tickets a nombre del abonado. El ERP exige un
 * AuthUser para firmar la columna del ticket; este no tiene permisos (`permissions:
 * []`), solo nombre: sirve para la trazabilidad ("lo abrió el bot"), no para
 * autorizar nada.
 */
const BOT_ACTOR: AuthUser = {
  id: 'chatbot',
  email: 'bot@vestel.com.co',
  name: 'Bot WhatsApp',
  roles: [],
  permissions: [],
};

/**
 * Herramientas del abonado. TODAS operan sobre el `subscriberId` que resolvió el
 * IdentityResolver a partir del teléfono que escribe — nunca sobre un id que venga
 * del modelo o del mensaje. Es la garantía de que un cliente no puede leer la
 * cuenta de otro pidiéndolo por chat, aunque el modelo se deje convencer.
 */
@Injectable()
export class ClienteToolset implements Toolset {
  private readonly logger = new Logger('ClienteToolset');

  constructor(
    private readonly subscribers: SubscribersService,
    private readonly cobranzas: CobranzasService,
    private readonly billing: BillingService,
    private readonly write: SupportWriteService,
    private readonly store: ChatbotSessionStore,
  ) {}

  definitions(_ctx: ToolContext): ToolDef[] {
    return [
      {
        name: 'mi_estado_de_cuenta',
        description:
          'Saldo y facturas pendientes del cliente que escribe: cuánto debe, de qué facturas y cuándo vencen.',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'mis_facturas',
        description: 'Últimas facturas del cliente que escribe, con su número, fecha, total y estado.',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'enviar_mi_factura',
        description:
          'Envía por este chat el PDF de una factura del cliente. Sin número de factura, envía la más reciente.',
        input_schema: {
          type: 'object',
          properties: {
            numero: { type: 'string', description: 'Número (tid) de la factura. Opcional: por defecto la última.' },
          },
        },
      },
      {
        name: 'mi_plan',
        description: 'Plan(es) y servicios contratados por el cliente que escribe, con su valor mensual y estado.',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'mis_pagos',
        description: 'Últimos pagos registrados del cliente que escribe.',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'reportar_falla',
        description:
          'Abre un ticket de soporte a nombre del cliente para reportar una falla del servicio. Requiere confirmación.',
        input_schema: {
          type: 'object',
          properties: {
            descripcion: { type: 'string', description: 'Qué le pasa al servicio, en palabras del cliente' },
          },
          required: ['descripcion'],
        },
      },
      {
        name: 'mis_tickets_soporte',
        description: 'Estado de los reportes/tickets de soporte abiertos del cliente que escribe.',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'hablar_con_humano',
        description:
          'Pasa la conversación a una persona del equipo. Úsala cuando el cliente lo pida, cuando se queje ' +
          'de la atención, cuando esté molesto, o cuando necesite algo que no puedes resolver con tus otras ' +
          'herramientas (negociar un acuerdo de pago, reclamar un cobro, cancelar el servicio). ' +
          'A partir de ese momento dejas de responder en este chat: contesta una persona. No la uses para ' +
          'preguntas que sí puedes resolver.',
        input_schema: {
          type: 'object',
          properties: {
            motivo: {
              type: 'string',
              description: 'Qué necesita el cliente, en pocas palabras, para que quien lo atienda no empiece de cero',
            },
          },
          required: ['motivo'],
        },
      },
    ];
  }

  async execute(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    // Cinturón y tirantes: este toolset solo lo monta el agente de clientes, pero si
    // algún día se cablea mal, el permiso sintético lo detiene igual.
    if (!ctx.can(CHAT_CLIENTE_PERMISSION)) return PERMISSION_DENIED;
    const id = subscriberIdOf(ctx.user);

    switch (name) {
      case 'mi_estado_de_cuenta':
        return safe(() => this.estadoCuenta(id));
      case 'mis_facturas':
        return safe(() => this.facturas(id));
      case 'enviar_mi_factura':
        return safe(() => this.enviarFactura(id, input, ctx));
      case 'mi_plan':
        return safe(() => this.plan(id));
      case 'mis_pagos':
        return safe(() => this.pagos(id));
      case 'reportar_falla':
        return safe(() => this.reportarFalla(id, input, ctx));
      case 'mis_tickets_soporte':
        return safe(() => this.tickets(id));
      case 'hablar_con_humano':
        return safe(() => this.escalar(input, ctx));
      default:
        return `Herramienta no disponible: ${name}`;
    }
  }

  private async estadoCuenta(id: string): Promise<string> {
    const d = await this.cobranzas.subscriberDebt(id);
    if (!d.invoices.length) {
      return `Estás al día, no tienes facturas pendientes.` +
        (d.balance ? ` Además tienes un saldo a favor de ${cop(d.balance)}.` : '');
    }
    const lineas = d.invoices.map(
      (i) => `• Factura ${i.tid}: debes ${cop(i.balance)} de ${cop(i.total)} · vence ${fecha(i.dueDate)}`,
    );
    return [
      `Tienes ${cop(d.totalDebt)} pendiente(s) en ${d.invoices.length} factura(s):`,
      ...lineas,
      d.balance ? `Saldo a favor: ${cop(d.balance)}` : '',
    ].filter(Boolean).join('\n');
  }

  private async facturas(id: string): Promise<string> {
    const rows: any[] = await this.subscribers.invoices(id);
    if (!rows.length) return 'No tienes facturas registradas.';
    return rows.slice(0, 5)
      .map((i) => `• Factura ${i.tid} · ${fecha(i.invoiceDate)} · ${cop(i.total)} · ${i.status}` +
        `${i.balance ? ` · pendiente ${cop(i.balance)}` : ' · pagada'}`)
      .join('\n');
  }

  private async enviarFactura(id: string, input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const rows: any[] = await this.subscribers.invoices(id);
    if (!rows.length) return 'No tienes facturas registradas.';

    const pedido = input.numero ? String(input.numero).replace(/\D/g, '') : '';
    // Se busca SOLO entre las facturas de este abonado: un número de otro cliente
    // simplemente no aparece aquí.
    const inv = pedido ? rows.find((i) => String(i.tid) === pedido) : rows[0];
    if (!inv) return `No encontré la factura ${pedido} entre tus facturas.`;

    const detail = await this.billing.detail(inv.id);
    const pdf = await invoicePdfBuffer(detail as any);
    const caption = `Factura N° ${detail.tid} · Total ${cop(detail.total)}` +
      (detail.balance > 0 ? ` · Pendiente ${cop(detail.balance)}` : ' · Pagada. ¡Gracias!');

    const ok = await ctx.sendDocument({
      data: pdf,
      fileName: `factura-${detail.tid}.pdf`,
      mimetype: 'application/pdf',
      caption,
    });
    if (!ok) {
      this.logger.warn(`No se pudo enviar el PDF de la factura ${detail.tid} al abonado ${id}`);
      return 'No pude enviar el PDF en este momento. Dile al cliente que lo intente más tarde.';
    }
    return `Le envié el PDF de la factura ${detail.tid}. Confírmale que ya lo tiene en el chat.`;
  }

  private async plan(id: string): Promise<string> {
    const s: any = await this.subscribers.detail(id);
    const servicios: any[] = s.services ?? [];
    if (!servicios.length) return 'No tienes servicios activos registrados.';
    const lineas = servicios.map(
      (sv) => `• ${sv.kind}: ${sv.planName ?? '—'} — ${cop(sv.price)}/mes (${sv.status ?? '—'})`,
    );
    return `Tu(s) servicio(s):\n${lineas.join('\n')}`;
  }

  private async pagos(id: string): Promise<string> {
    const st: any = await this.subscribers.statement(id);
    const abonos = (st.movements ?? []).filter((m: any) => (m.type ?? m.kind) === 'ABONO' || m.credit > 0);
    if (!abonos.length) return 'No tengo pagos registrados en tu cuenta.';
    return abonos.slice(0, 5)
      .map((m: any) => `• ${fecha(m.date)} · ${cop(m.credit ?? m.amount)}${m.note ? ` — ${m.note}` : ''}`)
      .join('\n');
  }

  /**
   * Pasa la conversación a una persona: marca el handoff y el bot deja de responder
   * aquí (lo corta el gate en el transporte, antes del motor). El mensaje entrante se
   * sigue registrando, así que el equipo lo atiende desde el visor de conversaciones,
   * igual que antes de que el bot existiera.
   *
   * NO pide confirmación, a diferencia de las escrituras: lo pidió el cliente, y
   * repreguntarle "¿seguro que quieres un humano?" a alguien que ya está molesto es
   * exactamente lo que no hay que hacer. Además falla del lado bueno — si el modelo la
   * invoca de más, el resultado es que atiende una persona; se devuelve al bot desde
   * Configuración con un clic.
   */
  private async escalar(input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const motivo = String(input.motivo ?? '').trim() || 'El cliente pidió hablar con una persona';
    await this.store.setHandoff(ctx.convKey, motivo);
    await ctx.audit({
      userId: ctx.user.id,
      action: 'chatbot.handoff',
      summary: `El cliente pidió hablar con una persona — ${motivo}`,
      detail: { convKey: ctx.convKey, motivo },
    });
    this.logger.log(`Handoff pedido en ${ctx.convKey}: ${motivo}`);
    return 'Listo: le avisé al equipo y una persona le va a escribir por este mismo chat. '
      + 'Despídete y NO sigas respondiendo consultas en este chat.';
  }

  private async reportarFalla(id: string, input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const descripcion = String(input.descripcion ?? '').trim();

    if (ctx.committing) {
      const r = await this.write.createTicket(
        {
          subscriberId: id,
          subject: 'Falla reportada por WhatsApp',
          type: 'Soporte',
          problem: descripcion,
          priority: 'Media',
        } as any,
        BOT_ACTOR,
      );
      await ctx.audit({
        userId: ctx.user.id, action: 'support.ticket.create',
        summary: `Abonado reportó falla por WhatsApp (ticket #${r.code})`,
        detail: { ticketId: r.id, subscriberId: id },
      });
      return `Listo: quedó registrado el reporte con el número #${r.code}. Un técnico lo revisará.`;
    }

    if (!descripcion) return 'Necesito que me cuentes qué le pasa al servicio para poder reportarlo.';
    return ctx.preparePending({
      summary: `Reportar la falla: "${descripcion}" y abrir un ticket de soporte a tu nombre.`,
      permission: CHAT_CLIENTE_PERMISSION,
      commitInput: { descripcion },
    });
  }

  /** Los tickets salen de la ficha del propio abonado, no del listado global. */
  private async tickets(id: string): Promise<string> {
    const s: any = await this.subscribers.detail(id);
    const abiertos = (s.tickets ?? []).filter((t: any) => t.status !== 'ANULADA');
    if (!abiertos.length) return 'No tienes reportes de soporte registrados.';
    return abiertos.slice(0, 5)
      .map((t: any) => `• Reporte #${t.code}: ${t.subject} — ${t.status} (${fecha(t.created)})`)
      .join('\n');
  }
}
