import { Injectable } from '@nestjs/common';
import type { Toolset, ToolContext, ToolDef } from '@s4gk/wa-agent';
import { PERMISSION_DENIED } from '@s4gk/wa-agent';
import { APP_PERMISSIONS as P } from '../../auth/permissions.catalog';
import { MikrotikService, type MikrotikActionResult } from '../../network/mikrotik.service';
import { SubscribersService } from '../../subscribers/subscribers.service';
import { authUserOf } from '../chatbot.identity';
import { canAny, gated, safe } from './toolset.util';

/** Mismo gate que el controller de red. */
const RED = [P.AREA_TECNICOS, P.AREA_ADMINISTRACION];

/**
 * Corte, reconexión y estado de conexión, sobre el MikrotikService que ya usa la web.
 *
 * El modo dry-run NO lo decide este toolset: lo manda el MikrotikService (setting
 * `network.mikrotikLive`, con el env MIKROTIK_LIVE como default). Aquí solo se
 * REPORTA con claridad, para que un técnico nunca crea que cortó algo que en
 * realidad no se tocó.
 */
@Injectable()
export class InternoRedToolset implements Toolset {
  constructor(
    private readonly mikrotik: MikrotikService,
    private readonly subscribers: SubscribersService,
  ) {}

  definitions(ctx: ToolContext): ToolDef[] {
    return gated(canAny(ctx, RED), [
      {
        name: 'estado_conexion',
        description:
          'Estado de conexión en el router de un abonado: si la sesión PPPoE está activa, su IP y si el usuario está deshabilitado.',
        input_schema: {
          type: 'object',
          properties: { subscriberId: { type: 'string' } },
          required: ['subscriberId'],
        },
      },
      {
        name: 'cortar_servicio',
        description:
          'Corta el servicio de internet de un abonado en el router (deshabilita el usuario PPPoE y tumba la sesión). Requiere confirmación.',
        input_schema: {
          type: 'object',
          properties: {
            subscriberId: { type: 'string' },
            motivo: { type: 'string', description: 'Motivo del corte (para la auditoría)' },
          },
          required: ['subscriberId'],
        },
      },
      {
        name: 'reconectar_servicio',
        description: 'Reconecta el servicio de internet de un abonado en el router. Requiere confirmación.',
        input_schema: {
          type: 'object',
          properties: {
            subscriberId: { type: 'string' },
            motivo: { type: 'string', description: 'Motivo de la reconexión (para la auditoría)' },
          },
          required: ['subscriberId'],
        },
      },
      {
        name: 'historial_red',
        description: 'Últimas acciones de red (cortes, reconexiones) de un abonado.',
        input_schema: {
          type: 'object',
          properties: { subscriberId: { type: 'string' } },
          required: ['subscriberId'],
        },
      },
    ]);
  }

  async execute(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    if (!canAny(ctx, RED)) return PERMISSION_DENIED;

    switch (name) {
      case 'estado_conexion':
        return safe(() => this.estado(String(input.subscriberId ?? '')));
      case 'cortar_servicio':
        return safe(() => this.accion('cut', input, ctx));
      case 'reconectar_servicio':
        return safe(() => this.accion('reconnect', input, ctx));
      case 'historial_red':
        return safe(() => this.historial(String(input.subscriberId ?? '')));
      default:
        return `Herramienta no disponible: ${name}`;
    }
  }

  private async estado(id: string): Promise<string> {
    const r = await this.mikrotik.liveStatus(id);
    if (r.dryRun) {
      return 'El módulo de red está en modo DRY-RUN (simulación), así que no puedo leer el estado real del router. ' +
        'Actívalo en Configuración → Red (network.mikrotikLive) para consultas en vivo.';
    }
    const l = r.live ?? {};
    return [
      `Router: ${r.mikrotik?.name ?? '—'} (${r.mikrotik?.host ?? '—'})`,
      `Usuario PPPoE: ${l.secretExists ? 'existe' : 'NO existe'}${l.secretDisabled ? ' · DESHABILITADO (cortado)' : ''}`,
      `Sesión: ${l.sessionActive ? `ACTIVA${l.ip ? ` · IP ${l.ip}` : ''}` : 'sin conexión'}`,
    ].join('\n');
  }

  private async accion(
    kind: 'cut' | 'reconnect',
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<string> {
    const subscriberId = String(input.subscriberId ?? '');
    const motivo = input.motivo ? String(input.motivo) : undefined;
    const verbo = kind === 'cut' ? 'Cortar' : 'Reconectar';

    if (ctx.committing) {
      const r: MikrotikActionResult = kind === 'cut'
        ? await this.mikrotik.cut(subscriberId, authUserOf(ctx.user))
        : await this.mikrotik.reconnect(subscriberId, authUserOf(ctx.user));
      await ctx.audit({
        userId: ctx.user.id,
        action: kind === 'cut' ? 'network.cut' : 'network.reconnect',
        summary: `${verbo} servicio por WhatsApp${motivo ? ` — ${motivo}` : ''}`,
        detail: { subscriberId, dryRun: r.dryRun },
      });
      if (r.dryRun) {
        return `⚠️ SIMULACIÓN: el módulo de red está en dry-run, así que NO se tocó el router. ` +
          `Se habría ejecutado: ${r.steps.join('; ') || verbo.toLowerCase()}.`;
      }
      return r.ok
        ? `Listo: servicio ${kind === 'cut' ? 'cortado' : 'reconectado'} en ${r.mikrotik?.name ?? 'el router'}.`
        : `No se pudo: ${r.message ?? 'el router no respondió'}.`;
    }

    // Resolver el nombre antes de preguntar: confirmar a ciegas un id es peligroso.
    const s: any = await this.subscribers.detail(subscriberId);
    const modo = this.mikrotik.isLive ? '' : ' (el módulo está en DRY-RUN: no se tocará el router de verdad)';
    return ctx.preparePending({
      summary: `${verbo} el servicio de ${s.name} (abonado ${s.abonado}, PPPoE ${s.network?.pppUsername ?? '—'})${motivo ? ` — ${motivo}` : ''}.${modo}`,
      permission: P.AREA_TECNICOS,
      commitInput: { subscriberId, motivo },
    });
  }

  private async historial(id: string): Promise<string> {
    const rows: any[] = await this.mikrotik.history(id, 5);
    if (!rows.length) return 'Ese abonado no tiene acciones de red registradas.';
    return rows
      .map((h) => `• ${new Date(h.date ?? h.created).toLocaleString('es-CO')} — ${h.action}${h.dryRun ? ' (simulado)' : ''} por ${h.user ?? '—'}`)
      .join('\n');
  }
}
