import { Module } from '@nestjs/common';
import { GeoController } from './geo.controller';
import { GeoService } from './geo.service';
import { RoutingService } from './routing.service';

@Module({
  controllers: [GeoController],
  providers: [GeoService, RoutingService],
  exports: [GeoService, RoutingService],
})
export class GeoModule {}
