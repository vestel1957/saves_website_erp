import { Module } from '@nestjs/common';
import { AccountingController } from './accounting.controller';
import { AccountsService } from './accounts.service';
import { JournalService } from './journal.service';
import { PeriodsService } from './periods.service';
import { MappingsService } from './mappings.service';
import { PostingService } from './posting.service';
import { ReportsService } from './reports.service';
import { CostCentersService } from './cost-centers.service';

/**
 * Contabilidad de partida doble (PUC Colombia).
 * Exporta PostingService y JournalService para que otros módulos
 * (facturación, compras, tesorería) contabilicen automáticamente sus documentos.
 */
@Module({
  controllers: [AccountingController],
  providers: [AccountsService, JournalService, PeriodsService, MappingsService, PostingService, ReportsService, CostCentersService],
  exports: [PostingService, JournalService, MappingsService],
})
export class AccountingModule {}
