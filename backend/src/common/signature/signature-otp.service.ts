import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { randomInt } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { hashPassword, verifyPassword } from '../../auth/crypto.util';
import { isValidPhone, normalizePhone } from '../phone.util';

/** Gate de envío REAL. Apagado ⇒ el código no sale por WhatsApp (modo simulación). */
export const SIGN_OTP_LIVE_KEY = 'signature.otpLive';
/** ¿Las firmas exigen código? Apagado ⇒ se aprueba como antes (válvula de escape). */
export const SIGN_OTP_REQUIRED_KEY = 'signature.otpRequired';
/**
 * ¿Cambiar una contraseña exige código? Llave aparte de `signature.otpRequired`
 * a propósito: son dos riesgos distintos —aprobar un gasto y apoderarse de una
 * cuenta— y el día que haya que apagar uno no se quiere apagar el otro sin darse
 * cuenta. El envío sí es el mismo interruptor (`signature.otpLive`).
 */
export const PASSWORD_OTP_REQUIRED_KEY = 'security.passwordOtpRequired';
/**
 * ¿Los códigos de CONTRASEÑA salen de verdad? Sin fijar, hereda `signature.otpLive`.
 *
 * Existe porque los dos envíos no se pueden encender a la vez sin daño colateral:
 * mientras la plantilla `codigo_firma` no esté aprobada, un código solo se entrega
 * si la ventana de 24 h con esa persona está abierta, y en una firma eso significa
 * que quien no le haya escrito al bot hoy **no puede aprobar** (el envío falla y la
 * operación se cae). En un cambio de contraseña la cuenta es distinta: quien no
 * reciba el código se queda como estaba, pero el que sí lo recibe —que son los que
 * conversan con el bot— ya tiene protección real. Así se enciende donde sirve sin
 * frenar las compras.
 */
export const PASSWORD_OTP_LIVE_KEY = 'security.passwordOtpLive';

/**
 * Qué se está firmando. Cada propósito es un cajón aparte: un código de una orden no
 * sirve para otra, y el de la salida de una transferencia no sirve para su entrada.
 */
export type SignaturePurpose =
  | 'purchase.approve'
  | 'profile.verify'
  /** Salida de equipo entre sedes: la firma la cajera encargada de la sede origen. */
  | 'equipment.dispatch'
  /** Entrada de equipo entre sedes: la firma quien lo recibe en la sede destino. */
  | 'equipment.receive'
  /** Acta de traspaso de material: la firma el encargado de la bodega que recibe. */
  | 'material.receive'
  /**
   * Cambio de la PROPIA contraseña (/perfil). El código va al WhatsApp del mismo
   * que la está cambiando.
   */
  | 'password.change'
  /**
   * Un administrador le restablece la contraseña a un funcionario. Ojo: aquí el
   * `userId` del código es el DUEÑO DE LA CUENTA, no el administrador — el código
   * le llega al funcionario y él se lo dicta a quien lo está atendiendo, que es lo
   * que hace que nadie pueda apropiarse de una cuenta ajena a sus espaldas.
   */
  | 'password.reset'
  /**
   * "Olvidé mi contraseña" desde la pantalla de ingreso. Sin sesión: el código
   * al WhatsApp vinculado ES la única prueba de que quien lo pide es el dueño,
   * así que aquí NUNCA es opcional (el ajuste `security.passwordOtpRequired` no
   * lo gobierna).
   */
  | 'password.forgot';

/**
 * Plantilla aprobada en Meta para mandar el código cuando la ventana de 24 h está
 * cerrada (que es lo normal: un autorizador de compras no le escribe al bot todos
 * los días). Variables: {{1}} qué se firma, {{2}} el código.
 *
 * Se crea desde /configuracion/whatsapp con este cuerpo:
 *   "Tu código para firmar {{1}} es {{2}} — vence en 5 minutos. Si no estabas
 *    firmando nada, ignóralo y avisa a sistemas."
 */
const PLANTILLA = {
  name: process.env.WA_SIGN_OTP_TEMPLATE ?? 'codigo_firma',
  language: process.env.WA_SIGN_OTP_TEMPLATE_LANG ?? 'es',
};

/**
 * El código vive poco: prueba que tienes el teléfono, no es una contraseña.
 *
 * 10 y no 5 minutos porque los 5 se medían desde que SALE, no desde que llega:
 * entre lo que tarda la pasarela y lo que tarda Meta en empujarlo al teléfono, a
 * quien tenía mala señal se le vencía mientras lo tecleaba. Con 5 intentos sobre
 * un millón de combinaciones, el doble de ventana no cambia nada del riesgo.
 */
const TTL_MIN = 10;
/** Intentos por código antes de quemarlo (después hay que pedir otro). */
const MAX_INTENTOS = 5;
/**
 * Espera entre envíos del mismo código: frena el doble clic y el gasto de
 * plantillas. 30 s es lo que aguanta alguien que no vio llegar nada antes de
 * volver a pulsar; más arriba, vuelve a pedirlo por otro lado.
 */
const REENVIO_S = 30;
/** Tope diario por persona. Cada plantilla se paga y la línea es TIER_250. */
const TOPE_DIARIO = 30;

type Solicitud = {
  userId: string;
  purpose: SignaturePurpose;
  /** Id de lo que se firma (la orden). null en la prueba del perfil, que no firma nada. */
  targetId?: string | null;
  /** Qué se firma, en prosa y corto: va dentro del WhatsApp ("la orden de compra #1042 por $1.200.000"). */
  detalle: string;
  /**
   * Cómo se le habla al dueño del teléfono. Por defecto está firmando algo; con
   * `'password'` el mensaje deja de hablar de firmas y dice lo único que importa
   * ahí: que le están cambiando la contraseña, y qué hacer si no era él.
   */
  accion?: 'firma' | 'password';
};

export type SignatureOtpEstado = {
  channel: 'whatsapp';
  /** Teléfono en claro solo si es el que puso el propio usuario (es su dato). */
  phone: string | null;
  phoneMask: string | null;
  /** De dónde sale el número: el que definió el usuario o el que sistemas le vinculó al chatbot. */
  source: 'propio' | 'whatsapp-vinculado' | null;
  verifiedAt: Date | null;
  /** ¿Las firmas están exigiendo código ahora mismo? */
  required: boolean;
  /** false ⇒ modo simulación: el código no sale por WhatsApp y se muestra en pantalla. */
  live: boolean;
  /** ¿Kapso está configurado? Sin esto, `live` no puede entregar nada. */
  whatsappEnabled: boolean;
  /** Lo que hoy pide firma (para que el perfil lo explique sin adivinar). */
  firmaExigidaEn: string[];
};

/**
 * Código de un solo uso para FIRMAR una operación crítica.
 *
 * El problema que resuelve: la sesión abierta ES la firma. Un portátil sin
 * bloquear en la oficina bastaba para aprobar una orden de compra a nombre de
 * gerencia, y la doble firma por monto no ayudaba —el rastro decía dos nombres,
 * pero nadie había demostrado estar ahí—. El código lo manda el sistema al
 * WhatsApp del firmante: para firmar hay que tener el teléfono en la mano.
 *
 * Decisiones que conviene no deshacer sin pensarlas:
 *
 *  · **El código no se guarda.** Va hasheado con scrypt (el mismo `hashPassword`
 *    de las contraseñas) y no con un sha256 pelado como el OTP del chatbot: son
 *    seis dígitos, y un sha256 de seis dígitos se rompe en un pestañeo con la
 *    tabla delante. Cuesta ~100 ms por verificación, que es exactamente el
 *    precio que se quiere pagar aquí.
 *
 *  · **El código está atado al usuario, al propósito y al objeto.** El de la
 *    orden A no firma la orden B, y el de la prueba del perfil no firma nada.
 *
 *  · **Las filas no se borran al consumirse.** Son el rastro de la firma: a qué
 *    número salió, cuándo, cuántos intentos costó y si fue en simulación.
 *
 *  · **`live` apagado ⇒ simulación.** No hay envío y el código se le devuelve a
 *    quien lo pidió, para poder recorrer el flujo completo sin plantilla
 *    aprobada ni gastar cuota. Se le enseña como lo que es —un modo de pruebas—
 *    y la firma queda marcada `simulated` en la bitácora.
 */
@Injectable()
export class SignatureOtpService {
  private readonly logger = new Logger('SignatureOtp');

  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsapp: WhatsappService,
  ) {}

  /** ¿Kapso está configurado? Sin esto, `live` no puede entregar nada. */
  get whatsappEnabled(): boolean {
    return this.whatsapp.enabled;
  }

  // ── Configuración ──────────────────────────────────────────────────────────
  // Mismo patrón que el resto del ERP: el ajuste guardado manda y el env es el
  // valor por defecto.

  async config(): Promise<{ live: boolean; required: boolean; passwordRequired: boolean; passwordLive: boolean }> {
    const rows = await this.prisma.appSetting.findMany({
      where: { key: { in: [SIGN_OTP_LIVE_KEY, SIGN_OTP_REQUIRED_KEY, PASSWORD_OTP_REQUIRED_KEY, PASSWORD_OTP_LIVE_KEY] } },
      select: { key: true, value: true },
    });
    const val = (k: string) => rows.find((r) => r.key === k)?.value ?? null;
    const bool = (v: string | null, pordefecto: boolean) =>
      v === 'true' || v === 'false' ? v === 'true' : pordefecto;
    const live = bool(val(SIGN_OTP_LIVE_KEY), process.env.SIGN_OTP_LIVE === 'true');
    return {
      live,
      // Sin fijar hereda el de las firmas: encender solo éste es una decisión
      // explícita, no un descuido de configuración.
      passwordLive: bool(val(PASSWORD_OTP_LIVE_KEY), process.env.PASSWORD_OTP_LIVE === 'true' || live),
      // Exigido por defecto: es el punto de la función. Se puede apagar por ajuste
      // si un día hay que aprobar con el WhatsApp caído.
      required: bool(val(SIGN_OTP_REQUIRED_KEY), process.env.SIGN_OTP_REQUIRED !== 'false'),
      passwordRequired: bool(val(PASSWORD_OTP_REQUIRED_KEY), process.env.PASSWORD_OTP_REQUIRED !== 'false'),
    };
  }

  // ── El teléfono del firmante ────────────────────────────────────────────────

  /**
   * A qué número le llegan los códigos de esta persona.
   *
   * `signaturePhone` es el que define el propio usuario en su perfil. Si no puso
   * ninguno se hereda `whatsappPhone`, el que sistemas le vinculó al chatbot:
   * ese número ya está probado (por ahí conversa con el bot heredando sus
   * permisos), así que exigirle además que lo reescriba solo conseguiría que
   * nadie pudiera aprobar el día que esto se encienda.
   */
  async telefono(userId: string): Promise<{ phone: string | null; source: 'propio' | 'whatsapp-vinculado' | null; verifiedAt: Date | null }> {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { signaturePhone: true, signaturePhoneVerifiedAt: true, whatsappPhone: true },
    });
    if (u?.signaturePhone) return { phone: u.signaturePhone, source: 'propio', verifiedAt: u.signaturePhoneVerifiedAt };
    if (u?.whatsappPhone) return { phone: u.whatsappPhone, source: 'whatsapp-vinculado', verifiedAt: null };
    return { phone: null, source: null, verifiedAt: null };
  }

  /** Enmascara el número: sirve para saber a qué celular mirar sin publicarlo entero. */
  static mask(phone: string | null): string | null {
    return phone ? `••• ••• ${phone.slice(-4)}` : null;
  }

  /** Estado completo para la tarjeta de /perfil ▸ Seguridad. */
  async estado(userId: string): Promise<SignatureOtpEstado> {
    const [{ live, required, passwordRequired }, tel] = await Promise.all([this.config(), this.telefono(userId)]);
    return {
      channel: 'whatsapp',
      // El número propio se devuelve entero (es suyo y lo tiene que poder corregir);
      // el heredado del chatbot va enmascarado, que lo administra sistemas.
      phone: tel.source === 'propio' ? tel.phone : null,
      phoneMask: SignatureOtpService.mask(tel.phone),
      source: tel.source,
      verifiedAt: tel.verifiedAt,
      required,
      live,
      whatsappEnabled: this.whatsapp.enabled,
      firmaExigidaEn: [
        ...(required
          ? [
              'Aprobar órdenes de compra (1ª y 2ª firma)',
              'Transferencias de equipos entre sedes (firma de salida y de recepción)',
              'Recibir un traspaso de material (acta)',
            ]
          : []),
        ...(passwordRequired
          ? ['Cambiar tu contraseña — y que te la restablezcan: el código llega a TU WhatsApp, aunque lo haga sistemas']
          : []),
      ],
    };
  }

  /**
   * Cambia el número al que llegan los códigos. Deja de estar verificado: el
   * sello dice "se comprobó que ESTE número recibe", y al cambiarlo ya no se
   * comprobó nada. Los códigos vivos se queman, para que uno pedido al número
   * anterior no sirva después del cambio.
   */
  async setTelefono(userId: string, raw: string) {
    const phone = normalizePhone(raw);
    if (!isValidPhone(phone)) {
      throw new BadRequestException('Ese teléfono no parece válido. Escribe el celular a 10 dígitos (ej. 3001112233).');
    }
    // Sin exigir móvil colombiano: WhatsApp Business también entrega a números
    // de otros países, y algún encargado puede estar fuera.
    await this.prisma.user.update({
      where: { id: userId },
      data: { signaturePhone: phone, signaturePhoneVerifiedAt: null },
    });
    await this.quemarPendientes(userId);
    this.logger.log(`Usuario ${userId} cambió su teléfono de firma a ••••${phone!.slice(-4)}.`);
    return this.estado(userId);
  }

  /** Quita el número propio: se vuelve al vinculado del chatbot si lo hay. */
  async borrarTelefono(userId: string) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { signaturePhone: null, signaturePhoneVerifiedAt: null },
    });
    await this.quemarPendientes(userId);
    return this.estado(userId);
  }

  /** Invalida los códigos vivos de un usuario (cambio de número, o de contraseña). */
  private async quemarPendientes(userId: string) {
    await this.prisma.signatureOtp.updateMany({
      where: { userId, consumedAt: null, expiresAt: { gt: new Date() } },
      data: { expiresAt: new Date() },
    });
  }

  // ── Pedir el código ────────────────────────────────────────────────────────

  /**
   * Genera un código, lo manda al WhatsApp del firmante y devuelve a dónde salió.
   *
   * Lanza si no hay a dónde mandarlo o si el envío falla: si el código no llegó,
   * no se puede dejar al usuario mirando un recuadro de seis casillas que nunca
   * va a poder llenar.
   */
  async pedir(s: Solicitud) {
    // Cronómetro de todo el camino. No es adorno: cuando alguien dice "el código
    // tardó", la única forma de saber si la culpa es nuestra o de la entrega de
    // Meta es tener los dos números separados en el log.
    const t0 = Date.now();
    const targetId = s.targetId ?? null;
    const ahora = new Date();
    const desdeHoy = new Date(ahora.getTime() - 24 * 3600_000);

    // Las cuatro consultas previas son independientes entre sí: en serie eran
    // cuatro idas y vueltas a la base delante del envío, y el usuario las espera
    // todas mirando el WhatsApp.
    const [cfg, tel, ultimo, delDia] = await Promise.all([
      this.config(),
      this.telefono(s.userId),
      this.prisma.signatureOtp.findFirst({
        where: { userId: s.userId, purpose: s.purpose, targetId },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.signatureOtp.count({ where: { userId: s.userId, createdAt: { gte: desdeHoy } } }),
    ]);
    // Cada tipo de código tiene su interruptor de envío: las contraseñas se
    // pueden encender antes que las firmas (ver `PASSWORD_OTP_LIVE_KEY`).
    //
    // La prueba del perfil sale de verdad si CUALQUIERA de los dos está
    // encendido: no es una operación que se pueda quedar bloqueada, es la única
    // forma que tiene alguien de comprobar que su celular recibe. Con los gates
    // separados, atarla solo al de firmas dejaba a quien va a recibir códigos de
    // contraseña sin poder probar nada.
    const live =
      s.accion === 'password' ? cfg.passwordLive
      : s.purpose === 'profile.verify' ? cfg.live || cfg.passwordLive
      : cfg.live;
    if (!tel.phone) {
      throw new BadRequestException(
        'No tienes un teléfono para recibir el código de firma. Defínelo en Mi perfil → Seguridad → Código de firma.',
      );
    }

    // Reenvío: si hay uno vivo y recién enviado, no se manda otro (el doble clic
    // en "Enviar código" mandaba dos y el usuario teclea el primero, que ya no vale).
    if (ultimo && !ultimo.consumedAt && ultimo.expiresAt > ahora) {
      const esperaMs = REENVIO_S * 1000 - (ahora.getTime() - ultimo.createdAt.getTime());
      if (esperaMs > 0) {
        throw new BadRequestException(
          `Ya te mandamos un código hace un momento. Revisa tu WhatsApp o pide otro en ${Math.ceil(esperaMs / 1000)} s.`,
        );
      }
    }

    if (delDia >= TOPE_DIARIO) {
      throw new BadRequestException(`Se pidieron demasiados códigos de firma en 24 h (${TOPE_DIARIO}). Habla con sistemas.`);
    }

    // La bitácora del servidor tiene que poder distinguir de un vistazo un código
    // de firma de uno de contraseña: no se investigan por lo mismo.
    const etiqueta = s.accion === 'password' ? 'Código de contraseña' : 'Código de firma';
    const codigo = String(randomInt(100_000, 1_000_000));
    const expiresAt = new Date(ahora.getTime() + TTL_MIN * 60_000);

    // Se guarda ANTES de enviar: si el envío falla, el código queda inservible
    // (nadie lo conoce) y el reintento crea otro. Al revés se podría entregar un
    // código que no existe en la base.
    const fila = await this.prisma.signatureOtp.create({
      data: {
        userId: s.userId, purpose: s.purpose, targetId,
        codeHash: hashPassword(codigo), phone: tel.phone,
        channel: 'whatsapp', simulated: !live, expiresAt,
      },
      select: { id: true, createdAt: true },
    });

    /**
     * Quema los códigos vivos anteriores del mismo cajón: solo el último vale.
     *
     * Va DESPUÉS del envío, no antes: delante era una ida y vuelta más que el
     * usuario esperaba sin recibir nada, y encima si el envío fallaba lo dejaba
     * sin el código nuevo (que nadie vio) y sin el viejo (recién quemado). Ahora
     * el anterior solo muere cuando hay uno nuevo de verdad en su teléfono.
     */
    const quemarAnteriores = () =>
      this.prisma.signatureOtp.updateMany({
        where: { userId: s.userId, purpose: s.purpose, targetId, consumedAt: null, id: { not: fila.id }, expiresAt: { gt: ahora } },
        data: { expiresAt: ahora },
      });

    if (!live) {
      await quemarAnteriores();
      const gate = s.accion === 'password' ? PASSWORD_OTP_LIVE_KEY : SIGN_OTP_LIVE_KEY;
      this.logger.warn(`[simulación] ${etiqueta} de ${s.userId} para ${s.purpose}${targetId ? ` (${targetId})` : ''}: ${codigo} — no se envió (gate ${gate} apagado).`);
      return {
        ok: true as const,
        phoneMask: SignatureOtpService.mask(tel.phone),
        expiresAt, resendAt: new Date(fila.createdAt.getTime() + REENVIO_S * 1000),
        simulated: true as const,
        // Solo en simulación, y solo a quien lo pidió para sí mismo: es la única
        // forma de recorrer el flujo sin plantilla aprobada.
        codigoSimulado: codigo,
      };
    }

    const preparado = Date.now();
    const entregado = await this.entregar(tel.phone, s.detalle, codigo, s.accion ?? 'firma');
    const salida = Date.now();
    if (!entregado.ok) {
      // El código muere con el envío fallido: pedir otro es gratis, adivinar cuál
      // de los dos llegó no.
      await this.prisma.signatureOtp.update({ where: { id: fila.id }, data: { expiresAt: ahora } });
      throw new BadRequestException(`No se pudo enviar el código a tu WhatsApp: ${entregado.error}`);
    }
    await quemarAnteriores();

    // Los dos tiempos, separados: `preparar` es lo nuestro (base de datos + hash)
    // y `Kapso` es lo que tardó la pasarela en aceptarlo. Lo que pase después de
    // eso ya es entrega de Meta y no se ve desde aquí.
    this.logger.log(
      `${etiqueta} enviado a ••••${tel.phone.slice(-4)} (${s.purpose}${targetId ? ` ${targetId}` : ''}) por ${entregado.via}` +
        ` · preparar ${preparado - t0} ms · Kapso ${salida - preparado} ms.`,
    );
    return {
      ok: true as const,
      phoneMask: SignatureOtpService.mask(tel.phone),
      expiresAt, resendAt: new Date(fila.createdAt.getTime() + REENVIO_S * 1000),
      simulated: false as const,
      via: entregado.via,
    };
  }

  /**
   * Entrega el código. Primero como texto normal —gratis y sin plantilla— y, si
   * Meta lo rechaza (lo habitual: la ventana de 24 h con este empleado está
   * cerrada), por la plantilla aprobada `codigo_firma`.
   *
   * No se usa el `reopenWithTemplate` de `sendText`: ése limita a una plantilla
   * por hora y por número, que es lo correcto para un aviso al cliente y un
   * desastre aquí (la segunda firma del día se quedaría sin código).
   */
  private async entregar(
    phone: string,
    detalle: string,
    codigo: string,
    accion: 'firma' | 'password',
  ): Promise<{ ok: true; via: string } | { ok: false; error: string }> {
    if (!this.whatsapp.enabled) {
      return { ok: false, error: 'WhatsApp no está configurado (Kapso).' };
    }

    const texto =
      accion === 'password'
        ? `🔐 Código para cambiar tu contraseña: ${codigo}\n\n` +
          `Se está cambiando la contraseña de tu cuenta del sistema (${detalle}). ` +
          `Vence en ${TTL_MIN} minutos y solo sirve una vez.\n` +
          `Si no lo pediste tú, NO lo compartas con nadie y avisa a sistemas ya mismo: ` +
          `con ese código le abren tu cuenta.`
        : `🔐 Código para firmar: ${codigo}\n\n` +
          `Estás firmando ${detalle}. Vence en ${TTL_MIN} minutos y solo sirve una vez.\n` +
          `Si no eras tú, NO lo compartas y avisa a sistemas.`;
    // `secreto`: el código no puede quedar guardado en el hilo de la bandeja.
    if (await this.whatsapp.sendText(phone, texto, { secreto: true })) return { ok: true, via: 'texto' };

    // Meta prohíbe saltos de línea y espacios seguidos en los parámetros de plantilla.
    const plano = detalle.replace(/\s+/g, ' ').trim().slice(0, 200);
    const r = await this.whatsapp.sendTemplate(phone, PLANTILLA.name, PLANTILLA.language, [plano, codigo]);
    if (r.ok) return { ok: true, via: `plantilla ${PLANTILLA.name}` };
    return {
      ok: false,
      error: `${r.error ?? 'error desconocido'} (la plantilla "${PLANTILLA.name}" tiene que estar aprobada en Meta).`,
    };
  }

  // ── Firmar ─────────────────────────────────────────────────────────────────

  /**
   * Comprueba el código SIN consumirlo. Los intentos fallidos sí cuentan.
   *
   * Existe para los asistentes de varios pasos —"escribe el código" y, en la
   * pantalla siguiente, "escribe la contraseña nueva"—: si el paso intermedio
   * consumiera el código, el último no tendría con qué demostrar nada. El código
   * se gasta al final, en `firmar()`, así que sigue sirviendo UNA sola vez.
   */
  async comprobar(p: { userId: string; purpose: SignaturePurpose; targetId?: string | null; code: string }) {
    await this.validar(p);
    return { ok: true as const };
  }

  /**
   * Busca el código vivo y comprueba que sea el que es. Devuelve la fila lista
   * para consumir. Lanza con un mensaje claro si no hay código, si venció, si se
   * agotaron los intentos o si no acierta.
   */
  private async validar(p: { userId: string; purpose: SignaturePurpose; targetId?: string | null; code: string }) {
    const targetId = p.targetId ?? null;
    const code = String(p.code ?? '').replace(/\D/g, '');
    if (!code) throw new BadRequestException('Escribe el código de 6 dígitos que te llegó por WhatsApp.');

    const fila = await this.prisma.signatureOtp.findFirst({
      where: { userId: p.userId, purpose: p.purpose, targetId, consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (!fila) throw new BadRequestException('No hay ningún código pendiente para esta firma. Pide uno nuevo.');
    if (fila.expiresAt.getTime() < Date.now()) throw new BadRequestException('Ese código ya venció. Pide uno nuevo.');
    if (fila.attempts >= MAX_INTENTOS) throw new BadRequestException('Se agotaron los intentos con ese código. Pide uno nuevo.');

    if (!verifyPassword(code, fila.codeHash)) {
      const { attempts } = await this.prisma.signatureOtp.update({
        where: { id: fila.id }, data: { attempts: { increment: 1 } }, select: { attempts: true },
      });
      const quedan = Math.max(0, MAX_INTENTOS - attempts);
      throw new BadRequestException(
        quedan > 0
          ? `Ese código no es. Te quedan ${quedan} intento(s).`
          : 'Ese código no es y se agotaron los intentos. Pide uno nuevo.',
      );
    }
    return fila;
  }

  /**
   * Consume el código y devuelve el rastro de la firma. Lanza con un mensaje
   * claro si no hay código, si venció, si se agotaron los intentos o si no es.
   *
   * El consumo es atómico (`updateMany` con `consumedAt: null` en el where): dos
   * peticiones simultáneas con el mismo código no pueden firmar dos veces.
   */
  async firmar(p: { userId: string; purpose: SignaturePurpose; targetId?: string | null; code: string }) {
    const fila = await this.validar(p);

    const consumo = await this.prisma.signatureOtp.updateMany({
      where: { id: fila.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (consumo.count === 0) throw new BadRequestException('Ese código ya se usó. Pide uno nuevo.');

    if (p.purpose === 'profile.verify') {
      await this.prisma.user.update({
        where: { id: p.userId },
        data: { signaturePhoneVerifiedAt: new Date() },
      }).catch(() => null);
    }

    return { otpId: fila.id, phone: fila.phone, phoneMask: SignatureOtpService.mask(fila.phone), simulated: fila.simulated };
  }

  /**
   * Frase para la bitácora de lo firmado. Va en el detalle del evento de la orden
   * porque ahí es donde alguien va a mirar el día que pregunten quién autorizó
   * esto: el rastro dice a qué teléfono salió el código.
   */
  static rastro(firma: { phoneMask: string | null; simulated: boolean }): string {
    return firma.simulated
      ? 'Firmado con código en modo SIMULACIÓN (no se envió WhatsApp)'
      : `Firmado con código enviado al WhatsApp ${firma.phoneMask ?? ''}`.trim();
  }

  // ── Historial (para el perfil) ─────────────────────────────────────────────

  /** Últimos códigos pedidos por esta persona. Nunca el código: solo qué, cuándo y en qué acabó. */
  async historial(userId: string, take = 8) {
    const rows = await this.prisma.signatureOtp.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(50, Math.max(1, take)),
      select: { id: true, purpose: true, targetId: true, phone: true, simulated: true, attempts: true, expiresAt: true, consumedAt: true, createdAt: true },
    });
    const ahora = Date.now();
    return rows.map((r) => ({
      id: r.id,
      purpose: r.purpose,
      targetId: r.targetId,
      phoneMask: SignatureOtpService.mask(r.phone),
      simulated: r.simulated,
      attempts: r.attempts,
      createdAt: r.createdAt,
      estado: r.consumedAt ? ('usado' as const) : r.expiresAt.getTime() < ahora ? ('vencido' as const) : ('pendiente' as const),
    }));
  }
}
