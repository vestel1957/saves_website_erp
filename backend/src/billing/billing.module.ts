import { Module } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { FacturasService } from './facturas.service';
import { RecurringService } from './recurring.service';
import { CatalogoService } from './catalogo.service';
import { WhatsappModule } from '../common/whatsapp/whatsapp.module';
import { MailModule } from '../common/mail/mail.module';
import { AccountingModule } from '../accounting/accounting.module';
import { TreasuryModule } from '../treasury/treasury.module';

@Module({
  // TreasuryModule aporta CobranzasService: la anulación de factura reversa sus pagos
  // con el mismo mecanismo de Voiding que usa tesorería. No hay ciclo (Treasury no
  // importa Billing).
  imports: [WhatsappModule, MailModule, AccountingModule, TreasuryModule],
  controllers: [BillingController],
  providers: [BillingService, FacturasService, RecurringService, CatalogoService],
  exports: [BillingService, FacturasService, RecurringService, CatalogoService],
})
export class BillingModule {}
