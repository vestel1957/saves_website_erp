import { IsString, MinLength } from 'class-validator';
import { AuthUser } from '../auth/current-user.decorator';
import { PlayhubService } from './playhub.service';

export class ProductDto {
  @IsString() @MinLength(1)
  productId!: string;
}

/** Integración PlayHub (OTT): catálogo, suscripciones, y sincronización. */
export class PlayhubController {
  constructor(private readonly playhub: PlayhubService) {}

  status() {
    return this.playhub.status();
  }

  catalog() {
    return this.playhub.catalog();
  }

  /** Suscripciones en vivo del cliente (consulta a PlayHub). */
  live(user: AuthUser, id: string) {
    return this.playhub.liveSubscriptions(user, id);
  }

  /** Suscripciones locales del cliente (tabla incremental). */
  local(user: AuthUser, id: string) {
    return this.playhub.localSubscriptions(user, id);
  }

  subscribe(user: AuthUser, id: string, dto: ProductDto) {
    return this.playhub.subscribe(user, id, dto.productId);
  }

  unsubscribe(user: AuthUser, id: string, dto: ProductDto) {
    return this.playhub.unsubscribe(user, id, dto.productId);
  }

  syncCustomer(user: AuthUser, id: string) {
    return this.playhub.syncCustomer(user, id);
  }

  /** Refresca la tabla local del cliente contra sus suscripciones en vivo. */
  syncLocal(user: AuthUser, id: string) {
    return this.playhub.syncSubscriber(user, id);
  }

  /** Elegibilidad del cliente (regla del mínimo de Megas, `PLAYHUB_MIN_MEGAS`). */
  eligibility(user: AuthUser, id: string) {
    return this.playhub.eligibility(user, id);
  }

  /**
   * Barrida masiva: arranca en segundo plano y devuelve al momento. `limit` sólo
   * se usa para probar sobre un puñado de clientes; sin él barre todos los que
   * tienen email (que es el login de PlayHub).
   */
  syncAll(limit?: string) {
    return this.playhub.syncAll(limit ? Number(limit) : undefined);
  }

  /** Progreso de la barrida masiva. */
  syncStatus() {
    return this.playhub.syncStatus();
  }
}
