import { Logger } from '../core/logger';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsappService } from '../common/whatsapp/whatsapp.service';
import { normalizePhone } from '../common/phone.util';

/** Nombre legible del abonado, con los mismos respaldos que usa el resto del ERP. */
function nombreDe(s: { fullName?: string | null; firstName?: string | null; lastName1?: string | null; companyName?: string | null }): string {
  return s.fullName?.trim()
    || [s.firstName, s.lastName1].filter(Boolean).join(' ').trim()
    || s.companyName?.trim()
    || 'el titular';
}

/**
 * Números autorizados a gestionar la cuenta de un abonado.
 *
 * Resuelve una deuda real del canal: el bot reconoce al cliente por el teléfono de su
 * ficha, así que cuando escribe el hijo, la esposa o quien paga el arriendo, cae en el
 * agente público y no puede ni ver la factura de su propia casa. La salida NO es
 * aceptar una cédula por chat —no hay forma de verificarla y la cédula circula por
 * todas partes— sino que el TITULAR autorice el número desde su propio WhatsApp: eso
 * sí prueba que quien autoriza tiene el celular registrado en la cuenta.
 *
 * Un número PENDIENTE no da acceso a nada. La solicitud le llega al titular por
 * WhatsApp, y mientras no la apruebe, quien pidió sigue siendo un desconocido.
 */
export class SubscriberContactsService {
  private readonly logger = new Logger('ContactosAbonado');

  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsapp: WhatsappService,
  ) {}

  /** Números vinculados a una cuenta (activos y pendientes), para mostrárselos al titular. */
  list(subscriberId: string) {
    return this.prisma.subscriberContact.findMany({
      where: { subscriberId, status: { in: ['ACTIVO', 'PENDIENTE'] } },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    });
  }

  /**
   * Autoriza (o reactiva) un número. `aprobadoPor` queda guardado para poder responder
   * después "¿quién le dio acceso a este número?".
   *
   * El `upsert` por teléfono es deliberado: si el número ya estaba pedido o revocado,
   * se reutiliza la fila en vez de dejar duplicados que luego confundan el rastro.
   */
  async autorizar(subscriberId: string, rawPhone: string, datos: { nombre?: string; relacion?: string; aprobadoPor: string }) {
    const phone = normalizePhone(rawPhone);
    if (!phone || !/^\d{10,15}$/.test(phone)) {
      return { ok: false as const, error: 'Ese número no parece válido. Pásamelo completo, ej. 3001234567.' };
    }

    // Un celular gestiona UNA cuenta: si ya está autorizado en otra, hay que
    // resolverlo a mano. Silenciarlo dejaría a alguien viendo la cuenta equivocada.
    const existente = await this.prisma.subscriberContact.findUnique({
      where: { phone },
      select: { subscriberId: true, status: true },
    });
    if (existente && existente.subscriberId !== subscriberId && existente.status === 'ACTIVO') {
      return { ok: false as const, error: 'Ese número ya está autorizado en otra cuenta. Habla con nosotros para revisarlo.' };
    }

    // Tampoco tiene sentido autorizar el teléfono que YA es el de la ficha.
    const dueño = await this.prisma.subscriber.findFirst({
      where: { id: subscriberId, OR: [{ phone1: { contains: phone.slice(-10) } }, { phone2: { contains: phone.slice(-10) } }] },
      select: { id: true },
    });
    if (dueño) return { ok: false as const, error: 'Ese número ya es el de la cuenta: no hace falta autorizarlo.' };

    const row = await this.prisma.subscriberContact.upsert({
      where: { phone },
      create: {
        subscriberId, phone, name: datos.nombre ?? null, relation: datos.relacion ?? null,
        status: 'ACTIVO', approvedBy: datos.aprobadoPor, approvedAt: new Date(),
      },
      update: {
        subscriberId, status: 'ACTIVO', approvedBy: datos.aprobadoPor, approvedAt: new Date(),
        ...(datos.nombre ? { name: datos.nombre } : {}),
        ...(datos.relacion ? { relation: datos.relacion } : {}),
      },
    });
    this.logger.log(`Número ${phone} AUTORIZADO en la cuenta ${subscriberId} por ${datos.aprobadoPor}.`);

    // Se le avisa al autorizado: si no, tendría que adivinar que ya puede escribir.
    void this.whatsapp.sendText(
      phone,
      'Hola. Ya puedes consultar y gestionar por este WhatsApp la cuenta de internet a la que te autorizaron. ' +
      'Escríbenos cuando necesites algo.',
    );
    return { ok: true as const, contacto: row };
  }

  /** Quita el acceso. Se conserva la fila (REVOCADO) para no perder el rastro. */
  async revocar(subscriberId: string, rawPhone: string) {
    const phone = normalizePhone(rawPhone) ?? '';
    const row = await this.prisma.subscriberContact.findFirst({ where: { phone, subscriberId } });
    if (!row) return { ok: false as const, error: 'Ese número no está autorizado en tu cuenta.' };
    await this.prisma.subscriberContact.update({ where: { id: row.id }, data: { status: 'REVOCADO' } });
    this.logger.log(`Número ${phone} REVOCADO de la cuenta ${subscriberId}.`);
    return { ok: true as const };
  }

  /**
   * Alguien pide, desde un número desconocido, que lo dejen gestionar una cuenta.
   *
   * No entrega NADA: solo deja la solicitud en PENDIENTE y se la manda al titular por
   * WhatsApp. Y responde igual exista o no el abonado —"si el número existe, le
   * avisamos"— porque contestar "ese abonado no existe" convierte el bot en un
   * comprobador gratuito de números de cuenta ajenos.
   */
  async solicitar(abonado: number, phone: string, datos: { nombre?: string; relacion?: string }) {
    const sub = await this.prisma.subscriber.findFirst({
      where: { abonado, status: { notIn: ['DEPURADO', 'RETIRADO'] } },
      select: { id: true, phone1: true, phone2: true, fullName: true, firstName: true, lastName1: true, companyName: true },
    });
    if (!sub) return { ok: true as const, avisado: false };

    // Un mismo desconocido no puede volver a pedir lo mismo cada rato: sin esto, el
    // titular recibiría un aviso por cada intento. Si ya hay una solicitud reciente
    // de ese número, se acepta en silencio y no se vuelve a molestar a nadie.
    const yaPidio = await this.prisma.subscriberContact.findFirst({
      where: { phone, status: 'PENDIENTE', createdAt: { gt: new Date(Date.now() - 24 * 3600_000) } },
      select: { id: true },
    });
    if (yaPidio) return { ok: true as const, avisado: false };

    await this.prisma.subscriberContact.upsert({
      where: { phone },
      create: {
        subscriberId: sub.id, phone, name: datos.nombre ?? null, relation: datos.relacion ?? null,
        status: 'PENDIENTE', note: `Solicitado desde WhatsApp el ${new Date().toLocaleDateString('es-CO')}`,
      },
      // Una solicitud NO puede pisar una autorización ya dada ni resucitar una
      // revocada: si la fila ya existe y no está pendiente, se deja como está.
      update: {},
    });

    const titular = normalizePhone(sub.phone1) ?? normalizePhone(sub.phone2);
    if (!titular) return { ok: true as const, avisado: false };

    const quien = [datos.nombre, datos.relacion && `(${datos.relacion})`].filter(Boolean).join(' ') || 'Alguien';

    // SIN `reopenWithTemplate`, a propósito y a diferencia del resto del bot.
    //
    // Quien dispara esto es un DESCONOCIDO que solo tecleó un número de abonado. Si
    // se le permitiera reabrir la ventana de 24 h con una plantilla, cualquiera
    // podría hacerle sonar el WhatsApp a un cliente cuantas veces quiera —y cada
    // plantilla, además, se paga—. Así que al titular se le avisa únicamente si ya
    // hay una conversación abierta con él; si no, la solicitud queda PENDIENTE y la
    // ve cuando él mismo escriba, o la resuelve un funcionario desde el ERP.
    const enviado = await this.whatsapp.sendText(
      titular,
      `Hola ${nombreDe(sub)}. ${quien} pidió, desde el número ${phone}, poder consultar y gestionar tu cuenta de internet por WhatsApp.\n\n` +
      `Si lo autorizas, respóndenos por aquí: "autoriza el ${phone}". Si no lo reconoces, ignora este mensaje: sin tu autorización ese número no puede ver nada de tu cuenta.`,
    );
    return { ok: true as const, avisado: enviado };
  }

  /** Solicitudes que esperan el sí del titular. */
  pendientes(subscriberId: string) {
    return this.prisma.subscriberContact.findMany({
      where: { subscriberId, status: 'PENDIENTE' },
      orderBy: { createdAt: 'desc' },
    });
  }
}
