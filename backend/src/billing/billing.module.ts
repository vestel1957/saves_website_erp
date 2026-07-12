import { Module } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { FacturasService } from './facturas.service';
import { RecurringService } from './recurring.service';
import { WhatsappModule } from '../common/whatsapp/whatsapp.module';
import { MailModule } from '../common/mail/mail.module';

@Module({
  imports: [WhatsappModule, MailModule],
  controllers: [BillingController],
  providers: [BillingService, FacturasService, RecurringService],
  exports: [BillingService, FacturasService, RecurringService],
})
export class BillingModule {}
