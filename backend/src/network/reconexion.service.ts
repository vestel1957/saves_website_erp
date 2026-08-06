import { Logger } from '../core/logger';
import { SubscriberStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/current-user.decorator';
import { MikrotikService } from './mikrotik.service';
import { GenieacsService } from './genieacs.service';

/**
 * Reconexión automática al pagar.
 *
 * Un cliente que paga tiene que volver a tener servicio sin que nadie más toque
 * nada, y "servicio" aquí son DOS cosas distintas que viven en equipos distintos:
 *
 *  · Internet → Mikrotik: sacar la IP de la lista MOROSOS y ponerla en ACTIVOS
 *    (y habilitar el secret si un corte viejo lo dejó deshabilitado).
 *  · TV       → la vía que le corresponda al abonado: TR-069 sobre el CPE
 *    (tag `tv-suspendida` + X_CATVConfiguration.Enable) o, si la ONT no habla
 *    TR-069, el puerto CATV por la OLT.
 *
 * Este servicio es el único que decide QUÉ le corresponde a cada abonado y deja
 * la base de datos contando lo mismo que los equipos. Lo usan todos los caminos
 * por los que entra un pago (caja y cargue de pagos), para que reconectar no
 * dependa de por dónde entró la plata.
 */

/** Estados en los que un pago significa "devuélvele el servicio".
 *
 *  CORTADO es el corte fresco; CARTERA es ese mismo corte dos meses después
 *  (el cron `runCartera` los mueve, y el equipo sigue cortado igual); REPORTADO
 *  es cortado + reportado a centrales. COMPROMISO ya viene de un acuerdo de pago.
 *
 *  Fuera quedan a propósito: SUSPENDIDO (suspensión pedida por el cliente, no se
 *  levanta sola por un abono), RETIRADO / DEPURADO / POR_RETIRAR / INACTIVO
 *  (pagar una deuda vieja no revive un servicio que ya se dio de baja) y
 *  EXONERADO / EVENTO / INSTALAR (no están cortados por plata).
 */
const ESTADOS_RECONECTABLES: SubscriberStatus[] = ['CORTADO', 'CARTERA', 'REPORTADO', 'COMPROMISO'];

/**
 * Cuánto espera QUIEN REGISTRA EL PAGO a que terminen los equipos.
 *
 * La reconexión de internet es un par de comandos por API (rápida), pero la TV
 * puede irse a una sesión SSH contra la OLT que relee el puerto hasta 4 veces, o
 * a un connection-request del ACS que espera a que el CPE despierte. La cajera no
 * puede quedarse mirando una pantalla 30 segundos por eso: si se pasa de este
 * tiempo se responde "va en curso" y el trabajo SIGUE corriendo en segundo plano
 * (termina, escribe su auditoría y actualiza el estado igual).
 */
const ESPERA_MAX_MS = 15_000;

export type ServicioReconectado = {
  servicio: 'INTERNET' | 'TV';
  ok: boolean;
  dryRun: boolean;
  /** Por dónde se hizo: el router, el ACS o la OLT. */
  via: 'MIKROTIK' | 'TR069' | 'OLT' | null;
  detalle: string;
};

export type ResultadoReconexion = {
  subscriberId: string;
  /** ¿Había algo que reconectar? false = el cliente no estaba cortado. */
  aplica: boolean;
  /** true si todo lo que se intentó salió bien (o si no había nada que hacer). */
  ok: boolean;
  /** Se agotó la espera: los equipos siguen aplicando en segundo plano. */
  enCurso: boolean;
  dryRun: boolean;
  servicios: ServicioReconectado[];
  mensaje: string;
};

type SubParaReconectar = {
  id: string;
  abonado: number;
  status: SubscriberStatus | null;
  pppUsername: string | null;
  services: { id: string; kind: string; status: string }[];
  _count: { oltOnus: number };
};

const SELECT_RECONEXION = {
  id: true,
  abonado: true,
  status: true,
  pppUsername: true,
  services: { select: { id: true, kind: true, status: true } },
  _count: { select: { oltOnus: true } },
} as const;

export class ReconexionService {
  private readonly logger = new Logger(ReconexionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mikrotik: MikrotikService,
    private readonly genieacs: GenieacsService,
  ) {}

  // ------------------------------------------------------------------
  // Qué le corresponde a este abonado
  // ------------------------------------------------------------------

  /** ¿El estado del abonado es de los que un pago debe levantar? */
  private estaCortado(sub: { status: SubscriberStatus | null }) {
    return !!sub.status && ESTADOS_RECONECTABLES.includes(sub.status);
  }

  /** Servicios de TV del abonado (la TV y los puntos/decos salen por el mismo puerto CATV). */
  private serviciosTv(sub: SubParaReconectar) {
    return sub.services.filter((s) => s.kind === 'TV' || s.kind === 'PUNTOS');
  }

  /**
   * ¿Hay que devolverle la TV?
   *
   * Sí cuando tiene TV contratada Y (estaba cortado por plata O su servicio de TV
   * está marcado como cortado). Lo segundo cubre al que solo tenía la TV cortada:
   * el corte de TV no cambia el estado del abonado, así que sin esa marca un
   * cliente ACTIVO con la TV suspendida se quedaría sin señal después de pagar.
   */
  private correspondeTv(sub: SubParaReconectar) {
    const tv = this.serviciosTv(sub);
    if (!tv.length) return false;
    // Sin equipo identificable (ni CPE por PPPoE ni ONU en la OLT) no hay a qué
    // mandarle la orden; se reporta como no aplicable en vez de inventar un intento.
    if (!sub.pppUsername && sub._count.oltOnus === 0) return false;
    return this.estaCortado(sub) || tv.some((s) => s.status !== 'ACTIVO');
  }

  /** ¿Hay que devolverle el internet? Solo si tiene PPPoE y venía cortado. */
  private correspondeInternet(sub: SubParaReconectar) {
    return !!sub.pppUsername && this.estaCortado(sub);
  }

  // ------------------------------------------------------------------
  // Pago individual (caja)
  // ------------------------------------------------------------------

  /**
   * Reconecta lo que corresponda tras un pago. NUNCA lanza: un fallo de red no
   * puede tumbar el recaudo, que ya está contabilizado. Lo que sí hace es dejar
   * el fallo bien visible (log a nivel error + el detalle en la respuesta) para
   * que quien recibió la plata sepa en el acto que el cliente sigue cortado.
   *
   * @param ctx  texto corto para la traza (p. ej. el recibo de caja).
   */
  async porPago(subscriberId: string, user?: AuthUser, ctx?: string): Promise<ResultadoReconexion> {
    const base: ResultadoReconexion = {
      subscriberId, aplica: false, ok: true, enCurso: false, dryRun: false,
      servicios: [], mensaje: 'El cliente no estaba cortado: no había nada que reconectar.',
    };
    try {
      const sub = (await this.prisma.subscriber.findUnique({
        where: { id: subscriberId }, select: SELECT_RECONEXION,
      })) as SubParaReconectar | null;
      if (!sub) return base;

      const haceInternet = this.correspondeInternet(sub);
      const haceTv = this.correspondeTv(sub);
      if (!haceInternet && !haceTv) return base;

      // Los dos equipos en paralelo: son independientes y el cliente espera por
      // el más lento, no por la suma.
      const trabajo = this.ejecutar(sub, haceInternet, haceTv, user, ctx);
      const terminado = await this.conEspera(trabajo, ESPERA_MAX_MS);
      if (!terminado.listo) {
        this.logger.warn(
          `Reconexión por pago del abonado ${sub.abonado}${ctx ? ` (${ctx})` : ''}: los equipos se están demorando; sigue en segundo plano.`,
        );
        return {
          ...base, aplica: true, ok: true, enCurso: true,
          mensaje: 'La reconexión está en curso en los equipos; puede tardar un momento en verse.',
        };
      }
      return terminado.valor;
    } catch (e) {
      // Cinturón: aquí no debería llegar nada, pero un recaudo jamás se cae por esto.
      this.logger.error(
        `Reconexión por pago del abonado ${subscriberId}${ctx ? ` (${ctx})` : ''}: ${(e as Error).message}. Puede seguir cortado.`,
      );
      return {
        ...base, aplica: true, ok: false,
        mensaje: `No se pudo reconectar: ${(e as Error).message}. El cliente puede seguir cortado.`,
      };
    }
  }

  /** El trabajo de verdad contra los equipos + el estado en base de datos. */
  private async ejecutar(
    sub: SubParaReconectar, haceInternet: boolean, haceTv: boolean, user?: AuthUser, ctx?: string,
  ): Promise<ResultadoReconexion> {
    const estadoAntes = sub.status;
    const [internet, tv] = await Promise.all([
      haceInternet ? this.reconectarInternet(sub, user) : Promise.resolve(null),
      haceTv ? this.reconectarTv(sub, user) : Promise.resolve(null),
    ]);

    const servicios = [internet, tv].filter((s): s is ServicioReconectado => !!s);
    const ok = servicios.every((s) => s.ok);
    const dryRun = servicios.some((s) => s.dryRun);

    // El estado solo se levanta si algo se aplicó DE VERDAD. En dry-run no se
    // tocó ningún equipo: dejar al cliente en ACTIVO ahí sería mentir en la ficha
    // —seguiría en MOROSOS y sin señal— y taparía que los gates están apagados.
    if (servicios.some((s) => s.ok && !s.dryRun)) await this.marcarActivo(sub, estadoAntes);

    const detalle = servicios.map((s) => `${s.servicio.toLowerCase()}=${s.ok ? 'ok' : 'FALLÓ'}`).join(' ');
    const linea = `Reconexión por pago del abonado ${sub.abonado}${ctx ? ` (${ctx})` : ''}: ${detalle}${dryRun ? ' [dry-run]' : ''}`;
    if (ok) this.logger.log(linea);
    else {
      this.logger.error(
        `${linea}. Detalle: ${servicios.filter((s) => !s.ok).map((s) => s.detalle).join(' | ')}. ` +
        'Reintentar desde Red (queda auditado en MikrotikActionLog / GenieacsLog / OltActionLog).',
      );
    }

    return {
      subscriberId: sub.id, aplica: true, ok, enCurso: false, dryRun, servicios,
      mensaje: ok
        ? (dryRun
          ? `Reconexión simulada (${detalle}): los interruptores LIVE están apagados, no se tocaron los equipos.`
          : `Servicio reconectado (${detalle}).`)
        : `La reconexión falló (${detalle}). El cliente PAGÓ pero puede seguir cortado.`,
    };
  }

  private async reconectarInternet(sub: SubParaReconectar, user?: AuthUser): Promise<ServicioReconectado> {
    try {
      const r = await this.mikrotik.reconnect(sub.id, user);
      if (r.ok && !r.dryRun) await this.marcarServicios(sub, ['INTERNET'], 'ACTIVO');
      return {
        servicio: 'INTERNET', ok: !!r.ok, dryRun: !!r.dryRun, via: 'MIKROTIK',
        detalle: r.message || r.error || '',
      };
    } catch (e) {
      return { servicio: 'INTERNET', ok: false, dryRun: false, via: 'MIKROTIK', detalle: (e as Error).message };
    }
  }

  private async reconectarTv(sub: SubParaReconectar, user?: AuthUser): Promise<ServicioReconectado> {
    try {
      const r = await this.genieacs.tvBatchBySubscribers([sub.id], true, user);
      const fila = r.results.find((x) => x.subscriberId === sub.id);
      const ok = !!fila?.ok;
      if (ok && !fila?.dryRun) await this.marcarServicios(sub, ['TV', 'PUNTOS'], 'ACTIVO');
      return {
        servicio: 'TV', ok, dryRun: !!r.dryRun,
        via: (fila?.via as ServicioReconectado['via']) ?? null,
        detalle: fila?.detail ?? 'No se pudo resolver el equipo de TV del cliente.',
      };
    } catch (e) {
      return { servicio: 'TV', ok: false, dryRun: false, via: null, detalle: (e as Error).message };
    }
  }

  // ------------------------------------------------------------------
  // Cargue de pagos (lote)
  // ------------------------------------------------------------------

  /**
   * Igual que `porPago` pero para muchos abonados de una vez: lo usa el cargue de
   * pagos (Efecty / banco / corresponsal), donde reconectar uno por uno abriría
   * una sesión por cliente. Aquí sí se agrupa: el corte/reconexión de Mikrotik va
   * por router (una conexión por router) y la TV en un solo barrido del ACS.
   *
   * Sin tope de espera: es un proceso de lote, no alguien mirando la pantalla.
   */
  async porPagoLote(subscriberIds: string[], user?: AuthUser) {
    const ids = [...new Set((subscriberIds || []).filter(Boolean))];
    const vacío = { total: 0, internet: 0, tv: 0, fallidos: 0, dryRun: false };
    if (!ids.length) return vacío;

    const subs = (await this.prisma.subscriber.findMany({
      where: { id: { in: ids } }, select: SELECT_RECONEXION,
    })) as SubParaReconectar[];

    const conInternet = subs.filter((s) => this.correspondeInternet(s));
    const conTv = subs.filter((s) => this.correspondeTv(s));
    if (!conInternet.length && !conTv.length) return vacío;

    const estadosAntes = new Map(subs.map((s) => [s.id, s.status]));
    let internet = 0, tv = 0, fallidos = 0, dryRun = false;
    const reconectados = new Set<string>();

    if (conInternet.length) {
      try {
        const r = await this.mikrotik.reconnectBatch(conInternet.map((s) => s.id), user);
        for (const fila of r.results) {
          if (fila.ok) { internet++; if (!fila.dryRun && fila.subscriberId) reconectados.add(fila.subscriberId); } else fallidos++;
          if (fila.dryRun) dryRun = true;
        }
        // Igual que en el pago individual: en dry-run no se tocó el router, así que
        // tampoco se toca el estado en base de datos.
        const okIds = new Set(r.results.filter((x) => x.ok && !x.dryRun).map((x) => x.subscriberId));
        await this.marcarServiciosDe(conInternet.filter((s) => okIds.has(s.id)), ['INTERNET'], 'ACTIVO');
      } catch (e) {
        fallidos += conInternet.length;
        this.logger.error(`Reconexión de internet en lote: ${(e as Error).message}`);
      }
    }

    if (conTv.length) {
      try {
        const r = await this.genieacs.tvBatchBySubscribers(conTv.map((s) => s.id), true, user);
        if (r.dryRun) dryRun = true;
        for (const fila of r.results) {
          if (fila.ok) { tv++; if (!fila.dryRun) reconectados.add(fila.subscriberId); } else fallidos++;
        }
        const okIds = new Set(r.results.filter((x) => x.ok && !x.dryRun).map((x) => x.subscriberId));
        await this.marcarServiciosDe(conTv.filter((s) => okIds.has(s.id)), ['TV', 'PUNTOS'], 'ACTIVO');
      } catch (e) {
        fallidos += conTv.length;
        this.logger.error(`Reconexión de TV en lote: ${(e as Error).message}`);
      }
    }

    for (const sub of subs) {
      if (reconectados.has(sub.id)) await this.marcarActivo(sub, estadosAntes.get(sub.id) ?? null);
    }

    // `total` = a cuántos había que devolverles algo, no cuántos pagaron: el
    // mensaje que ve el operador cuenta clientes atendidos, no filas del archivo.
    const atendidos = new Set([...conInternet, ...conTv].map((s) => s.id)).size;
    this.logger.log(
      `Reconexión por pagos (lote): ${ids.length} pagaron, ${atendidos} estaban cortados → internet=${internet} tv=${tv} fallidos=${fallidos}${dryRun ? ' [dry-run]' : ''}`,
    );
    return { total: atendidos, internet, tv, fallidos, dryRun };
  }

  // ------------------------------------------------------------------
  // Estado en base de datos
  // ------------------------------------------------------------------

  /**
   * Deja el abonado en ACTIVO y REGISTRA el cambio.
   *
   * El registro no es adorno: los cambios de estado hechos en silencio son los
   * que tienen el historial descuadrado (ver el cron de Cartera), y sin historial
   * no se puede responder cuántos activos había en una fecha.
   */
  private async marcarActivo(sub: { id: string; abonado: number }, estadoAntes: SubscriberStatus | null) {
    if (estadoAntes === 'ACTIVO') return;
    const ahora = new Date();
    try {
      // `mikrotik.reconnect` ya pudo dejarlo en ACTIVO; este update es idempotente
      // y el historial se escribe una sola vez porque se decide por `estadoAntes`.
      await this.prisma.subscriber.update({
        where: { id: sub.id },
        data: { previousStatus: estadoAntes ?? undefined, status: 'ACTIVO', statusChangedAt: ahora },
      });
      await this.prisma.subscriberStatusHistory.create({
        data: { subscriberId: sub.id, status: 'ACTIVO', date: ahora, note: 'Reconexión automática por pago' },
      });
    } catch (e) {
      this.logger.warn(`No se pudo dejar en ACTIVO al abonado ${sub.abonado}: ${(e as Error).message}`);
    }
  }

  /** Marca el estado de unos servicios del abonado (la foto por servicio en BD). */
  private marcarServicios(sub: SubParaReconectar, kinds: string[], status: 'ACTIVO' | 'CORTADO') {
    return this.marcarServiciosDe([sub], kinds, status);
  }

  private async marcarServiciosDe(subs: SubParaReconectar[], kinds: string[], status: 'ACTIVO' | 'CORTADO') {
    const ids = subs.flatMap((s) => s.services.filter((x) => kinds.includes(x.kind) && x.status !== status).map((x) => x.id));
    if (!ids.length) return;
    await this.prisma.subscriberService
      .updateMany({ where: { id: { in: ids } }, data: { status: status as any } })
      .catch((e) => this.logger.warn(`No se pudo marcar el estado de los servicios: ${e.message}`));
  }

  // ------------------------------------------------------------------

  /**
   * Espera a `p` como mucho `ms`. Si se pasa, devuelve `listo:false` y deja la
   * promesa corriendo (con su propio catch para que no quede sin manejar).
   */
  private conEspera<T>(p: Promise<T>, ms: number): Promise<{ listo: true; valor: T } | { listo: false }> {
    let temporizador: NodeJS.Timeout;
    const vencimiento = new Promise<{ listo: false }>((resolve) => {
      temporizador = setTimeout(() => resolve({ listo: false }), ms);
    });
    p.catch((e) => this.logger.error(`Reconexión en segundo plano: ${(e as Error).message}`));
    return Promise.race([
      p.then((valor) => ({ listo: true as const, valor })).catch(() => ({ listo: false as const })),
      vencimiento,
    ]).finally(() => clearTimeout(temporizador));
  }
}
