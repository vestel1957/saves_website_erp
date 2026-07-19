import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AreaGuard } from '../auth/area.guard';
import { RequireArea } from '../auth/require-area.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { AccountsService } from './accounts.service';
import { JournalService } from './journal.service';
import { PeriodsService } from './periods.service';
import { MappingsService } from './mappings.service';
import { ReportsService } from './reports.service';
import { CostCentersService } from './cost-centers.service';
import { PostingService } from './posting.service';
import {
  CreateAccountDto, UpdateAccountDto, CreateJournalEntryDto, CreatePeriodDto, UpsertMappingDto,
} from './dto/accounting.dto';

/** Contabilidad — partida doble (PUC Colombia). */
@Controller('accounting')
@UseGuards(JwtAuthGuard, AreaGuard)
@RequireArea('administracion', 'contabilidad', 'gerencia')
export class AccountingController {
  constructor(
    private readonly accounts: AccountsService,
    private readonly journal: JournalService,
    private readonly periods: PeriodsService,
    private readonly mappings: MappingsService,
    private readonly reports: ReportsService,
    private readonly costCenters: CostCentersService,
    private readonly posting: PostingService,
  ) {}

  // ---- Pendientes contables ----
  /**
   * Documentos que se emitieron pero cuyo asiento automático falló (típicamente por
   * un mapeo de cuentas ausente). Antes esto sólo dejaba un warn en el log y no había
   * forma de saber qué había quedado sin contabilizar.
   */
  @Get('pending')
  listPending(@Query('all') all?: string) {
    return this.posting.listPending({ incluirResueltos: all === '1' });
  }

  @Post('pending/:id/retry')
  @RequireArea('administracion', 'contabilidad')
  retryPending(@Param('id') id: string) {
    return this.posting.retryPending(id);
  }

  // ---- Centros de costo ----
  @Get('cost-centers') listCostCenters(@Query('all') all?: string) { return this.costCenters.list(all === '1'); }
  @Post('cost-centers') @RequireArea('administracion', 'contabilidad')
  createCostCenter(@Body() body: { code: string; name: string; parentId?: string | null }) { return this.costCenters.create(body); }
  @Delete('cost-centers/:id') @RequireArea('administracion', 'contabilidad')
  deactivateCostCenter(@Param('id') id: string) { return this.costCenters.setActive(id, false); }

  // ---- Plan de cuentas ----
  @Get('accounts') listAccounts(@Query('all') all?: string) { return this.accounts.list(all === '1'); }
  @Get('accounts/tree') tree(@Query('all') all?: string) { return this.accounts.tree(all === '1'); }
  @Post('accounts') @RequireArea('administracion', 'contabilidad') createAccount(@Body() dto: CreateAccountDto) { return this.accounts.create(dto); }
  @Patch('accounts/:id') @RequireArea('administracion', 'contabilidad') updateAccount(@Param('id') id: string, @Body() dto: UpdateAccountDto) { return this.accounts.update(id, dto); }
  @Delete('accounts/:id') @RequireArea('administracion', 'contabilidad') deactivateAccount(@Param('id') id: string) { return this.accounts.deactivate(id); }

  // ---- Libro diario / asientos ----
  @Get('journal-entries') listJournal(@Query('from') from?: string, @Query('to') to?: string, @Query('status') status?: string) {
    return this.journal.list({ from, to, status });
  }
  @Get('journal-entries/:id') getEntry(@Param('id') id: string) { return this.journal.get(id); }
  @Post('journal-entries') @RequireArea('administracion', 'contabilidad')
  createEntry(@Body() dto: CreateJournalEntryDto, @CurrentUser() user: AuthUser) {
    return this.journal.createManual(dto, user?.name ?? user?.email ?? null);
  }
  @Post('journal-entries/:id/reverse') @RequireArea('administracion', 'contabilidad')
  reverse(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.journal.reverse(id, user?.name ?? user?.email ?? null);
  }

  // ---- Periodos fiscales ----
  @Get('periods') listPeriods() { return this.periods.list(); }
  @Post('periods') @RequireArea('administracion', 'contabilidad') createPeriod(@Body() dto: CreatePeriodDto) { return this.periods.create(dto); }
  @Post('periods/:id/close') @RequireArea('administracion', 'contabilidad') closePeriod(@Param('id') id: string) { return this.periods.close(id); }
  @Post('periods/:id/reopen') @RequireArea('administracion', 'contabilidad') reopenPeriod(@Param('id') id: string) { return this.periods.reopen(id); }

  // ---- Mapeo de cuentas ----
  @Get('mappings') listMappings() { return this.mappings.list(); }
  @Post('mappings') @RequireArea('administracion', 'contabilidad') upsertMapping(@Body() dto: UpsertMappingDto) { return this.mappings.upsert(dto); }

  // ---- Reportes ----
  @Get('ledger/:accountId') ledger(@Param('accountId') accountId: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.reports.ledger(accountId, { from, to });
  }
  @Get('reports/trial-balance') trialBalance(@Query('from') from?: string, @Query('to') to?: string) { return this.reports.trialBalance({ from, to }); }
  @Get('reports/income-statement') incomeStatement(@Query('from') from?: string, @Query('to') to?: string) { return this.reports.incomeStatement({ from, to }); }
  @Get('reports/balance-sheet') balanceSheet(@Query('from') from?: string, @Query('to') to?: string) { return this.reports.balanceSheet({ from, to }); }
  @Get('reports/cash-flow') cashFlow(@Query('from') from?: string, @Query('to') to?: string) { return this.reports.cashFlow({ from, to }); }
  @Get('reports/monthly-summary') monthlySummary(@Query('months') months?: string) { return this.reports.monthlySummary(Number(months) || 6); }
}
