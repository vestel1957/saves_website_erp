/**
 * Rutas de admin — ── FICHERO GENERADO ──
 *
 * Lo genera `scripts/generar-routers.ts` desde el contrato extraído del
 * controlador. Cablea HTTP -> método: extrae los argumentos de `req` y llama.
 * La lógica sigue viviendo en WhatsappController, que ya no lleva decoradores.
 *
 * Endpoints: 15
 */
import { crearRouter, manejar } from '../../core/http/ruta';
import { validar } from '../../core/http/validar';
import { autenticar, exigirPermisos, usuarioDe } from '../../core/auth/instancias';
import { WhatsappController } from './whatsapp.controller';
import { whatsappCampaignService, whatsappLogService, whatsappService } from '../../core/contenedor';
import { WhatsappService } from './whatsapp.service';
import { WhatsappLogService } from './whatsapp-log.service';
import { WhatsappCampaignService } from './whatsapp-campaign.service';
import { CampaignPreviewDto, CampaignTestDto, CreateCampaignDto, TemplateDto } from './dto/campaign.dto';
import { APP_PERMISSIONS } from '../../auth/permissions.catalog';

/** Instancia única del controlador. Las dependencias salen del contenedor. */
const whatsapp = new WhatsappController(whatsappService, whatsappLogService, whatsappCampaignService);

export const whatsappRouter = crearRouter();
whatsappRouter.get(
  '/whatsapp/campaigns',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.WHATSAPP_MANAGE),
  manejar((req) => whatsapp.campaigns_(req.query.page as string, req.query.pageSize as string)),
);

whatsappRouter.post(
  '/whatsapp/campaigns',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.WHATSAPP_MANAGE),
  manejar((req) => whatsapp.createCampaign(validar(CreateCampaignDto, req.body), usuarioDe(req))),
);

whatsappRouter.get(
  '/whatsapp/campaigns/options',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.WHATSAPP_MANAGE),
  manejar((req) => whatsapp.campaignOptions()),
);

whatsappRouter.post(
  '/whatsapp/campaigns/preview',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.WHATSAPP_MANAGE),
  manejar((req) => whatsapp.previewCampaign(validar(CampaignPreviewDto, req.body))),
);

whatsappRouter.post(
  '/whatsapp/campaigns/test',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.WHATSAPP_MANAGE),
  manejar((req) => whatsapp.testCampaign(validar(CampaignTestDto, req.body), usuarioDe(req))),
);

whatsappRouter.get(
  '/whatsapp/campaigns/:id',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.WHATSAPP_MANAGE),
  manejar((req) => whatsapp.campaignReport(req.params.id, req.query.status as string, req.query.page as string, req.query.pageSize as string)),
);

whatsappRouter.post(
  '/whatsapp/campaigns/:id/retry',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.WHATSAPP_MANAGE),
  manejar((req) => whatsapp.retryCampaign(req.params.id)),
);

whatsappRouter.get(
  '/whatsapp/health',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.WHATSAPP_MANAGE),
  manejar((req) => whatsapp.health()),
);

whatsappRouter.get(
  '/whatsapp/messages',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.WHATSAPP_MANAGE),
  manejar((req) => whatsapp.messages(req.query.search as string, req.query.direction as string, req.query.page as string, req.query.pageSize as string)),
);

whatsappRouter.get(
  '/whatsapp/status',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.WHATSAPP_MANAGE),
  manejar((req) => whatsapp.status()),
);

whatsappRouter.get(
  '/whatsapp/templates',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.WHATSAPP_MANAGE),
  manejar((req) => whatsapp.templates()),
);

whatsappRouter.post(
  '/whatsapp/templates',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.WHATSAPP_MANAGE),
  manejar((req) => whatsapp.createTemplate(validar(TemplateDto, req.body))),
);

whatsappRouter.delete(
  '/whatsapp/templates/:id',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.WHATSAPP_MANAGE),
  manejar((req) => whatsapp.deleteTemplate(req.params.id)),
);

whatsappRouter.patch(
  '/whatsapp/templates/:id',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.WHATSAPP_MANAGE),
  manejar((req) => whatsapp.updateTemplate(req.params.id, validar(TemplateDto, req.body))),
);

whatsappRouter.post(
  '/whatsapp/test',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.WHATSAPP_MANAGE),
  manejar((req) => whatsapp.test(req.body)),
);
