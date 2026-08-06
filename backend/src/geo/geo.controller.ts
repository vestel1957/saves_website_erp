import { GeoService } from './geo.service';
import { MapQueryDto, PingDto, RouteDto, SetSubscriberLocationDto } from './dto/geo.dto';
import { AuthUser } from '../auth/current-user.decorator';

/** Mapa: abonados, cajas NAP y última posición conocida de los funcionarios. */
export class GeoController {
  constructor(private readonly geo: GeoService) {}

  points(user: AuthUser, q: MapQueryDto) {
    return this.geo.points(user, q);
  }

  coverage(user: AuthUser) {
    return this.geo.coverage(user);
  }

  /**
   * Dónde está cada funcionario. Más restringido que el resto del módulo a
   * propósito: saber dónde está un compañero es información de jefatura, no algo
   * que deba ver cualquiera que entre al mapa.
   */
  technicians(user: AuthUser, horas?: string) {
    const h = Number(horas);
    return this.geo.technicians(user, Number.isFinite(h) && h > 0 && h <= 168 ? h : undefined);
  }

  /** Recorrido de un funcionario en un día. Misma restricción que `technicians`. */
  trail(userId: string, fecha?: string) {
    return this.geo.trail(userId, fecha);
  }

  /**
   * Punto propio. Sin `@RequireArea` extra: cualquiera que use el sistema puede
   * registrar DÓNDE ESTÁ ÉL. Nadie puede grabar el punto de otro — el usuario
   * sale del token, nunca del cuerpo de la petición.
   */
  ping(user: AuthUser, dto: PingDto) {
    return this.geo.ping(user, dto);
  }

  /**
   * Ruta hasta el destino. Es POST y no GET porque lleva la posición del
   * funcionario en el cuerpo: esa coordenada no debe quedar escrita en los logs
   * de acceso ni en el historial del navegador.
   */
  route(user: AuthUser, dto: RouteDto) {
    return this.geo.route(user, dto);
  }

  setSubscriberLocation(
    user: AuthUser,
    id: string,
    dto: SetSubscriberLocationDto,
  ) {
    return this.geo.setSubscriberLocation(user, id, dto);
  }
}
