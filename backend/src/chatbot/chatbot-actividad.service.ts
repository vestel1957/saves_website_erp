import { Logger } from '../core/logger';
import { PrismaService } from '../prisma/prisma.service';
import { BOT_ACTOR } from './chatbot.identity';

/**
 * Colombia no tiene horario de verano: siempre UTC-05:00. Así que el inicio del día
 * local es, exactamente, las 05:00 UTC de esa misma fecha.
 *
 * Se calcula así y no con `new Date().setHours(0,0,0,0)` porque el servidor no está en
 * Colombia (hoy corre en Europe/Berlin): a las 20:00 de Yopal, la medianoche local del
 * servidor ya es el día siguiente y "los mensajes de hoy" saldrían del día equivocado.
 * Es el mismo cuidado que tienen los cron y el calendario del prompt.
 */
function inicioDiaColombia(diasAtras = 0): Date {
  const hoyBogota = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
  const inicio = new Date(`${hoyBogota}T05:00:00.000Z`);
  if (diasAtras) inicio.setUTCDate(inicio.getUTCDate() - diasAtras);
  return inicio;
}

/**
 * Qué ha hecho el bot. Es la vista que SAM tenía en su dashboard (`/api/estadisticas` y
 * `/api/casos`) y que aquí faltaba: los datos existían, pero repartidos entre
 * `/soporte`, `/whatsapp` y Configuración, así que nadie podía responder "¿está
 * sirviendo esto?" sin abrir tres pantallas y sumar a mano.
 *
 * Todo sale de tablas que ya se llenaban solas; no hay contadores nuevos que mantener
 * (y por tanto no hay un contador que pueda quedar desincronizado de la realidad).
 */
export class ChatbotActividadService {
  private readonly logger = new Logger('ChatbotActividad');

  constructor(private readonly prisma: PrismaService) {}

  async resumen() {
    const hoy = inicioDiaColombia();
    const semana = inicioDiaColombia(7);
    const mes = inicioDiaColombia(30);

    const [
      porEstado,
      mensajesHoy,
      mensajesSemana,
      notasDeVoz,
      notasConAudio,
      solicitudesPorTipo,
      ultimasSolicitudes,
      escaladas,
      esperandoConfirmacion,
      revisitas,
    ] = await Promise.all([
      this.prisma.whatsappConversation.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.whatsappMessage.groupBy({
        by: ['direction'], where: { createdAt: { gte: hoy } }, _count: { _all: true },
      }),
      this.prisma.whatsappMessage.groupBy({
        by: ['direction'], where: { createdAt: { gte: semana } }, _count: { _all: true },
      }),
      this.prisma.whatsappMessage.count({ where: { hasAudio: true, createdAt: { gte: mes } } }),
      this.prisma.whatsappMessage.count({
        where: { hasAudio: true, audioPath: { not: null }, createdAt: { gte: mes } },
      }),
      // Todo lo que el bot ha registrado, por tipo de orden. `col` es quien la abrió.
      this.prisma.ticket.groupBy({
        by: ['type'], where: { col: BOT_ACTOR.name }, _count: { _all: true },
        orderBy: { _count: { type: 'desc' } },
      }),
      this.prisma.ticket.findMany({
        where: { col: BOT_ACTOR.name },
        orderBy: { createdAt: 'desc' },
        take: 12,
        select: {
          id: true, code: true, type: true, subject: true, status: true, priority: true,
          createdAt: true, assigned: true,
          subscriber: { select: { abonado: true, fullName: true, firstName: true, lastName1: true, companyName: true } },
        },
      }),
      // Conversaciones que el bot no pudo resolver y pasó a una persona. El motivo es lo
      // que dice DÓNDE se queda corto el bot: es la lista de trabajo para mejorarlo.
      this.prisma.whatsappConversation.findMany({
        where: { handoffReason: { not: null }, status: { in: ['PENDIENTE', 'ASIGNADA'] } },
        orderBy: { lastMessageAt: 'desc' },
        take: 12,
        select: {
          phone: true, handoffReason: true, status: true, lastMessageAt: true,
          assignedTo: { select: { name: true } },
          subscriber: { select: { abonado: true, fullName: true, firstName: true, lastName1: true, companyName: true } },
        },
      }),
      this.prisma.whatsappConversation.count({ where: { awaitingTicketId: { not: null } } }),
      // Órdenes que nacieron porque el cliente dijo que NO le había quedado. Es el
      // indicador honesto del bucle de confirmación: si sube, algo se está cerrando en
      // falso en campo.
      this.prisma.ticket.count({
        where: { col: BOT_ACTOR.name, subject: { startsWith: 'Re-visita' }, createdAt: { gte: mes } },
      }),
    ]);

    const cuenta = (rows: Array<{ direction: string; _count: { _all: number } }>, dir: string) =>
      rows.find((r) => r.direction === dir)?._count._all ?? 0;

    const nombre = (s: any) =>
      s ? (s.fullName || [s.firstName, s.lastName1].filter(Boolean).join(' ') || s.companyName || null) : null;

    return {
      conversaciones: {
        bot: porEstado.find((r) => r.status === 'BOT')?._count._all ?? 0,
        pendientes: porEstado.find((r) => r.status === 'PENDIENTE')?._count._all ?? 0,
        asignadas: porEstado.find((r) => r.status === 'ASIGNADA')?._count._all ?? 0,
        resueltas: porEstado.find((r) => r.status === 'RESUELTA')?._count._all ?? 0,
        esperandoConfirmacion,
      },
      mensajes: {
        hoy: { recibidos: cuenta(mensajesHoy, 'IN'), enviados: cuenta(mensajesHoy, 'OUT') },
        semana: { recibidos: cuenta(mensajesSemana, 'IN'), enviados: cuenta(mensajesSemana, 'OUT') },
      },
      notasDeVoz: {
        /** Últimos 30 días. */
        total: notasDeVoz,
        /** De esas, cuántas se pueden escuchar (las anteriores al cambio, no). */
        conAudio: notasConAudio,
      },
      solicitudes: {
        total: solicitudesPorTipo.reduce((a, r) => a + r._count._all, 0),
        porTipo: solicitudesPorTipo.map((r) => ({ tipo: r.type, total: r._count._all })),
        revisitasMes: revisitas,
        ultimas: ultimasSolicitudes.map((t) => ({
          id: t.id, code: t.code, type: t.type, subject: t.subject, status: t.status,
          priority: t.priority, createdAt: t.createdAt, assigned: t.assigned,
          abonado: t.subscriber?.abonado ?? null,
          cliente: nombre(t.subscriber),
        })),
      },
      escaladas: escaladas.map((c) => ({
        phone: c.phone, motivo: c.handoffReason, status: c.status,
        lastMessageAt: c.lastMessageAt, atiende: c.assignedTo?.name ?? null,
        abonado: c.subscriber?.abonado ?? null,
        cliente: nombre(c.subscriber),
      })),
    };
  }
}
