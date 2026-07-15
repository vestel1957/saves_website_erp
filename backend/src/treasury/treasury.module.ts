import { Module } from '@nestjs/common';
import { TreasuryController } from './treasury.controller';
import { TreasuryService } from './treasury.service';
import { CobranzasService } from './cobranzas.service';
import { AccountingModule } from '../accounting/accounting.module';
import { NetworkModule } from '../network/network.module';

@Module({
  imports: [AccountingModule, NetworkModule],
  controllers: [TreasuryController],
  providers: [TreasuryService, CobranzasService],
  exports: [TreasuryService, CobranzasService],
})
export class TreasuryModule {}
