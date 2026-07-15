import { Module } from '@nestjs/common';
import { PaymentImportsService } from './payment-imports.service';
import { PaymentImportsController } from './payment-imports.controller';
import { TreasuryModule } from '../treasury/treasury.module';

/** Cargue masivo de pagos externos (Efecty). Reutiliza CobranzasService.collect. */
@Module({
  imports: [TreasuryModule],
  controllers: [PaymentImportsController],
  providers: [PaymentImportsService],
})
export class PaymentImportsModule {}
