import { Body, Controller, Get, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { enviarAdjuntoSeguro } from '../uploads';
import { WhatsappInboxService } from './whatsapp-inbox.service';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { PermissionsGuard } from '../../auth/permissions.guard';
import { RequirePermissions } from '../../auth/require-permissions.decorator';
import { APP_PERMISSIONS } from '../../auth/permissions.catalog';
import { CurrentUser, type AuthUser } from '../../auth/current-user.decorator';

/**
 * Bandeja de WhatsApp: ver los chats y responderlos.
 *
 * Va aparte de `WhatsappController` (que es `/admin/whatsapp`) porque el permiso es
 * otro y la gente también: configurar el canal es de Sistemas, atender a un cliente es
 * de quien atiende clientes. Meterlo bajo `system.whatsapp` habría obligado a dar
 * acceso a las credenciales del canal para poder contestar un "¿por qué no tengo
 * internet?".
 */
@Controller('whatsapp')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(APP_PERMISSIONS.WHATSAPP_INBOX)
export class WhatsappInboxController {
  constructor(private readonly inbox: WhatsappInboxService) {}

  /** Hilos de la bandeja, con contadores por estado para las pestañas. */
  @Get('conversaciones')
  list(
    @CurrentUser() user: AuthUser,
    @Query('estado') estado?: string,
    @Query('mias') mias?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
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
  @Get('agentes')
  agents() {
    return this.inbox.agents();
  }

  /** Hilo completo de un número. */
  @Get('conversaciones/:phone')
  thread(@Param('phone') phone: string, @Query('take') take?: string) {
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
  @Get('audios/:id')
  async audio(@Param('id') id: string, @Res() res: Response) {
    const { ruta, nombre } = await this.inbox.audio(id);
    return enviarAdjuntoSeguro(res, ruta, nombre);
  }

  /** Responder como persona (calla al bot en esa conversación). */
  @Post('conversaciones/:phone/responder')
  reply(@Param('phone') phone: string, @Body() body: { text: string }, @CurrentUser() user: AuthUser) {
    return this.inbox.reply(phone, body?.text ?? '', { id: user.id, name: user.name });
  }

  @Post('conversaciones/:phone/leido')
  markRead(@Param('phone') phone: string, @CurrentUser() user: AuthUser) {
    return this.inbox.markRead(phone, user.id);
  }

  /** Tomarla, o pasársela a otro con `userId`. */
  @Post('conversaciones/:phone/asignar')
  assign(@Param('phone') phone: string, @Body() body: { userId?: string }, @CurrentUser() user: AuthUser) {
    return this.inbox.assign(phone, { id: user.id }, body?.userId);
  }

  /** Cerrar: la conversación vuelve al bot. */
  @Post('conversaciones/:phone/resolver')
  resolve(@Param('phone') phone: string, @CurrentUser() user: AuthUser) {
    return this.inbox.resolve(phone, { id: user.id });
  }

  /** Devolverla al bot sin darla por atendida. */
  @Post('conversaciones/:phone/devolver-bot')
  returnToBot(@Param('phone') phone: string) {
    return this.inbox.returnToBot(phone);
  }
}
