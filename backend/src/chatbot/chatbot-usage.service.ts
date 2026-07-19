import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { PrismaService } from '../prisma/prisma.service';

/** Tope diario de tokens. 0 o ausente = sin tope. */
export const CHATBOT_BUDGET_KEY = 'chatbot.dailyTokenBudget';

/** Cache del total del día: se consulta en CADA mensaje y cambia poco. */
const TTL_MS = 30_000;

const dayUtc = () => {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
};

/**
 * Contabilidad del consumo del LLM y tope diario.
 *
 * Existe porque nadie contaba tokens: no había límite por usuario, por día ni global,
 * y el agente público atiende a CUALQUIER número que escriba (por diseño). Una campaña
 * de spam, un bucle de reintentos o simplemente el éxito bastan para disparar la
 * factura sin que nadie se entere hasta que llega.
 *
 * El tope es un freno de emergencia, no una cuota fina: al superarlo el bot se apaga
 * solo hasta el día siguiente y deja el canal como si estuviera apagado —el mensaje se
 * registra y lo atiende una persona—, que es exactamente lo que hace el interruptor.
 */
@Injectable()
export class ChatbotUsageService {
  private readonly logger = new Logger('ChatbotUsage');
  private cache: { at: number; tokens: number; budget: number } | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Cliente de OpenAI que además contabiliza. Envuelve `chat.completions.create`
   * porque es el ÚNICO punto donde el `usage` de OpenAI sigue existiendo: el adaptador
   * del motor lo descarta al normalizar la respuesta.
   *
   * La contabilidad nunca puede tumbar una conversación: si el registro falla, se
   * loguea y se sigue.
   */
  instrument(client: OpenAI): OpenAI {
    const completions = client.chat.completions;
    const create = completions.create.bind(completions);
    completions.create = (async (body: any, opts: any) => {
      const res: any = await create(body, opts);
      if (res?.usage) {
        this.record(
          String(res.model ?? body?.model ?? 'desconocido'),
          Number(res.usage.prompt_tokens ?? 0),
          Number(res.usage.completion_tokens ?? 0),
        ).catch((e) => this.logger.warn(`No se pudo registrar el consumo: ${e.message}`));
      }
      return res;
    }) as typeof completions.create;
    return client;
  }

  private async record(model: string, input: number, output: number) {
    const day = dayUtc();
    await this.prisma.chatbotUsage.upsert({
      where: { day_model: { day, model } },
      create: { day, model, inputTokens: input, outputTokens: output, requests: 1 },
      update: {
        inputTokens: { increment: input },
        outputTokens: { increment: output },
        requests: { increment: 1 },
      },
    });
    this.cache = null; // el total cambió
  }

  /** Tokens de hoy y tope vigente. */
  private async load() {
    if (this.cache && Date.now() - this.cache.at < TTL_MS) return this.cache;
    const [agg, setting] = await Promise.all([
      this.prisma.chatbotUsage.aggregate({
        where: { day: dayUtc() },
        _sum: { inputTokens: true, outputTokens: true },
      }),
      this.prisma.appSetting.findUnique({ where: { key: CHATBOT_BUDGET_KEY }, select: { value: true } }),
    ]);
    const tokens = (agg._sum.inputTokens ?? 0) + (agg._sum.outputTokens ?? 0);
    const budget = Math.max(0, Number(setting?.value ?? 0) || 0);
    this.cache = { at: Date.now(), tokens, budget };
    return this.cache;
  }

  /**
   * ¿Se pasó del tope de hoy? Si la consulta falla, devuelve false: quedarse sin bot
   * por un fallo de la BD es peor que gastar unos tokens de más — y el gate ya se
   * apaga solo si la BD no responde.
   */
  async exceeded(): Promise<boolean> {
    try {
      const c = await this.load();
      if (!c.budget) return false; // sin tope configurado
      if (c.tokens >= c.budget) {
        this.logger.warn(`Tope diario superado: ${c.tokens}/${c.budget} tokens. El bot no atiende hasta mañana.`);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /** Para el panel: consumo de hoy, tope y desglose por modelo de los últimos días. */
  async summary() {
    const c = await this.load();
    const porDia = await this.prisma.chatbotUsage.groupBy({
      by: ['day'],
      _sum: { inputTokens: true, outputTokens: true, requests: true },
      orderBy: { day: 'desc' },
      take: 14,
    });
    return {
      hoy: c.tokens,
      budget: c.budget || null,
      excedido: !!c.budget && c.tokens >= c.budget,
      historial: porDia.map((d) => ({
        day: d.day,
        tokens: (d._sum.inputTokens ?? 0) + (d._sum.outputTokens ?? 0),
        requests: d._sum.requests ?? 0,
      })),
    };
  }

  async setBudget(tokens: number, updatedBy?: string) {
    const value = String(Math.max(0, Math.floor(tokens) || 0));
    await this.prisma.appSetting.upsert({
      where: { key: CHATBOT_BUDGET_KEY },
      create: { key: CHATBOT_BUDGET_KEY, value, group: 'chatbot', updatedBy },
      update: { value, updatedBy },
    });
    this.cache = null;
    this.logger.log(`Tope diario del bot: ${value === '0' ? 'sin tope' : `${value} tokens`} (por ${updatedBy ?? '?'}).`);
    return this.summary();
  }
}
