import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';
import { WhatsappLogService } from './whatsapp-log.service';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { PermissionsGuard } from '../../auth/permissions.guard';
import { RequirePermissions } from '../../auth/require-permissions.decorator';
import { APP_PERMISSIONS } from '../../auth/permissions.catalog';

/**
 * Gestión del canal de WhatsApp (Kapso, Cloud API oficial). A diferencia de la
 * antigua librería no oficial (Baileys), no hay QR que escanear ni sesión que
 * vincular: el número se conecta una vez en el panel de Kapso y aquí solo se
 * consulta el estado y se envía un mensaje de prueba.
 * Requiere el permiso transversal `system.whatsapp` (Administración).
 */
@Controller('admin/whatsapp')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class WhatsappController {
  constructor(
    private readonly whatsapp: WhatsappService,
    private readonly log: WhatsappLogService,
  ) {}

  @Get('status')
  @RequirePermissions(APP_PERMISSIONS.WHATSAPP_MANAGE)
  status() {
    return this.whatsapp.status();
  }

  /** Historial de conversación (entrantes + salientes). */
  @Get('messages')
  @RequirePermissions(APP_PERMISSIONS.WHATSAPP_MANAGE)
  messages(@Query('search') search?: string, @Query('direction') direction?: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.log.list({ search, direction, page: Number(page), pageSize: Number(pageSize) });
  }

  @Post('test')
  @RequirePermissions(APP_PERMISSIONS.WHATSAPP_MANAGE)
  async test(@Body() body: { to: string; message?: string }) {
    const ok = await this.whatsapp.sendText(
      body.to,
      body.message ?? '✅ Prueba de WhatsApp desde BHDC.',
    );
    return { ok };
  }
}
