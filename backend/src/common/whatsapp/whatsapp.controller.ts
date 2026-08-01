import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';
import { WhatsappLogService } from './whatsapp-log.service';
import { WhatsappCampaignService } from './whatsapp-campaign.service';
import { CreateCampaignDto, TemplateDto } from './dto/campaign.dto';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { PermissionsGuard } from '../../auth/permissions.guard';
import { RequirePermissions } from '../../auth/require-permissions.decorator';
import { APP_PERMISSIONS } from '../../auth/permissions.catalog';
import { CurrentUser, type AuthUser } from '../../auth/current-user.decorator';

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
    private readonly campaigns: WhatsappCampaignService,
  ) {}

  @Get('status')
  @RequirePermissions(APP_PERMISSIONS.WHATSAPP_MANAGE)
  status() {
    return this.whatsapp.status();
  }

  /**
   * Salud REAL del número contra Kapso/Meta: calidad (GREEN/YELLOW/RED) y tier de
   * mensajería (clientes únicos/24h). Es lo que hay que vigilar en campañas masivas:
   * calidad en rojo o tier bajo = Meta va a rechazar o castigar los envíos.
   */
  @Get('health')
  @RequirePermissions(APP_PERMISSIONS.WHATSAPP_MANAGE)
  health() {
    return this.whatsapp.probe();
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

  // --- Plantillas ---

  @Get('templates')
  @RequirePermissions(APP_PERMISSIONS.WHATSAPP_MANAGE)
  templates() {
    return this.campaigns.listTemplates();
  }

  @Post('templates')
  @RequirePermissions(APP_PERMISSIONS.WHATSAPP_MANAGE)
  createTemplate(@Body() dto: TemplateDto) {
    return this.campaigns.createTemplate(dto);
  }

  @Patch('templates/:id')
  @RequirePermissions(APP_PERMISSIONS.WHATSAPP_MANAGE)
  updateTemplate(@Param('id') id: string, @Body() dto: TemplateDto) {
    return this.campaigns.updateTemplate(id, dto);
  }

  @Delete('templates/:id')
  @RequirePermissions(APP_PERMISSIONS.WHATSAPP_MANAGE)
  deleteTemplate(@Param('id') id: string) {
    return this.campaigns.deleteTemplate(id);
  }

  // --- Campañas / envío masivo ---

  @Get('campaigns')
  @RequirePermissions(APP_PERMISSIONS.WHATSAPP_MANAGE)
  campaigns_(@Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.campaigns.listCampaigns({ page: Number(page), pageSize: Number(pageSize) });
  }

  @Post('campaigns')
  @RequirePermissions(APP_PERMISSIONS.WHATSAPP_MANAGE)
  createCampaign(@Body() dto: CreateCampaignDto, @CurrentUser() user: AuthUser) {
    return this.campaigns.createCampaign(dto, user);
  }

  @Get('campaigns/:id')
  @RequirePermissions(APP_PERMISSIONS.WHATSAPP_MANAGE)
  campaignReport(
    @Param('id') id: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.campaigns.campaignReport(id, { status, page: Number(page), pageSize: Number(pageSize) });
  }

  @Post('campaigns/:id/retry')
  @RequirePermissions(APP_PERMISSIONS.WHATSAPP_MANAGE)
  retryCampaign(@Param('id') id: string) {
    return this.campaigns.retryFailed(id);
  }
}
