import { Injectable, Logger } from '@nestjs/common';
import type { AgentUser } from '@s4gk/wa-agent';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { normalizePhone } from '../common/phone.util';
import { CHAT_CLIENTE_PERMISSION, type ChatIdentity } from './chatbot.identity';

/** Cuentas basura del legacy: nunca se eligen si hay una viva con el mismo teléfono. */
const DEAD_STATUS = new Set(['DEPURADO', 'RETIRADO']);

/**
 * Resuelve el número entrante a un usuario del motor, en este orden:
 *
 *   1. FUNCIONARIO — `User.whatsappPhone` (único, E.164 sin '+'). Sus permisos son
 *      los EFECTIVOS del ERP (`AuthService.resolveUser`: unión de roles ∪ ALLOW − DENY),
 *      así que el agente no puede hacer por WhatsApp nada que el funcionario no pueda
 *      hacer en la web. Un usuario inactivo resuelve a null y cae al siguiente paso.
 *   2. ABONADO — teléfono en `phone1`/`phone2`.
 *   3. PÚBLICO — desconocido: atiende el agente público (info general, cero datos).
 *
 * Nunca devuelve null: devolverlo silenciaría el mensaje, y el diseño acordado es
 * que un desconocido sí reciba respuesta pública.
 */
@Injectable()
export class ChatbotIdentityService {
  private readonly logger = new Logger('ChatbotIdentity');

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
  ) {}

  async resolveUser(phone: string): Promise<AgentUser | null> {
    const digits = normalizePhone(phone) ?? String(phone).replace(/\D/g, '');
    if (!digits) return null;

    const interno = await this.resolveInterno(digits);
    if (interno) return interno;

    const cliente = await this.resolveCliente(digits);
    if (cliente) return cliente;

    return this.agentUser(`wa:${digits}`, 'Visitante', [], { kind: 'publico', phone: digits });
  }

  /** Funcionario por `User.whatsappPhone`, con sus permisos efectivos del ERP. */
  private async resolveInterno(digits: string): Promise<AgentUser | null> {
    const user = await this.prisma.user
      .findUnique({ where: { whatsappPhone: digits }, select: { id: true } })
      .catch((e: Error) => {
        this.logger.warn(`No se pudo buscar el funcionario por whatsappPhone: ${e.message}`);
        return null;
      });
    if (!user) return null;

    // resolveUser devuelve null si la cuenta está desactivada: entonces NO es un
    // funcionario para el chatbot y se le atiende como abonado o público.
    const authUser = await this.auth.resolveUser(user.id);
    if (!authUser) return null;

    return this.agentUser(authUser.id, authUser.name, authUser.permissions, { kind: 'interno', authUser });
  }

  /**
   * Abonado por teléfono. Los teléfonos legacy vienen sin formato garantizado, así
   * que se compara por los últimos 10 dígitos (que es lo que hoy funciona en
   * producción, ver WhatsappLogService). `contains` puede dar falsos positivos —un
   * last10 puede aparecer dentro de un número más largo—, por eso NO se usa
   * findFirst: se traen los candidatos, se exige que el last10 calce de verdad al
   * final del número y se prefiere la cuenta viva sobre las depuradas/retiradas.
   */
  private async resolveCliente(digits: string): Promise<AgentUser | null> {
    const last10 = digits.slice(-10);
    if (last10.length < 10) return null;

    const rows = await this.candidatos(last10);
    const exact = rows.filter(
      (r) => this.endsWith(r.phone1, last10) || this.endsWith(r.phone2, last10),
    );
    if (!exact.length) return null;

    const chosen = exact.find((r) => !DEAD_STATUS.has(r.status ?? '')) ?? exact[0];
    if (exact.length > 1) {
      this.logger.warn(`El teléfono ${last10} apunta a ${exact.length} abonados; se eligió ${chosen.abonado}.`);
    }

    const name =
      chosen.fullName?.trim() ||
      [chosen.firstName, chosen.lastName1].filter(Boolean).join(' ').trim() ||
      chosen.companyName?.trim() ||
      'Cliente';

    return this.agentUser(chosen.id, name, [CHAT_CLIENTE_PERMISSION], {
      kind: 'cliente',
      subscriberId: chosen.id,
      abonado: chosen.abonado,
    });
  }

  /** Abonados cuyo teléfono contiene esos 10 dígitos. Nunca lanza: sin BD, no hay match. */
  private async candidatos(last10: string) {
    try {
      return await this.prisma.subscriber.findMany({
        where: { OR: [{ phone1: { contains: last10 } }, { phone2: { contains: last10 } }] },
        select: {
          id: true, abonado: true, status: true, phone1: true, phone2: true,
          fullName: true, firstName: true, lastName1: true, companyName: true,
        },
        take: 10,
      });
    } catch (e) {
      this.logger.warn(`No se pudo buscar el abonado por teléfono: ${(e as Error).message}`);
      return [];
    }
  }

  /** ¿El teléfono guardado termina en estos 10 dígitos? (descarta falsos `contains`). */
  private endsWith(stored: string | null, last10: string): boolean {
    const d = (stored ?? '').replace(/\D/g, '');
    return d.length >= 10 && d.endsWith(last10);
  }

  private agentUser(id: string, name: string, permissions: string[], identity: ChatIdentity): AgentUser {
    return { id, name, permissions, meta: { identity } };
  }
}
