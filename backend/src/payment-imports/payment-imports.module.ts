import { Module } from '@nestjs/common';
import { PaymentImportsService } from './payment-imports.service';
import { PaymentImportsController } from './payment-imports.controller';
import { TreasuryModule } from '../treasury/treasury.module';
import { NetworkModule } from '../network/network.module';

/**
 * Cargue masivo de pagos externos (Efecty). Reutiliza CobranzasService.collect y,
 * al terminar el lote, ReconexionService para devolverle el servicio a quien pagó.
 */
@Module({
  imports: [TreasuryModule, NetworkModule],
  controllers: [PaymentImportsController],
  providers: [PaymentImportsService],
})
export class PaymentImportsModule {}
