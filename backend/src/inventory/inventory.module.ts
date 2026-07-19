import { Module } from '@nestjs/common';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { InventoryAlertsService } from './alerts.service';

@Module({
  controllers: [InventoryController],
  providers: [InventoryService, InventoryAlertsService],
  exports: [InventoryService],
})
export class InventoryModule {}
