import { Logger } from '../../core/logger';
import { SubscriberStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { normalizePhone } from '../phone.util';
import { esMovilColombiano, WhatsappCampaignService } from './whatsapp-campaign.service';
import { whereExigible } from '../../billing/factura-exigible';
import { hoyEnColombia } from '../fecha-colombia';

const cop = (n: number) =>
  new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n || 0);

/** Interruptor de la corrida PROGRAMADA. El disparo manual siempre ejecuta. */
export const WA_REMINDERS_ENABLED_KEY = 'whatsapp.remindersEnabled';
/** Gate de envío real. Apagado ⇒ se calcula a quién se le escribiría, sin escribir. */
export const WA_REMINDERS_LIVE_KEY = 'whatsapp.remindersLive';
/** Tope de mensajes por corrida (límite de Meta: hoy 2.000 clientes únicos/24h). */
export const WA_REMINDERS_CAP_KEY = 'whatsapp.remindersDailyCap';

/**
 * Plantilla aprobada en Meta que se usa. Variables: {{1}} nombre, {{2}} deuda.
 * Lleva el sufijo `_hx…` (herencia de los ContentSid de Twilio) porque así se llaman
 * en la WABA del número +57 322 4478769, a la que se clonaron conservando el nombre:
 * tiene que ser EXACTO o Meta responde "template name does not exist" y la corrida
 * entera sale FAILED.
 */
const TEMPLATE = 'vestel_mas_del_mes_pendiente_una_vez_por_semana_103_hx1b7a454c9509332e761b476c48c5665e';

/**
 * Estados a los que se les recuerda la deuda: los que siguen siendo clientes.
 * Fuera quedan DEPURADO/RETIRADO/POR_RETIRAR (ya no son clientes: cobrarles por
 * WhatsApp es la vía rápida a un reporte de spam), EXONERADO (no paga por acuerdo),
 * e INSTALAR/EVENTO (no hay servicio prestado todavía).
 */
const ESTADOS_COBRABLES: SubscriberStatus[] = [
  SubscriberStatus.ACTIVO,
  SubscriberStatus.CORTADO,
  SubscriberStatus.CARTERA,
  SubscriberStatus.COMPROMISO,
  SubscriberStatus.SUSPENDIDO,
];

/** No se le vuelve a escribir al mismo abonado antes de esto. */
const DEDUPE_DIAS = 7;

/**
 * Deuda mínima para molestar a alguien. Por debajo suele ser un resto de redondeo
 * o un ajuste pendiente, y un WhatsApp de cobro por $300 hace más daño que bien.
 */
const DEUDA_MINIMA = 1000;

/** Tope por corrida si nadie lo configuró. Muy por debajo del TIER_2K de la línea. */
const CAP_DEFECTO = 150;

type Candidato = {
  id: string;
  abonado: number | null;
  phone: string;
  deuda: number;
  status: SubscriberStatus | null;
};

/**
 * Recordatorio de cartera por WhatsApp: el bot deja de ser solo reactivo y sale a
 * buscar al moroso.
 *
 * Va por PLANTILLA aprobada (ver `TEMPLATE`) porque estos clientes llevan
 * meses sin escribir: fuera de la ventana de 24 h de Meta el texto libre se
 * rechaza. Y va montado sobre el motor de campañas que ya existe, en vez de un
 * bucle propio de `sendTemplate`, para heredar el throttle, el reintento con
 * backoff ante rate-limit, el seguimiento de entrega por webhook y el reporte de
 * /whatsapp/masivo — una corrida del cron se ve y se audita igual
 * que una campaña lanzada a mano.
 *
 * Si el cliente RESPONDE, el mensaje entra por el webhook de siempre y lo atiende
 * el chatbot (su teléfono resuelve a abonado ⇒ agente de clientes): puede
 * consultar su saldo, pedir el PDF de la factura o hablar con una persona. Ese es
 * el punto de mandarlo por este canal y no por correo.
 *
 * Dos frenos, porque esto le escribe a clientes reales y no se puede deshacer:
 *  1. `remindersLive` apagado ⇒ calcula la lista y no envía nada (dry-run).
 *  2. tope por corrida ⇒ la línea es TIER_2K (2.000 clientes únicos/24 h) y
 *     pasarse quema la cuota que necesitan las campañas y los avisos de corte.
 * Con ~2.500 morosos y el tope por defecto, la rotación cubre a todos en ~17 días:
 * se atiende primero a quien lleva más tiempo sin recibir aviso.
 */
export class WhatsappRemindersService {
  private readonly logger = new Logger('WhatsappReminders');

  constructor(
    private readonly prisma: PrismaService,
    private readonly campaigns: WhatsappCampaignService,
  ) {}

  // ── Configuración ────────────────────────────────────────────────────────────
  // Mismo patrón que el resto del ERP: el ajuste de la UI manda, el env es el
  // valor por defecto. Sin cache: esto corre una vez al día, no por mensaje.

  async config() {
    const rows = await this.prisma.appSetting.findMany({
      where: { key: { in: [WA_REMINDERS_ENABLED_KEY, WA_REMINDERS_LIVE_KEY, WA_REMINDERS_CAP_KEY] } },
      select: { key: true, value: true },
    });
    const val = (k: string) => rows.find((r) => r.key === k)?.value ?? null;
    const bool = (v: string | null, envDefault: boolean) =>
      v === 'true' || v === 'false' ? v === 'true' : envDefault;

    const cap = Number(val(WA_REMINDERS_CAP_KEY) ?? process.env.WA_REMINDERS_CAP ?? CAP_DEFECTO);
    return {
      enabled: bool(val(WA_REMINDERS_ENABLED_KEY), process.env.WA_REMINDERS_ENABLED === 'true'),
      live: bool(val(WA_REMINDERS_LIVE_KEY), process.env.WA_REMINDERS_LIVE === 'true'),
      cap: Math.max(1, Math.min(1000, Math.floor(cap) || CAP_DEFECTO)),
      template: TEMPLATE,
      dedupeDias: DEDUPE_DIAS,
      deudaMinima: DEUDA_MINIMA,
      estados: ESTADOS_COBRABLES,
    };
  }

  async setConfig(
    patch: { enabled?: boolean; live?: boolean; cap?: number },
    updatedBy?: string,
  ) {
    const put = (key: string, value: string) =>
      this.prisma.appSetting.upsert({
        where: { key },
        create: { key, value, group: 'whatsapp', updatedBy },
        update: { value, updatedBy },
      });

    if (patch.enabled !== undefined) await put(WA_REMINDERS_ENABLED_KEY, String(patch.enabled));
    if (patch.live !== undefined) {
      await put(WA_REMINDERS_LIVE_KEY, String(patch.live));
      this.logger.warn(
        `Recordatorios por WhatsApp en modo ${patch.live ? 'REAL (se envían mensajes)' : 'SIMULACIÓN'} por ${updatedBy ?? 'desconocido'}.`,
      );
    }
    if (patch.cap !== undefined) await put(WA_REMINDERS_CAP_KEY, String(Math.max(1, Math.floor(patch.cap) || CAP_DEFECTO)));
    return this.config();
  }

  // ── Corrida ──────────────────────────────────────────────────────────────────

  /**
   * Elige a quién se le escribe. El orden es la rotación: primero quien nunca ha
   * recibido un recordatorio y luego el que lleva más tiempo sin uno, para que
   * con el tope diario la lista entera se recorra sola sin repetirle a los mismos.
   */
  async candidatos(limite: number, status?: string): Promise<Candidato[]> {
    const ahora = new Date();
    const corte = new Date(ahora.getTime() - DEDUPE_DIAS * 86400_000);

    const estados = status && (ESTADOS_COBRABLES as string[]).includes(status)
      ? [status as SubscriberStatus]
      : ESTADOS_COBRABLES;

    // Se pide de más (x3) porque después caen los que no tienen móvil, los que no
    // llegan a la deuda mínima y los que están hablando con una persona. Filtrar
    // eso en SQL no se puede (el móvil hay que normalizarlo, la deuda se agrega
    // aparte), y quedarse corto significa mandar menos avisos de los que el tope
    // permite justo el día que más falta hacen.
    const filas = await this.prisma.subscriber.findMany({
      where: {
        status: { in: estados },
        OR: [{ lastWaReminderAt: null }, { lastWaReminderAt: { lt: corte } }],
        invoices: { some: { status: { in: ['DUE', 'PARTIAL'] }, dueDate: { lt: ahora } } },
      },
      select: { id: true, abonado: true, phone1: true, phone2: true, status: true },
      orderBy: [{ lastWaReminderAt: { sort: 'asc', nulls: 'first' } }, { abonado: 'asc' }],
      take: limite * 3,
    });

    const conMovil = filas
      .map((s) => {
        const phone = [s.phone1, s.phone2]
          .map((p) => normalizePhone(p))
          .find((p): p is string => esMovilColombiano(p));
        return phone ? { ...s, phone } : null;
      })
      .filter((s): s is (typeof filas)[number] & { phone: string } => !!s);

    if (!conMovil.length) return [];

    const deudas = await this.deudaDe(conMovil.map((s) => s.id));
    const enManosDeUnaPersona = await this.escaladosA(conMovil.map((s) => s.phone));

    const elegidos: Candidato[] = [];
    const telefonosUsados = new Set<string>();
    for (const s of conMovil) {
      if (elegidos.length >= limite) break;
      const deuda = deudas[s.id] ?? 0;
      if (deuda < DEUDA_MINIMA) continue;
      // Un cliente que pidió hablar con una persona sigue esperándola: meterle un
      // cobro automático en esa misma conversación es exactamente lo que no hay
      // que hacer.
      if (enManosDeUnaPersona.has(s.phone)) continue;
      // Dos fichas con el mismo celular (misma persona, varios contratos) = un
      // solo mensaje: para Meta son la misma conversación y para el cliente, dos
      // cobros seguidos.
      if (telefonosUsados.has(s.phone)) continue;
      telefonosUsados.add(s.phone);
      elegidos.push({ id: s.id, abonado: s.abonado, phone: s.phone, deuda, status: s.status });
    }
    return elegidos;
  }

  private async deudaDe(ids: string[]): Promise<Record<string, number>> {
    const rows = await this.prisma.subInvoice.groupBy({
      by: ['subscriberId'],
      // La factura del mes que viene NO es deuda todavía: el bot cobraría un mes que
      // no ha empezado. Ver `factura-exigible`.
      where: { subscriberId: { in: ids }, status: { in: ['DUE', 'PARTIAL'] }, ...whereExigible(hoyEnColombia()) },
      _sum: { total: true, paidAmount: true },
    });
    const map: Record<string, number> = {};
    for (const r of rows) {
      if (!r.subscriberId) continue;
      map[r.subscriberId] = Math.max(0, Number(r._sum.total ?? 0) - Number(r._sum.paidAmount ?? 0));
    }
    return map;
  }

  /**
   * Teléfonos cuya conversación está escalada a una persona. La clave la arma el
   * motor del chatbot como `kapso:<teléfono tal cual llegó>`, así que se compara
   * por los últimos 10 dígitos en vez de reconstruirla: el `from` del webhook trae
   * el 57 y la ficha del abonado no siempre.
   */
  private async escaladosA(telefonos: string[]): Promise<Set<string>> {
    const filas = await this.prisma.chatbotSession.findMany({
      where: { handoffAt: { not: null } },
      select: { convKey: true },
    });
    const escalados = new Set(filas.map((f) => f.convKey.replace(/\D/g, '').slice(-10)).filter(Boolean));
    return new Set(telefonos.filter((t) => escalados.has(t.slice(-10))));
  }

  /**
   * Manda los recordatorios de hoy. Devuelve el resumen que el cron guarda en
   * `CronRun` y pinta el panel de automatizaciones.
   */
  async run(opts: { manual: boolean; limit?: number; status?: string; userName?: string }) {
    const cfg = await this.config();
    const limite = Math.min(opts.limit ?? cfg.cap, cfg.cap);
    const elegidos = await this.candidatos(limite, opts.status);

    if (!elegidos.length) {
      return { ok: true, enviados: 0, candidatos: 0, dryRun: !cfg.live, detail: 'no hay morosos pendientes de aviso' };
    }

    const totalDeuda = elegidos.reduce((a, c) => a + c.deuda, 0);

    if (!cfg.live) {
      // Dry-run: la lista sale al log para poder revisarla antes de encender, y NO
      // se marca `lastWaReminderAt` — si se marcara, al pasar a real esos clientes
      // se saltarían el aviso una semana por un envío que nunca ocurrió.
      const muestra = elegidos.slice(0, 5).map((c) => `${c.abonado ?? '—'}/${c.phone}`).join(', ');
      this.logger.log(
        `[SIMULACIÓN] Se habrían enviado ${elegidos.length} recordatorios (${muestra}${elegidos.length > 5 ? '…' : ''}).`,
      );
      return {
        ok: true,
        enviados: 0,
        candidatos: elegidos.length,
        dryRun: true,
        totalDeuda,
        detail: `SIMULACIÓN: ${elegidos.length} recordatorios listos por enviar (${cop(totalDeuda)} en cartera). Actívalo con el interruptor "envío real".`,
      };
    }

    const hoy = new Date().toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' });
    const { campaignId } = await this.campaigns.createCampaign(
      {
        name: `Recordatorios de pago · ${hoy}${opts.manual ? ' (manual)' : ''}`,
        templateName: TEMPLATE,
        subscriberIds: elegidos.map((c) => c.id),
      },
      { name: opts.userName ?? 'Automatización' },
      // Sin autoarranque: hay que ESPERAR el envío para marcar el dedupe solo
      // sobre los que salieron.
      { autoStart: false },
    );

    // `sinEspera`: si el cupo de 24 h se acaba a mitad, lo que falta se marca
    // fallido en vez de quedar esperando cupo. Una campaña que siguiera enviando
    // horas después saldría sin marcar `lastWaReminderAt`, y mañana esos clientes
    // volverían a entrar en la lista: dos cobros seguidos.
    await this.campaigns.runCampaign(campaignId, { sinEspera: true });

    const enviados = await this.prisma.whatsappSend.findMany({
      where: { campaignId, status: { in: ['SENT', 'DELIVERED', 'READ'] } },
      select: { subscriberId: true },
    });
    const ids = enviados.map((e) => e.subscriberId).filter((x): x is string => !!x);
    if (ids.length) {
      // Solo los que SALIERON. Marcar también los fallidos les quitaría el aviso
      // una semana por un problema nuestro — la misma trampa que ya se corrigió en
      // los recordatorios por correo.
      await this.prisma.subscriber.updateMany({ where: { id: { in: ids } }, data: { lastWaReminderAt: new Date() } });
    }

    const fallidos = elegidos.length - ids.length;
    const detail = `recordatorios enviados: ${ids.length}${fallidos ? `, fallidos: ${fallidos}` : ''} (candidatos: ${elegidos.length})`;
    this.logger.log(`[wa-reminders] ${detail}`);
    return { ok: true, enviados: ids.length, fallidos, candidatos: elegidos.length, dryRun: false, campaignId, totalDeuda, detail };
  }
}
