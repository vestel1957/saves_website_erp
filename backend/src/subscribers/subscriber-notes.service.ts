import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from '../auth/current-user.decorator';
import { exigirSedeSuscriptor } from '../common/sede-scope';

/**
 * Notas internas de un cliente.
 * Extraído de SubscribersService: bloque autónomo sobre `subscriberNote`.
 */
@Injectable()
export class SubscriberNotesService {
  constructor(private readonly prisma: PrismaService) {}

  async addNote(id: string, body: string, authorName?: string, user?: AuthUser) {
    await exigirSedeSuscriptor(this.prisma, user, id);
    const exists = await this.prisma.subscriber.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw new NotFoundException('Suscriptor no encontrado');
    const n = await this.prisma.subscriberNote.create({
      data: { subscriberId: id, body: body.trim(), authorName: authorName ?? null },
    });
    return { id: n.id, body: n.body, author: n.authorName, createdAt: n.createdAt };
  }

  async deleteNote(id: string, noteId: string, user?: AuthUser) {
    await exigirSedeSuscriptor(this.prisma, user, id);
    const n = await this.prisma.subscriberNote.findFirst({ where: { id: noteId, subscriberId: id } });
    if (!n) throw new NotFoundException('Nota no encontrada');
    await this.prisma.subscriberNote.delete({ where: { id: n.id } });
    return { ok: true };
  }
}
