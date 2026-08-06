import { Logger } from '../../core/logger';
import type { Request, Response } from 'express';
import { WhatsappService } from './whatsapp.service';

/**
 * Webhook PÚBLICO de WhatsApp (Kapso reenvía el evento de Meta en formato Graph).
 * No lleva JwtAuthGuard: el emisor no manda token; la autenticidad se valida con
 * la firma X-Hub-Signature-256 (App Secret de Meta).
 *
 * Configurar en el panel de Kapso como URL de reenvío del número:
 *   https://<host>/api/whatsapp/webhook
 * y el mismo Verify Token que WHATSAPP_WEBHOOK_VERIFY_TOKEN (handshake GET).
 */
export class WhatsappWebhookController {
  private readonly logger = new Logger('WhatsappWebhookController');

  constructor(private readonly whatsapp: WhatsappService) {}

  /** Verificación del webhook (handshake inicial estilo Meta). */
  verify(
    mode: string,
    token: string,
    challenge: string,
    res: Response,
  ) {
    if (mode === 'subscribe' && token && token === this.whatsapp.verifyToken) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send('forbidden');
  }

  /** Recepción de eventos (mensajes). Valida la firma antes de procesar. */
  receive(req: Request, body: any, res: Response) {
    const sig = {
      kapso: req.header('x-webhook-signature'), // webhook estructurado de Kapso
      hub: req.header('x-hub-signature-256'), // reenvío formato Meta
    };
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!this.whatsapp.verifySignature(rawBody, sig)) {
      this.logger.warn('Webhook con firma inválida: descartado.');
      return res.status(401).send('invalid signature');
    }
    // Responder 200 de inmediato (el emisor reintenta si tarda) y procesar aparte.
    this.whatsapp.processWebhook(body);
    return res.status(200).send('ok');
  }
}
