import { Module } from '@nestjs/common';
import { CronService } from './cron.service';
import { CronController } from './cron.controller';
import { BillingModule } from '../billing/billing.module';
import { MailModule } from '../common/mail/mail.module';
import { WhatsappModule } from '../common/whatsapp/whatsapp.module';
import { ReportsModule } from '../reports/reports.module';

@Module({
  // Facturas (recurrente) + Mail y WhatsApp (recordatorios de cartera por los dos canales)
  imports: [BillingModule, MailModule, WhatsappModule, ReportsModule],
  controllers: [CronController],
  providers: [CronService],
  exports: [CronService],
})
export class CronModule {}
