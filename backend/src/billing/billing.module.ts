import { Module } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { FacturasService } from './facturas.service';
import { RecurringService } from './recurring.service';
import { WhatsappModule } from '../common/whatsapp/whatsapp.module';

@Module({
  imports: [WhatsappModule],
  controllers: [BillingController],
  providers: [BillingService, FacturasService, RecurringService],
  exports: [BillingService, FacturasService, RecurringService],
})
export class BillingModule {}
