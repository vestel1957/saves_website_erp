import { Module } from '@nestjs/common';
import { SupportController } from './support.controller';
import { SupportService } from './support.service';
import { AgendaService } from './agenda.service';
import { SupportWriteService } from './support-write.service';
import { GeofenceService } from './geofence.service';
import { OnuProvisionService } from './onu-provision.service';
import { NetworkModule } from '../network/network.module';
import { ResponsibilitiesModule } from '../responsibilities/responsibilities.module';
import { ReportsModule } from '../reports/reports.module';

@Module({
  // Aporta MikrotikService para la cascada al resolver, y OltService +
  // OltPlanProfileService para autenticar la ONU desde la orden de instalación.
  // ResponsibilitiesModule avisa al encargado de soporte de las órdenes sin asignar.
  // ReportsModule presta PerformanceService: "mi rendimiento" mide con la misma regla
  // que el tablero de gerencia en vez de tener su propia versión de la re-visita.
  imports: [NetworkModule, ResponsibilitiesModule, ReportsModule],
  controllers: [SupportController],
  providers: [SupportService, AgendaService, SupportWriteService, GeofenceService, OnuProvisionService],
  exports: [SupportService, AgendaService, SupportWriteService, GeofenceService, OnuProvisionService],
})
export class SupportModule {}
