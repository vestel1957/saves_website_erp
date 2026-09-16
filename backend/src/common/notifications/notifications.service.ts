import { Logger } from '../../core/logger';
import { PrismaService } from '../../prisma/prisma.service';

/** Lo que se le pide al servicio para avisar de algo. */
export interface NotifyInput {
  kind: string;
  title: string;
  body?: string | null;
  link?: string | null;
  /** Asunto: si ya hay un aviso SIN LEER con esta llave, se actualiza ese. */
  groupKey?: string | null;
}

/** Tope de avisos que devuelve la campanita. Más abajo no los mira nadie. */
const TOPE = 30;

/**
 * Avisos personales (la campanita).
 *
 * Regla de oro: **solo se notifica lo que alguien tiene que HACER**. Un mensaje que
 * el bot está atendiendo no genera aviso — si notificáramos cada mensaje entrante, la
 * campanita marcaría rojo todo el día y dejaría de significar nada, que es la única
 * forma real de romper una notificación.
 *
 * Es genérico a propósito (`kind` y `link` son texto): nació con la bandeja de
 * WhatsApp, pero cualquier módulo puede avisar sin tocar el modelo.
 */
export class NotificationsService {
  private readonly logger = new Logger('Notifications');

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Avisa a varias personas del mismo asunto. Nunca lanza: un aviso que falla no
   * puede tumbar la operación que lo produjo (registrar un mensaje, asignar un chat).
   *
   * Se resuelve en 3 consultas pase lo que pase, **no una por destinatario**: un chat
   * escalado se le avisa a TODOS los que pueden atender (hoy 23) y hacerlo en paralelo
   * abría 23 conexiones de golpe — Postgres se quedaba sin cupo y cuatro personas se
   * quedaban sin su aviso. Medido, no supuesto.
   */
  async notify(userIds: string[], input: NotifyInput): Promise<void> {
    const destinatarios = [...new Set(userIds.filter(Boolean))];
    if (!destinatarios.length) return;

    const datos = {
      kind: input.kind,
      title: input.title.slice(0, 200),
      body: input.body?.slice(0, 1000) ?? null,
      link: input.link ?? null,
      groupKey: input.groupKey ?? null,
    };

    try {
      if (!datos.groupKey) {
        await this.prisma.notification.createMany({
          data: destinatarios.map((userId) => ({ userId, ...datos })),
        });
        return;
      }

      // Seis mensajes del mismo cliente son UN asunto. A quien ya tenga un aviso sin
      // leer de este chat se le refresca ese (y su fecha, para que suba en la lista)
      // en lugar de apilarle seis.
      const vivos = await this.prisma.notification.findMany({
        where: { userId: { in: destinatarios }, groupKey: datos.groupKey, readAt: null },
        select: { id: true, userId: true },
      });
      if (vivos.length) {
        await this.prisma.notification.updateMany({
          where: { id: { in: vivos.map((v) => v.id) } },
          data: { ...datos, createdAt: new Date() },
        });
      }
      const yaAvisados = new Set(vivos.map((v) => v.userId));
      const nuevos = destinatarios.filter((id) => !yaAvisados.has(id));
      if (nuevos.length) {
        await this.prisma.notification.createMany({
          data: nuevos.map((userId) => ({ userId, ...datos })),
        });
      }
    } catch (e) {
      this.logger.warn(`No se pudieron crear los avisos (${datos.kind}): ${(e as Error).message}`);
    }
  }

  /**
   * Retira un aviso de la campanita de quien ya no le corresponde.
   *
   * El contrapeso de `notify`: la regla de oro dice "sólo se notifica lo que alguien
   * tiene que HACER", y en cuanto deja de tener que hacerlo el aviso sobra. El caso
   * que lo trajo (2026-09-04) es la orden que se le pasa a otro técnico: el anterior
   * se quedaba con un "te asignaron esta orden" de un trabajo que ya no es suyo —
   * Brayan tenía cuatro de órdenes que hacía días eran de Miguel Ángel—.
   *
   * Se BORRA en vez de marcarse leída a propósito: un aviso leído sigue en la lista
   * de los 30 y sigue ocupando sitio en la campanita del técnico, que es justo lo
   * que se viene a quitar. Nunca lanza, por lo mismo que `notify`.
   */
  async retirar(groupKey: string, kind: string, exceptoUserIds: string[] = []): Promise<number> {
    if (!groupKey) return 0;
    try {
      const r = await this.prisma.notification.deleteMany({
        where: {
          groupKey,
          kind,
          ...(exceptoUserIds.filter(Boolean).length ? { userId: { notIn: [...new Set(exceptoUserIds.filter(Boolean))] } } : {}),
        },
      });
      return r.count;
    } catch (e) {
      this.logger.warn(`No se pudo retirar el aviso ${kind}/${groupKey}: ${(e as Error).message}`);
      return 0;
    }
  }

  /** Lo que pinta la campanita: sin leer primero, recientes antes. */
  async list(userId: string) {
    const [items, unread] = await Promise.all([
      this.prisma.notification.findMany({
        where: { userId },
        orderBy: [{ readAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'desc' }],
        take: TOPE,
      }),
      this.prisma.notification.count({ where: { userId, readAt: null } }),
    ]);
    return {
      items: items.map((n) => ({
        id: n.id,
        kind: n.kind,
        title: n.title,
        body: n.body,
        link: n.link,
        leida: !!n.readAt,
        createdAt: n.createdAt,
      })),
      unread,
      /** Sin leer por módulo (el prefijo de `kind`), para los distintivos del menú. */
      porModulo: await this.porModulo(userId),
    };
  }

  private async porModulo(userId: string): Promise<Record<string, number>> {
    const filas = await this.prisma.notification.groupBy({
      by: ['kind'],
      where: { userId, readAt: null },
      _count: { _all: true },
    });
    const acc: Record<string, number> = {};
    for (const f of filas) {
      const modulo = f.kind.split('.')[0];
      acc[modulo] = (acc[modulo] ?? 0) + f._count._all;
    }
    return acc;
  }

  async markRead(userId: string, id: string) {
    await this.prisma.notification.updateMany({
      where: { id, userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { ok: true };
  }

  /** Marca leídas las de un asunto (al abrir el chat, sus avisos sobran). */
  async markGroupRead(userId: string, groupKey: string) {
    await this.prisma.notification.updateMany({
      where: { userId, groupKey, readAt: null },
      data: { readAt: new Date() },
    });
    return { ok: true };
  }

  async markAllRead(userId: string) {
    await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { ok: true };
  }

  /**
   * Borra los avisos leídos de más de 30 días.
   *
   * ⚠️ HOY NO LO LLAMA NADIE: no hay cron de mantenimiento (le pasa lo mismo a
   * `ChatbotSessionStore.purge`). Con `groupKey` colapsando los avisos de un mismo
   * chat el crecimiento es lento, pero cuando exista ese cron, engancharlo aquí.
   */
  async purge(): Promise<number> {
    const corte = new Date(Date.now() - 30 * 86400_000);
    const r = await this.prisma.notification.deleteMany({
      where: { createdAt: { lt: corte }, readAt: { not: null } },
    });
    return r.count;
  }
}
