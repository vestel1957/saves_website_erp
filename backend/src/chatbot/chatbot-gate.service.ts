import { Logger } from '../core/logger';
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
 * Ids de los planes que el agente público puede ofrecer (separados por coma).
 *
 * Existe porque el catálogo heredado tiene 72 planes ACTIVOS —tarifas viejas,
 * duplicadas y cosas como "1 Mega por $20.000"— y quien pregunta por WhatsApp es
 * casi siempre alguien que quiere contratar. Listárselos todos no es informar, es
 * confundir y además cotizar planes que ya no se venden. Vacío = se ofrecen todos
 * (comportamiento anterior, sin sorpresas al desplegar).
 */
export const CHATBOT_PLANS_KEY = 'chatbot.planesPublicos';

/**
 * ¿Se le pregunta al cliente si su servicio quedó bien cuando se cierra la orden que
 * él abrió por WhatsApp? (ver `TicketConfirmacionService`). Encendido por omisión: es
 * el que evita que una avería se dé por resuelta sin que el cliente lo sepa.
 */
export const CHATBOT_CONFIRMAR_KEY = 'chatbot.confirmarSolucion';

/**
 * ¿Puede el bot escribir SIN que le pregunten? (técnico asignado, pago aplicado — ver
 * `AvisosProactivosService`).
 *
 * APAGADO por omisión, y a conciencia: es la única conducta del bot que le llega a un
 * cliente que no escribió nada. Un aviso de más no es un mensaje raro en un chat, es
 * una queja y un golpe a la calificación del número en Meta. Se enciende cuando el
 * equipo lo decida, no al desplegar.
 */
export const CHATBOT_AVISOS_KEY = 'chatbot.avisosProactivos';

/**
 * Cache corta. El corte tiene que sentirse INMEDIATO —es el botón de pánico cuando el
 * bot le está diciendo disparates a un cliente—, así que 5s en vez de los 15s de
 * Mikrotik. La consulta cuesta ~5 ms contra los ~2000 ms que tarda una respuesta:
 * irrelevante.
 */
const TTL_MS = 5000;

/**
 * Motivo por el que el bot no atiende, en clave estable para que el transporte pueda
 * reaccionar distinto a cada uno sin comparar textos en español.
 */
export type MotivoVeto = 'apagado' | 'escalada' | 'tope' | 'piloto';

/**
 * Lo que se le dice al cliente cuando el bot topó el cupo del día.
 *
 * Deliberadamente no menciona tokens, cupos ni fallas técnicas: al cliente no le
 * incumbe y solo genera desconfianza. Lo único que importa es que sepa que su mensaje
 * llegó y que alguien lo va a contestar.
 */
const AVISO_TOPE =
  '¡Gracias por escribirnos! 🙌 En este momento no puedo responderte automáticamente, ' +
  'pero tu mensaje ya quedó registrado y un asesor de Vestel te continúa por este mismo chat.';

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

  /**
   * ¿Atiende el bot a este número ahora mismo?
   *
   * `aviso`, cuando viene, es un texto que el transporte DEBE enviarle al cliente: hay
   * vetos (el tope de gasto) en los que el silencio deja a alguien esperando una
   * respuesta que no va a llegar nunca.
   */
  async shouldHandle(
    phone: string,
  ): Promise<{ ok: boolean; reason?: string; code?: MotivoVeto; aviso?: string }> {
    const c = await this.load();
    if (!c.enabled) return { ok: false, reason: 'apagado', code: 'apagado' };

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
      // Sin `aviso`: ya se le avisó cuando se escaló. Repetirlo en cada mensaje sería
      // spam a un cliente que está esperando a una persona.
      return { ok: false, reason: 'la atiende una persona (escalada)', code: 'escalada' };
    }

    const digits = normalizePhone(phone);

    // Tope de gasto del día: freno de emergencia. Se comprueba aquí, en el transporte,
    // para que al superarlo no se gaste ni un token más.
    if (await this.usage.exceeded()) {
      // Y se escala a una persona, que es lo que faltaba: antes el bot simplemente
      // hacía `return` y el cliente se quedaba sin respuesta, sin chulito de leído y
      // sin que nadie en la empresa supiera que había alguien esperando. El handoff lo
      // pone en la bandeja de WhatsApp y, de paso, hace que el resto de sus mensajes
      // corten arriba (en `isHandedOff`) sin volver a consultar el tope.
      await this.escalarPorTope(phone);
      return { ok: false, reason: 'se superó el tope de tokens de hoy', code: 'tope', aviso: AVISO_TOPE };
    }

    if (!c.allow.length) return { ok: true };
    return c.allow.includes(digits ?? '')
      ? { ok: true }
      : { ok: false, reason: 'fuera de la lista blanca del piloto', code: 'piloto' };
  }

  /**
   * Escala la conversación porque se agotó el cupo del día.
   *
   * Nunca propaga: si la escalada falla, el veto sigue siendo válido y lo peor que pasa
   * es que la conversación no aparezca en la bandeja. Dejar que una excepción suba de
   * aquí haría que el mensaje se procesara —o se perdiera— por una razón que no tiene
   * nada que ver con atender al cliente.
   */
  private async escalarPorTope(phone: string): Promise<void> {
    try {
      await this.store.setHandoff(convKeyOf(phone), 'se agotó el tope de tokens del bot del día');
    } catch (e) {
      this.logger.warn(`No se pudo escalar ${phone} tras agotarse el tope: ${(e as Error).message}`);
    }
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

  /**
   * Ids de los planes que el agente público ofrece. Lista vacía = todos los activos.
   * No se cachea con el resto: se lee una vez por consulta de planes (poquísimas) y
   * así un cambio en el catálogo comercial se ve al instante.
   */
  async planesPublicos(): Promise<string[]> {
    try {
      const row = await this.prisma.appSetting.findUnique({
        where: { key: CHATBOT_PLANS_KEY },
        select: { value: true },
      });
      return (row?.value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    } catch (e) {
      // Ante un fallo de BD se ofrecen todos: es información pública, no hay riesgo.
      this.logger.warn(`No se pudo leer el catálogo comercial del bot: ${(e as Error).message}`);
      return [];
    }
  }

  /**
   * Las dos conductas que el bot ejecuta por su cuenta, sin que nadie escriba: pedirle
   * confirmación al cliente cuando se cierra su orden, y avisarle de lo que pasa con
   * ella. Se leen en cada uso (son pocas veces) para que el interruptor de la UI surta
   * efecto al instante, igual que el interruptor general.
   *
   * El respaldo es la variable de entorno, y los valores por omisión NO son iguales a
   * propósito: la confirmación responde a algo que el cliente ya pidió y va encendida;
   * los avisos proactivos salen sin que nadie los pida y van apagados.
   */
  async conductas(): Promise<{ confirmarSolucion: boolean; avisosProactivos: boolean }> {
    const porDefecto = {
      confirmarSolucion: process.env.WA_BOT_CONFIRMAR !== 'false',
      avisosProactivos: process.env.WA_BOT_AVISOS === 'true',
    };
    try {
      const rows = await this.prisma.appSetting.findMany({
        where: { key: { in: [CHATBOT_CONFIRMAR_KEY, CHATBOT_AVISOS_KEY] } },
        select: { key: true, value: true },
      });
      const leer = (k: string, def: boolean) => {
        const v = rows.find((r) => r.key === k)?.value;
        return v === 'true' || v === 'false' ? v === 'true' : def;
      };
      return {
        confirmarSolucion: leer(CHATBOT_CONFIRMAR_KEY, porDefecto.confirmarSolucion),
        avisosProactivos: leer(CHATBOT_AVISOS_KEY, porDefecto.avisosProactivos),
      };
    } catch (e) {
      // Ante un fallo de BD se cae a lo que diga el entorno; para los avisos eso es
      // "apagado", que es el lado seguro (no se le escribe a nadie por error).
      this.logger.warn(`No se pudieron leer las conductas del bot: ${(e as Error).message}`);
      return porDefecto;
    }
  }

  async setConducta(
    cual: 'confirmarSolucion' | 'avisosProactivos',
    activa: boolean,
    updatedBy?: string,
  ) {
    const key = cual === 'confirmarSolucion' ? CHATBOT_CONFIRMAR_KEY : CHATBOT_AVISOS_KEY;
    await this.put(key, String(activa), updatedBy);
    this.logger.warn(`${cual} ${activa ? 'ACTIVADA' : 'desactivada'} por ${updatedBy ?? 'desconocido'}.`);
    return this.conductas();
  }

  async setPlanesPublicos(planIds: string[], updatedBy?: string) {
    const ids = [...new Set((planIds ?? []).map((s) => String(s).trim()).filter(Boolean))];
    await this.put(CHATBOT_PLANS_KEY, ids.join(','), updatedBy);
    this.logger.log(`Catálogo comercial del bot: ${ids.length ? `${ids.length} plan(es)` : '(vacío → ofrece todos los activos)'}`);
    return { planIds: ids };
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
