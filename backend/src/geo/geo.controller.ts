import { Body, Controller, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { GeoService } from './geo.service';
import { MapQueryDto, PingDto, RouteDto, SetSubscriberLocationDto } from './dto/geo.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AreaGuard } from '../auth/area.guard';
import { RequireArea } from '../auth/require-area.decorator';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';

/** Mapa: abonados, cajas NAP y última posición conocida de los funcionarios. */
@Controller('geo')
@UseGuards(JwtAuthGuard, AreaGuard)
@RequireArea('gerencia', 'administracion', 'contabilidad', 'tecnicos', 'sistemas', 'caja')
export class GeoController {
  constructor(private readonly geo: GeoService) {}

  @Get('points')
  points(@CurrentUser() user: AuthUser, @Query() q: MapQueryDto) {
    return this.geo.points(user, q);
  }

  @Get('coverage')
  coverage(@CurrentUser() user: AuthUser) {
    return this.geo.coverage(user);
  }

  /**
   * Dónde está cada funcionario. Más restringido que el resto del módulo a
   * propósito: saber dónde está un compañero es información de jefatura, no algo
   * que deba ver cualquiera que entre al mapa.
   */
  @Get('technicians')
  @RequireArea('gerencia', 'administracion', 'sistemas')
  technicians(@CurrentUser() user: AuthUser, @Query('horas') horas?: string) {
    const h = Number(horas);
    return this.geo.technicians(user, Number.isFinite(h) && h > 0 && h <= 168 ? h : undefined);
  }

  /** Recorrido de un funcionario en un día. Misma restricción que `technicians`. */
  @Get('trail/:userId')
  @RequireArea('gerencia', 'administracion', 'sistemas')
  trail(@Param('userId') userId: string, @Query('fecha') fecha?: string) {
    return this.geo.trail(userId, fecha);
  }

  /**
   * Punto propio. Sin `@RequireArea` extra: cualquiera que use el sistema puede
   * registrar DÓNDE ESTÁ ÉL. Nadie puede grabar el punto de otro — el usuario
   * sale del token, nunca del cuerpo de la petición.
   */
  @Post('ping')
  @RequireArea('gerencia', 'administracion', 'contabilidad', 'tecnicos', 'sistemas', 'caja')
  ping(@CurrentUser() user: AuthUser, @Body() dto: PingDto) {
    return this.geo.ping(user, dto);
  }

  /**
   * Ruta hasta el destino. Es POST y no GET porque lleva la posición del
   * funcionario en el cuerpo: esa coordenada no debe quedar escrita en los logs
   * de acceso ni en el historial del navegador.
   */
  @Post('route')
  route(@CurrentUser() user: AuthUser, @Body() dto: RouteDto) {
    return this.geo.route(user, dto);
  }

  @Put('subscribers/:id/location')
  @RequireArea('gerencia', 'administracion', 'tecnicos', 'sistemas')
  setSubscriberLocation(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: SetSubscriberLocationDto,
  ) {
    return this.geo.setSubscriberLocation(user, id, dto);
  }
}
