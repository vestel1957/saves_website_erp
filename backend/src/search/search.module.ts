import { Module } from '@nestjs/common';
import { SubscribersModule } from '../subscribers/subscribers.module';
import { BillingModule } from '../billing/billing.module';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';

/**
 * Búsqueda con IA (⌘K en lenguaje natural). Reutiliza los servicios de
 * abonados y facturación que ya exponen su list() con filtros; aquí solo se
 * añade la capa que traduce la frase del usuario a esos filtros.
 */
@Module({
  imports: [SubscribersModule, BillingModule],
  controllers: [SearchController],
  providers: [SearchService],
})
export class SearchModule {}
