import { BadRequestException, Injectable } from '@nestjs/common';
import { SignatureOtpService } from './signature-otp.service';

/** Quién es el dueño de la cuenta cuya contraseña se va a cambiar. */
export type DuenoCuenta = { id: string; name?: string | null; email?: string | null };

/** Cómo llegó el cambio: lo hace el propio dueño o se lo restablece un administrador. */
export type ModoCambio = 'propia' | 'reset';

/** Lo que el frontend necesita saber ANTES de abrir el diálogo del código. */
export type PasswordOtpPolicy = {
  /** ¿Hay que pedir código para este cambio? */
  required: boolean;
  /** false ⇒ modo simulación: el código no sale por WhatsApp y se muestra en pantalla. */
  live: boolean;
  /** A qué WhatsApp saldría, enmascarado. null ⇒ no hay a dónde mandarlo. */
  phoneMask: string | null;
  /** De dónde sale ese número: el que puso el usuario o el que sistemas le vinculó al chatbot. */
  source: 'propio' | 'whatsapp-vinculado' | null;
  /** Nombre del dueño de la cuenta, para que el diálogo diga a quién le va a llegar. */
  owner: string | null;
  /**
   * Por qué NO se puede pedir el código (dueño sin WhatsApp). Va en prosa y con la
   * salida, porque quien lee esto está atendiendo a alguien que se quedó sin entrar.
   */
  blocked: string | null;
};

/**
 * Código de un solo uso para CAMBIAR UNA CONTRASEÑA.
 *
 * El agujero que tapa: la contraseña es la llave de todo lo demás. Un
 * superusuario podía restablecer la clave de cualquier funcionario y entrar como
 * él —a firmar, a mover caja, a cerrar órdenes— sin que el dueño de la cuenta se
 * enterara nunca; y una sesión abierta y sin bloquear bastaba para que un tercero
 * se cambiara la clave y se quedara con la cuenta.
 *
 * La decisión que ordena todo lo demás: **el código va SIEMPRE al WhatsApp del
 * dueño de la cuenta**, no al de quien está haciendo el cambio. Cuando sistemas
 * le restablece la contraseña a un funcionario, es el funcionario quien recibe
 * los seis dígitos y quien se los dicta: sin él no hay cambio, y si alguien
 * intenta hacerlo a sus espaldas le llega el WhatsApp igual y se entera.
 *
 * Se apoya entero en `SignatureOtpService` (mismo hash scrypt, mismos intentos,
 * mismo TTL, mismo rastro en `SignatureOtp`): aquí solo vive la política propia
 * de las contraseñas —a quién se le manda, con qué texto y cuándo se exige—.
 */
@Injectable()
export class PasswordOtpService {
  constructor(private readonly firma: SignatureOtpService) {}

  private purpose(modo: ModoCambio) {
    return modo === 'propia' ? ('password.change' as const) : ('password.reset' as const);
  }

  // ── "Olvidé mi contraseña" (sin sesión) ────────────────────────────────────
  // Cajón aparte del resto: aquí el código no es un segundo factor sino el ÚNICO
  // factor —quien lo pide no ha demostrado nada todavía—, así que ni lo gobierna
  // el ajuste `security.passwordOtpRequired` ni se devuelve jamás a la pantalla
  // (ni siquiera en simulación: cualquiera podría teclear un correo ajeno).

  /** ¿Puede salir un código de verdad ahora mismo? Sin esto, recuperar no sirve. */
  async canalListo() {
    const { passwordLive } = await this.firma.config();
    return { live: passwordLive, whatsappEnabled: this.firma.whatsappEnabled };
  }

  /** ¿A este correo se le puede mandar el código? (uso interno: no responde a nadie). */
  telefonoDe(userId: string) {
    return this.firma.telefono(userId);
  }

  /** Manda el código de recuperación al WhatsApp vinculado a esa cuenta. */
  async pedirOlvido(dueno: DuenoCuenta) {
    await this.firma.pedir({
      userId: dueno.id,
      purpose: 'password.forgot',
      detalle: 'lo pidió alguien desde la pantalla de ingreso, con tu correo',
      accion: 'password',
    });
  }

  /** Comprueba el código de recuperación sin gastarlo (paso 2 del asistente). */
  comprobarOlvido(dueno: DuenoCuenta, code: string) {
    return this.firma.comprobar({ userId: dueno.id, purpose: 'password.forgot', code });
  }

  /** Gasta el código de recuperación (paso 3) y devuelve el rastro para la bitácora. */
  async consumirOlvido(dueno: DuenoCuenta, code: string) {
    const firma = await this.firma.firmar({ userId: dueno.id, purpose: 'password.forgot', code });
    return firma.simulated
      ? 'Recuperada con código en modo SIMULACIÓN (no se envió WhatsApp)'
      : `Recuperada con el código enviado al WhatsApp ${firma.phoneMask ?? ''}`.trim();
  }

  /** Qué se le dice al dueño por WhatsApp: quién está detrás del cambio. */
  private detalle(modo: ModoCambio, actorNombre?: string | null) {
    return modo === 'propia'
      ? 'lo estás cambiando tú desde Mi perfil'
      : `lo está haciendo ${actorNombre?.trim() || 'un administrador'} desde el panel de sistemas`;
  }

  /**
   * ¿Hace falta código, y se puede mandar? Lo consulta la pantalla al abrir el
   * diálogo para no ofrecer un botón que va a fallar.
   */
  async policy(dueno: DuenoCuenta, modo: ModoCambio): Promise<PasswordOtpPolicy> {
    const [{ passwordLive: live, passwordRequired }, tel] = await Promise.all([
      this.firma.config(),
      this.firma.telefono(dueno.id),
    ]);
    const nombre = dueno.name?.trim() || dueno.email || null;
    return {
      required: passwordRequired,
      live,
      phoneMask: SignatureOtpService.mask(tel.phone),
      source: tel.source,
      owner: nombre,
      blocked: passwordRequired && !tel.phone ? this.sinTelefono(modo, nombre) : null,
    };
  }

  /**
   * Mensaje de "no hay a dónde mandar el código". Termina siempre en una salida
   * concreta: dejar a alguien sin poder entrar y sin decirle qué hacer es peor
   * que no haber puesto el código.
   */
  private sinTelefono(modo: ModoCambio, nombre: string | null) {
    return modo === 'propia'
      ? 'No tienes ningún WhatsApp vinculado, así que no hay a dónde mandarte el código. ' +
          'Defínelo tú mismo en Mi perfil → Seguridad → Código de firma (eso no pide código) y vuelve a intentarlo.'
      : `${nombre ?? 'Ese funcionario'} no tiene ningún WhatsApp vinculado, así que no hay a dónde mandarle el código ` +
          'y su contraseña no se puede cambiar. Que entre a Mi perfil → Seguridad y registre su celular, ' +
          'o vincúlale el número del chatbot desde Configuración → WhatsApp.';
  }

  /**
   * Manda el código al WhatsApp del dueño de la cuenta y devuelve a dónde salió
   * (enmascarado) para que la pantalla lo muestre.
   */
  async pedir(dueno: DuenoCuenta, modo: ModoCambio, actorNombre?: string | null) {
    const { passwordRequired } = await this.firma.config();
    if (!passwordRequired) {
      throw new BadRequestException('Los cambios de contraseña no están pidiendo código ahora mismo.');
    }
    const tel = await this.firma.telefono(dueno.id);
    if (!tel.phone) {
      throw new BadRequestException(this.sinTelefono(modo, dueno.name?.trim() || dueno.email || null));
    }
    return this.firma.pedir({
      userId: dueno.id,
      purpose: this.purpose(modo),
      detalle: this.detalle(modo, actorNombre),
      accion: 'password',
    });
  }

  /**
   * Consume el código antes de tocar la contraseña. Devuelve el rastro para la
   * bitácora, o `null` si la exigencia está apagada.
   *
   * Se llama SIEMPRE antes de escribir el hash nuevo: si el código no sirve, la
   * contraseña no se cambió y la anterior sigue funcionando.
   */
  async exigir(dueno: DuenoCuenta, modo: ModoCambio, code?: string | null): Promise<string | null> {
    const { passwordRequired } = await this.firma.config();
    if (!passwordRequired) return null;

    const limpio = String(code ?? '').replace(/\D/g, '');
    if (!limpio) {
      const nombre = dueno.name?.trim() || dueno.email || null;
      const tel = await this.firma.telefono(dueno.id);
      if (!tel.phone) throw new BadRequestException(this.sinTelefono(modo, nombre));
      throw new BadRequestException(
        modo === 'propia'
          ? 'Para cambiar tu contraseña hace falta el código de 6 dígitos que te llega por WhatsApp.'
          : `Para cambiar esa contraseña hace falta el código de 6 dígitos que le llega por WhatsApp a ${nombre ?? 'el funcionario'}.`,
      );
    }

    const firma = await this.firma.firmar({ userId: dueno.id, purpose: this.purpose(modo), code: limpio });
    return firma.simulated
      ? 'Confirmado con código en modo SIMULACIÓN (no se envió WhatsApp)'
      : `Confirmado con el código enviado al WhatsApp del titular ${firma.phoneMask ?? ''}`.trim();
  }
}
