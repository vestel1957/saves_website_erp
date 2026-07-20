import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/current-user.decorator';
import { parsePoint } from '../geo/geo.util';
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
  /** Qué escribir en el Ticket al cerrar. */
  datos: {
    closeLat: number | null;
    closeLng: number | null;
    closeAccuracyM: number | null;
    closeDistanceM: number | null;
    closeGeoOk: boolean | null;
    closeGeoReason: string | null;
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
@Injectable()
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
    ticket: { type: string | null; subscriberId: string | null },
    dto: { lat?: number; lng?: number; accuracyM?: number; justificacion?: string },
    user: AuthUser | undefined,
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
      justificacion: dto.justificacion,
    });

    const base = {
      closeLat: tecnico?.lat ?? null,
      closeLng: tecnico?.lng ?? null,
      closeAccuracyM: tecnico?.accuracyM ?? null,
      closeDistanceM: null as number | null,
      closeGeoOk: null as boolean | null,
      closeGeoReason: null as string | null,
    };

    switch (veredicto.accion) {
      case 'exigir-ubicacion':
        throw new GeofenceException({ razon: 'sin-ubicacion', message: veredicto.motivo, radioM });

      case 'exigir-justificacion':
        throw new GeofenceException({
          razon: 'fuera-de-rango',
          distanciaM: veredicto.distanciaM,
          radioM: veredicto.radioM,
          message:
            `Estás a ${Math.round(veredicto.distanciaM)} m del domicilio del cliente y el máximo ` +
            `para cerrar es ${veredicto.radioM} m. Si aun así tienes que cerrarla, escribe el motivo.`,
        });

      case 'permitir-y-georreferenciar':
        return {
          veredicto,
          datos: { ...base, closeGeoOk: null },
          georreferenciar: tecnico ? { lat: tecnico.lat, lng: tecnico.lng } : null,
        };

      case 'permitir-justificado':
        return {
          veredicto,
          datos: {
            ...base,
            closeDistanceM: veredicto.distanciaM,
            closeGeoOk: false,
            closeGeoReason: dto.justificacion?.trim() ?? null,
          },
          georreferenciar: null,
        };

      case 'permitir-marcado':
        // Modo observación: no se frena, pero queda igual de registrado que si
        // se hubiera bloqueado. Es el dato con el que se decidirá el radio real.
        this.log.log(
          `Cierre fuera de rango (observando): ${Math.round(veredicto.distanciaM)} m > ${veredicto.radioM} m`,
        );
        return {
          veredicto,
          datos: { ...base, closeDistanceM: veredicto.distanciaM, closeGeoOk: false },
          georreferenciar: null,
        };

      case 'permitir':
      default:
        return {
          veredicto,
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
        closeLat: true, closeLng: true,
        subscriber: { select: { id: true, abonado: true, fullName: true, gpsLat: true, gpsLng: true } },
      },
    });

    return {
      dias,
      modo: await this.modo(),
      radioM: await this.radioM(),
      resumen: { fuera, dentro, sinDato },
      casos: casos.map((c) => ({
        id: c.id,
        code: c.code,
        type: c.type,
        tecnico: c.assigned,
        fecha: c.finalDate,
        distanciaM: c.closeDistanceM,
        precisionM: c.closeAccuracyM,
        justificacion: c.closeGeoReason,
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

  private async ajuste(key: string): Promise<string | null> {
    const row = await this.prisma.appSetting.findUnique({ where: { key } });
    return row?.value ?? null;
  }
}
