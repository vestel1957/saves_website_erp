import { WhatsappService } from './whatsapp.service';
import { WhatsappLogService } from './whatsapp-log.service';
import { WhatsappCampaignService } from './whatsapp-campaign.service';
import { CampaignPreviewDto, CampaignTestDto, CreateCampaignDto, TemplateDto } from './dto/campaign.dto';
import { APP_PERMISSIONS } from '../../auth/permissions.catalog';
import { type AuthUser } from '../../auth/current-user.decorator';

/**
 * Gestión del canal de WhatsApp (Kapso, Cloud API oficial). A diferencia de la
 * antigua librería no oficial (Baileys), no hay QR que escanear ni sesión que
 * vincular: el número se conecta una vez en el panel de Kapso y aquí solo se
 * consulta el estado y se envía un mensaje de prueba.
 * Requiere el permiso transversal `system.whatsapp` (Administración).
 */
export class WhatsappController {
  constructor(
    private readonly whatsapp: WhatsappService,
    private readonly log: WhatsappLogService,
    private readonly campaigns: WhatsappCampaignService,
  ) {}

  status() {
    return this.whatsapp.status();
  }

  /**
   * Salud REAL del número contra Kapso/Meta: calidad (GREEN/YELLOW/RED) y tier de
   * mensajería (clientes únicos/24h). Es lo que hay que vigilar en campañas masivas:
   * calidad en rojo o tier bajo = Meta va a rechazar o castigar los envíos.
   * Trae además cuánto del cupo de 24 h ya se gastó.
   */
  health() {
    return this.campaigns.salud();
  }

  /** Historial de conversación (entrantes + salientes). */
  messages(search?: string, direction?: string, page?: string, pageSize?: string) {
    return this.log.list({ search, direction, page: Number(page), pageSize: Number(pageSize) });
  }

  async test(body: { to: string; message?: string }) {
    const ok = await this.whatsapp.sendText(
      body.to,
      body.message ?? '✅ Prueba de WhatsApp desde BHDC.',
    );
    return { ok };
  }

  // --- Plantillas ---

  templates() {
    return this.campaigns.listTemplates();
  }

  createTemplate(dto: TemplateDto) {
    return this.campaigns.createTemplate(dto);
  }

  updateTemplate(id: string, dto: TemplateDto) {
    return this.campaigns.updateTemplate(id, dto);
  }

  deleteTemplate(id: string) {
    return this.campaigns.deleteTemplate(id);
  }

  // --- Campañas / envío masivo ---

  campaigns_(page?: string, pageSize?: string) {
    return this.campaigns.listCampaigns({ page: Number(page), pageSize: Number(pageSize) });
  }

  createCampaign(dto: CreateCampaignDto, user: AuthUser) {
    return this.campaigns.createCampaign(dto, user);
  }

  /** Sedes, planes y estados para armar el público de una campaña. */
  campaignOptions() {
    return this.campaigns.opcionesCampana();
  }

  /** A quién le llegaría, cuántos se caen y por qué, y cómo se reparte en el cupo diario. */
  previewCampaign(dto: CampaignPreviewDto) {
    return this.campaigns.previewCampaign(dto);
  }

  /** Envío de prueba de la plantilla a un celular, con los datos de un cliente real. */
  testCampaign(dto: CampaignTestDto, user: AuthUser) {
    return this.campaigns.testCampaign(dto, user);
  }

  campaignReport(
    id: string,
    status?: string,
    page?: string,
    pageSize?: string,
  ) {
    return this.campaigns.campaignReport(id, { status, page: Number(page), pageSize: Number(pageSize) });
  }

  retryCampaign(id: string) {
    return this.campaigns.retryFailed(id);
  }
}
