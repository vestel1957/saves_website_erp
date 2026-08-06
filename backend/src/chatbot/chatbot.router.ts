/**
 * Rutas de admin — ── FICHERO GENERADO ──
 *
 * Lo genera `scripts/generar-routers.ts` desde el contrato extraído del
 * controlador. Cablea HTTP -> método: extrae los argumentos de `req` y llama.
 * La lógica sigue viviendo en ChatbotController, que ya no lleva decoradores.
 *
 * Endpoints: 14
 */
import { crearRouter, manejar } from '../core/http/ruta';
import { validar } from '../core/http/validar';
import { autenticar, exigirPermisos, usuarioDe } from '../core/auth/instancias';
import { ChatbotController, AllowlistDto, BudgetDto, ConductaDto, LinkPhoneDto, PlanesDto, SwitchDto } from './chatbot.controller';
import { chatbotActividadService, chatbotGateService, chatbotLinkService, chatbotService, chatbotSessionStore, chatbotUsageService, plansService } from '../core/contenedor';
import { BadRequestException } from '../core/http/errores';
import { IsArray, IsBoolean, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { APP_PERMISSIONS } from '../auth/permissions.catalog';
import { ChatbotService } from './chatbot.service';
import { ChatbotLinkService } from './chatbot-link.service';
import { ChatbotGateService } from './chatbot-gate.service';
import { ChatbotSessionStore } from './chatbot-session.store';
import { ChatbotUsageService } from './chatbot-usage.service';
import { ChatbotActividadService } from './chatbot-actividad.service';
import { PlansService } from '../plans/plans.service';

/** Instancia única del controlador. Las dependencias salen del contenedor. */
const chatbot = new ChatbotController(chatbotService, chatbotLinkService, chatbotGateService, chatbotSessionStore, chatbotUsageService, plansService, chatbotActividadService);

export const chatbotRouter = crearRouter();
chatbotRouter.get(
  '/chatbot/actividad',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.WHATSAPP_MANAGE),
  manejar((req) => chatbot.actividadDelBot()),
);

chatbotRouter.put(
  '/chatbot/allowlist',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.WHATSAPP_MANAGE),
  manejar((req) => chatbot.allowlist(validar(AllowlistDto, req.body), usuarioDe(req))),
);

chatbotRouter.put(
  '/chatbot/budget',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.WHATSAPP_MANAGE),
  manejar((req) => chatbot.budget(validar(BudgetDto, req.body), usuarioDe(req))),
);

chatbotRouter.put(
  '/chatbot/conductas/:cual',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.WHATSAPP_MANAGE),
  manejar((req) => chatbot.conducta(req.params.cual, validar(ConductaDto, req.body), usuarioDe(req))),
);

chatbotRouter.get(
  '/chatbot/handoffs',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.WHATSAPP_MANAGE),
  manejar((req) => chatbot.handoffs()),
);

chatbotRouter.delete(
  '/chatbot/handoffs/:convKey',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.WHATSAPP_MANAGE),
  manejar((req) => chatbot.releaseHandoff(req.params.convKey)),
);

chatbotRouter.get(
  '/chatbot/planes',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.WHATSAPP_MANAGE),
  manejar((req) => chatbot.planes()),
);

chatbotRouter.put(
  '/chatbot/planes',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.WHATSAPP_MANAGE),
  manejar((req) => chatbot.setPlanes(validar(PlanesDto, req.body), usuarioDe(req))),
);

chatbotRouter.get(
  '/chatbot/status',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.WHATSAPP_MANAGE),
  manejar((req) => chatbot.status()),
);

chatbotRouter.put(
  '/chatbot/switch',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.WHATSAPP_MANAGE),
  manejar((req) => chatbot.switch_(validar(SwitchDto, req.body), usuarioDe(req))),
);

chatbotRouter.get(
  '/chatbot/vinculos',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.WHATSAPP_MANAGE),
  manejar((req) => chatbot.links_()),
);

chatbotRouter.delete(
  '/chatbot/vinculos/:userId',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.WHATSAPP_MANAGE),
  manejar((req) => chatbot.unlink(req.params.userId)),
);

chatbotRouter.put(
  '/chatbot/vinculos/:userId',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.WHATSAPP_MANAGE),
  manejar((req) => chatbot.link(req.params.userId, validar(LinkPhoneDto, req.body))),
);

chatbotRouter.get(
  '/chatbot/vinculos/candidatos',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.WHATSAPP_MANAGE),
  manejar((req) => chatbot.candidatos()),
);
