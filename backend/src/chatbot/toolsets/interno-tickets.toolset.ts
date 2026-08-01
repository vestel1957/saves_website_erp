import { Injectable } from '@nestjs/common';
import type { Toolset, ToolContext, ToolDef } from '@s4gk/wa-agent';
import { PERMISSION_DENIED } from '@s4gk/wa-agent';
import { APP_PERMISSIONS as P } from '../../auth/permissions.catalog';
import { SupportService } from '../../support/support.service';
import { SupportWriteService } from '../../support/support-write.service';
import { ChatbotDocsService, enviarDoc } from '../chatbot-docs.service';
import { authUserOf } from '../chatbot.identity';
import {
  canAny, DOCUMENTO_DENEGADO, fecha, gated, HERRAMIENTAS_DOCUMENTOS, puedeDocumentos, safe,
} from './toolset.util';

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
 * Cómo llama la gente a los estados vs. cómo se llaman en la BD.
 *
 * Nadie pregunta por "tickets en estado PENDIENTE": pregunta "cuántos hay abiertos".
 * El modelo traduce eso a `status: "abierto"`, que no existe en el enum de Prisma y
 * hacía reventar la consulta con un error técnico. Se traduce aquí, que es donde se
 * conoce el vocabulario del negocio.
 */
const SINONIMOS: Record<string, (typeof ESTADOS)[number]> = {
  ABIERTO: 'PENDIENTE', ABIERTOS: 'PENDIENTE', ABIERTA: 'PENDIENTE', ABIERTAS: 'PENDIENTE',
  PENDIENTES: 'PENDIENTE', NUEVO: 'PENDIENTE', NUEVOS: 'PENDIENTE', OPEN: 'PENDIENTE',
  REALIZANDOSE: 'REALIZANDO', PROCESO: 'REALIZANDO', 'EN CURSO': 'REALIZANDO', CURSO: 'REALIZANDO',
  RESUELTOS: 'RESUELTO', RESUELTA: 'RESUELTO', CERRADO: 'RESUELTO', CERRADOS: 'RESUELTO', SOLUCIONADO: 'RESUELTO',
  ANULADO: 'ANULADA', ANULADOS: 'ANULADA', ANULADAS: 'ANULADA', CANCELADO: 'ANULADA', CANCELADA: 'ANULADA',
};

/**
 * Estado del ERP a partir de lo que mandó el modelo. Devuelve `null` si no se puede
 * traducir, para responderle con las opciones válidas en vez de romper la consulta.
 */
function estadoDe(raw: unknown): (typeof ESTADOS)[number] | null {
  const v = String(raw ?? '').trim().toUpperCase();
  if (!v) return null;
  if ((ESTADOS as readonly string[]).includes(v)) return v as (typeof ESTADOS)[number];
  return SINONIMOS[v] ?? null;
}

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
    private readonly docs: ChatbotDocsService,
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
        description:
          'Busca tickets de TODA la empresa por texto, estado, prioridad o técnico asignado, y devuelve ' +
          'CUÁNTOS hay en total además de los primeros. Úsala también para contar: "cuántos tickets ' +
          'abiertos hay", "cuántos pendientes tiene Yopal", "qué reclamos hay sin atender". Los abiertos ' +
          'son los PENDIENTE; los que se están atendiendo, REALIZANDO.',
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
      ...gated(canAny(ctx, SOPORTE) && puedeDocumentos(ctx), [
      {
        name: 'enviar_orden_de_servicio',
        description:
          'Genera el PDF de la orden de servicio (acta técnica) de un ticket y lo adjunta A ESTE CHAT: ' +
          'lleva los datos del cliente, el problema, el equipo asignado, el material usado, el seguimiento ' +
          'y el espacio de firmas. Es la misma acta que se imprime desde el ERP para que el cliente firme.',
        input_schema: {
          type: 'object',
          properties: { id: { type: 'string', description: 'id del ticket (de mis_tickets o buscar_tickets)' } },
          required: ['id'],
        },
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
    // Segunda barrera de los documentos: declararlos solo a administración evita que
    // el modelo los ofrezca, pero no que los invoque si se inventa el nombre.
    if (HERRAMIENTAS_DOCUMENTOS.has(name) && !puedeDocumentos(ctx)) return DOCUMENTO_DENEGADO;

    switch (name) {
      case 'mis_tickets':
        return safe(() => this.misTickets(ctx));
      case 'buscar_tickets':
        return safe(() => this.buscar(input, ctx));
      case 'detalle_ticket':
        return safe(() => this.detalle(String(input.id ?? ''), ctx));
      case 'enviar_orden_de_servicio':
        return safe(() => this.enviarActa(String(input.id ?? ''), ctx));
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
    const w = await this.support.miJornada(authUserOf(ctx.user));
    if (!w.resolved) {
      return 'No pude ligar tu usuario con una ficha de empleado, así que no puedo listar tus tickets. ' +
        'Pídele a administración que revise que tu correo coincida en Empleados.';
    }
    const { realizando, resueltoHoy, vencidas, rezagadas } = w.contadores;
    // Se cuenta la AGENDA, no la cola entera: decir "28 pendientes" cuando 27 son
    // órdenes de hace años es la clase de dato que hace que nadie vuelva a preguntar.
    const cab = `${w.tech?.name ?? 'Tú'}: ${w.agenda.length} por atender, ${realizando} en curso, ${resueltoHoy} resuelto(s) hoy` +
      `${vencidas ? `, ⚠ ${vencidas} vencida(s)` : ''}.` +
      `${rezagadas ? ` (Además ${rezagadas} sin cerrar de hace más de ${w.diasRezago} días.)` : ''}`;
    if (!w.agenda.length) return `${cab}\nNo tienes órdenes nuevas por atender. 🎉`;
    // Ya vienen en orden de atención (en curso → prioridad → más vieja primero), así
    // que por WhatsApp se leen igual de arriba abajo. Se cortan a 15: en el chat una
    // lista más larga no se lee, y el panel las tiene todas.
    const lineas = w.agenda.slice(0, 15).map(
      (t) => `• #${t.code} [${t.status}/${t.priority}${t.vencida ? ' ⚠ vencida' : ''}] ${t.subject} — ${t.client}` +
        `${t.address ? `\n  ${t.address}` : ''}${t.sede ? ` (${t.sede})` : ''}\n  id: ${t.id}`,
    );
    return `${cab}\n${lineas.join('\n')}`;
  }

  private async buscar(input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    // Con el usuario del chat, igual que el resto: si no, consultar por WhatsApp
    // sería la puerta trasera del acotado por sede.
    // "abiertos" no es un estado de la BD: se traduce antes de consultar. Si no se
    // puede traducir, se dice qué valores hay en vez de mandarle basura a Prisma.
    const status = input.status ? estadoDe(input.status) : undefined;
    if (input.status && !status) {
      return `No conozco el estado "${String(input.status)}". Los estados son: ${ESTADOS.join(', ')} ` +
        '(los "abiertos" son los PENDIENTE, y los que están atendiéndose son REALIZANDO).';
    }

    const res: any = await this.support.tickets({
      search: input.search ? String(input.search) : undefined,
      status: status ?? undefined,
      priority: input.priority ? String(input.priority) : undefined,
      tec: input.tec ? String(input.tec) : undefined,
      pageSize: 8,
    }, authUserOf(ctx.user));
    if (!res.items?.length) return 'No encontré tickets con esos criterios.';
    const lineas = res.items.map(
      (t: any) => `• #${t.code} [${t.status}] ${t.subject} — ${t.client ?? '—'} · ${fecha(t.created)}\n  id: ${t.id}`,
    );
    const extra = res.total > res.items.length ? `\n(+${res.total - res.items.length} más)` : '';
    return `${res.total} ticket(s):\n${lineas.join('\n')}${extra}`;
  }

  private async detalle(id: string, ctx: ToolContext): Promise<string> {
    const t: any = await this.support.ticketDetail(id, authUserOf(ctx.user));
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

  /**
   * El acta de la orden, al chat del técnico: es el papel que se lleva a la casa del
   * cliente para que firme, y hasta hoy solo se podía imprimir desde la web.
   */
  private async enviarActa(id: string, ctx: ToolContext): Promise<string> {
    if (!id) return 'Indica el id del ticket (búscalo con mis_tickets o buscar_tickets).';
    return enviarDoc(ctx, await this.docs.ordenServicio(id, authUserOf(ctx.user)));
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
    const t: any = await this.support.ticketDetail(id, authUserOf(ctx.user));
    return ctx.preparePending({
      summary: `Agregar al ticket #${t.code} la nota: "${mensaje}"`,
      permission: P.AREA_TECNICOS,
      commitInput: { id, mensaje },
    });
  }

  private async estado(input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const id = String(input.id ?? '');
    // Mismo vocabulario que en la búsqueda: "ciérralo" o "ya quedó resuelto" tienen
    // que llegar a RESUELTO. Se traduce ANTES de confirmar, para que lo que el
    // funcionario aprueba sea el estado real que se va a guardar.
    const status = estadoDe(input.status);
    if (!status) {
      return `No conozco el estado "${String(input.status ?? '')}". Debe ser uno de: ${ESTADOS.join(', ')}.`;
    }
    if (ctx.committing) {
      await this.write.updateStatus(id, { status } as any, authUserOf(ctx.user));
      await ctx.audit({
        userId: ctx.user.id, action: 'support.ticket.status',
        summary: `Ticket a ${status} por WhatsApp`, detail: { ticketId: id, status },
      });
      return `Ticket actualizado a ${status}.`;
    }
    const t: any = await this.support.ticketDetail(id, authUserOf(ctx.user));
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
