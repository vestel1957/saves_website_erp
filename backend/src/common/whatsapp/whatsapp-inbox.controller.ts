import type { Response } from 'express';
import { enviarAdjuntoSeguro } from '../uploads';
import { WhatsappInboxService } from './whatsapp-inbox.service';
import { APP_PERMISSIONS } from '../../auth/permissions.catalog';
import { type AuthUser } from '../../auth/current-user.decorator';

/**
 * Bandeja de WhatsApp: ver los chats y responderlos.
 *
 * Va aparte de `WhatsappController` (que es `/admin/whatsapp`) porque el permiso es
 * otro y la gente también: configurar el canal es de Sistemas, atender a un cliente es
 * de quien atiende clientes. Meterlo bajo `system.whatsapp` habría obligado a dar
 * acceso a las credenciales del canal para poder contestar un "¿por qué no tengo
 * internet?".
 */
export class WhatsappInboxController {
  constructor(private readonly inbox: WhatsappInboxService) {}

  /** Hilos de la bandeja, con contadores por estado para las pestañas. */
  list(
    user: AuthUser,
    estado?: string,
    mias?: string,
    search?: string,
    page?: string,
    pageSize?: string,
  ) {
    return this.inbox.list({
      estado,
      mias: mias === 'true' || mias === '1',
      search,
      page: Number(page),
      pageSize: Number(pageSize),
      userId: user.id,
    });
  }

  /** Usuarios que pueden atender (desplegable de "pasar a"). */
  agents() {
    return this.inbox.agents();
  }

  /** Hilo completo de un número. */
  thread(phone: string, take?: string) {
    return this.inbox.thread(phone, { take: Number(take) });
  }

  /**
   * Nota de voz de un mensaje, para escucharla desde la bandeja.
   *
   * Se sirve con `enviarAdjuntoSeguro` como cualquier otro adjunto —`nosniff`,
   * `attachment` y un Content-Type de lista blanca— y no como un archivo estático: son
   * bytes que mandó un tercero y no deben poder renderizarse en el origen de la API
   * (ver la explicación en `common/uploads.ts`). El reproductor de la bandeja los lee
   * por fetch y arma un blob, así que el `attachment` no le estorba; y quien abra la
   * URL a pelo se descarga el audio, que también sirve.
   */
  async audio(id: string, res: Response) {
    const { ruta, nombre } = await this.inbox.audio(id);
    return enviarAdjuntoSeguro(res, ruta, nombre);
  }

  /** Responder como persona (calla al bot en esa conversación). */
  reply(phone: string, body: { text: string }, user: AuthUser) {
    return this.inbox.reply(phone, body?.text ?? '', { id: user.id, name: user.name });
  }

  markRead(phone: string, user: AuthUser) {
    return this.inbox.markRead(phone, user.id);
  }

  /** Tomarla, o pasársela a otro con `userId`. */
  assign(phone: string, body: { userId?: string }, user: AuthUser) {
    return this.inbox.assign(phone, { id: user.id }, body?.userId);
  }

  /** Cerrar: la conversación vuelve al bot. */
  resolve(phone: string, user: AuthUser) {
    return this.inbox.resolve(phone, { id: user.id });
  }

  /** Devolverla al bot sin darla por atendida. */
  returnToBot(phone: string) {
    return this.inbox.returnToBot(phone);
  }
}
