/**
 * Rutas de whatsapp — ── FICHERO GENERADO ──
 *
 * Lo genera `scripts/generar-routers.ts` desde el contrato extraído del
 * controlador. Cablea HTTP -> método: extrae los argumentos de `req` y llama.
 * La lógica sigue viviendo en WhatsappInboxController, que ya no lleva decoradores.
 *
 * Endpoints: 9
 */
import { crearRouter, manejar } from '../../core/http/ruta';
import { autenticar, exigirPermisos, usuarioDe } from '../../core/auth/instancias';
import { WhatsappInboxController } from './whatsapp-inbox.controller';
import { whatsappInboxService } from '../../core/contenedor';
import type { Response } from 'express';
import { enviarAdjuntoSeguro } from '../uploads';
import { WhatsappInboxService } from './whatsapp-inbox.service';
import { APP_PERMISSIONS } from '../../auth/permissions.catalog';

/** Instancia única del controlador. Las dependencias salen del contenedor. */
const whatsappInbox = new WhatsappInboxController(whatsappInboxService);

export const whatsappInboxRouter = crearRouter();
whatsappInboxRouter.get(
  '/agentes',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.WHATSAPP_INBOX),
  manejar((req) => whatsappInbox.agents()),
);

whatsappInboxRouter.get(
  '/audios/:id',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.WHATSAPP_INBOX),
  manejar((req, res) => whatsappInbox.audio(req.params.id, res)),
);

whatsappInboxRouter.get(
  '/conversaciones',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.WHATSAPP_INBOX),
  manejar((req) => whatsappInbox.list(usuarioDe(req), req.query.estado as string, req.query.mias as string, req.query.search as string, req.query.page as string, req.query.pageSize as string)),
);

whatsappInboxRouter.get(
  '/conversaciones/:phone',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.WHATSAPP_INBOX),
  manejar((req) => whatsappInbox.thread(req.params.phone, req.query.take as string)),
);

whatsappInboxRouter.post(
  '/conversaciones/:phone/asignar',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.WHATSAPP_INBOX),
  manejar((req) => whatsappInbox.assign(req.params.phone, req.body, usuarioDe(req))),
);

whatsappInboxRouter.post(
  '/conversaciones/:phone/devolver-bot',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.WHATSAPP_INBOX),
  manejar((req) => whatsappInbox.returnToBot(req.params.phone)),
);

whatsappInboxRouter.post(
  '/conversaciones/:phone/leido',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.WHATSAPP_INBOX),
  manejar((req) => whatsappInbox.markRead(req.params.phone, usuarioDe(req))),
);

whatsappInboxRouter.post(
  '/conversaciones/:phone/resolver',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.WHATSAPP_INBOX),
  manejar((req) => whatsappInbox.resolve(req.params.phone, usuarioDe(req))),
);

whatsappInboxRouter.post(
  '/conversaciones/:phone/responder',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.WHATSAPP_INBOX),
  manejar((req) => whatsappInbox.reply(req.params.phone, req.body, usuarioDe(req))),
);
