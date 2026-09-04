import { Logger } from '../../core/logger';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
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
 *
 * REENVÍO (`WHATSAPP_WEBHOOK_FORWARD_URL`): el chatbot ya no vive aquí sino en la
 * instancia de /home/dev/saves_vestel (puerto 3081), pero el número sigue dado de
 * alta contra este host —es el que tiene el certificado de app.saves.com.co—, así
 * que este endpoint recibe y le pasa el evento tal cual. Aquí el bot está apagado
 * (`WA_AGENT_ENABLED=false`), de modo que solo uno de los dos contesta.
 *
 * El evento SÍ se sigue procesando aquí además de reenviarlo: apagado el agente,
 * `processWebhook` únicamente alimenta el log de conversaciones, y los funcionarios
 * que trabajan en este sistema tienen que seguir viendo lo que escriben los clientes.
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
    this.reenviar(req, rawBody);
    return res.status(200).send('ok');
  }

  /**
   * Pasa el evento, tal cual, a la instancia que sí lleva el chatbot.
   *
   * Dos detalles que no son opcionales:
   *  · Se mandan los BYTES CRUDOS, no `JSON.stringify(body)`. La firma es un HMAC
   *    sobre esos bytes exactos; reserializar —aunque salga un JSON equivalente—
   *    la rompe y el destino responde 401.
   *  · Es fire-and-forget y va DESPUÉS del 200. Si el destino tarda o está caído,
   *    quien escribió no puede quedarse esperando: un reintento de Kapso es un
   *    mensaje duplicado para el cliente.
   */
  private reenviar(req: Request, rawBody?: Buffer) {
    const destino = (process.env.WHATSAPP_WEBHOOK_FORWARD_URL ?? '').trim();
    if (!destino || !rawBody) return;

    let url: URL;
    try {
      url = new URL(destino);
    } catch {
      this.logger.warn(`WHATSAPP_WEBHOOK_FORWARD_URL no es una URL válida: ${destino}`);
      return;
    }

    // Se copian las cabeceras del emisor —la firma y la clave de idempotencia son
    // las que el destino necesita— salvo las que describen ESTA conexión.
    const cabeceras: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (['host', 'connection', 'content-length', 'accept-encoding'].includes(k)) continue;
      if (typeof v === 'string') cabeceras[k] = v;
    }
    cabeceras['content-length'] = String(rawBody.byteLength);
    cabeceras['x-wa-forwarded'] = '1';

    const enviar = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const r = enviar(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'POST',
        headers: cabeceras,
        timeout: 15_000,
      },
      (resp) => {
        resp.resume(); // hay que drenar la respuesta o el socket queda colgado
        const ok = (resp.statusCode ?? 0) >= 200 && (resp.statusCode ?? 0) < 300;
        if (!ok) this.logger.warn(`El chatbot respondió ${resp.statusCode} al webhook reenviado.`);
      },
    );
    r.on('timeout', () => r.destroy(new Error('timeout de 15 s')));
    r.on('error', (e) =>
      // El caso típico: la instancia del chatbot está caída. Se avisa claro, porque
      // desde WhatsApp solo se ve un bot que dejó de contestar.
      this.logger.warn(`No se pudo reenviar el webhook a ${destino}: ${e.message}`),
    );
    r.end(rawBody);
  }
}
