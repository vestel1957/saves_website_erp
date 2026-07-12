import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { WhatsappService } from './whatsapp.service';
import { WhatsappLogService } from './whatsapp-log.service';
import { WhatsappController } from './whatsapp.controller';
import { WhatsappWebhookController } from './whatsapp-webhook.controller';

/**
 * Módulo de WhatsApp (Kapso, Cloud API oficial). Exporta WhatsappService para que
 * cualquier canal de alertas (inventario, mantenimiento, SST…) y el chatbot
 * puedan enviar mensajes y recibir el webhook entrante.
 */
@Module({
  imports: [AuthModule],
  controllers: [WhatsappController, WhatsappWebhookController],
  providers: [WhatsappService, WhatsappLogService],
  exports: [WhatsappService, WhatsappLogService],
})
export class WhatsappModule {}
