import { Module } from '@nestjs/common';
import { NetworkController } from './network.controller';
import { NetworkService } from './network.service';
import { NetworkWriteService } from './network-write.service';
import { MikrotikService } from './mikrotik.service';
import { MikrotikAdminService } from './mikrotik-admin.service';
import { MikrotikController } from './mikrotik.controller';
import { OltController } from './olt.controller';
import { OltService } from './olt.service';
import { OltPlanProfileService } from './olt-plan-profile.service';
import { GenieacsController } from './genieacs.controller';
import { GenieacsService } from './genieacs.service';
import { ReconexionService } from './reconexion.service';
import { WhatsappModule } from '../common/whatsapp/whatsapp.module';
import { SignatureModule } from '../common/signature/signature.module';

@Module({
  // WhatsappModule: mensajería masiva. SignatureModule: el código de un solo uso con
  // el que se firma la salida y la entrada de una transferencia entre sedes.
  imports: [WhatsappModule, SignatureModule],
  controllers: [NetworkController, OltController, MikrotikController, GenieacsController],
  providers: [NetworkService, NetworkWriteService, MikrotikService, MikrotikAdminService, OltService, OltPlanProfileService, GenieacsService, ReconexionService],
  exports: [NetworkService, NetworkWriteService, MikrotikService, MikrotikAdminService, OltService, OltPlanProfileService, GenieacsService, ReconexionService],
})
export class NetworkModule {}
