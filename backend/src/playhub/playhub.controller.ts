import { IsString, MinLength } from 'class-validator';
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
  live(id: string) {
    return this.playhub.liveSubscriptions(id);
  }

  /** Suscripciones locales del cliente (tabla incremental). */
  local(id: string) {
    return this.playhub.localSubscriptions(id);
  }

  subscribe(id: string, dto: ProductDto) {
    return this.playhub.subscribe(id, dto.productId);
  }

  unsubscribe(id: string, dto: ProductDto) {
    return this.playhub.unsubscribe(id, dto.productId);
  }

  syncCustomer(id: string) {
    return this.playhub.syncCustomer(id);
  }

  /** Refresca la tabla local del cliente contra sus suscripciones en vivo. */
  syncLocal(id: string) {
    return this.playhub.syncSubscriber(id);
  }

  /** Sincronización masiva (todos los clientes con suscripciones locales). */
  syncAll(limit?: string) {
    return this.playhub.syncAll(limit ? Number(limit) : 500);
  }
}
