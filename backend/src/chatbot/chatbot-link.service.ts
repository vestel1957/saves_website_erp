import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { isValidPhone, normalizePhone } from '../common/phone.util';

/**
 * Vincula el número de WhatsApp de un funcionario con su usuario del ERP
 * (`User.whatsappPhone`). Es lo que hace que el agente lo atienda como interno y
 * herede sus permisos.
 *
 * El número se guarda SIEMPRE normalizado a E.164 sin '+' (57 + 10 dígitos), que es
 * el formato en el que llega el `from` del webhook. Si se guardara como lo teclea el
 * usuario ("300 123 4567"), el lookup nunca casaría y el funcionario sería atendido
 * como un desconocido.
 */
@Injectable()
export class ChatbotLinkService {
  constructor(private readonly prisma: PrismaService) {}

  async list() {
    const rows = await this.prisma.user.findMany({
      where: { whatsappPhone: { not: null } },
      select: { id: true, name: true, email: true, isActive: true, whatsappPhone: true },
      orderBy: { name: 'asc' },
    });
    return rows.map((u) => ({
      userId: u.id, name: u.name, email: u.email, active: u.isActive, phone: u.whatsappPhone,
    }));
  }

  async link(userId: string, rawPhone: string) {
    const phone = normalizePhone(rawPhone);
    if (!isValidPhone(phone)) {
      throw new BadRequestException('Teléfono inválido. Usa el número de WhatsApp, ej. 3001234567.');
    }
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true } });
    if (!user) throw new NotFoundException('Usuario no encontrado');

    // whatsappPhone es único: un número identifica a UNA persona. Si ya está tomado,
    // hay que decir por quién — si no, el error de Prisma no explicaría nada.
    const taken = await this.prisma.user.findUnique({
      where: { whatsappPhone: phone! },
      select: { id: true, name: true },
    });
    if (taken && taken.id !== userId) {
      throw new ConflictException(`Ese WhatsApp ya está vinculado a ${taken.name}.`);
    }

    await this.prisma.user.update({ where: { id: userId }, data: { whatsappPhone: phone } });
    return { userId, name: user.name, phone, linked: true };
  }

  async unlink(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) throw new NotFoundException('Usuario no encontrado');
    await this.prisma.user.update({ where: { id: userId }, data: { whatsappPhone: null } });
    return { userId, linked: false };
  }
}
