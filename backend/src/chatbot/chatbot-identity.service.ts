import { Injectable, Logger } from '@nestjs/common';
import type { AgentUser } from '@s4gk/wa-agent';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { normalizePhone } from '../common/phone.util';
import { CHAT_CLIENTE_PERMISSION, CHAT_PUBLICO_PERMISSION, type ChatIdentity } from './chatbot.identity';
import { ChatAccessService } from './chat-access.service';

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
    private readonly access: ChatAccessService,
  ) {}

  async resolveUser(phone: string): Promise<AgentUser | null> {
    const digits = normalizePhone(phone) ?? String(phone).replace(/\D/g, '');
    if (!digits) return null;

    const interno = await this.resolveInterno(digits);
    if (interno) return interno;

    const cliente = await this.resolveCliente(digits);
    if (cliente) return cliente;

    // Familiar autorizado por el titular (ver SubscriberContact). Va DESPUÉS del
    // titular a propósito: si el mismo número está en la ficha y además autorizado
    // en otra cuenta, manda su propia cuenta.
    const autorizado = await this.resolveAutorizado(digits);
    if (autorizado) return autorizado;

    // Número que se validó a sí mismo (datos de la factura y, si dio el código del
    // titular, acceso pleno). Va de último: cualquier vínculo real manda sobre esto.
    const verificado = await this.resolveVerificado(digits);
    if (verificado) return verificado;

    // Lleva el permiso sintético del agente público (ver CHAT_PUBLICO_PERMISSION): no
    // le da acceso a nada, solo le permite CONFIRMAR lo que registra a su nombre
    // (afiliación, cobertura, PQR).
    return this.agentUser(`wa:${digits}`, 'Visitante', [CHAT_PUBLICO_PERMISSION], {
      kind: 'publico',
      phone: digits,
    });
  }

  /**
   * Número que el titular autorizó a gestionar su cuenta (el hijo, la esposa, quien
   * paga el arriendo). Solo cuenta el estado ACTIVO: un PENDIENTE es una solicitud
   * que nadie ha aprobado y no puede ver ni un peso.
   *
   * Se comprueba además que la cuenta siga viva: autorizar a un familiar no puede
   * sobrevivir a la baja del abonado.
   */
  private async resolveAutorizado(digits: string): Promise<AgentUser | null> {
    const c = await this.prisma.subscriberContact
      .findUnique({
        where: { phone: digits },
        select: {
          status: true, name: true, relation: true,
          subscriber: {
            select: {
              id: true, abonado: true, status: true,
              fullName: true, firstName: true, lastName1: true, companyName: true,
            },
          },
        },
      })
      .catch((e: Error) => {
        this.logger.warn(`No se pudo buscar el número autorizado: ${e.message}`);
        return null;
      });

    if (!c || c.status !== 'ACTIVO') return null;
    if (DEAD_STATUS.has(c.subscriber.status ?? '')) {
      this.logger.warn(`El número ${digits} está autorizado en una cuenta ${c.subscriber.status}; se atiende como público.`);
      return null;
    }

    const titular =
      c.subscriber.fullName?.trim() ||
      [c.subscriber.firstName, c.subscriber.lastName1].filter(Boolean).join(' ').trim() ||
      c.subscriber.companyName?.trim() ||
      'el titular';

    // El nombre que ve el agente es el del AUTORIZADO, no el del titular: saludar
    // "Hola Pedro" a la hija de Pedro es raro y además revela quién es el titular a
    // quien quizá solo sepa el número de abonado.
    return this.agentUser(c.subscriber.id, c.name?.trim() || 'Autorizado', [CHAT_CLIENTE_PERMISSION], {
      kind: 'cliente',
      subscriberId: c.subscriber.id,
      abonado: c.subscriber.abonado,
      autorizado: { nombre: c.name?.trim() || null, relacion: c.relation?.trim() || null, titular },
    });
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
   * final del número, y solo se resuelve si el resultado es UNA persona viva e
   * inequívoca — ambigüedad o solo-muertos degradan al agente público.
   */
  private async resolveCliente(digits: string): Promise<AgentUser | null> {
    const last10 = digits.slice(-10);
    if (last10.length < 10) return null;

    const rows = await this.candidatos(last10);
    const exact = rows.filter(
      (r) => this.endsWith(r.phone1, last10) || this.endsWith(r.phone2, last10),
    );
    if (!exact.length) return null;

    // Solo cuentas vivas: un DEPURADO/RETIRADO no debe recibir datos de cuenta.
    // Y si el teléfono apunta a varias personas distintas (hay miles de last-10
    // duplicados y números reciclados en el legacy), NO se adivina: se atiende
    // como público antes que arriesgar el saldo/factura de otro (Habeas Data).
    // Varios registros con la MISMA cédula sí son la misma persona duplicada.
    const vivos = exact.filter((r) => !DEAD_STATUS.has(r.status ?? ''));
    if (!vivos.length) {
      this.logger.warn(`El teléfono ${last10} solo calza con cuentas muertas (${exact.length}); se atiende como público.`);
      return null;
    }
    const docs = new Set(vivos.map((r) => r.docNumber?.trim() || `sin-doc:${r.id}`));
    if (docs.size > 1) {
      this.logger.warn(`El teléfono ${last10} apunta a ${vivos.length} abonados vivos con identidad distinta; se atiende como público.`);
      return null;
    }
    const chosen = vivos[0];

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

  /**
   * Número desconocido que pasó la validación de identidad (ver ChatAccessService).
   * El nivel viaja en la identidad para que el toolset de clientes sepa qué NO
   * ofrecerle: con acceso básico no se le da el PDF de la factura ni los pagos.
   */
  private async resolveVerificado(digits: string): Promise<AgentUser | null> {
    const v = await this.access.vigente(digits);
    if (!v?.subscriber) return null;

    const s = v.subscriber;
    const titular = s.fullName?.trim()
      || [s.firstName, s.lastName1].filter(Boolean).join(' ').trim()
      || s.companyName?.trim()
      || 'el titular';

    return this.agentUser(s.id, titular, [CHAT_CLIENTE_PERMISSION], {
      kind: 'cliente',
      subscriberId: s.id,
      abonado: s.abonado,
      acceso: v.nivel === 'COMPLETO' ? 'completo' : 'basico',
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
          docNumber: true,
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
