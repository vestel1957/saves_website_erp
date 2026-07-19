import { Injectable } from '@nestjs/common';
import type { Toolset, ToolContext, ToolDef } from '@s4gk/wa-agent';
import { PERMISSION_DENIED } from '@s4gk/wa-agent';
import { APP_PERMISSIONS as P } from '../../auth/permissions.catalog';
import { SupportService } from '../../support/support.service';
import { SupportWriteService } from '../../support/support-write.service';
import { authUserOf } from '../chatbot.identity';
import { canAny, fecha, gated, safe } from './toolset.util';

/** Mismo gate que el controller de soporte: quién puede CONSULTAR tickets. */
const SOPORTE = [P.AREA_TECNICOS, P.AREA_ADMINISTRACION, P.AREA_CAJA];

/**
 * Quién puede ESCRIBIR. Más estrecho que `SOPORTE`, y tiene que coincidir con el
 * `permission` de cada `preparePending`: el motor lo revalida al confirmar, así que
 * declararle la herramienta a quien no lo tiene le hace recorrer todo el flujo para
 * chocar al final con "ya no tienes permiso" — que además insinúa que el permiso
 * cambió, cuando nunca lo tuvo.
 */
const SOPORTE_ESCRIBE = [P.AREA_TECNICOS];

const ESTADOS = ['PENDIENTE', 'REALIZANDO', 'RESUELTO', 'ANULADA'] as const;

/**
 * Tickets de soporte para el agente interno: ver la carga propia, consultar,
 * crear, anotar la solución y cambiar el estado.
 *
 * Las escrituras pasan por `preparePending`, así que el motor pide un SÍ/NO
 * determinista antes de tocar la BD: el modelo nunca decide solo.
 */
@Injectable()
export class InternoTicketsToolset implements Toolset {
  constructor(
    private readonly support: SupportService,
    private readonly write: SupportWriteService,
  ) {}

  definitions(ctx: ToolContext): ToolDef[] {
    return [
      ...gated(canAny(ctx, SOPORTE), [
      {
        name: 'mis_tickets',
        description:
          'Tickets asignados al funcionario que escribe: pendientes y en curso, más el conteo de resueltos hoy. ' +
          'Úsala cuando pregunte "qué tengo", "mis órdenes", "mi trabajo de hoy".',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'buscar_tickets',
        description: 'Busca tickets por texto, estado, prioridad o técnico asignado.',
        input_schema: {
          type: 'object',
          properties: {
            search: { type: 'string', description: 'Texto libre (cliente, asunto…)' },
            status: { type: 'string', enum: [...ESTADOS] },
            priority: { type: 'string', enum: ['Baja', 'Media', 'Alta', 'Urgente'] },
            tec: { type: 'string', description: 'Técnico asignado' },
          },
        },
      },
      {
        name: 'detalle_ticket',
        description: 'Detalle completo de un ticket: cliente, problema, estado, historial y materiales.',
        input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      },
      ]),
      ...gated(canAny(ctx, SOPORTE_ESCRIBE), [
      {
        name: 'crear_ticket',
        description: 'Crea un ticket de soporte para un abonado. Requiere confirmación del funcionario.',
        input_schema: {
          type: 'object',
          properties: {
            subscriberId: { type: 'string', description: 'id del abonado (de buscar_abonado)' },
            subject: { type: 'string', description: 'Asunto corto' },
            type: { type: 'string', description: 'Tipo/detalle, ej. "Sin servicio", "Instalación"' },
            problem: { type: 'string', description: 'Descripción del problema' },
            priority: { type: 'string', enum: ['Baja', 'Media', 'Alta', 'Urgente'] },
            assigned: { type: 'string', description: 'Técnico a asignar (opcional)' },
          },
          required: ['subscriberId', 'subject', 'type'],
        },
      },
      {
        name: 'agregar_nota_ticket',
        description:
          'Agrega una nota o la solución al historial del ticket. Requiere confirmación.',
        input_schema: {
          type: 'object',
          properties: { id: { type: 'string' }, mensaje: { type: 'string' } },
          required: ['id', 'mensaje'],
        },
      },
      {
        name: 'cambiar_estado_ticket',
        description:
          'Cambia el estado de un ticket. OJO: pasarlo a RESUELTO puede disparar la cascada configurada ' +
          '(reconectar el servicio en la red y cobrarle la reconexión al cliente). Requiere confirmación.',
        input_schema: {
          type: 'object',
          properties: { id: { type: 'string' }, status: { type: 'string', enum: [...ESTADOS] } },
          required: ['id', 'status'],
        },
      },
      ]),
    ];
  }

  async execute(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    if (!canAny(ctx, SOPORTE)) return PERMISSION_DENIED;

    switch (name) {
      case 'mis_tickets':
        return safe(() => this.misTickets(ctx));
      case 'buscar_tickets':
        return safe(() => this.buscar(input));
      case 'detalle_ticket':
        return safe(() => this.detalle(String(input.id ?? '')));
      case 'crear_ticket':
        return safe(() => this.crear(input, ctx));
      case 'agregar_nota_ticket':
        return safe(() => this.nota(input, ctx));
      case 'cambiar_estado_ticket':
        return safe(() => this.estado(input, ctx));
      default:
        return `Herramienta no disponible: ${name}`;
    }
  }

  private async misTickets(ctx: ToolContext): Promise<string> {
    const w = await this.support.myWork(authUserOf(ctx.user));
    if (!w.resolved) {
      return 'No pude ligar tu usuario con una ficha de empleado, así que no puedo listar tus tickets. ' +
        'Pídele a administración que revise que tu correo coincida en Empleados.';
    }
    const { pendiente, realizando, resueltoHoy } = w.counts;
    const cab = `${w.tech?.name ?? 'Tú'}: ${pendiente} pendiente(s), ${realizando} en curso, ${resueltoHoy} resuelto(s) hoy.`;
    if (!w.tickets.length) return `${cab}\nNo tienes tickets abiertos. 🎉`;
    const lineas = w.tickets.map(
      (t) => `• #${t.code} [${t.status}/${t.priority}] ${t.subject} — ${t.client}` +
        `${t.address ? `\n  ${t.address}` : ''}${t.sede ? ` (${t.sede})` : ''}\n  id: ${t.id}`,
    );
    return `${cab}\n${lineas.join('\n')}`;
  }

  private async buscar(input: Record<string, unknown>): Promise<string> {
    const res: any = await this.support.tickets({
      search: input.search ? String(input.search) : undefined,
      status: input.status ? String(input.status) : undefined,
      priority: input.priority ? String(input.priority) : undefined,
      tec: input.tec ? String(input.tec) : undefined,
      pageSize: 8,
    });
    if (!res.items?.length) return 'No encontré tickets con esos criterios.';
    const lineas = res.items.map(
      (t: any) => `• #${t.code} [${t.status}] ${t.subject} — ${t.client ?? '—'} · ${fecha(t.created)}\n  id: ${t.id}`,
    );
    const extra = res.total > res.items.length ? `\n(+${res.total - res.items.length} más)` : '';
    return `${res.total} ticket(s):\n${lineas.join('\n')}${extra}`;
  }

  private async detalle(id: string): Promise<string> {
    const t: any = await this.support.ticketDetail(id);
    const hilo = (t.threads ?? []).slice(-3)
      .map((h: any) => `  – ${fecha(h.date ?? h.created)} ${h.col ?? ''}: ${h.message ?? ''}`)
      .join('\n');
    return [
      `Ticket #${t.code} [${t.status}/${t.priority}] — ${t.subject}`,
      `Cliente: ${t.client ?? '—'}${t.address ? ` · ${t.address}` : ''}`,
      `Tipo: ${t.type ?? '—'} · Asignado: ${t.assigned ?? 'sin asignar'} · Creado ${fecha(t.created)}`,
      t.problem ? `Problema: ${t.problem}` : '',
      hilo ? `Últimas notas:\n${hilo}` : '',
      `id: ${t.id}`,
    ].filter(Boolean).join('\n');
  }

  private async crear(input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    if (ctx.committing) {
      const r = await this.write.createTicket(input as any, authUserOf(ctx.user));
      await ctx.audit({
        userId: ctx.user.id, action: 'support.ticket.create',
        summary: `Ticket #${r.code} creado por WhatsApp`, detail: { ticketId: r.id },
      });
      return `Listo: ticket #${r.code} creado.`;
    }
    const subscriberId = String(input.subscriberId ?? '');
    const subject = String(input.subject ?? '').trim();
    const tipo = String(input.type ?? '').trim();
    if (!subscriberId || !subject || !tipo) return 'Necesito el abonado, el asunto y el tipo de ticket.';
    return ctx.preparePending({
      summary: `Crear ticket "${subject}" (${tipo}) para el abonado.`,
      permission: P.AREA_TECNICOS,
      commitInput: {
        subscriberId, subject, type: tipo,
        problem: input.problem ? String(input.problem) : undefined,
        priority: input.priority ? String(input.priority) : undefined,
        assigned: input.assigned ? String(input.assigned) : undefined,
      },
    });
  }

  private async nota(input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const id = String(input.id ?? '');
    const mensaje = String(input.mensaje ?? '').trim();
    if (ctx.committing) {
      await this.write.addThread(id, { message: mensaje } as any, authUserOf(ctx.user));
      await ctx.audit({
        userId: ctx.user.id, action: 'support.ticket.note',
        summary: `Nota agregada al ticket por WhatsApp`, detail: { ticketId: id },
      });
      return 'Nota agregada al ticket.';
    }
    if (!id || !mensaje) return 'Necesito el id del ticket y el texto de la nota.';
    const t: any = await this.support.ticketDetail(id);
    return ctx.preparePending({
      summary: `Agregar al ticket #${t.code} la nota: "${mensaje}"`,
      permission: P.AREA_TECNICOS,
      commitInput: { id, mensaje },
    });
  }

  private async estado(input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const id = String(input.id ?? '');
    const status = String(input.status ?? '').toUpperCase();
    if (ctx.committing) {
      await this.write.updateStatus(id, { status } as any, authUserOf(ctx.user));
      await ctx.audit({
        userId: ctx.user.id, action: 'support.ticket.status',
        summary: `Ticket a ${status} por WhatsApp`, detail: { ticketId: id, status },
      });
      return `Ticket actualizado a ${status}.`;
    }
    if (!ESTADOS.includes(status as (typeof ESTADOS)[number])) {
      return `Estado inválido. Debe ser uno de: ${ESTADOS.join(', ')}.`;
    }
    const t: any = await this.support.ticketDetail(id);
    // El aviso de la cascada va en el resumen: es lo que el usuario confirma.
    const aviso = status === 'RESUELTO'
      ? ' Si la cascada está activa, esto reconecta el servicio y le cobra la reconexión al cliente.'
      : '';
    return ctx.preparePending({
      summary: `Cambiar el ticket #${t.code} (${t.subject}) de ${t.status} a ${status}.${aviso}`,
      permission: P.AREA_TECNICOS,
      commitInput: { id, status },
    });
  }
}
