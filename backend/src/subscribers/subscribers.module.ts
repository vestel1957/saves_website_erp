import { Module } from '@nestjs/common';
import { SubscribersController } from './subscribers.controller';
import { SubscribersService } from './subscribers.service';
import { SubscriberGeoService } from './subscriber-geo.service';
import { SubscriberFilesService } from './subscriber-files.service';
import { SubscriberNotesService } from './subscriber-notes.service';
import { NetworkModule } from '../network/network.module';

@Module({
  imports: [NetworkModule], // aporta MikrotikService para empujar el perfil al cambiar de plan
  controllers: [SubscribersController],
  providers: [
    SubscribersService,
    SubscriberGeoService,
    SubscriberFilesService,
    SubscriberNotesService,
  ],
  exports: [SubscribersService],
})
export class SubscribersModule {}
