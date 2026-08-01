import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ResponsibilitiesModule } from '../../responsibilities/responsibilities.module';
import { WhatsappService } from './whatsapp.service';
import { WhatsappLogService } from './whatsapp-log.service';
import { WhatsappCampaignService } from './whatsapp-campaign.service';
import { WhatsappRemindersService } from './whatsapp-reminders.service';
import { WhatsappInboxService } from './whatsapp-inbox.service';
import { WhatsappInternalAlertListener } from './whatsapp-internal-alert.listener';
import { WhatsappController } from './whatsapp.controller';
import { WhatsappWebhookController } from './whatsapp-webhook.controller';
import { WhatsappInboxController } from './whatsapp-inbox.controller';

/**
 * Módulo de WhatsApp (Kapso, Cloud API oficial). Exporta WhatsappService para que
 * cualquier canal de alertas (inventario, mantenimiento, SST…) y el chatbot
 * puedan enviar mensajes y recibir el webhook entrante.
 *
 * `WhatsappInboxService` se exporta para que el chatbot sincronice sus escalados con
 * la bandeja (ChatbotModule importa a este; nunca al revés).
 */
@Module({
  imports: [AuthModule, NotificationsModule, ResponsibilitiesModule],
  controllers: [WhatsappController, WhatsappWebhookController, WhatsappInboxController],
  providers: [WhatsappService, WhatsappLogService, WhatsappCampaignService, WhatsappRemindersService, WhatsappInboxService, WhatsappInternalAlertListener],
  exports: [WhatsappService, WhatsappLogService, WhatsappCampaignService, WhatsappRemindersService, WhatsappInboxService],
})
export class WhatsappModule {}
