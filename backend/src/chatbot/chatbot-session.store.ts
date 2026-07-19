import { Injectable, Logger } from '@nestjs/common';
import type { SessionStore, StoredPending, Turn } from '@s4gk/wa-agent';
import { PrismaService } from '../prisma/prisma.service';

/** TTL de la acción pendiente. Igual que el del almacén en memoria del motor. */
const PENDING_TTL_MS = 10 * 60 * 1000;
/** TTL de los ids vistos. Cubre de sobra los reintentos de Kapso. */
const DEDUPE_TTL_MS = 10 * 60 * 1000;
/** Historial: el motor ya recorta, esto es la red de seguridad al leer. */
const MAX_HISTORY = 20;

/**
 * `SessionStore` respaldado por Prisma.
 *
 * El motor trae `InMemorySessionStore`, que funciona pero pierde todo al reiniciar y
 * no se comparte entre procesos. Con escrituras que cortan servicio o mueven caja eso
 * no es aceptable: un `pm2 restart` entre "¿confirmas?" y el "SÍ" dejaba al técnico
 * respondiendo a una pregunta que ya nadie recordaba, y un reintento de Kapso tras el
 * reinicio se procesaba dos veces.
 *
 * Guardar aquí es barato: son ~2 consultas por mensaje contra los ~2000 ms que tarda
 * una respuesta del LLM.
 */
@Injectable()
export class ChatbotSessionStore implements SessionStore {
  private readonly logger = new Logger('ChatbotSessionStore');

  constructor(private readonly prisma: PrismaService) {}

  async getHistory(convKey: string): Promise<Turn[]> {
    const row = await this.prisma.chatbotSession.findUnique({
      where: { convKey },
      select: { history: true },
    });
    const turns = (row?.history ?? []) as unknown as Turn[];
    if (!Array.isArray(turns)) return [];
    return turns.slice(-MAX_HISTORY);
  }

  async setHistory(convKey: string, turns: Turn[]): Promise<void> {
    const history = (turns ?? []).slice(-MAX_HISTORY) as unknown as object;
    await this.prisma.chatbotSession.upsert({
      where: { convKey },
      create: { convKey, history },
      update: { history },
    });
  }

  async getPending(convKey: string): Promise<StoredPending | null> {
    const row = await this.prisma.chatbotSession.findUnique({
      where: { convKey },
      select: { pending: true, pendingAt: true },
    });
    if (!row?.pending || !row.pendingAt) return null;

    // Caduca por fecha, no por un timer en memoria: si no, un reinicio resucitaría
    // una confirmación vieja y el siguiente "sí" del usuario —dicho para otra cosa—
    // ejecutaría una escritura que ya nadie espera.
    if (Date.now() - row.pendingAt.getTime() > PENDING_TTL_MS) {
      await this.setPending(convKey, null);
      return null;
    }
    return row.pending as unknown as StoredPending;
  }

  async setPending(convKey: string, pending: StoredPending | null): Promise<void> {
    const data = {
      pending: (pending ?? null) as unknown as object,
      pendingAt: pending ? new Date() : null,
    };
    await this.prisma.chatbotSession.upsert({
      where: { convKey },
      create: { convKey, history: [], ...data },
      update: data,
    });
  }

  /**
   * Registra el id y dice si YA se había visto. La condición de carrera la resuelve la
   * BD: el `create` sobre la PK falla si otro worker lo insertó primero, y ese fallo
   * ES la respuesta "ya estaba" — comprobar-y-luego-insertar dejaría pasar el duplicado
   * justo cuando importa (dos workers atendiendo el reintento a la vez).
   */
  async seen(messageId: string): Promise<boolean> {
    if (!messageId) return false;
    try {
      await this.prisma.chatbotSeenMessage.create({ data: { messageId } });
      return false;
    } catch {
      return true;
    }
  }

  // ── Escalamiento a una persona ──────────────────────────────────────────────
  // El bot se calla en esa conversación; el mensaje se sigue registrando y lo atiende
  // un funcionario desde el visor. Es el mismo trato que da el interruptor general,
  // pero para una sola conversación.

  /** Marca la conversación como atendida por una persona. Idempotente. */
  async setHandoff(convKey: string, reason: string | null): Promise<void> {
    const data = { handoffAt: new Date(), handoffReason: reason?.slice(0, 500) ?? null };
    await this.prisma.chatbotSession.upsert({
      where: { convKey },
      create: { convKey, history: [], ...data },
      update: data,
    });
    this.logger.log(`Conversación ${convKey} escalada a una persona: ${reason ?? 'sin motivo'}`);
  }

  /** Devuelve el bot a la conversación. */
  async clearHandoff(convKey: string): Promise<void> {
    await this.prisma.chatbotSession.updateMany({
      where: { convKey },
      data: { handoffAt: null, handoffReason: null },
    });
    this.logger.log(`Conversación ${convKey} devuelta al bot.`);
  }

  async isHandedOff(convKey: string): Promise<boolean> {
    const row = await this.prisma.chatbotSession.findUnique({
      where: { convKey },
      select: { handoffAt: true },
    });
    return !!row?.handoffAt;
  }

  /** Las que esperan a una persona, la más vieja primero: es una cola de trabajo. */
  async listHandoffs() {
    return this.prisma.chatbotSession.findMany({
      where: { handoffAt: { not: null } },
      orderBy: { handoffAt: 'asc' },
      select: { convKey: true, handoffAt: true, handoffReason: true, updatedAt: true },
    });
  }

  /**
   * Borra lo caducado. Lo llama el cron de mantenimiento; sin esto las tablas crecen
   * para siempre con conversaciones muertas.
   */
  async purge(): Promise<{ sesiones: number; vistos: number }> {
    const corte = new Date(Date.now() - DEDUPE_TTL_MS);
    const [vistos, sesiones] = await Promise.all([
      this.prisma.chatbotSeenMessage.deleteMany({ where: { seenAt: { lt: corte } } }),
      // 30 días sin hablar: la conversación ya no aporta contexto útil. Las escaladas
      // NO se tocan: borrarlas devolvería el bot a una conversación que un cliente
      // pidió expresamente que atendiera una persona, y encima sin dejar rastro.
      this.prisma.chatbotSession.deleteMany({
        where: { updatedAt: { lt: new Date(Date.now() - 30 * 86400_000) }, handoffAt: null },
      }),
    ]);
    return { sesiones: sesiones.count, vistos: vistos.count };
  }
}
