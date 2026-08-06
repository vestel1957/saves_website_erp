import { BadRequestException, NotFoundException } from '../../core/http/errores';
import { Logger } from '../../core/logger';
import { Prisma, WhatsappConvStatus } from '@prisma/client';
import { extname } from 'node:path';
import { PrismaService } from '../../prisma/prisma.service';
import { rutaDeNotaDeVoz } from './whatsapp-audio.store';
import { WhatsappService } from './whatsapp.service';
import { NotificationsService } from '../notifications/notifications.service';
import { APP_PERMISSIONS } from '../../auth/permissions.catalog';
import { ResponsibilityNotifierService } from '../../responsibilities/responsibility-notifier.service';

/** Ventana de servicio de Meta: fuera de ella solo se puede escribir por plantilla. */
export const VENTANA_MS = 24 * 60 * 60 * 1000;

/** Prefijo con el que el motor del bot arma su llave de conversación (`kapso:<tel>`). */
const TRANSPORTE = 'kapso';

const preview = (body: string) => (body || '').replace(/\s+/g, ' ').trim().slice(0, 160);
const digitsOf = (phone: string) => (phone || '').replace(/\D/g, '');

/**
 * Bandeja de atención de WhatsApp: el lado humano del mismo canal que atiende el bot.
 *
 * El bot ya sabía callarse (`ChatbotSession.handoffAt`), pero la conversación escalada
 * caía en un montón anónimo: nadie era dueño de ella y no había dónde responder. Aquí
 * cada hilo tiene estado, dueño y respuesta.
 *
 * Dos reglas que gobiernan todo lo demás:
 *
 *  1. Si una PERSONA escribe en un chat, el bot se calla en ese chat. Que los dos
 *     contesten a la vez es peor que no tener bandeja: el cliente recibe dos versiones
 *     de la misma respuesta y ninguna manda.
 *  2. Al resolver, el bot vuelve. Si no, cada conversación atendida una vez quedaría
 *     muda para siempre y la bandeja se llenaría de gente esperando a un humano que ya
 *     no está mirando.
 *
 * El silencio del bot se escribe directamente sobre `ChatbotSession` en vez de usar
 * `ChatbotSessionStore`: ese servicio vive en ChatbotModule, que importa a este módulo
 * — inyectarlo aquí cerraría el ciclo. Es la misma vía que ya usa
 * `WhatsappRemindersService` para respetar los escalados.
 */
export class WhatsappInboxService {
  private readonly logger = new Logger('WhatsappInbox');

  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsapp: WhatsappService,
    private readonly notifications: NotificationsService,
    private readonly porCargo: ResponsibilityNotifierService,
  ) {}

  // ── Índice de conversaciones ───────────────────────────────────────────────

  /**
   * Registra en la conversación el mensaje que acaba de pasar por el log. Se llama en
   * CADA mensaje (entrante o saliente, del bot o de una persona) para que la bandeja
   * esté al día sin recorrer la tabla de mensajes.
   *
   * `rawPhone` es el teléfono TAL CUAL lo entregó el transporte: con él se arma la
   * misma `convKey` que usa el motor. Normalizarla dejaría el handoff guardado bajo una
   * llave que el gate del bot no busca nunca — y el bot seguiría respondiendo encima de
   * la persona.
   */
  async touch(params: {
    direction: 'IN' | 'OUT';
    phone: string;
    body: string;
    subscriberId: string | null;
    rawPhone?: string;
    sentById?: string | null;
  }): Promise<void> {
    const phone = digitsOf(params.phone);
    if (!phone) return;
    const ahora = new Date();
    const entrante = params.direction === 'IN';
    const texto = preview(params.body);

    // Un cliente que vuelve a escribir sobre una conversación ya cerrada abre un caso
    // nuevo, y al bot ya se le devolvió el chat al resolverlo: dejarla como RESUELTA
    // mentiría en la lista. Si vuelve a hacer falta una persona, el bot la escalará.
    const reabrir = entrante ? await this.estaResuelta(phone) : false;

    const comun = {
      ...(reabrir ? { status: 'BOT' as WhatsappConvStatus, resolvedAt: null, resolvedById: null } : {}),
      lastMessageAt: ahora,
      lastDirection: params.direction,
      preview: texto,
      ...(params.subscriberId ? { subscriberId: params.subscriberId } : {}),
      ...(entrante && params.rawPhone ? { convKey: `${TRANSPORTE}:${params.rawPhone}` } : {}),
    };

    try {
      const conv = await this.prisma.whatsappConversation.upsert({
        where: { phone },
        create: {
          phone,
          ...comun,
          lastInboundAt: entrante ? ahora : null,
          unread: entrante ? 1 : 0,
        },
        update: entrante
          ? { ...comun, lastInboundAt: ahora, unread: { increment: 1 } }
          // Un saliente significa que alguien —bot o persona— ya contestó: lo que
          // quedaba sin leer, quedó atendido. Sin esto la bandeja se llenaría de
          // "sin leer" de conversaciones que el bot ya resolvió solo.
          : { ...comun, unread: 0 },
      });
      if (entrante) await this.avisarEntrante(conv, params.body);
    } catch (e) {
      this.logger.warn(`No se pudo actualizar la conversación de ${phone}: ${(e as Error).message}`);
    }
  }

  /**
   * Avisa por la campanita de un mensaje entrante.
   *
   * Solo si hay una PERSONA en juego: si la conversación la lleva el bot, nadie tiene
   * nada que hacer y notificarlo sería enseñarle a todo el mundo a ignorar la campana.
   *  · ASIGNADA  → a su dueño, y solo a él.
   *  · PENDIENTE → al encargado de call center: es de nadie y alguien la tiene que tomar.
   *
   * El pendiente se dirige por CARGO y no por permiso (`whatsapp.inbox`) desde que
   * existe "Encargados por cargo". Avisarle a las 23 personas que pueden abrir la
   * bandeja era avisarle a ninguna: nadie se sentía el destinatario. Mientras el cargo
   * esté sin nombrar, `notifyPost` cae al respaldo por ese mismo permiso, así que el
   * aviso no se pierde — sólo deja de tener dueño hasta que se nombre.
   */
  private async avisarEntrante(
    conv: { phone: string; status: WhatsappConvStatus; assignedToId: string | null; subscriberId: string | null },
    texto: string,
  ): Promise<void> {
    if (conv.status !== 'ASIGNADA' && conv.status !== 'PENDIENTE') return;

    const aviso = {
      kind: 'whatsapp.mensaje',
      title: `Mensaje de ${await this.nombreDe(conv)}`,
      body: preview(texto),
      link: `/whatsapp?chat=${conv.phone}`,
      groupKey: `whatsapp:${conv.phone}`,
    };

    if (conv.status === 'PENDIENTE') {
      await this.porCargo.notifyPost('call-center', aviso);
      return;
    }
    if (!conv.assignedToId) return;
    await this.notifications.notify([conv.assignedToId], aviso);
  }

  private async nombreDe(conv: { phone: string; subscriberId: string | null }): Promise<string> {
    if (!conv.subscriberId) return `+${conv.phone}`;
    const s = await this.prisma.subscriber
      .findUnique({
        where: { id: conv.subscriberId },
        select: { fullName: true, firstName: true, lastName1: true, companyName: true },
      })
      .catch(() => null);
    if (!s) return `+${conv.phone}`;
    return (
      s.fullName || [s.firstName, s.lastName1].filter(Boolean).join(' ') || s.companyName || `+${conv.phone}`
    );
  }

  private async estaResuelta(phone: string): Promise<boolean> {
    const row = await this.prisma.whatsappConversation.findUnique({
      where: { phone },
      select: { status: true },
    });
    return row?.status === 'RESUELTA';
  }

  /** Escalada desde el bot: la conversación entra a la cola sin dueño. */
  async onHandoff(convKey: string, reason: string | null): Promise<void> {
    const phone = digitsOf(convKey);
    if (!phone) return;
    try {
      const actual = await this.prisma.whatsappConversation.findUnique({
        where: { phone },
        select: { status: true },
      });
      // Si ya la tiene alguien, no se le quita: que el cliente vuelva a pedir un humano
      // no debe devolver a la cola una conversación que ya está siendo atendida.
      const status: WhatsappConvStatus | undefined = actual?.status === 'ASIGNADA' ? undefined : 'PENDIENTE';
      await this.prisma.whatsappConversation.upsert({
        where: { phone },
        create: { phone, convKey, status: 'PENDIENTE', handoffReason: reason, lastMessageAt: new Date() },
        update: { convKey, handoffReason: reason, ...(status ? { status } : {}) },
      });
    } catch (e) {
      this.logger.warn(`No se pudo encolar ${convKey}: ${(e as Error).message}`);
    }
  }

  /**
   * El bot vuelve a la conversación por una vía ajena a la bandeja (el botón de
   * Configuración → Agente). La bandeja se entera para no seguir mostrándola como
   * pendiente de una persona que ya no tiene nada que hacer ahí.
   */
  async onBotReturn(convKey: string): Promise<void> {
    const phone = digitsOf(convKey);
    if (!phone) return;
    await this.prisma.whatsappConversation
      .updateMany({
        where: { phone, status: { in: ['PENDIENTE', 'ASIGNADA'] } },
        data: { status: 'BOT', assignedToId: null, assignedAt: null, handoffReason: null },
      })
      .catch((e) => this.logger.warn(`No se pudo devolver ${phone} al bot en la bandeja: ${(e as Error).message}`));
  }

  // ── Consulta ───────────────────────────────────────────────────────────────

  /**
   * Lista de hilos, el más reciente primero. `estado` filtra la cola; `mias` acota a
   * las del usuario, que es como trabaja quien atiende: abre su columna y responde.
   */
  async list(params: {
    estado?: string;
    mias?: boolean;
    search?: string;
    page?: number;
    pageSize?: number;
    userId: string;
  }) {
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(params.pageSize) || 30));
    const where: Prisma.WhatsappConversationWhereInput = {};

    const estado = (params.estado || '').toUpperCase();
    if (estado === 'PENDIENTES') where.status = 'PENDIENTE';
    else if (estado === 'ABIERTAS') where.status = { in: ['PENDIENTE', 'ASIGNADA'] };
    else if (['BOT', 'PENDIENTE', 'ASIGNADA', 'RESUELTA'].includes(estado)) {
      where.status = estado as WhatsappConvStatus;
    }
    if (params.mias) where.assignedToId = params.userId;

    const s = (params.search || '').trim();
    if (s) {
      where.OR = [
        { phone: { contains: digitsOf(s) || s } },
        { preview: { contains: s, mode: 'insensitive' } },
        { subscriber: { fullName: { contains: s, mode: 'insensitive' } } },
        // `abonado` es numérico: solo se busca por él si lo que teclearon es un número.
        ...(/^\d+$/.test(s) ? [{ subscriber: { abonado: Number(s) } }] : []),
      ];
    }

    const [rows, total, contadores] = await Promise.all([
      this.prisma.whatsappConversation.findMany({
        where,
        orderBy: { lastMessageAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          subscriber: { select: { id: true, fullName: true, firstName: true, lastName1: true, companyName: true, abonado: true, status: true } },
          assignedTo: { select: { id: true, name: true } },
        },
      }),
      this.prisma.whatsappConversation.count({ where }),
      this.prisma.whatsappConversation.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);

    const porEstado = Object.fromEntries(contadores.map((c) => [c.status, c._count._all]));
    return {
      items: rows.map((r) => this.serialize(r)),
      total,
      page,
      pageSize,
      pages: Math.ceil(total / pageSize),
      contadores: {
        pendientes: porEstado.PENDIENTE ?? 0,
        asignadas: porEstado.ASIGNADA ?? 0,
        bot: porEstado.BOT ?? 0,
        resueltas: porEstado.RESUELTA ?? 0,
        mias: await this.prisma.whatsappConversation.count({
          where: { assignedToId: params.userId, status: 'ASIGNADA' },
        }),
      },
    };
  }

  /** Hilo completo de un número (orden cronológico) + ficha de la conversación. */
  async thread(phone: string, params: { take?: number } = {}) {
    const digits = digitsOf(phone);
    if (!digits) throw new BadRequestException('Teléfono inválido.');
    const take = Math.min(500, Math.max(20, Number(params.take) || 200));

    const [conv, mensajes] = await Promise.all([
      this.prisma.whatsappConversation.findUnique({
        where: { phone: digits },
        include: {
          subscriber: { select: { id: true, fullName: true, firstName: true, lastName1: true, companyName: true, abonado: true, status: true, addressLine: true } },
          assignedTo: { select: { id: true, name: true } },
        },
      }),
      this.prisma.whatsappMessage.findMany({
        where: { phone: digits },
        orderBy: { createdAt: 'desc' },
        take,
        include: { sentBy: { select: { id: true, name: true } } },
      }),
    ]);

    if (!conv && !mensajes.length) throw new NotFoundException('No hay conversación con ese número.');

    return {
      conversacion: conv ? this.serialize(conv) : { phone: digits, status: 'BOT', ventana: this.ventana(null) },
      mensajes: mensajes.reverse().map((m) => ({
        id: m.id,
        direction: m.direction,
        body: m.body,
        hasAudio: m.hasAudio,
        // Ruta para escuchar la nota de voz. Solo cuando el binario está guardado: las
        // notas anteriores a este cambio tienen `hasAudio` en true y nada que reproducir,
        // y ofrecer un botón que no suena es peor que no ofrecerlo.
        audioUrl: m.audioPath ? `/whatsapp/audios/${m.id}` : null,
        createdAt: m.createdAt,
        // Saliente sin autor = lo escribió el sistema (bot, alerta o campaña).
        autor: m.sentBy?.name ?? null,
        autorId: m.sentBy?.id ?? null,
      })),
    };
  }

  /**
   * Ruta en disco de la nota de voz de un mensaje, para servirla (ver
   * `whatsapp-audio.store`, que valida el nombre y la existencia del archivo).
   */
  async audio(id: string): Promise<{ ruta: string; nombre: string }> {
    const m = await this.prisma.whatsappMessage.findUnique({
      where: { id },
      select: { audioPath: true, phone: true, createdAt: true },
    });
    if (!m?.audioPath) throw new NotFoundException('Ese mensaje no tiene nota de voz guardada.');
    const ruta = rutaDeNotaDeVoz(m.audioPath);
    if (!ruta) throw new NotFoundException('La nota de voz ya no está en el servidor.');
    // Nombre legible al descargar: de quién y de cuándo, que es lo que hace falta
    // cuando el audio acaba adjunto a un caso o reenviado a un técnico.
    const fecha = m.createdAt.toISOString().slice(0, 16).replace('T', ' ').replace(':', 'h');
    return { ruta, nombre: `nota de voz ${m.phone} ${fecha}${extname(m.audioPath)}` };
  }

  // ── Acciones ───────────────────────────────────────────────────────────────

  /**
   * Responde como persona. Al hacerlo, el bot se calla en esta conversación y el hilo
   * queda a nombre de quien escribió (si no tenía dueño).
   *
   * Fuera de la ventana de 24 h, `sendText` reabre por plantilla aprobada — es la única
   * salida legal de Meta. Se devuelve `ventana` para que la pantalla lo diga antes de
   * escribir, no después de que el mensaje se convierta en otra cosa.
   */
  async reply(phone: string, text: string, user: { id: string; name?: string }) {
    const digits = digitsOf(phone);
    const cuerpo = (text || '').trim();
    if (!digits) throw new BadRequestException('Teléfono inválido.');
    if (!cuerpo) throw new BadRequestException('El mensaje va vacío.');
    if (cuerpo.length > 4000) throw new BadRequestException('El mensaje supera los 4.000 caracteres.');

    // Callar al bot ANTES de enviar: si el envío tarda y entra un mensaje del cliente,
    // el bot ya no puede colarse a responderlo por debajo.
    await this.silenciarBot(digits, `Responde ${user.name ?? 'un funcionario'}`);
    await this.tomarSiNoTieneDueno(digits, user.id);

    const ok = await this.whatsapp.sendText(digits, cuerpo, {
      reopenWithTemplate: true,
      sentById: user.id,
    });
    if (!ok) {
      return {
        ok: false,
        error: 'WhatsApp no aceptó el mensaje. Revisa la conexión del canal en Configuración.',
      };
    }
    await this.markRead(digits, user.id);
    return { ok: true };
  }

  /**
   * Marca los entrantes como vistos. Apaga también los avisos de la campanita de ese
   * chat: quien lo está leyendo ya no necesita que le recuerden que existe.
   */
  async markRead(phone: string, userId?: string) {
    const digits = digitsOf(phone);
    await this.prisma.whatsappConversation
      .updateMany({ where: { phone: digits }, data: { unread: 0 } })
      .catch(() => null);
    if (userId) {
      await this.notifications.markGroupRead(userId, `whatsapp:${digits}`).catch(() => null);
    }
    return { ok: true };
  }

  /** Toma la conversación (o se la pasa a otro, si viene `targetUserId`). */
  async assign(phone: string, user: { id: string }, targetUserId?: string) {
    const digits = digitsOf(phone);
    const destino = targetUserId || user.id;
    const existe = await this.prisma.user.findUnique({ where: { id: destino }, select: { id: true } });
    if (!existe) throw new BadRequestException('El usuario destino no existe.');

    // Tomarla implica que la atiende una persona: el bot se calla también aquí, no solo
    // al escribir. Si no, entre "la tomo" y "le escribo" el bot seguiría contestando.
    await this.silenciarBot(digits, 'La atiende un funcionario');
    const conv = await this.prisma.whatsappConversation.upsert({
      where: { phone: digits },
      create: { phone: digits, status: 'ASIGNADA', assignedToId: destino, assignedAt: new Date(), lastMessageAt: new Date() },
      update: { status: 'ASIGNADA', assignedToId: destino, assignedAt: new Date(), resolvedAt: null, resolvedById: null },
    });

    // Tomarla uno mismo no se avisa: ya sabe que la tomó, lo acaba de hacer. Pasársela
    // a otro sí — es trabajo que aparece en su bandeja sin que él lo pidiera.
    if (destino !== user.id) {
      await this.notifications.notify([destino], {
        kind: 'whatsapp.asignado',
        title: `Te pasaron un chat: ${await this.nombreDe(conv)}`,
        body: conv.handoffReason ?? conv.preview,
        link: `/whatsapp?chat=${digits}`,
        groupKey: `whatsapp:${digits}`,
      });
    }
    return { ok: true };
  }

  /**
   * Cierra la conversación y devuelve el bot. Volver a manos del bot es parte de
   * resolver: una conversación cerrada que sigue muda deja al cliente hablándole a
   * nadie la próxima vez que escriba.
   */
  async resolve(phone: string, user: { id: string }) {
    const digits = digitsOf(phone);
    await this.devolverBot(digits);
    await this.prisma.whatsappConversation.updateMany({
      where: { phone: digits },
      data: { status: 'RESUELTA', resolvedAt: new Date(), resolvedById: user.id, unread: 0 },
    });
    return { ok: true };
  }

  /** Devuelve la conversación al bot sin marcarla como atendida. */
  async returnToBot(phone: string) {
    const digits = digitsOf(phone);
    await this.devolverBot(digits);
    await this.prisma.whatsappConversation.updateMany({
      where: { phone: digits },
      data: { status: 'BOT', assignedToId: null, assignedAt: null, handoffReason: null },
    });
    return { ok: true };
  }

  /** Usuarios que pueden atender la bandeja (para el desplegable de asignar). */
  async agents() {
    const rows = await this.prisma.user.findMany({
      where: {
        isActive: true,
        OR: [
          { roles: { some: { role: { permissions: { some: { permission: { key: APP_PERMISSIONS.WHATSAPP_INBOX } } } } } } },
          { permissionOverrides: { some: { effect: 'ALLOW', permission: { key: APP_PERMISSIONS.WHATSAPP_INBOX } } } },
        ],
      },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
      take: 200,
    });
    return rows;
  }

  // ── Internos ───────────────────────────────────────────────────────────────

  /**
   * Silencia al bot en esta conversación. Escribe el handoff sobre TODAS las sesiones
   * cuya llave termine en el número (además de la canónica): el motor arma la llave con
   * el teléfono tal cual llega, que no siempre trae indicativo, y buscar solo la
   * canónica dejaría al bot suelto justo en esas.
   */
  private async silenciarBot(phone: string, motivo: string): Promise<void> {
    const last10 = phone.slice(-10);
    const ahora = new Date();
    try {
      await this.prisma.chatbotSession.upsert({
        where: { convKey: `${TRANSPORTE}:${phone}` },
        create: { convKey: `${TRANSPORTE}:${phone}`, history: [], handoffAt: ahora, handoffReason: motivo },
        update: { handoffAt: ahora, handoffReason: motivo },
      });
      if (last10) {
        await this.prisma.chatbotSession.updateMany({
          where: { convKey: { endsWith: last10 }, handoffAt: null },
          data: { handoffAt: ahora, handoffReason: motivo },
        });
      }
    } catch (e) {
      this.logger.warn(`No se pudo silenciar al bot en ${phone}: ${(e as Error).message}`);
    }
  }

  private async devolverBot(phone: string): Promise<void> {
    const last10 = phone.slice(-10);
    if (!last10) return;
    await this.prisma.chatbotSession
      .updateMany({ where: { convKey: { endsWith: last10 } }, data: { handoffAt: null, handoffReason: null } })
      .catch((e) => this.logger.warn(`No se pudo devolver el bot a ${phone}: ${(e as Error).message}`));
  }

  private async tomarSiNoTieneDueno(phone: string, userId: string): Promise<void> {
    const conv = await this.prisma.whatsappConversation.findUnique({
      where: { phone },
      select: { status: true, assignedToId: true },
    });
    // Con dueño se respeta al dueño: que un segundo funcionario mande un mensaje no le
    // quita el caso a quien lo viene siguiendo.
    if (conv?.assignedToId && conv.status === 'ASIGNADA') return;
    await this.prisma.whatsappConversation.upsert({
      where: { phone },
      create: { phone, status: 'ASIGNADA', assignedToId: userId, assignedAt: new Date(), lastMessageAt: new Date() },
      update: { status: 'ASIGNADA', assignedToId: userId, assignedAt: new Date(), resolvedAt: null, resolvedById: null },
    });
  }

  /** Cuánto queda de la ventana de 24 h de Meta (lo que decide si se puede texto libre). */
  private ventana(lastInboundAt: Date | null) {
    if (!lastInboundAt) return { abierta: false, minutos: 0 };
    const restante = VENTANA_MS - (Date.now() - lastInboundAt.getTime());
    return { abierta: restante > 0, minutos: Math.max(0, Math.round(restante / 60000)) };
  }

  private serialize(r: any) {
    const s = r.subscriber;
    return {
      id: r.id,
      phone: r.phone,
      status: r.status,
      handoffReason: r.handoffReason,
      unread: r.unread,
      preview: r.preview,
      lastDirection: r.lastDirection,
      lastMessageAt: r.lastMessageAt,
      lastInboundAt: r.lastInboundAt,
      assignedToId: r.assignedToId,
      assignedToName: r.assignedTo?.name ?? null,
      assignedAt: r.assignedAt,
      resolvedAt: r.resolvedAt,
      // Se le preguntó si su servicio quedó funcionando y aún no responde (ver
      // TicketConfirmacionService). Quien atienda debe saberlo: si escribe él primero,
      // el sistema va a leer su mensaje como un "sí" o un "no".
      esperandoConfirmacion: !!r.awaitingTicketId,
      subscriberId: s?.id ?? null,
      subscriberName: s
        ? s.fullName || [s.firstName, s.lastName1].filter(Boolean).join(' ') || s.companyName || null
        : null,
      abonado: s?.abonado ?? null,
      subscriberStatus: s?.status ?? null,
      subscriberAddress: s?.addressLine ?? null,
      ventana: this.ventana(r.lastInboundAt ?? null),
    };
  }
}
