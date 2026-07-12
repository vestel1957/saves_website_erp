import { Module } from '@nestjs/common';
import { TreasuryController } from './treasury.controller';
import { TreasuryService } from './treasury.service';
import { CobranzasService } from './cobranzas.service';

@Module({
  controllers: [TreasuryController],
  providers: [TreasuryService, CobranzasService],
  exports: [TreasuryService, CobranzasService],
})
export class TreasuryModule {}
