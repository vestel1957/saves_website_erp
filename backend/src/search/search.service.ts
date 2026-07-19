import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { SubscribersService } from '../subscribers/subscribers.service';
import { BillingService } from '../billing/billing.service';
import type { AuthUser } from '../auth/current-user.decorator';
import { SUPERADMIN_PERMISSION } from '../auth/permissions.catalog';

/**
 * Búsqueda con IA para el ⌘K: traduce una frase en español natural
 * ("facturas vencidas de julio", "abonados suspendidos con fibra") a filtros
 * ESTRUCTURADOS sobre los servicios que ya existen, y devuelve resultados
 * clicables agrupados por módulo.
 *
 * Es una sola llamada al LLM (clasificar + extraer), NO un agente que actúa:
 * el modelo elige módulo y filtros, y el despacho a la BD lo hace este servicio
 * de forma determinista. Así la barra de búsqueda es rápida y barata, y el LLM
 * nunca ejecuta nada por su cuenta.
 *
 * RBAC: solo se ofrece al modelo —y solo se consulta— lo que el usuario puede
 * ver por su área (misma semántica OR que el AreaGuard). Un módulo fuera de su
 * alcance ni siquiera entra en el enum del esquema.
 *
 * Apagable con AI_SEARCH_ENABLED=false. Sin OPENAI_API_KEY queda inactivo y el
 * frontend cae a la búsqueda por palabra clave de siempre.
 */

/** Un resultado listo para pintar y navegar en el palette. */
export type SearchHit = {
  module: string; // 'abonados' | 'facturas'
  id: string;
  href: string;
  title: string;
  subtitle: string;
  badge?: string | null;
};

export type AiSearchResult = {
  ok: boolean;
  /** Interpretación humana de lo que entendió la IA (se muestra como "chip"). */
  interpreted: string | null;
  module: string | null;
  hits: SearchHit[];
  /** true si la IA no está disponible: el front cae a keyword. */
  unavailable?: boolean;
};

/** Módulos que la IA puede buscar, con el área (OR) que los habilita. */
const MODULES = {
  abonados: { areas: ['administracion', 'contabilidad', 'tecnicos', 'caja'] },
  facturas: { areas: ['contabilidad', 'caja'] },
} as const;

type ModuleKey = keyof typeof MODULES;

@Injectable()
export class SearchService {
  private readonly logger = new Logger('AiSearch');
  private readonly client: OpenAI | null;
  private readonly model: string;

  constructor(
    private readonly subscribers: SubscribersService,
    private readonly billing: BillingService,
  ) {
    const enabled = process.env.AI_SEARCH_ENABLED !== 'false';
    this.client =
      enabled && process.env.OPENAI_API_KEY
        ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
        : null;
    this.model =
      process.env.AI_SEARCH_MODEL ?? process.env.WHATSAPP_BOT_MODEL ?? 'gpt-4o-mini';
  }

  get isEnabled() {
    return !!this.client;
  }

  /** Áreas del usuario (OR). El superadmin pasa todas. */
  private allowedModules(user: AuthUser): ModuleKey[] {
    const perms = new Set(user.permissions ?? []);
    const isSuper = perms.has(SUPERADMIN_PERMISSION);
    return (Object.keys(MODULES) as ModuleKey[]).filter(
      (m) => isSuper || MODULES[m].areas.some((a) => perms.has(`area.${a}`)),
    );
  }

  async search(query: string, user: AuthUser): Promise<AiSearchResult> {
    const q = (query || '').trim();
    const allowed = this.allowedModules(user);
    if (!this.client || !q || allowed.length === 0) {
      return { ok: false, interpreted: null, module: null, hits: [], unavailable: !this.client };
    }

    let intent: Intent | null = null;
    try {
      intent = await this.extractIntent(q, allowed);
    } catch (err) {
      this.logger.warn(`Fallo extrayendo intención: ${(err as Error).message}`);
      return { ok: false, interpreted: null, module: null, hits: [], unavailable: true };
    }

    if (!intent || !allowed.includes(intent.modulo as ModuleKey)) {
      return { ok: false, interpreted: null, module: null, hits: [] };
    }

    try {
      const hits =
        intent.modulo === 'facturas'
          ? await this.searchFacturas(intent)
          : await this.searchAbonados(intent);
      return { ok: true, interpreted: intent.interpretacion ?? null, module: intent.modulo, hits };
    } catch (err) {
      this.logger.warn(`Fallo despachando búsqueda: ${(err as Error).message}`);
      return { ok: false, interpreted: intent.interpretacion ?? null, module: intent.modulo, hits: [] };
    }
  }

  // ---- LLM: clasificar + extraer filtros --------------------------------

  private async extractIntent(q: string, allowed: ModuleKey[]): Promise<Intent | null> {
    const today = new Date().toISOString().slice(0, 10);
    const res = await this.client!.chat.completions.create({
      model: this.model,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content:
            'Eres el traductor de la barra de búsqueda de un ERP para un proveedor de internet (ISP) en Colombia. ' +
            `Fecha de hoy: ${today}. Convierte la frase del usuario en filtros estructurados. ` +
            'Elige el módulo más probable. Si la frase es un nombre, documento, celular o número de abonado, usa el módulo "abonados". ' +
            'Deja en null lo que no se mencione explícitamente. "interpretacion" es un resumen corto en español de lo que entendiste.',
        },
        { role: 'user', content: q },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'intencion_busqueda',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              modulo: { type: 'string', enum: allowed },
              termino: {
                type: ['string', 'null'],
                description: 'Texto libre a buscar: nombre, documento, celular o número.',
              },
              interpretacion: { type: ['string', 'null'] },
              abonados: {
                type: ['object', 'null'],
                additionalProperties: false,
                properties: {
                  estado: {
                    type: ['string', 'null'],
                    enum: ['ACTIVO', 'SUSPENDIDO', 'CORTADO', 'RETIRADO', 'CARTERA', 'COMPROMISO', null],
                  },
                  servicio: { type: ['string', 'null'], enum: ['internet', 'tv', 'combo', null] },
                  tecnologia: { type: ['string', 'null'], enum: ['FTTH', 'EOC', null] },
                  cuenta: { type: ['string', 'null'], enum: ['aldia', 'debe', 'compromiso', null] },
                },
                required: ['estado', 'servicio', 'tecnologia', 'cuenta'],
              },
              facturas: {
                type: ['object', 'null'],
                additionalProperties: false,
                properties: {
                  estado: { type: ['string', 'null'], enum: ['DUE', 'PAID', 'PARTIAL', 'VOID', null] },
                  vencidas: { type: ['boolean', 'null'] },
                  desde: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
                  hasta: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
                },
                required: ['estado', 'vencidas', 'desde', 'hasta'],
              },
            },
            required: ['modulo', 'termino', 'interpretacion', 'abonados', 'facturas'],
          },
        },
      },
    });
    const raw = res.choices[0]?.message?.content;
    return raw ? (JSON.parse(raw) as Intent) : null;
  }

  // ---- Despacho a los servicios existentes ------------------------------

  private async searchAbonados(intent: Intent): Promise<SearchHit[]> {
    const f = intent.abonados ?? {};
    const { items } = await this.subscribers.list({
      search: intent.termino ?? undefined,
      status: f.estado ?? undefined,
      servicio: f.servicio ?? undefined,
      tecnologia: f.tecnologia ?? undefined,
      cuenta: f.cuenta ?? undefined,
      pageSize: 6,
    });
    return (items ?? []).map((s: any) => ({
      module: 'abonados',
      id: s.id,
      href: `/clientes/${s.id}`,
      title: s.name,
      subtitle: [
        `Abonado ${s.abonado}`,
        s.docNumber ? `${s.docType ?? ''} ${s.docNumber}`.trim() : null,
        s.phone || null,
      ]
        .filter(Boolean)
        .join(' · '),
      badge: s.status ? String(s.status).toLowerCase() : null,
    }));
  }

  private async searchFacturas(intent: Intent): Promise<SearchHit[]> {
    const f = intent.facturas ?? {};
    const { items } = await this.billing.list({
      search: intent.termino ?? undefined,
      status: f.estado ?? undefined,
      overdue: f.vencidas ? '1' : undefined,
      from: f.desde ?? undefined,
      to: f.hasta ?? undefined,
      all: f.desde || f.hasta ? undefined : '1', // sin rango: histórico completo
      pageSize: 6,
    });
    return (items ?? []).map((i: any) => ({
      module: 'facturas',
      id: i.id,
      href: i.subscriberId ? `/clientes/${i.subscriberId}` : '/facturacion',
      title: `Factura #${i.tid} · ${i.subscriber ?? 'Cliente'}`,
      subtitle: [
        cop(i.total),
        i.balance > 0 ? `saldo ${cop(i.balance)}` : 'pagada',
        i.dueDate ? `vence ${new Date(i.dueDate).toISOString().slice(0, 10)}` : null,
      ]
        .filter(Boolean)
        .join(' · '),
      badge: i.status ? String(i.status).toLowerCase() : null,
    }));
  }
}

/** Forma que devuelve el LLM (validada por el json_schema strict). */
type Intent = {
  modulo: string;
  termino: string | null;
  interpretacion: string | null;
  abonados: {
    estado?: string | null;
    servicio?: string | null;
    tecnologia?: string | null;
    cuenta?: string | null;
  } | null;
  facturas: {
    estado?: string | null;
    vencidas?: boolean | null;
    desde?: string | null;
    hasta?: string | null;
  } | null;
};

const cop = (n: number) =>
  new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: 'COP',
    maximumFractionDigits: 0,
  }).format(Number(n) || 0);
