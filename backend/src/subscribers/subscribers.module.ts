import { Module } from '@nestjs/common';
import { SubscribersController } from './subscribers.controller';
import { SubscribersService } from './subscribers.service';
import { NetworkModule } from '../network/network.module';

@Module({
  imports: [NetworkModule], // aporta MikrotikService para empujar el perfil al cambiar de plan
  controllers: [SubscribersController],
  providers: [SubscribersService],
  exports: [SubscribersService],
})
export class SubscribersModule {}
