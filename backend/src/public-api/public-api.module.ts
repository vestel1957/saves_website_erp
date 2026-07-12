import { Module } from '@nestjs/common';
import { ApiKeysService } from './api-keys.service';
import { ApiKeysController } from './api-keys.controller';
import { PublicService } from './public.service';
import { PublicController } from './public.controller';
import { ApiKeyGuard } from './api-key.guard';

/**
 * API REST pública para terceros (claves de API) + su panel de gestión.
 * El acceso público va por ApiKeyGuard; la gestión por JwtAuthGuard+área.
 */
@Module({
  controllers: [ApiKeysController, PublicController],
  providers: [ApiKeysService, PublicService, ApiKeyGuard],
})
export class PublicApiModule {}
