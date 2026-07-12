import { Module } from '@nestjs/common';
import { CronService } from './cron.service';
import { CronController } from './cron.controller';
import { BillingModule } from '../billing/billing.module';
import { MailModule } from '../common/mail/mail.module';

@Module({
  imports: [BillingModule, MailModule], // Facturas (recurrente) + Mail (recordatorios)
  controllers: [CronController],
  providers: [CronService],
  exports: [CronService],
})
export class CronModule {}
