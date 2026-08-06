import { Logger } from '../../core/logger';
import type { EmisorDeEventos } from '../../core/eventos';
import { createHmac, timingSafeEqual } from 'crypto';
import { extensionDeAudio, mimeBase } from '../uploads';
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
  /** Tier de mensajería de Meta (TIER_250, TIER_1K, TIER_10K, TIER_100K, TIER_UNLIMITED). */
  tier?: string | null;
  /** 'EXPIRED' aquí suele impedir enviar aunque el resto esté bien. */
  codeVerification?: string | null;
  platform?: string | null;
}

/**
 * Tipos de mensaje que el bot NO puede leer, descritos en primera persona para que
 * el modelo sepa exactamente qué llegó y qué le falta. La clave es el `type` de la
 * Cloud API. Lo que no esté aquí (reacciones, system…) sí se ignora: no es un
 * mensaje que espere respuesta.
 */
const ADJUNTO_DESCRITO: Record<string, string> = {
  image: 'el cliente envió una FOTO que no puedes ver',
  document: 'el cliente envió un ARCHIVO/PDF que no puedes abrir',
  video: 'el cliente envió un VIDEO que no puedes ver',
  location: 'el cliente compartió su UBICACIÓN',
  sticker: 'el cliente envió un sticker',
  contacts: 'el cliente compartió un CONTACTO',
};

/**
 * Plantilla aprobada que se usa para reabrir la ventana de 24 h (ver
 * `reopenWithTemplate`). Cuerpo: "Hola {{1}}, te compartimos una información
 * importante sobre tu servicio de internet: {{2}}. Gracias por tu atención."
 */
const PLANTILLA_REAPERTURA = { name: 'aviso_general', language: 'es' };

export class WhatsappService {
  /**
   * Lo que queda escrito en el hilo de un mensaje `secreto`. Se guarda algo (y no
   * nada) a propósito: en la bandeja tiene que verse QUE se le mandó un código y
   * cuándo —es el rastro de "a esta persona le llegó algo a las 3:05"—, sin que se
   * pueda leer el código.
   */
  static readonly OCULTO = '🔐 Código de un solo uso (oculto por seguridad)';

  private readonly logger = new Logger('WhatsappService');
  private probeCache: { at: number; result: WhatsappProbe } | null = null;
  /** Versión de la Graph API que Kapso expone en la ruta (p. ej. v24.0). */
  private get graphVersion() {
    return process.env.KAPSO_GRAPH_VERSION ?? 'v24.0';
  }
  private get baseUrl() {
    return (process.env.KAPSO_BASE_URL ?? 'https://api.kapso.ai/meta/whatsapp').replace(/\/+$/, '');
  }

  constructor(private readonly events: EmisorDeEventos) {}

  private get apiKey() {
    return process.env.KAPSO_API_KEY ?? '';
  }
  private get phoneNumberId() {
    return process.env.KAPSO_PHONE_NUMBER_ID ?? '';
  }
  private get appSecret() {
    return process.env.WHATSAPP_WEBHOOK_APP_SECRET ?? '';
  }
  /** WhatsApp Business Account (WABA) dueña de las plantillas. */
  private get wabaId() {
    return process.env.KAPSO_WABA_ID ?? '';
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
      const fields = 'display_phone_number,verified_name,quality_rating,messaging_limit_tier,code_verification_status,platform_type';
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
            tier: data.messaging_limit_tier ?? null,
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
   * (texto o voz), soportando los formatos con los que Kapso entrega:
   *   - LOTE:         `{ type, batch: true, data: [...], batch_info }` (ver abajo).
   *   - Reenvío Meta: `entry[].changes[].value.messages[]`.
   *   - Estructurado: `{ message: {...}, conversation: {...} }`.
   *
   * `depth` solo lo usa la recursión de los sobres; nadie más debe pasarlo.
   */
  processWebhook(body: any, depth = 0): void {
    try {
      if (this.esDeOtroNumero(body)) return;
      // Modo 0: LOTE. El webhook de Kapso viene con `buffer_enabled` (ventana de 5 s),
      // así que los mensajes recibidos NO llegan sueltos: llegan agrupados dentro de
      // un sobre `{type, batch, data:[…], batch_info}`. Hasta el 2026-07-28 ese sobre
      // caía en el "no reconocible" del final y se descartaba en silencio — es decir,
      // TODOS los mensajes de clientes reales se perdían (los de prueba entraban por
      // otro formato y por eso el canal parecía sano). Cada elemento se reprocesa como
      // un webhook normal en vez de asumir su forma: si Kapso cambia el contenido del
      // lote, sigue funcionando mientras el elemento sea un evento válido.
      if (depth < 3 && Array.isArray(body?.data) && (body?.batch || body?.batch_info)) {
        for (const ev of body.data) this.processWebhook(ev, depth + 1);
        return;
      }

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
      // Sobre de un solo evento (`{event|type, data:{…}}`): se desenvuelve y se
      // reintenta. Va al final para no cambiar el orden de los modos anteriores.
      if (depth < 3 && body?.data && typeof body.data === 'object' && !Array.isArray(body.data)) {
        this.processWebhook(body.data, depth + 1);
        return;
      }

      // Se registra una MUESTRA del cuerpo, no solo las claves: cuando apareció el
      // formato de lote, saber los nombres de las claves no bastó para reconstruir
      // qué se estaba perdiendo. Recortado, que aquí puede venir texto del cliente.
      this.logger.log(
        `Webhook sin mensaje entrante reconocible. Claves: ${Object.keys(body ?? {}).join(', ')} · ` +
          `muestra: ${JSON.stringify(body ?? {}).slice(0, 300)}`,
      );
    } catch (e) {
      this.logger.warn(`Error procesando webhook Kapso: ${(e as Error).message}`);
    }
  }

  /**
   * ¿Este evento es de OTRO número de WhatsApp?
   *
   * El 2026-08-06 un mensaje dirigido al número de otro sistema (nexus) llegó
   * también a este webhook —el panel de Kapso tenía esta URL registrada en los
   * dos números— y el bot le contestó al cliente por el número de Vestel: dos
   * asistentes distintos respondiendo a la misma persona, uno de ellos sin
   * contexto ninguno. Lo delató que la respuesta saliera como plantilla, porque
   * la ventana de 24 h de ESTE número nunca se había abierto.
   *
   * Cada backend atiende exactamente un número. Lo que venga de otro se
   * registra y se descarta: la configuración del panel puede equivocarse, el
   * código no tiene por qué seguirle la corriente.
   */
  private esDeOtroNumero(body: any): boolean {
    const propio = this.phoneNumberId;
    if (!propio) return false; // sin número configurado no hay nada que comparar
    const entrante =
      body?.phone_number_id ??
      body?.conversation?.phone_number_id ??
      body?.data?.phone_number_id ??
      body?.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;
    if (!entrante || String(entrante) === propio) return false;

    this.logger.warn(
      `Webhook del número ${entrante} descartado: este sistema atiende el ${propio}.`,
    );
    return true;
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

      // Notas de voz / audio: se descarga el media por Kapso y se transcribe AQUÍ.
      //
      // La transcripción se hacía antes dentro del motor del bot (`engine.js` la pide
      // al `Transcriber` cuando el texto viene vacío), y eso tenía dos consecuencias
      // malas para el lado humano del canal: el texto no volvía nunca a nuestro código
      // —así que la bandeja guardaba "(nota de voz)" y nada más—, y si el bot estaba
      // apagado o el número quedaba fuera del piloto, la nota de voz no se transcribía
      // en absoluto. Quien atendía tenía que llamar al cliente para saber qué dijo.
      //
      // Hacerlo aquí no duplica el gasto: el motor solo transcribe si `text` llega
      // vacío, así que al mandárselo ya resuelto se salta su propia llamada.
      if (m.type === 'audio' || m.type === 'voice') {
        const media = m.audio ?? m.voice;
        const mediaId = media?.id;
        if (!mediaId) return;
        const audio = await this.downloadMedia(mediaId);
        // Si el audio no se pudo bajar, el cliente igual espera respuesta: se avisa
        // en vez de dejar la nota de voz en el vacío.
        if (!audio) {
          this.events.emit(WHATSAPP_INBOUND_EVENT, {
            transport: 'kapso',
            from,
            text: '(el cliente envió una NOTA DE VOZ que no se pudo descargar ni escuchar)',
            messageId: m.id,
          } satisfies InboundWhatsappMessage);
          return;
        }
        const mimetype = media?.mime_type ?? audio.mimetype;
        this.events.emit(WHATSAPP_INBOUND_EVENT, {
          transport: 'kapso',
          from,
          // Vacío si no se pudo transcribir: el motor lo intentará por su cuenta y, si
          // tampoco puede, le pide al cliente que lo escriba. El audio se guarda igual,
          // que es lo que permite escucharlo en la bandeja aunque no haya texto.
          text: (await this.transcribir(audio.data, mimetype)) ?? '',
          audio: { data: audio.data, mimetype },
          messageId: m.id,
        } satisfies InboundWhatsappMessage);
        return;
      }

      // Todo lo demás (foto del recibo, PDF, ubicación, sticker, contacto…) el bot no
      // lo puede leer, pero callarse es peor que decirlo: el cliente manda la foto del
      // comprobante y se queda esperando una respuesta que nunca llega. Entra al motor
      // una descripción de lo que llegó —con el pie de foto si lo trae, que muchas
      // veces es el mensaje de verdad— y el agente responde pidiendo lo que necesita.
      const descripcion = ADJUNTO_DESCRITO[String(m?.type ?? '')];
      if (descripcion) {
        const pie = String(m?.[m.type]?.caption ?? '').trim();
        this.events.emit(WHATSAPP_INBOUND_EVENT, {
          transport: 'kapso',
          from,
          text: `(${descripcion}${pie ? `. El pie del archivo dice: "${pie}"` : ''})`,
          messageId: m.id,
        } satisfies InboundWhatsappMessage);
      }
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

  // ---------- Plantillas en Meta (vía Kapso, a nivel WABA) ----------

  /**
   * Estado real de las plantillas en Meta: nombre → status (APPROVED/PENDING/REJECTED).
   * Cacheado 60s (lo consulta el listado del panel). Devuelve null si no hay WABA
   * configurada o la API falla — el caller distingue "no sé" de "no existe".
   */
  private metaTplCache: { at: number; map: Record<string, string> } | null = null;
  async metaTemplateStatuses(): Promise<Record<string, string> | null> {
    if (!this.enabled || !this.wabaId) return null;
    if (this.metaTplCache && Date.now() - this.metaTplCache.at < 60_000) return this.metaTplCache.map;
    try {
      const url = `${this.baseUrl}/${this.graphVersion}/${this.wabaId}/message_templates?limit=200`;
      const res = await fetch(url, { headers: this.authHeaders() });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok || !Array.isArray(data?.data)) return null;
      const map: Record<string, string> = {};
      for (const t of data.data) if (t?.name) map[t.name] = String(t.status ?? '');
      this.metaTplCache = { at: Date.now(), map };
      return map;
    } catch {
      return null;
    }
  }

  /**
   * Crea la plantilla en Meta (queda PENDING hasta que Meta la apruebe). El body
   * usa {{1}},{{2}}… y Meta exige un ejemplo por variable; también prohíbe
   * variables al inicio/fin del cuerpo (eso se valida aquí para dar error claro).
   */
  async createMetaTemplate(tpl: {
    name: string; language: string; category?: string | null;
    bodyText: string; headerText?: string | null; examples: string[];
  }): Promise<{ ok: boolean; status?: string; error?: string }> {
    if (!this.enabled || !this.wabaId) {
      return { ok: false, error: 'Kapso sin configurar (falta KAPSO_WABA_ID).' };
    }
    if (/^\s*\{\{\d+\}\}/.test(tpl.bodyText) || /\{\{\d+\}\}\s*$/.test(tpl.bodyText)) {
      return { ok: false, error: 'Meta no permite variables al inicio ni al final del cuerpo.' };
    }
    const nVars = new Set(tpl.bodyText.match(/\{\{(\d+)\}\}/g) ?? []).size;
    const body: any = { type: 'BODY', text: tpl.bodyText };
    if (nVars > 0) body.example = { body_text: [tpl.examples.slice(0, nVars)] };
    const components: any[] = [];
    if (tpl.headerText?.trim()) components.push({ type: 'HEADER', format: 'TEXT', text: tpl.headerText.trim() });
    components.push(body);
    try {
      const res = await fetch(`${this.baseUrl}/${this.graphVersion}/${this.wabaId}/message_templates`, {
        method: 'POST',
        headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: tpl.name, language: tpl.language, category: tpl.category || 'UTILITY',
          allow_category_change: true, components,
        }),
      });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok || data?.error) {
        const e = data?.error;
        return { ok: false, error: e?.error_user_msg ?? e?.message ?? `HTTP ${res.status}` };
      }
      this.metaTplCache = null;
      return { ok: true, status: data?.status ?? 'PENDING' };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
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
  ): Promise<{ ok: boolean; messageId?: string; error?: string; retryable?: boolean }> {
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
        // Rate-limit de Meta: 4 = too many API calls, 80007 = throughput,
        // 130429 = rate limit hit. Esos se pueden reintentar con backoff;
        // el resto (plantilla inválida, número inexistente…) no.
        const code = Number(data?.error?.code ?? 0);
        const retryable = res.status === 429 || [4, 80007, 130429].includes(code);
        this.logger.warn(`Kapso ${res.status} enviando plantilla a ${to}: ${JSON.stringify(data)}`);
        return { ok: false, error, retryable };
      }
      return { ok: true, messageId: data?.messages?.[0]?.id };
    } catch (e) {
      // Error de red (timeout, DNS…): transitorio, se puede reintentar.
      return { ok: false, error: (e as Error).message, retryable: true };
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
        // Con el detalle: un 400 a secas no dice si el id caducó, si es de otro
        // número o si la ruta cambió, y las notas de voz se pierden calladas.
        this.logger.warn(`Kapso ${metaRes.status} resolviendo media ${mediaId}: ${(await metaRes.text()).slice(0, 200)}`);
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
   * Pasa una nota de voz a texto con Whisper. Devuelve null si no se pudo (y nunca
   * lanza: una transcripción fallida no puede tumbar la recepción del mensaje, que ya
   * está descargado y se va a guardar igual).
   *
   * Se apaga con `WA_AUDIO_TRANSCRIBE=false`; el audio se sigue guardando y se puede
   * escuchar en la bandeja, solo deja de haber texto.
   */
  private async transcribir(data: Buffer, mimetype?: string): Promise<string | null> {
    if (process.env.WA_AUDIO_TRANSCRIBE === 'false') return null;
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return null;
    // Tope de la API (25 MB). Una nota de voz jamás se acerca, pero un audio reenviado
    // desde la galería sí puede: mejor no gastar la subida para que la rechacen.
    if (data.byteLength > 24 * 1024 * 1024) {
      this.logger.warn(`Nota de voz de ${Math.round(data.byteLength / 1024)} KB: demasiado grande para transcribir.`);
      return null;
    }
    try {
      const { default: OpenAI, toFile } = await import('openai');
      const client = new OpenAI({ apiKey, timeout: 30_000, maxRetries: 1 });
      // El nombre importa: la API deduce el formato de la extensión, y sin ella
      // rechaza el archivo aunque los bytes estén bien.
      const ext = extensionDeAudio(mimetype) ?? '.ogg';
      const file = await toFile(data, `nota-de-voz${ext}`, { type: mimeBase(mimetype) || 'audio/ogg' });
      const r = await client.audio.transcriptions.create({
        file,
        model: process.env.WHATSAPP_STT_MODEL ?? 'whisper-1',
        language: 'es',
      });
      const texto = (r.text ?? '').trim();
      if (texto) this.logger.log(`Nota de voz transcrita (${texto.length} car.).`);
      return texto || null;
    } catch (e) {
      this.logger.warn(`No se pudo transcribir la nota de voz: ${(e as Error).message}`);
      return null;
    }
  }

  /**
   * Marca el mensaje entrante como LEÍDO (chulitos azules) y enciende el
   * "escribiendo…" en el chat de quien escribió.
   *
   * Es la única forma de dar señal de vida mientras el agente piensa: entre la
   * transcripción de una nota de voz, las vueltas de herramientas y el LLM, un turno
   * puede tardar más de diez segundos, y hasta ahora el cliente no veía absolutamente
   * nada en ese rato — ni siquiera que el mensaje se había leído.
   *
   * No hay nada que "apagar": la Cloud API baja el indicador sola al enviar la
   * respuesta o a los ~25 s. Cualquier fallo se degrada a log y devuelve false: esto
   * es cosmética, y jamás debe impedir que salga la respuesta de verdad.
   */
  async sendTypingIndicator(messageId: string): Promise<boolean> {
    if (!this.enabled || !messageId) return false;
    const url = `${this.baseUrl}/${this.graphVersion}/${this.phoneNumberId}/messages`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          status: 'read',
          message_id: messageId,
          typing_indicator: { type: 'text' },
        }),
      });
      if (!res.ok) {
        this.logger.warn(`Kapso ${res.status} enviando "escribiendo…": ${await res.text()}`);
        return false;
      }
      return true;
    } catch (e) {
      this.logger.warn(`Error Kapso enviando "escribiendo…": ${(e as Error).message}`);
      return false;
    }
  }

  /**
   * Envía un texto. Si Kapso no está configurado, NO lanza: registra en log y
   * retorna false, para no romper el motor de alertas.
   *
   * `reopenWithTemplate` lo usa SOLO el chatbot: ver `reopenWithTemplate()`.
   * `sentById` viaja hasta el log para distinguir en el hilo lo que escribió una
   * PERSONA desde la bandeja de lo que mandó el sistema (bot, alerta o campaña).
   *
   * `secreto` para lo que NO puede quedar escrito en ninguna parte: los códigos
   * de un solo uso. Todo lo que sale se persiste literal en `WhatsappMessage` y
   * se ve en la bandeja /whatsapp, así que sin esto cualquiera con ese permiso
   * leía el código de un compañero y se quedaba con su cuenta — justo lo que el
   * código venía a impedir. El mensaje sale igual; lo que se guarda es una marca.
   */
  async sendText(
    to: string,
    text: string,
    opts: { reopenWithTemplate?: boolean; sentById?: string; secreto?: boolean } = {},
  ): Promise<boolean> {
    if (!this.enabled) {
      this.logger.log(`[no enviado · WhatsApp deshabilitado] → ${to}: ${opts.secreto ? WhatsappService.OCULTO : text}`);
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
        const detalle = await res.text();
        this.logger.warn(`Kapso ${res.status} enviando a ${to}: ${detalle}`);
        if (opts.reopenWithTemplate && this.esVentanaCerrada(detalle)) {
          return this.reopenWithTemplate(to, text, opts.sentById, opts.secreto);
        }
        return false;
      }
      const data = await res.json().catch(() => ({}));
      // Registrar en el log de conversación (lo persiste WhatsappLogService).
      this.events.emit(WHATSAPP_OUTBOUND_EVENT, {
        to: to.replace(/\D/g, ''),
        text: opts.secreto ? WhatsappService.OCULTO : text,
        messageId: data?.messages?.[0]?.id,
        sentById: opts.sentById,
      });
      return true;
    } catch (e) {
      this.logger.warn(`Error Kapso enviando a ${to}: ${(e as Error).message}`);
      return false;
    }
  }

  /** ¿El rechazo es "fuera de la ventana de 24 h"? (Kapso lo dice en prosa, Meta con el código 131047). */
  private esVentanaCerrada(detalle: string): boolean {
    return /24-?hour window|131047|re-?engagement|template message to reopen/i.test(detalle);
  }

  /** Último envío por plantilla a cada teléfono: evita repetir la reapertura. */
  private readonly reaperturas = new Map<string, number>();

  /**
   * Ventana de 24 h cerrada: Meta prohíbe el texto libre y el cliente se quedaría sin
   * respuesta (era exactamente lo que pasaba: el bot pensaba, gastaba tokens y el
   * mensaje moría en un warning del log). La única salida legal es una plantilla
   * aprobada, así que la respuesta ya redactada viaja dentro de `aviso_general`.
   *
   * Dos cuidados:
   *  - Meta RECHAZA parámetros con saltos de línea, tabulaciones o 4+ espacios
   *    seguidos, y el bot escribe con viñetas: hay que aplanar el texto.
   *  - Cada plantilla abre una conversación FACTURABLE, así que se manda como mucho
   *    una por hora y por número. Si el cliente responde, la ventana queda abierta y
   *    el resto de la conversación vuelve a ser texto libre y gratis.
   */
  private async reopenWithTemplate(to: string, text: string, sentById?: string, secreto?: boolean): Promise<boolean> {
    const digits = to.replace(/\D/g, '');
    const ultima = this.reaperturas.get(digits) ?? 0;
    if (Date.now() - ultima < 60 * 60 * 1000) {
      this.logger.warn(`Ventana cerrada con ${digits} y ya se le mandó una plantilla hace menos de 1 h: no se repite.`);
      return false;
    }

    const cuerpo = text.replace(/\s+/g, ' ').trim().slice(0, 700);
    if (!cuerpo) return false;

    const r = await this.sendTemplate(digits, PLANTILLA_REAPERTURA.name, PLANTILLA_REAPERTURA.language, ['buen día', cuerpo]);
    if (!r.ok) {
      this.logger.error(`No se pudo responder a ${digits} ni por plantilla: ${r.error}`);
      return false;
    }
    this.reaperturas.set(digits, Date.now());
    this.logger.log(`Ventana de 24 h cerrada con ${digits}: la respuesta salió como plantilla ${PLANTILLA_REAPERTURA.name}.`);
    this.events.emit(WHATSAPP_OUTBOUND_EVENT, { to: digits, text: secreto ? WhatsappService.OCULTO : text, messageId: r.messageId, sentById });
    return true;
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
