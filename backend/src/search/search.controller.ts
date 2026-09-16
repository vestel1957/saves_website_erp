import { AuthUser } from '../auth/current-user.decorator';
import { SearchService } from './search.service';
import { esTecnicoDeCampo } from '../common/tecnico-scope';
import { ForbiddenException } from '../core/http/errores';

/**
 * Búsqueda con IA del ⌘K. La llama cualquier funcionario autenticado MENOS el
 * técnico de campo (ver `ai()`); el servicio filtra además internamente qué
 * módulos consulta según su área (RBAC), así que no lleva `exigirArea` a nivel de
 * ruta: la puerta está en los datos.
 */
export class SearchController {
  constructor(private readonly search: SearchService) {}

  ai(q: string, user: AuthUser) {
    // El técnico de campo NO tiene buscador (2026-09-10): se le quitó el ⌘K de la
    // barra y aquí se cierra la puerta, que es donde cuenta. Su perfil va acotado a
    // sus órdenes, su bodega y sus equipos; una búsqueda libre sobre clientes y
    // facturas es exactamente lo contrario.
    if (esTecnicoDeCampo(user)) {
      throw new ForbiddenException('La búsqueda no está disponible para tu perfil.');
    }
    return this.search.search(q ?? '', user);
  }
}
