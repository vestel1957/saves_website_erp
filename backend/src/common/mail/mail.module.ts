import { Module } from '@nestjs/common';
import { MailService } from './mail.service';
import { MailController } from './mail.controller';
import { SettingsModule } from '../../settings/settings.module';

/**
 * Correo saliente (SMTP vía nodemailer) + plantillas de correo. Exporta
 * MailService para que Billing (envío de factura) y Cron (recordatorios de
 * cartera) puedan enviar correos.
 */
@Module({
  imports: [SettingsModule],
  controllers: [MailController],
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
