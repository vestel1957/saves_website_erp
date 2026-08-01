import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthUser } from '../auth/current-user.decorator';
import { esTecnicoDeCampo } from '../common/tecnico-scope';

/**
 * Puerta del módulo RED / ISP y de Mikrotik frente al técnico de campo
 * (2026-07-31, decisión del usuario: se le quitan del sidebar y del acceso).
 *
 * No basta con quitarle las llaves de pantalla: los controladores de red están
 * abiertos por ÁREA (`@RequireArea('tecnicos', ...)`) y él sigue siendo del área
 * técnica —lo necesita para soporte y para su inventario—, así que sin esto seguiría
 * llegando a `/api/network/*` a mano: ver la OLT, listar routers, tumbar sesiones.
 *
 * Se hace con lista blanca y no con lista negra: lo que el técnico conserva del
 * módulo son DOS lecturas (sus equipos y su "bodega"), marcadas con
 * `@AbiertoAlTecnico()`. Cualquier ruta nueva de red nace cerrada para él, que es el
 * lado correcto cuando lo que hay detrás son cortes de servicio y routers.
 *
 * OJO — lo que este guard NO toca: autenticar la ONU y aplicar la velocidad DENTRO de
 * una orden de trabajo. Esas dos viven en `SupportController` (no aquí) y siguen
 * exigiendo `network.olt.manage`, que el técnico conserva: es su trabajo de campo, no
 * el módulo de Red. Si algún día se le quita ese permiso, se queda sin poder instalar.
 */
export const ABIERTO_AL_TECNICO = 'abierto_al_tecnico';

/** Marca una ruta del módulo de red como accesible para el técnico de campo. */
export const AbiertoAlTecnico = () => SetMetadata(ABIERTO_AL_TECNICO, true);

@Injectable()
export class ModuloRedGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const abierto = this.reflector.getAllAndOverride<boolean>(ABIERTO_AL_TECNICO, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (abierto) return true;

    const user = context.switchToHttp().getRequest<{ user?: AuthUser }>().user;
    if (!esTecnicoDeCampo(user)) return true;

    throw new ForbiddenException('Red / ISP y Mikrotik no están en tu perfil.');
  }
}
