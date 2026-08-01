import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { CurrentUser, type AuthUser } from '../../auth/current-user.decorator';

/**
 * La campanita. Sin permisos: cada quien ve LO SUYO y nada más — el `userId` sale
 * siempre de la sesión, nunca de la petición, así que no hay forma de pedir los
 * avisos de otro.
 */
@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.notifications.list(user.id);
  }

  @Post('read-all')
  readAll(@CurrentUser() user: AuthUser) {
    return this.notifications.markAllRead(user.id);
  }

  /** Marca leídos los avisos de un asunto (p. ej. al abrir ese chat). */
  @Post('read-group')
  readGroup(@CurrentUser() user: AuthUser, @Body() body: { groupKey: string }) {
    return this.notifications.markGroupRead(user.id, body?.groupKey ?? '');
  }

  @Post(':id/read')
  read(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.notifications.markRead(user.id, id);
  }
}
