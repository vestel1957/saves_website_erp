import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { ResponsibilitiesModule } from '../responsibilities/responsibilities.module';
import { SignatureModule } from '../common/signature/signature.module';

@Module({
  // Avisa al encargado de compras (orden por aprobar) y al de bodega (material en camino).
  // SignatureModule: la aprobación se firma con el código que llega al WhatsApp.
  imports: [ResponsibilitiesModule, SignatureModule],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
