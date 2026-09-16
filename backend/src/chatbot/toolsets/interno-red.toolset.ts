import type { Toolset, ToolContext, ToolDef } from '@s4gk/wa-agent';
import { PERMISSION_DENIED } from '@s4gk/wa-agent';
import { APP_PERMISSIONS as P } from '../../auth/permissions.catalog';
import { MikrotikService, type MikrotikActionResult } from '../../network/mikrotik.service';
import { OltService } from '../../network/olt.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SubscribersService } from '../../subscribers/subscribers.service';
import { authUserOf } from '../chatbot.identity';
import { canAny, fecha, gated, safe } from './toolset.util';

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
export class InternoRedToolset implements Toolset {
  constructor(
    private readonly mikrotik: MikrotikService,
    private readonly subscribers: SubscribersService,
    private readonly olt: OltService,
    private readonly prisma: PrismaService,
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
      {
        name: 'diagnostico_onu',
        description:
          'Diagnóstico de la fibra de un abonado en la OLT: si la ONU está en línea y con qué potencia óptica ' +
          '(dBm) la recibe, para saber si la falla es de la fibra (empalme sucio, curva, corte) o del equipo. ' +
          'Úsala cuando un técnico pregunte por la señal, la potencia, los dBm o por qué un cliente está caído.',
        input_schema: {
          type: 'object',
          properties: { subscriberId: { type: 'string', description: 'id del abonado (de buscar_abonado)' } },
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
      case 'diagnostico_onu':
        return safe(() => this.diagnosticoOnu(String(input.subscriberId ?? '')));
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

  /**
   * Señal óptica de la fibra del abonado. Es la pregunta que hoy obliga al técnico a
   * llamar a la oficina para que alguien entre a la OLT: con esto la resuelve desde
   * el poste por WhatsApp.
   *
   * La potencia RX es el dato que decide el trabajo: si está en rango, el problema
   * está en la casa (router, cables, WiFi) y desplazar una cuadrilla a revisar la
   * fibra es tiempo perdido; si está baja, hay que buscar el empalme o la curva. Por
   * eso el número va acompañado del veredicto: un "-27,4 dBm" sin interpretar no le
   * dice nada a quien no vive metido en la OLT.
   */
  private async diagnosticoOnu(id: string): Promise<string> {
    if (!id) return 'Indica el id del abonado (búscalo primero con buscar_abonado).';

    const onu = await this.prisma.oltOnu.findFirst({
      where: { subscriberId: id },
      orderBy: { lastSync: 'desc' },
      include: { olt: { select: { id: true, name: true } } },
    });
    if (!onu) {
      return 'Ese abonado no tiene ONU registrada en ninguna OLT. Puede estar por fibra de otro operador, ' +
        'por radio, o su ONU aún no se ha censado. Revísalo en el módulo de red.';
    }

    const ubic = `${onu.frame}/${onu.slot ?? '?'}/${onu.port ?? '?'}:${onu.ontId ?? '?'}`;
    const cabecera = [
      `OLT ${onu.olt?.name ?? '—'} · puerto ${ubic}${onu.sn ? ` · SN ${onu.sn}` : ''}`,
      `Último censo: ${fecha(onu.lastSync)} · estado guardado: ${onu.runState ?? '—'}/${onu.configState ?? '—'}`,
    ];

    const modo = await this.olt.mode();
    if (!modo.live) {
      return [
        ...cabecera,
        'El módulo de OLT está en modo SIMULACIÓN, así que no puedo interrogar la fibra en vivo: lo de arriba es ' +
        'lo último que quedó censado. Para leer la potencia real hay que activar el modo en vivo (OLT_LIVE).',
      ].join('\n');
    }

    if (onu.slot == null || onu.port == null || onu.ontId == null) {
      return [...cabecera, 'Falta la ubicación completa (slot/puerto/ont-id) para interrogar la ONU en vivo.'].join('\n');
    }

    const r = await this.olt.ontOptical(onu.olt.id, onu.frame, onu.slot, onu.port, onu.ontId);
    if (!r.ok) {
      return [...cabecera, `No pude leer la óptica: ${r.error ?? 'la OLT no respondió'}.`].join('\n');
    }

    const o = r.optical as Record<string, string | undefined>;
    const rx = this.dbm(o.rx);
    const lineas = [
      ...cabecera,
      `Potencia que RECIBE la ONU (RX): ${o.rx ?? '—'} dBm${rx === null ? '' : ` — ${this.veredictoRx(rx)}`}`,
      `Potencia que TRANSMITE la ONU (TX): ${o.tx ?? '—'} dBm`,
      o.olt_rx ? `Potencia que la OLT recibe de la ONU: ${o.olt_rx} dBm` : '',
      o.temp ? `Temperatura: ${o.temp} °C` : '',
    ].filter(Boolean);

    if (rx === null) {
      lineas.push(
        'Sin lectura de potencia: eso pasa cuando la ONU está apagada, sin luz, o la fibra está cortada. ' +
        'Lo primero es confirmar que el equipo del cliente tenga corriente.',
      );
    }
    return lineas.join('\n');
  }

  /** "-18.50" → -18.5. Devuelve null cuando la OLT no dio lectura ("-", vacío). */
  private dbm(raw?: string): number | null {
    const n = Number(String(raw ?? '').replace(',', '.').replace(/[^\d.-]/g, ''));
    return Number.isFinite(n) && n !== 0 ? n : null;
  }

  /**
   * Umbrales de una GPON normal (clase B+). No son opinión: fuera de −8/−27 dBm el
   * enlace o se satura o se cae, y entre −25 y −27 ya está al límite de sensibilidad
   * del receptor, que es cuando el cliente reporta cortes intermitentes que "no se
   * ven" en el sistema.
   */
  private veredictoRx(rx: number): string {
    if (rx > -8) return 'DEMASIADA señal (la ONU está muy cerca o falta atenuador): puede saturar y dar cortes';
    if (rx >= -25) return 'NORMAL: la fibra está bien, busca la falla en el equipo del cliente o su red interna';
    if (rx >= -27) return 'DÉBIL, al límite: da cortes intermitentes. Revisa empalmes, conectores sucios y curvas cerradas';
    return 'CRÍTICA, fuera de rango: la fibra está dañada, muy sucia o mal empalmada. Hay que ir a revisarla';
  }

  private async historial(id: string): Promise<string> {
    const rows: any[] = await this.mikrotik.history(id, 5);
    if (!rows.length) return 'Ese abonado no tiene acciones de red registradas.';
    return rows
      .map((h) => `• ${new Date(h.date ?? h.created).toLocaleString('es-CO')} — ${h.action}${h.dryRun ? ' (simulado)' : ''} por ${h.user ?? '—'}`)
      .join('\n');
  }
}
