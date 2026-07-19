import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createHmac, timingSafeEqual } from 'crypto';
import {
  WHATSAPP_INBOUND_EVENT, WHATSAPP_OUTBOUND_EVENT, WHATSAPP_STATUS_EVENT,
  type InboundWhatsappMessage, type WhatsappStatusUpdate,
} from './whatsapp.types';

/**
 * Transporte de WhatsApp a través de KAPSO (https://kapso.com), un proxy sobre la
 * Cloud API OFICIAL de Meta (WhatsApp Business Platform). A diferencia de las
 * librerías no oficiales (Baileys), no hay riesgo de baneo y cumple la política de
 * Meta para bots de propósito específico.
 *
 * La API de Kapso es la misma Graph API de Meta; solo cambia:
 *   - base URL → https://api.kapso.ai/meta/whatsapp
 *   - auth     → header `X-API-Key` (en vez de `Authorization: Bearer`)
 *
 * Entrada: webhook (reenviado por Kapso en formato Meta, firmado X-Hub-Signature-256)
 *          → emite WHATSAPP_INBOUND_EVENT.
 * Salida:  POST /{version}/{phoneNumberId}/messages.
 *
 * Se activa cuando KAPSO_API_KEY y KAPSO_PHONE_NUMBER_ID están definidos. Si no,
 * degrada a log (no lanza), para no romper el motor de alertas ni el arranque.
 *
 * Lo exporta el WhatsappModule para que cualquier canal (alertas de inventario,
 * mantenimiento, SST…) y el chatbot puedan enviar mensajes.
 */
/** Resultado de comprobar las credenciales contra Kapso (ver `probe()`). */
export interface WhatsappProbe {
  /** true = las credenciales sirven y el número respondió. */
  ok: boolean;
  error?: string;
  phone?: string | null;
  name?: string | null;
  quality?: string | null;
  /** 'EXPIRED' aquí suele impedir enviar aunque el resto esté bien. */
  codeVerification?: string | null;
  platform?: string | null;
}

@Injectable()
export class WhatsappService {
  private readonly logger = new Logger('WhatsappService');
  private probeCache: { at: number; result: WhatsappProbe } | null = null;
  /** Versión de la Graph API que Kapso expone en la ruta (p. ej. v24.0). */
  private get graphVersion() {
    return process.env.KAPSO_GRAPH_VERSION ?? 'v24.0';
  }
  private get baseUrl() {
    return (process.env.KAPSO_BASE_URL ?? 'https://api.kapso.ai/meta/whatsapp').replace(/\/+$/, '');
  }

  constructor(private readonly events: EventEmitter2) {}

  private get apiKey() {
    return process.env.KAPSO_API_KEY ?? '';
  }
  private get phoneNumberId() {
    return process.env.KAPSO_PHONE_NUMBER_ID ?? '';
  }
  private get appSecret() {
    return process.env.WHATSAPP_WEBHOOK_APP_SECRET ?? '';
  }
  /** Token arbitrario configurado en el panel/Meta y validado en el GET del webhook. */
  get verifyToken() {
    return process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN ?? '';
  }
  get enabled() {
    return !!this.apiKey && !!this.phoneNumberId;
  }

  /** Headers de autenticación de Kapso. */
  private authHeaders(): Record<string, string> {
    return { 'X-API-Key': this.apiKey };
  }

  /**
   * Estado por CONFIGURACIÓN: dice que las variables están puestas, NO que sirvan.
   * Para saber si de verdad se puede enviar, usa `probe()`.
   */
  status() {
    return {
      provider: 'kapso' as const,
      enabled: this.enabled,
      hasApiKey: !!this.apiKey,
      hasPhoneNumberId: !!this.phoneNumberId,
      hasAppSecret: !!this.appSecret,
      baseUrl: this.baseUrl,
      graphVersion: this.graphVersion,
    };
  }

  /**
   * Comprueba CONTRA KAPSO que las credenciales sirven y devuelve el estado real del
   * número.
   *
   * Existe porque `enabled` solo mira que las variables no estén vacías: con una API
   * key de un proyecto borrado, `enabled` decía true mientras la API respondía
   * `401 "Application has been deleted"` — y como `sendText` degrada a log, el chatbot
   * habría contestado al vacío sin que nadie se enterara. Esto es lo que hay que mirar
   * antes de encender el bot.
   *
   * Cacheado 60s: lo llama un panel, no hace falta pegarle a Kapso en cada refresco.
   */
  async probe(): Promise<WhatsappProbe> {
    if (this.probeCache && Date.now() - this.probeCache.at < 60_000) return this.probeCache.result;

    let result: WhatsappProbe;
    if (!this.enabled) {
      result = { ok: false, error: 'Kapso sin configurar: falta KAPSO_API_KEY o KAPSO_PHONE_NUMBER_ID.' };
    } else {
      const fields = 'display_phone_number,verified_name,quality_rating,code_verification_status,platform_type';
      const url = `${this.baseUrl}/${this.graphVersion}/${this.phoneNumberId}?fields=${fields}`;
      try {
        const res = await fetch(url, { headers: this.authHeaders() });
        const data: any = await res.json().catch(() => ({}));
        if (!res.ok || data?.error) {
          const msg = data?.error?.message ?? `HTTP ${res.status}`;
          result = { ok: false, error: `Kapso rechazó las credenciales: ${msg}` };
        } else {
          result = {
            ok: true,
            phone: data.display_phone_number ?? null,
            name: data.verified_name ?? null,
            quality: data.quality_rating ?? null,
            codeVerification: data.code_verification_status ?? null,
            platform: data.platform_type ?? null,
          };
        }
      } catch (e) {
        result = { ok: false, error: `No se pudo contactar a Kapso: ${(e as Error).message}` };
      }
    }
    if (!result.ok) this.logger.warn(`Diagnóstico de WhatsApp: ${result.error}`);
    this.probeCache = { at: Date.now(), result };
    return result;
  }

  /**
   * Verifica la firma del webhook con el secreto configurado, soportando los DOS
   * modos de Kapso (mismo HMAC-SHA256 del cuerpo crudo, distinto header/formato):
   *   - Webhook estructurado de Kapso → header `X-Webhook-Signature` = hex crudo.
   *   - Reenvío formato Meta          → header `X-Hub-Signature-256` = `sha256=`+hex.
   * Sin secreto configurado RECHAZA (fail-closed): este controller es el único sin
   * JwtAuthGuard, así que la firma es la única barrera. Aceptar sin verificar dejaría
   * el endpoint abierto a inyección de mensajes falsos si el arranque pierde el .env.
   */
  verifySignature(rawBody: Buffer | undefined, sig: { hub?: string; kapso?: string }): boolean {
    if (!this.appSecret) {
      this.logger.error(
        'WHATSAPP_WEBHOOK_APP_SECRET no configurado: webhook rechazado. ' +
          'Definir la variable para poder recibir mensajes entrantes.',
      );
      return false;
    }
    if (!rawBody) return false;
    const hex = createHmac('sha256', this.appSecret).update(rawBody).digest('hex');
    if (sig.kapso) return this.safeEqual(sig.kapso, hex); // Kapso: hex crudo
    if (sig.hub) return this.safeEqual(sig.hub, 'sha256=' + hex); // Meta: sha256=hex
    return false;
  }

  private safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && timingSafeEqual(ab, bb);
  }

  /**
   * Procesa el payload del webhook y emite un evento por cada mensaje entrante
   * (texto o voz), soportando los dos formatos de Kapso:
   *   - Reenvío Meta: `entry[].changes[].value.messages[]`.
   *   - Estructurado: `{ message: {...}, conversation: {...} }`.
   */
  processWebhook(body: any): void {
    try {
      // Modo 1: reenvío en formato Meta.
      if (Array.isArray(body?.entry)) {
        for (const entry of body.entry) {
          for (const change of entry?.changes ?? []) {
            const value = change?.value;
            // El BSUID de Meta puede omitir `from`; el wa_id del contacto es el respaldo.
            const contactWaId = value?.contacts?.[0]?.wa_id;
            for (const m of value?.messages ?? []) {
              // El audio requiere descarga async; no bloqueamos el ack 200 del webhook.
              void this.handleInboundMessage(m, contactWaId);
            }
            // Estados de entrega de mensajes salientes (sent/delivered/read/failed).
            for (const st of value?.statuses ?? []) this.handleStatus(st);
          }
        }
        return;
      }
      // Modo 2: webhook estructurado de Kapso (whatsapp.message.received).
      const msg = body?.message ?? body?.data?.message ?? null;
      if (msg) {
        if (msg?.kapso?.direction === 'outbound') {
          // Un eco saliente con estado también sirve para trackear entrega.
          if (msg?.status && (msg?.id || msg?.wa_message_id)) {
            this.handleStatus({ id: msg.id ?? msg.wa_message_id, status: msg.status, errors: msg.errors });
          }
          return;
        }
        const fallback = body?.conversation?.phone_number ?? body?.phone_number;
        void this.handleInboundMessage(msg, fallback);
        return;
      }
      // Modo 3: evento de estado estructurado de Kapso.
      const stMsg = body?.status ?? body?.data?.status ?? null;
      if (stMsg && (body?.message_id || body?.wa_message_id || stMsg?.message_id)) {
        this.handleStatus({ id: body?.message_id ?? body?.wa_message_id ?? stMsg?.message_id, status: stMsg?.value ?? stMsg, errors: body?.errors });
        return;
      }
      this.logger.log(`Webhook sin mensaje entrante reconocible. Claves: ${Object.keys(body ?? {}).join(', ')}`);
    } catch (e) {
      this.logger.warn(`Error procesando webhook Kapso: ${(e as Error).message}`);
    }
  }

  /** Normaliza un mensaje entrante (texto o nota de voz) y emite el evento. */
  private async handleInboundMessage(m: any, fallbackFrom?: string): Promise<void> {
    try {
      const from = String(m?.from ?? fallbackFrom ?? '').replace(/\D/g, '');
      if (!from) return;

      if (m.type === 'text') {
        const text = (m.text?.body ?? '').trim();
        if (!text) return;
        this.events.emit(WHATSAPP_INBOUND_EVENT, {
          transport: 'kapso',
          from,
          text,
          messageId: m.id,
        } satisfies InboundWhatsappMessage);
        return;
      }

      // Notas de voz / audio: descargar el media por Kapso y dejar que el
      // ChatbotService lo transcriba.
      if (m.type === 'audio' || m.type === 'voice') {
        const media = m.audio ?? m.voice;
        const mediaId = media?.id;
        if (!mediaId) return;
        const audio = await this.downloadMedia(mediaId);
        if (!audio) return;
        this.events.emit(WHATSAPP_INBOUND_EVENT, {
          transport: 'kapso',
          from,
          text: '',
          audio: { data: audio.data, mimetype: media?.mime_type ?? audio.mimetype },
          messageId: m.id,
        } satisfies InboundWhatsappMessage);
        return;
      }
      // Otros tipos (imágenes, ubicación, etc.) se ignoran por ahora.
    } catch (e) {
      this.logger.warn(`Error normalizando mensaje Kapso: ${(e as Error).message}`);
    }
  }

  /** Normaliza un cambio de estado de entrega y emite el evento para persistirlo. */
  private handleStatus(st: any): void {
    try {
      const messageId = String(st?.id ?? st?.message_id ?? '').trim();
      const raw = String(st?.status ?? '').toLowerCase();
      if (!messageId || !raw) return;
      const status = (['sent', 'delivered', 'read', 'failed'] as const).find((s) => raw === s);
      if (!status) return;
      const error = status === 'failed'
        ? (st?.errors?.[0]?.title ?? st?.errors?.[0]?.message ?? st?.error ?? 'Error de entrega')
        : undefined;
      this.events.emit(WHATSAPP_STATUS_EVENT, { messageId, status, error } satisfies WhatsappStatusUpdate);
    } catch (e) {
      this.logger.warn(`Error normalizando estado Kapso: ${(e as Error).message}`);
    }
  }

  /**
   * Envía una plantilla (HSM) aprobada en Meta. Es el único modo de INICIAR
   * conversación fuera de la ventana de 24h. `bodyParams` son los valores de las
   * variables {{1}},{{2}}… del cuerpo, en orden. Devuelve el id del mensaje (para
   * trackear su estado por el webhook) o un error.
   */
  async sendTemplate(
    to: string,
    templateName: string,
    languageCode: string,
    bodyParams: string[] = [],
  ): Promise<{ ok: boolean; messageId?: string; error?: string }> {
    if (!this.enabled) {
      this.logger.log(`[plantilla no enviada · WhatsApp deshabilitado] → ${to}: ${templateName}`);
      return { ok: false, error: 'WhatsApp no está configurado (Kapso)' };
    }
    const url = `${this.baseUrl}/${this.graphVersion}/${this.phoneNumberId}/messages`;
    const components = bodyParams.length
      ? [{ type: 'body', parameters: bodyParams.map((t) => ({ type: 'text', text: String(t ?? '') })) }]
      : undefined;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: to.replace(/\D/g, ''),
          type: 'template',
          template: { name: templateName, language: { code: languageCode }, components },
        }),
      });
      const data = await res.json().catch(() => ({} as any));
      if (!res.ok) {
        const error = data?.error?.message ?? `HTTP ${res.status}`;
        this.logger.warn(`Kapso ${res.status} enviando plantilla a ${to}: ${JSON.stringify(data)}`);
        return { ok: false, error };
      }
      return { ok: true, messageId: data?.messages?.[0]?.id };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /**
   * Descarga un media entrante por Kapso en dos pasos:
   *  1) GET /{version}/{mediaId}?phone_number_id=… (con X-API-Key) → JSON con
   *     `download_url` (URL firmada de Kapso, token embebido, expira ~4 min);
   *  2) GET de ese download_url SIN headers → bytes.
   * Devuelve el buffer o null.
   */
  private async downloadMedia(mediaId: string): Promise<{ data: Buffer; mimetype?: string } | null> {
    if (!this.enabled) return null;
    try {
      const metaUrl = `${this.baseUrl}/${this.graphVersion}/${mediaId}?phone_number_id=${encodeURIComponent(this.phoneNumberId)}`;
      const metaRes = await fetch(metaUrl, { headers: this.authHeaders() });
      if (!metaRes.ok) {
        this.logger.warn(`Kapso ${metaRes.status} resolviendo media ${mediaId}.`);
        return null;
      }
      const meta = (await metaRes.json()) as { download_url?: string; url?: string; mime_type?: string };
      const downloadUrl = meta?.download_url ?? meta?.url;
      if (!downloadUrl) return null;
      // El download_url de Kapso lleva el token embebido: se descarga sin headers.
      const binRes = await fetch(downloadUrl);
      if (!binRes.ok) {
        this.logger.warn(`Kapso ${binRes.status} descargando media ${mediaId}.`);
        return null;
      }
      const data = Buffer.from(await binRes.arrayBuffer());
      return { data, mimetype: meta.mime_type };
    } catch (e) {
      this.logger.warn(`Error descargando media Kapso: ${(e as Error).message}`);
      return null;
    }
  }

  /**
   * Envía un texto. Si Kapso no está configurado, NO lanza: registra en log y
   * retorna false, para no romper el motor de alertas.
   */
  async sendText(to: string, text: string): Promise<boolean> {
    if (!this.enabled) {
      this.logger.log(`[no enviado · WhatsApp deshabilitado] → ${to}: ${text}`);
      return false;
    }
    const url = `${this.baseUrl}/${this.graphVersion}/${this.phoneNumberId}/messages`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: to.replace(/\D/g, ''),
          type: 'text',
          text: { body: text },
        }),
      });
      if (!res.ok) {
        this.logger.warn(`Kapso ${res.status} enviando a ${to}: ${await res.text()}`);
        return false;
      }
      const data = await res.json().catch(() => ({}));
      // Registrar en el log de conversación (lo persiste WhatsappLogService).
      this.events.emit(WHATSAPP_OUTBOUND_EVENT, { to: to.replace(/\D/g, ''), text, messageId: data?.messages?.[0]?.id });
      return true;
    } catch (e) {
      this.logger.warn(`Error Kapso enviando a ${to}: ${(e as Error).message}`);
      return false;
    }
  }

  /**
   * Envía un documento (p. ej. un PDF) en dos pasos, como exige la Cloud API:
   *  1) subir el binario a /media → obtener un mediaId;
   *  2) enviar un mensaje type:document referenciando ese mediaId.
   * Mismo contrato tolerante que sendText: degrada a log si no está configurado.
   */
  async sendDocument(
    to: string,
    buffer: Buffer,
    fileName: string,
    caption?: string,
    mimetype = 'application/pdf',
  ): Promise<boolean> {
    if (!this.enabled) {
      this.logger.log(`[doc no enviado · WhatsApp deshabilitado] → ${to}: ${fileName}`);
      return false;
    }
    try {
      const mediaId = await this.uploadMedia(buffer, fileName, mimetype);
      if (!mediaId) return false;
      const url = `${this.baseUrl}/${this.graphVersion}/${this.phoneNumberId}/messages`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: to.replace(/\D/g, ''),
          type: 'document',
          document: { id: mediaId, filename: fileName, caption: caption || undefined },
        }),
      });
      if (!res.ok) {
        this.logger.warn(`Kapso ${res.status} enviando documento a ${to}: ${await res.text()}`);
        return false;
      }
      return true;
    } catch (e) {
      this.logger.warn(`Error Kapso enviando documento a ${to}: ${(e as Error).message}`);
      return false;
    }
  }

  /** Sube un binario a la Media API (vía Kapso) y devuelve su id (o null si falla). */
  private async uploadMedia(buffer: Buffer, fileName: string, mimetype: string): Promise<string | null> {
    const url = `${this.baseUrl}/${this.graphVersion}/${this.phoneNumberId}/media`;
    try {
      const form = new FormData();
      form.append('messaging_product', 'whatsapp');
      form.append('type', mimetype);
      form.append('file', new Blob([buffer as unknown as BlobPart], { type: mimetype }), fileName);
      const res = await fetch(url, {
        method: 'POST',
        headers: this.authHeaders(),
        body: form,
      });
      if (!res.ok) {
        this.logger.warn(`Kapso ${res.status} subiendo media: ${await res.text()}`);
        return null;
      }
      const json = (await res.json()) as { id?: string };
      return json?.id ?? null;
    } catch (e) {
      this.logger.warn(`Error Kapso subiendo media: ${(e as Error).message}`);
      return null;
    }
  }

  /** Destinatarios por defecto desde WHATSAPP_ALERT_TO (coma-separado, E.164 sin +). */
  defaultRecipients(): string[] {
    return (process.env.WHATSAPP_ALERT_TO ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /** Compatibilidad: el motor de alertas consulta si el canal está listo. */
  isReady() {
    return this.enabled;
  }
}
