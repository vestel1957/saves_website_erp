import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomInt } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsappService } from '../common/whatsapp/whatsapp.service';
import { normalizePhone } from '../common/phone.util';

/** Cuánto dura una verificación antes de volver a pedirla. Un celular prestado no puede quedar abierto para siempre. */
const VIGENCIA_H = 12;
/** Intentos de datos antes de bloquear el número: sin freno se pueden tantear cédulas. */
const MAX_INTENTOS = 3;
const BLOQUEO_H = 24;
/** El código vive poco: es una prueba de posesión, no una contraseña. */
const OTP_MIN = 10;
const OTP_MAX_INTENTOS = 3;

/** Sin tildes, sin dobles espacios y en mayúsculas, para comparar nombres del legacy. */
function normalizar(txt: string): string {
  return txt.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Palabras del nombre que sirven para comparar (se van las partículas y las iniciales). */
function tokens(nombre: string): string[] {
  const fuera = new Set(['DE', 'DEL', 'LA', 'LAS', 'LOS', 'Y', 'SAS', 'SA', 'LTDA']);
  return normalizar(nombre).split(' ').filter((t) => t.length >= 3 && !fuera.has(t));
}

const sha = (v: string) => createHash('sha256').update(v).digest('hex');

/**
 * Verificación de identidad para números desconocidos.
 *
 * Existe porque la vía fuerte —que el titular autorice el número desde su propio
 * WhatsApp— no siempre se puede: hay titulares mayores sin WhatsApp, de viaje o
 * fallecidos, y su hijo igual necesita reportar que no hay internet.
 *
 * El acceso va por NIVELES, y el motivo es que los tres datos que se piden (documento,
 * nombre y teléfono del titular) **están impresos en la factura**: quien recoja un
 * recibo del andén los tiene. Por eso acertarlos habilita solo lo que no hace daño si
 * resultó ser la persona equivocada, y todo lo que expone la cuenta —el PDF con la
 * dirección, los pagos, los cambios— exige además el código que se manda al WhatsApp
 * del titular, que sí prueba tener ese teléfono en la mano.
 */
@Injectable()
export class ChatAccessService {
  private readonly logger = new Logger('ChatAccess');

  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsapp: WhatsappService,
  ) {}

  /** Verificación vigente de un número, o null. Una caducada no vale. */
  async vigente(phone: string) {
    const v = await this.prisma.chatAccessVerification
      .findUnique({ where: { phone }, include: { subscriber: { select: { id: true, abonado: true, status: true, fullName: true, firstName: true, lastName1: true, companyName: true } } } })
      .catch(() => null);
    if (!v || v.nivel === 'NINGUNO' || !v.subscriber) return null;
    if (v.expiraAt && v.expiraAt.getTime() < Date.now()) return null;
    if (['DEPURADO', 'RETIRADO'].includes(v.subscriber.status ?? '')) return null;
    return v;
  }

  /**
   * Valida los tres datos contra UNA cuenta viva. Los tres tienen que apuntar al
   * mismo abonado: acertar dos de tres no abre nada.
   *
   * El mensaje de error es siempre el mismo ("no coinciden"), sin decir cuál falló:
   * si dijera "el documento sí pero el teléfono no", se podría ir afinando por partes.
   */
  async validarDatos(phone: string, datos: { documento: string; nombre: string; telefonoTitular: string }) {
    const bloqueo = await this.bloqueado(phone);
    if (bloqueo) return { ok: false as const, error: `Por seguridad este número quedó bloqueado para validar identidad. Vuelve a intentarlo ${bloqueo}.` };

    const doc = String(datos.documento ?? '').replace(/\D/g, '');
    const telTitular = normalizePhone(datos.telefonoTitular);
    const last10 = telTitular?.slice(-10) ?? '';
    if (!doc || !last10 || !datos.nombre?.trim()) {
      return { ok: false as const, error: 'Necesito los tres datos: número de documento del titular, su nombre completo y el celular que tiene registrado con nosotros.' };
    }

    const candidatos = await this.prisma.subscriber.findMany({
      where: { docNumber: doc, status: { notIn: ['DEPURADO', 'RETIRADO'] } },
      select: { id: true, abonado: true, phone1: true, phone2: true, fullName: true, firstName: true, lastName1: true, companyName: true },
      take: 10,
    });

    const casaTelefono = (s: { phone1: string | null; phone2: string | null }) =>
      [s.phone1, s.phone2].some((p) => {
        const d = (p ?? '').replace(/\D/g, '');
        return d.length >= 10 && d.endsWith(last10);
      });

    const casaNombre = (s: { fullName: string | null; firstName: string | null; lastName1: string | null; companyName: string | null }) => {
      const guardado = tokens(s.fullName || [s.firstName, s.lastName1].filter(Boolean).join(' ') || s.companyName || '');
      const dado = new Set(tokens(datos.nombre));
      if (!guardado.length || !dado.size) return false;
      const comunes = guardado.filter((t) => dado.has(t));
      // Al menos dos palabras en común y la mayoría del nombre guardado: así entra
      // "Jose Rubio" contra "JOSE ANTONIO RUBIO PEREZ", pero no un apellido suelto.
      return comunes.length >= 2 && comunes.length / guardado.length >= 0.5;
    };

    const acierto = candidatos.find((s) => casaTelefono(s) && casaNombre(s));
    if (!acierto) {
      const intentos = await this.fallo(phone);
      const restantes = Math.max(0, MAX_INTENTOS - intentos);
      return {
        ok: false as const,
        error: restantes > 0
          ? `Esos datos no coinciden con ninguna cuenta. Te quedan ${restantes} intento(s).`
          : `Esos datos no coinciden. Por seguridad este número queda bloqueado ${BLOQUEO_H} horas para validar identidad.`,
      };
    }

    const ahora = new Date();
    await this.prisma.chatAccessVerification.upsert({
      where: { phone },
      create: { phone, subscriberId: acierto.id, nivel: 'BASICO', verificadoAt: ahora, expiraAt: new Date(ahora.getTime() + VIGENCIA_H * 3600_000) },
      update: { subscriberId: acierto.id, nivel: 'BASICO', verificadoAt: ahora, expiraAt: new Date(ahora.getTime() + VIGENCIA_H * 3600_000), intentos: 0, bloqueadoHasta: null },
    });
    this.logger.log(`Número ${phone} verificado por DATOS sobre el abonado ${acierto.abonado} (acceso básico).`);
    return { ok: true as const, subscriberId: acierto.id, abonado: acierto.abonado };
  }

  /**
   * Manda al WhatsApp del titular un código de 6 dígitos. Es el paso que sube de
   * básico a completo.
   *
   * Se envía SIN plantilla a propósito: si la ventana de 24 h está cerrada no se
   * fuerza —una plantilla la dispara aquí un desconocido y se paga— y se le dice al
   * que pregunta que el titular tiene que escribirnos primero.
   */
  async pedirCodigo(phone: string) {
    const v = await this.vigente(phone);
    if (!v?.subscriberId) return { ok: false as const, error: 'Primero hay que validar los datos de la cuenta.' };

    const sub = await this.prisma.subscriber.findUnique({ where: { id: v.subscriberId }, select: { phone1: true, phone2: true } });
    const titular = normalizePhone(sub?.phone1) ?? normalizePhone(sub?.phone2);
    if (!titular) return { ok: false as const, error: 'Esa cuenta no tiene un celular registrado al cual mandar el código.' };

    const codigo = String(randomInt(100_000, 1_000_000));
    await this.prisma.chatAccessVerification.update({
      where: { phone },
      data: { otpHash: sha(codigo), otpExpiraAt: new Date(Date.now() + OTP_MIN * 60_000), otpIntentos: 0 },
    });

    const enviado = await this.whatsapp.sendText(
      titular,
      `Código de verificación: ${codigo}\n\nAlguien desde el número ${phone} está pidiendo gestionar tu cuenta de internet. ` +
      `Dale este código SOLO si lo conoces y quieres que lo haga. Vence en ${OTP_MIN} minutos.`,
    );
    if (!enviado) {
      return {
        ok: false as const,
        error: 'No pude mandarle el código al titular por WhatsApp en este momento. Pídele que él nos escriba primero a este número y ahí sí se lo enviamos.',
      };
    }
    // El teléfono del titular se devuelve enmascarado: sirve para que quien pide
    // sepa a qué celular mirar, sin revelárselo si no lo conocía.
    return { ok: true as const, destino: `••••${titular.slice(-4)}` };
  }

  /** Confirma el código y sube a acceso completo. */
  async confirmarCodigo(phone: string, codigo: string) {
    const v = await this.prisma.chatAccessVerification.findUnique({ where: { phone } });
    if (!v?.otpHash || !v.otpExpiraAt) return { ok: false as const, error: 'No hay ningún código pendiente. Pide uno nuevo.' };
    if (v.otpExpiraAt.getTime() < Date.now()) return { ok: false as const, error: 'Ese código ya venció. Pide uno nuevo.' };
    if (v.otpIntentos >= OTP_MAX_INTENTOS) return { ok: false as const, error: 'Demasiados intentos con el código. Pide uno nuevo.' };

    if (sha(String(codigo ?? '').replace(/\D/g, '')) !== v.otpHash) {
      await this.prisma.chatAccessVerification.update({ where: { phone }, data: { otpIntentos: { increment: 1 } } });
      return { ok: false as const, error: 'Ese código no es. Revísalo e inténtalo otra vez.' };
    }

    const ahora = new Date();
    await this.prisma.chatAccessVerification.update({
      where: { phone },
      data: { nivel: 'COMPLETO', verificadoAt: ahora, expiraAt: new Date(ahora.getTime() + VIGENCIA_H * 3600_000), otpHash: null, otpExpiraAt: null, otpIntentos: 0 },
    });
    this.logger.log(`Número ${phone} verificado por CÓDIGO del titular (acceso completo).`);
    return { ok: true as const };
  }

  /** ¿Está bloqueado? Devuelve el texto de cuándo se libera, o null. */
  private async bloqueado(phone: string): Promise<string | null> {
    const v = await this.prisma.chatAccessVerification.findUnique({ where: { phone }, select: { bloqueadoHasta: true } });
    if (!v?.bloqueadoHasta || v.bloqueadoHasta.getTime() < Date.now()) return null;
    const horas = Math.ceil((v.bloqueadoHasta.getTime() - Date.now()) / 3600_000);
    return `en ${horas} hora(s)`;
  }

  /** Suma un intento fallido y bloquea al llegar al tope. */
  private async fallo(phone: string): Promise<number> {
    const v = await this.prisma.chatAccessVerification.upsert({
      where: { phone },
      create: { phone, intentos: 1 },
      update: { intentos: { increment: 1 } },
      select: { intentos: true },
    });
    if (v.intentos >= MAX_INTENTOS) {
      await this.prisma.chatAccessVerification.update({
        where: { phone },
        data: { bloqueadoHasta: new Date(Date.now() + BLOQUEO_H * 3600_000), intentos: 0 },
      });
      this.logger.warn(`Número ${phone} BLOQUEADO ${BLOQUEO_H} h por fallar la validación de identidad.`);
    }
    return v.intentos;
  }
}
