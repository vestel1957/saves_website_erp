import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../common/notifications/notifications.module';
import { ResponsibilitiesService } from './responsibilities.service';
import { ResponsibilityNotifierService } from './responsibility-notifier.service';
import { ResponsibilitiesController } from './responsibilities.controller';

/**
 * Encargados por cargo.
 *
 * NO importa WhatsappModule a propósito, aunque mande WhatsApps: la bandeja de
 * WhatsApp es uno de los módulos que avisa por cargo, así que importarlo cerraría el
 * ciclo. El envío sale por el evento `internal.alert`, que escucha un listener del
 * lado de WhatsApp. Aquí las flechas sólo apuntan hacia afuera.
 */
@Module({
  imports: [AuthModule, NotificationsModule],
  controllers: [ResponsibilitiesController],
  providers: [ResponsibilitiesService, ResponsibilityNotifierService],
  exports: [ResponsibilitiesService, ResponsibilityNotifierService],
})
export class ResponsibilitiesModule {}
