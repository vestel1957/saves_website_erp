import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { normalizePhone } from '../common/phone.util';
import { ChatbotSessionStore } from './chatbot-session.store';
import { ChatbotUsageService } from './chatbot-usage.service';
import { convKeyOf } from './chatbot.identity';

/** Interruptor del bot. Igual que `network.mikrotikLive`: el ajuste manda, el env es el default. */
export const CHATBOT_ENABLED_KEY = 'chatbot.enabled';
/** Lista blanca de teléfonos (E.164, separados por coma). Vacía = atiende a todos. */
export const CHATBOT_ALLOWLIST_KEY = 'chatbot.allowlist';

/**
 * Cache corta. El corte tiene que sentirse INMEDIATO —es el botón de pánico cuando el
 * bot le está diciendo disparates a un cliente—, así que 5s en vez de los 15s de
 * Mikrotik. La consulta cuesta ~5 ms contra los ~2000 ms que tarda una respuesta:
 * irrelevante.
 */
const TTL_MS = 5000;

/**
 * Decide si el bot atiende un mensaje, en tiempo de MENSAJE (no de arranque).
 *
 * Existe porque apagar el bot editando `.env` + `pm2 restart` no es una opción cuando
 * hay clientes reales escribiendo: se necesita un interruptor que surta efecto en
 * segundos desde la UI. Sigue el patrón que el ERP ya usa para los cortes de red: el
 * `AppSetting` manda si está definido; si no existe la fila, decide la variable de
 * entorno.
 *
 * La lista blanca es para el piloto: con el número real conectado, encender sin filtro
 * pone al bot a hablarles a los 7.000 abonados de golpe. Con lista, solo contesta a los
 * números que tú digas y el resto sigue como hoy (silencio del bot, lo atiende una
 * persona) — el mensaje entrante igual queda en el log de conversaciones.
 */
@Injectable()
export class ChatbotGateService {
  private readonly logger = new Logger('ChatbotGate');
  private cache: { at: number; enabled: boolean; allow: string[]; fromSetting: boolean } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly store: ChatbotSessionStore,
    private readonly usage: ChatbotUsageService,
  ) {}

  private get envEnabled(): boolean {
    return process.env.WA_AGENT_ENABLED === 'true';
  }

  private async load() {
    if (this.cache && Date.now() - this.cache.at < TTL_MS) return this.cache;
    let enabled = this.envEnabled;
    let allow: string[] = [];
    let fromSetting = false;
    try {
      const rows = await this.prisma.appSetting.findMany({
        where: { key: { in: [CHATBOT_ENABLED_KEY, CHATBOT_ALLOWLIST_KEY] } },
        select: { key: true, value: true },
      });
      const val = (k: string) => rows.find((r) => r.key === k)?.value ?? null;
      const on = val(CHATBOT_ENABLED_KEY);
      if (on === 'true' || on === 'false') {
        enabled = on === 'true';
        fromSetting = true;
      }
      allow = this.parseList(val(CHATBOT_ALLOWLIST_KEY));
    } catch (e) {
      // Si la BD falla, NO se asume encendido: ante la duda, el bot se calla.
      this.logger.warn(`No se pudo leer la configuración del bot; se apaga por precaución: ${(e as Error).message}`);
      enabled = false;
    }
    this.cache = { at: Date.now(), enabled, allow, fromSetting };
    return this.cache;
  }

  /** Teléfonos normalizados a E.164 sin '+', para que casen con el `from` del webhook. */
  private parseList(raw: string | null): string[] {
    return (raw ?? '')
      .split(/[,;\s]+/)
      .map((p) => normalizePhone(p))
      .filter((p): p is string => !!p);
  }

  /** Invalida la cache: tras cambiar el ajuste, el efecto es inmediato y no en 5s. */
  private bust() {
    this.cache = null;
  }

  /** ¿Atiende el bot a este número ahora mismo? */
  async shouldHandle(phone: string): Promise<{ ok: boolean; reason?: string }> {
    const c = await this.load();
    if (!c.enabled) return { ok: false, reason: 'apagado' };

    // Escalada a una persona: manda sobre la lista blanca y sobre todo lo demás. Si el
    // cliente pidió un humano, que el bot vuelva a meterse en la conversación es peor
    // que no haberlo ofrecido nunca.
    //
    // OJO con la clave: se usa el teléfono TAL CUAL llega, sin normalizar, porque el
    // motor arma la suya así (`${msg.transport}:${msg.from}`, engine.js:146) y es esa
    // la que la herramienta guardó vía `ctx.convKey`. Normalizarla aquí buscaría
    // `kapso:57300…` contra un handoff guardado como `kapso:300…` y no lo encontraría
    // nunca: el bot seguiría respondiendo a quien pidió un humano.
    if (await this.store.isHandedOff(convKeyOf(phone))) {
      return { ok: false, reason: 'la atiende una persona (escalada)' };
    }

    const digits = normalizePhone(phone);

    // Tope de gasto del día: freno de emergencia. Se comprueba aquí, en el transporte,
    // para que al superarlo no se gaste ni un token más.
    if (await this.usage.exceeded()) {
      return { ok: false, reason: 'se superó el tope de tokens de hoy' };
    }

    if (!c.allow.length) return { ok: true };
    return c.allow.includes(digits ?? '')
      ? { ok: true }
      : { ok: false, reason: 'fuera de la lista blanca del piloto' };
  }

  /** Estado actual, para el panel. */
  async config() {
    const c = await this.load();
    return {
      enabled: c.enabled,
      /** De dónde sale el valor: el ajuste de la UI o la variable de entorno. */
      source: c.fromSetting ? ('ajuste' as const) : ('env' as const),
      envDefault: this.envEnabled,
      allowlist: c.allow,
      /** Con lista blanca, el bot está en piloto: no atiende al resto de abonados. */
      pilot: c.allow.length > 0,
    };
  }

  async setEnabled(enabled: boolean, updatedBy?: string) {
    await this.put(CHATBOT_ENABLED_KEY, String(enabled), updatedBy);
    this.logger.warn(`Bot de WhatsApp ${enabled ? 'ENCENDIDO' : 'APAGADO'} por ${updatedBy ?? 'desconocido'}.`);
    return this.config();
  }

  async setAllowlist(phones: string[], updatedBy?: string) {
    const list = this.parseList((phones ?? []).join(','));
    await this.put(CHATBOT_ALLOWLIST_KEY, list.join(','), updatedBy);
    this.logger.log(`Lista blanca del bot: ${list.length ? list.join(', ') : '(vacía → atiende a todos)'}`);
    return this.config();
  }

  private async put(key: string, value: string, updatedBy?: string) {
    await this.prisma.appSetting.upsert({
      where: { key },
      create: { key, value, group: 'chatbot', updatedBy },
      update: { value, updatedBy },
    });
    this.bust();
  }
}
