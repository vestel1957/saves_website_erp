import { Module } from '@nestjs/common';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { InventoryAlertsService } from './alerts.service';
import { SignatureModule } from '../common/signature/signature.module';
import { WhatsappModule } from '../common/whatsapp/whatsapp.module';

@Module({
  // SignatureModule: el código con el que se firma el recibido del acta.
  // WhatsappModule: el acta en PDF sale sola al WhatsApp de quien la firma.
  imports: [SignatureModule, WhatsappModule],
  controllers: [InventoryController],
  providers: [InventoryService, InventoryAlertsService],
  exports: [InventoryService],
})
export class InventoryModule {}
