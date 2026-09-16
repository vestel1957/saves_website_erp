import { HttpException, HttpStatus } from '../core/http/errores';
import { Logger } from '../core/logger';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/current-user.decorator';
import { parsePoint } from '../geo/geo.util';
import { traductorDeTecnicos } from '../staff/nombre-tecnico';
import { detectarSenales, normalizarIp, type Senal } from './spoof.policy';
import {
  TIPOS_DE_CAMPO_POR_DEFECTO,
  evaluarCierre,
  normalizarTipo,
  type ModoCerca,
  type Veredicto,
} from './geofence.policy';

/** Ajustes en `AppSetting` (grupo `tickets`), sobreescribibles por entorno. */
const K_MODO = 'tickets.geofence.mode';
const K_RADIO = 'tickets.geofence.radiusM';
const K_TIPOS = 'tickets.geofence.fieldTypes';
/** IPs públicas de las oficinas, para cotejarlas con el punto declarado.
 *  Formato: "190.14.238.10@5.3378,-72.3959;otra.ip@lat,lng" */
const K_OFICINAS = 'security.officeIps';

const RADIO_POR_DEFECTO_M = 100;

/**
 * Excepción que entiende el frontend para pedir la justificación sin recargar.
 * Es 422 y no 400 porque la petición está bien formada: lo que falla es una
 * regla de negocio, y el cliente puede reintentar añadiendo el motivo.
 */
export class GeofenceException extends HttpException {
  constructor(payload: Record<string, unknown>) {
    super({ code: 'GEOFENCE', ...payload }, HttpStatus.UNPROCESSABLE_ENTITY);
  }
}

export type ResultadoCerca = {
  veredicto: Veredicto;
  /** Señales de ubicación posiblemente simulada. */
  senales: Senal[];
  /** Qué escribir en el Ticket al cerrar. */
  datos: {
    closeLat: number | null;
    closeLng: number | null;
    closeAccuracyM: number | null;
    closeDistanceM: number | null;
    closeGeoOk: boolean | null;
    closeGeoReason: string | null;
    closeFlags: string[];
  };
  /** Coordenada a guardarle al abonado (solo cuando no tenía ninguna). */
  georreferenciar: { lat: number; lng: number } | null;
};

/**
 * Geo-cerca del cierre de órdenes: un técnico no debería poder dar por resuelta
 * una visita a domicilio sin haber estado en el domicilio.
 *
 * Se aplica **en el servidor**. Una comprobación en el navegador sería
 * decorativa: quien quisiera saltársela solo tendría que llamar al endpoint
 * directamente, que es exactamente lo que haría alguien con motivos para
 * saltársela.
 *
 * Arranca en modo `observar` a propósito. Antes de bloquear a nadie hay que ver
 * cuántos cierres legítimos caerían fuera del radio: la coordenada del abonado
 * puede venir mala del legacy, el GPS falla bajo techo, y una regla nueva que
 * frena el trabajo el primer día se desactiva el segundo. Con unas semanas de
 * datos en `/soporte/geocerca` se decide el radio de verdad y se pasa a
 * `exigir`. Es el mismo camino que MIKROTIK_LIVE u OLT_LIVE.
 */
export class GeofenceService {
  private readonly log = new Logger(GeofenceService.name);

  constructor(private readonly prisma: PrismaService) {}

  async modo(): Promise<ModoCerca> {
    const env = process.env.TICKET_GEOFENCE_MODE;
    const crudo = env ?? (await this.ajuste(K_MODO)) ?? 'observar';
    return crudo === 'exigir' || crudo === 'off' ? crudo : 'observar';
  }

  async radioM(): Promise<number> {
    const n = Number(process.env.TICKET_GEOFENCE_RADIUS_M ?? (await this.ajuste(K_RADIO)));
    return Number.isFinite(n) && n > 0 ? n : RADIO_POR_DEFECTO_M;
  }

  /** Tipos de orden que exigen presencia. Configurables sin tocar código. */
  async tiposCampo(): Promise<string[]> {
    const crudo = await this.ajuste(K_TIPOS);
    if (!crudo?.trim()) return TIPOS_DE_CAMPO_POR_DEFECTO;
    return crudo.split(',').map(normalizarTipo).filter(Boolean);
  }

  /**
   * Evalúa un cierre. Lanza `GeofenceException` si hay que frenarlo; en caso
   * contrario devuelve lo que el llamador debe persistir.
   */
  async evaluar(
    ticket: { id?: string; code?: number | null; type: string | null; subscriberId: string | null },
    dto: { lat?: number; lng?: number; accuracyM?: number },
    user: AuthUser | undefined,
    ip?: string | null,
  ): Promise<ResultadoCerca> {
    const [modo, radioM, tiposCampo] = await Promise.all([
      this.modo(),
      this.radioM(),
      this.tiposCampo(),
    ]);

    let cliente: { lat: number; lng: number } | null = null;
    if (ticket.subscriberId) {
      const sub = await this.prisma.subscriber.findUnique({
        where: { id: ticket.subscriberId },
        select: { gpsLat: true, gpsLng: true },
      });
      cliente = parsePoint(sub?.gpsLat, sub?.gpsLng);
    }

    const tecnico =
      dto.lat != null && dto.lng != null
        ? { lat: dto.lat, lng: dto.lng, accuracyM: dto.accuracyM ?? null }
        : null;

    const veredicto = evaluarCierre({
      modo,
      radioM,
      tiposCampo,
      tipoOrden: ticket.type,
      permisosUsuario: user?.permissions,
      cliente,
      tecnico,
    });

    // Señales de ubicación simulada. Se calculan aunque el cierre se permita:
    // el caso interesante es justo el que pasa la cerca porque el punto es falso.
    const senales = tecnico
      ? await this.senalesDe(tecnico, user, ip, ticket.code ?? null)
      : [];
    if (senales.length) {
      this.log.warn(
        `Ubicación sospechosa al cerrar (${user?.name ?? '?'}): ${senales.join(', ')}`,
      );
    }

    const base = {
      closeLat: tecnico?.lat ?? null,
      closeLng: tecnico?.lng ?? null,
      closeAccuracyM: tecnico?.accuracyM ?? null,
      closeDistanceM: null as number | null,
      closeGeoOk: null as boolean | null,
      closeGeoReason: null as string | null,
      closeFlags: senales as string[],
    };

    switch (veredicto.accion) {
      case 'exigir-ubicacion':
        throw new GeofenceException({ razon: 'sin-ubicacion', message: veredicto.motivo, radioM });

      /**
       * Fuera de rango: la orden NO se cierra, y ya no hay motivo que lo permita
       * (2026-09-10). El mensaje tiene que decir las DOS salidas reales, porque un
       * bloqueo sin salida se convierte en una orden abierta para siempre: acercarse
       * al domicilio, o —si el punto guardado del cliente está mal, que es la causa
       * más frecuente— avisarlo en el seguimiento para que se corrija la coordenada
       * y la cierre su coordinador.
       */
      case 'exigir-presencia':
        throw new GeofenceException({
          razon: 'fuera-de-rango',
          distanciaM: veredicto.distanciaM,
          radioM: veredicto.radioM,
          message:
            `Estás a ${Math.round(veredicto.distanciaM)} m del domicilio del cliente y el máximo `
            + `para cerrar es ${veredicto.radioM} m: esta orden se cierra desde la casa del cliente. `
            + 'Si ya estás allí y lo que está mal es la dirección guardada, déjalo dicho en el '
            + 'seguimiento para que se corrija y la cierre tu coordinador.',
        });

      case 'permitir-y-georreferenciar':
        return {
          veredicto,
          senales,
          datos: { ...base, closeGeoOk: null },
          georreferenciar: tecnico ? { lat: tecnico.lat, lng: tecnico.lng } : null,
        };

      case 'permitir-marcado':
        // Modo observación: no se frena, pero queda igual de registrado que si
        // se hubiera bloqueado. Es el dato con el que se decidirá el radio real.
        this.log.log(
          `Cierre fuera de rango (observando): ${Math.round(veredicto.distanciaM)} m > ${veredicto.radioM} m`,
        );
        return {
          veredicto,
          senales,
          datos: { ...base, closeDistanceM: veredicto.distanciaM, closeGeoOk: false },
          georreferenciar: null,
        };

      case 'permitir':
      default:
        return {
          veredicto,
          senales,
          datos: {
            ...base,
            closeDistanceM: 'distanciaM' in veredicto ? veredicto.distanciaM : null,
            // `true` solo cuando de verdad se comprobó y se cumplió; en los demás
            // casos `null` = "no aplicaba", que no es lo mismo que "cumplió".
            closeGeoOk: veredicto.motivo === 'dentro-de-rango' ? true : null,
          },
          georreferenciar: null,
        };
    }
  }

  /**
   * Informe de cierres marcados. Es lo que hace útil el modo observación: sin
   * esto, "observar" es no hacer nada.
   */
  async informe(dias = 30) {
    const desde = new Date(Date.now() - dias * 86400_000);
    const [fuera, dentro, sinDato] = await Promise.all([
      this.prisma.ticket.count({ where: { closeGeoOk: false, finalDate: { gte: desde } } }),
      this.prisma.ticket.count({ where: { closeGeoOk: true, finalDate: { gte: desde } } }),
      this.prisma.ticket.count({
        where: { status: 'RESUELTO', closeGeoOk: null, finalDate: { gte: desde } },
      }),
    ]);

    const casos = await this.prisma.ticket.findMany({
      where: { closeGeoOk: false, finalDate: { gte: desde } },
      orderBy: { closeDistanceM: 'desc' },
      take: 200,
      select: {
        id: true, code: true, type: true, assigned: true, finalDate: true,
        closeDistanceM: true, closeAccuracyM: true, closeGeoReason: true,
        closeLat: true, closeLng: true, closeFlags: true,
        subscriber: { select: { id: true, abonado: true, fullName: true, gpsLat: true, gpsLng: true } },
      },
    });

    // Los cierres CON señales pero que pasaron la cerca son el caso más
    // interesante: la pasaron precisamente porque el punto podría ser falso.
    const sospechosos = await this.prisma.ticket.findMany({
      where: { finalDate: { gte: desde }, NOT: { closeFlags: { isEmpty: true } } },
      orderBy: { finalDate: 'desc' },
      take: 100,
      select: {
        id: true, code: true, type: true, assigned: true, finalDate: true,
        closeFlags: true, closeGeoOk: true, closeDistanceM: true,
        subscriber: { select: { id: true, abonado: true, fullName: true } },
      },
    });

    // Las órdenes guardan al técnico con su username del legacy; aquí sale su nombre.
    const tr = await traductorDeTecnicos(this.prisma);

    return {
      dias,
      modo: await this.modo(),
      radioM: await this.radioM(),
      resumen: { fuera, dentro, sinDato, sospechosos: sospechosos.length },
      sospechosos: sospechosos.map((c) => ({
        id: c.id, code: c.code, type: c.type, tecnico: tr.nombre(c.assigned), fecha: c.finalDate,
        senales: c.closeFlags, dentroDeRango: c.closeGeoOk,
        cliente: c.subscriber
          ? { id: c.subscriber.id, abonado: c.subscriber.abonado, nombre: c.subscriber.fullName }
          : null,
      })),
      casos: casos.map((c) => ({
        id: c.id,
        code: c.code,
        type: c.type,
        tecnico: tr.nombre(c.assigned),
        fecha: c.finalDate,
        distanciaM: c.closeDistanceM,
        precisionM: c.closeAccuracyM,
        justificacion: c.closeGeoReason,
        senales: c.closeFlags,
        cierre: c.closeLat != null && c.closeLng != null ? { lat: c.closeLat, lng: c.closeLng } : null,
        cliente: c.subscriber
          ? {
              id: c.subscriber.id,
              abonado: c.subscriber.abonado,
              nombre: c.subscriber.fullName,
              punto: parsePoint(c.subscriber.gpsLat, c.subscriber.gpsLng),
            }
          : null,
      })),
    };
  }

  /**
   * Reúne las señales de ubicación simulada para un punto reportado.
   *
   * Todo lo que necesita ya está guardado: los puntos anteriores del usuario
   * (GeoPing) y la geo de las fotos de evidencia de esta misma orden. No se le
   * pide nada extra al técnico.
   */
  private async senalesDe(
    punto: { lat: number; lng: number; accuracyM: number | null },
    user: AuthUser | undefined,
    ip: string | null | undefined,
    ticketCode: number | null,
  ): Promise<Senal[]> {
    if (!user) return [];
    const ahora = new Date();

    const [previos, hilos, oficinas] = await Promise.all([
      // Los últimos puntos del mismo usuario: para el punto calcado y el salto.
      this.prisma.geoPing.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { lat: true, lng: true, createdAt: true },
      }),
      // Fotos de evidencia de esta orden, que traen su propia coordenada.
      ticketCode != null
        ? this.prisma.ticketThread.findMany({
            where: { ticketCode, geoLat: { not: null }, geoLng: { not: null } },
            orderBy: { date: 'desc' },
            take: 10,
            select: { geoLat: true, geoLng: true },
          })
        : Promise.resolve([]),
      this.oficinas(),
    ]);

    const anterior = previos[0]
      ? { lat: previos[0].lat, lng: previos[0].lng, en: previos[0].createdAt }
      : null;

    return detectarSenales({
      punto: { ...punto, en: ahora },
      anterior,
      puntosPrevios: previos.map((p) => ({ lat: p.lat, lng: p.lng })),
      ip,
      oficinas,
      fotos: hilos.flatMap((h) => {
        const p = parsePoint(h.geoLat, h.geoLng);
        return p ? [p] : [];
      }),
    });
  }

  /** IPs públicas exactas de las oficinas, separadas por coma. */
  async oficinas(): Promise<string[]> {
    const crudo = process.env.OFFICE_IPS ?? (await this.ajuste(K_OFICINAS));
    if (!crudo?.trim()) return [];
    return crudo.split(',').map((x) => normalizarIp(x)).filter(Boolean);
  }

  async guardarOficinas(ips: string[], user?: AuthUser): Promise<{ ips: string[] }> {
    const limpias = [...new Set(ips.map((x) => normalizarIp(x)).filter(Boolean))];
    await this.prisma.appSetting.upsert({
      where: { key: K_OFICINAS },
      create: { key: K_OFICINAS, value: limpias.join(','), group: 'security', updatedBy: user?.name },
      update: { value: limpias.join(','), updatedBy: user?.name },
    });
    return { ips: limpias };
  }

  /**
   * IPs desde las que se ha escrito en el sistema, con quién y cuánto.
   *
   * Existe porque nadie sabe de memoria la IP pública de su oficina — y menos si
   * es dinámica. En vez de pedir un dato que hay que ir a buscar, se enseña lo
   * que el sistema ya vio y se marca con un clic. La auditoría ya guardaba la IP
   * de cada escritura; sólo faltaba mirarla.
   */
  async ipsVistas(dias = 90) {
    const desde = new Date(Date.now() - dias * 86400_000);
    const filas = await this.prisma.auditLog.findMany({
      where: { createdAt: { gte: desde }, ipAddress: { not: null } },
      select: { ipAddress: true, createdAt: true, user: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 5000,
    });

    const marcadas = new Set(await this.oficinas());
    const porIp = new Map<string, { escrituras: number; usuarios: Set<string>; ultima: Date }>();
    for (const f of filas) {
      const ip = normalizarIp(f.ipAddress!);
      // Localhost es el propio servidor (tareas, scripts): nunca es una oficina.
      if (ip === '127.0.0.1' || ip === '::1') continue;
      const e = porIp.get(ip) ?? { escrituras: 0, usuarios: new Set<string>(), ultima: f.createdAt };
      e.escrituras++;
      if (f.user?.name) e.usuarios.add(f.user.name);
      if (f.createdAt > e.ultima) e.ultima = f.createdAt;
      porIp.set(ip, e);
    }

    return {
      dias,
      configuradas: [...marcadas],
      ips: [...porIp.entries()]
        .map(([ip, e]) => ({
          ip,
          escrituras: e.escrituras,
          usuarios: [...e.usuarios],
          ultima: e.ultima,
          esOficina: marcadas.has(ip),
        }))
        .sort((a, b) => b.escrituras - a.escrituras),
    };
  }

  private async ajuste(key: string): Promise<string | null> {
    const row = await this.prisma.appSetting.findUnique({ where: { key } });
    return row?.value ?? null;
  }
}
