import { Module } from '@nestjs/common';
import { CronService } from './cron.service';
import { CronController } from './cron.controller';
import { BillingModule } from '../billing/billing.module';

@Module({
  imports: [BillingModule], // aporta FacturasService para la facturación recurrente
  controllers: [CronController],
  providers: [CronService],
  exports: [CronService],
})
export class CronModule {}
