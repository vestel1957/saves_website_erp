import { NotificationsService } from './notifications.service';
import { type AuthUser } from '../../auth/current-user.decorator';

/**
 * La campanita. Sin permisos: cada quien ve LO SUYO y nada más — el `userId` sale
 * siempre de la sesión, nunca de la petición, así que no hay forma de pedir los
 * avisos de otro.
 */
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  list(user: AuthUser) {
    return this.notifications.list(user.id);
  }

  readAll(user: AuthUser) {
    return this.notifications.markAllRead(user.id);
  }

  /** Marca leídos los avisos de un asunto (p. ej. al abrir ese chat). */
  readGroup(user: AuthUser, body: { groupKey: string }) {
    return this.notifications.markGroupRead(user.id, body?.groupKey ?? '');
  }

  read(user: AuthUser, id: string) {
    return this.notifications.markRead(user.id, id);
  }
}
