import { ResponsibilitiesService } from './responsibilities.service';
import { SetHoldersDto } from './dto/responsibilities.dto';
import { type AuthUser } from '../auth/current-user.decorator';

/**
 * Encargados por cargo: quién es el de call center, el de bodega, el de cartera.
 *
 * Restringido a sistemas y gerencia igual que el resto de Configuración. Nombrar al
 * encargado de un frente decide a quién le llega el trabajo, así que no es una
 * preferencia personal: es organización de la empresa.
 */
export class ResponsibilitiesController {
  constructor(private readonly responsibilities: ResponsibilitiesService) {}

  list() {
    return this.responsibilities.list();
  }

  /** Usuarios activos que se pueden nombrar (para el selector de la pantalla). */
  assignable() {
    return this.responsibilities.assignableUsers();
  }

  set(post: string, body: SetHoldersDto, u?: AuthUser) {
    return this.responsibilities.setHolders(post, body?.holders ?? [], u?.name ?? u?.email);
  }
}
