import { Module } from '@nestjs/common';
import { NetworkController } from './network.controller';
import { NetworkService } from './network.service';
import { NetworkWriteService } from './network-write.service';
import { MikrotikService } from './mikrotik.service';
import { MikrotikAdminService } from './mikrotik-admin.service';
import { MikrotikController } from './mikrotik.controller';
import { OltController } from './olt.controller';
import { OltService } from './olt.service';
import { WhatsappModule } from '../common/whatsapp/whatsapp.module';

@Module({
  imports: [WhatsappModule], // aporta WhatsappService para la mensajería masiva
  controllers: [NetworkController, OltController, MikrotikController],
  providers: [NetworkService, NetworkWriteService, MikrotikService, MikrotikAdminService, OltService],
  exports: [NetworkService, NetworkWriteService, MikrotikService, MikrotikAdminService, OltService],
})
export class NetworkModule {}
