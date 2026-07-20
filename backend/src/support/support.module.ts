import { Module } from '@nestjs/common';
import { SupportController } from './support.controller';
import { SupportService } from './support.service';
import { SupportWriteService } from './support-write.service';
import { GeofenceService } from './geofence.service';
import { NetworkModule } from '../network/network.module';

@Module({
  imports: [NetworkModule], // aporta MikrotikService para la cascada al resolver
  controllers: [SupportController],
  providers: [SupportService, SupportWriteService, GeofenceService],
  exports: [SupportService, SupportWriteService, GeofenceService],
})
export class SupportModule {}
