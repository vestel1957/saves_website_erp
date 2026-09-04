import { BundlesService } from './bundles.service';
import { CreateBundleDto, UpdateBundleDto } from './dto/bundle.dto';

/** Combos comerciales (paquetes de planes que se venden juntos). */
export class BundlesController {
  constructor(private readonly bundles: BundlesService) {}

  list(activeOnly?: string) {
    return this.bundles.list({ activeOnly: activeOnly === 'true' });
  }

  /** Catálogo de apps que se pueden ofrecer en un combo (para el selector). */
  apps() {
    return this.bundles.appsCatalogo();
  }

  create(dto: CreateBundleDto) {
    return this.bundles.create(dto);
  }

  update(id: string, dto: UpdateBundleDto) {
    return this.bundles.update(id, dto);
  }

  remove(id: string) {
    return this.bundles.remove(id);
  }
}
