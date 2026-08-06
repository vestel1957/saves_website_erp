/**
 * Rutas de whatsapp — ── FICHERO GENERADO ──
 *
 * Lo genera `scripts/generar-routers.ts` desde el contrato extraído del
 * controlador. Cablea HTTP -> método: extrae los argumentos de `req` y llama.
 * La lógica sigue viviendo en WhatsappWebhookController, que ya no lleva decoradores.
 *
 * Endpoints: 2
 */
import { crearRouter, manejar } from '../../core/http/ruta';
import { WhatsappWebhookController } from './whatsapp-webhook.controller';
import { whatsappService } from '../../core/contenedor';
import { Logger } from '../../core/logger';
import type { Request, Response } from 'express';
import { WhatsappService } from './whatsapp.service';

/** Instancia única del controlador. Las dependencias salen del contenedor. */
const whatsappWebhook = new WhatsappWebhookController(whatsappService);

export const whatsappWebhookRouter = crearRouter();
whatsappWebhookRouter.get(
  '/webhook',
  manejar((req, res) => whatsappWebhook.verify(req.query["hub.mode"] as string, req.query["hub.verify_token"] as string, req.query["hub.challenge"] as string, res)),
);

whatsappWebhookRouter.post(
  '/webhook',
  manejar((req, res) => whatsappWebhook.receive(req, req.body, res)),
);
