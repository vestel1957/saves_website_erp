import { Module } from '@nestjs/common';
import {
  MyPromotionsController,
  PromotionsController,
} from './promotions.controller';
import { PromotionsService } from './promotions.service';
import { BillingModule } from '../billing/billing.module';

/** Promociones de facturación (legacy `settings/promociones`). */
@Module({
  imports: [BillingModule],
  controllers: [PromotionsController, MyPromotionsController],
  providers: [PromotionsService],
  exports: [PromotionsService],
})
export class PromotionsModule {}
