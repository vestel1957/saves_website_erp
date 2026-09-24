import { AuthUser } from '../auth/current-user.decorator';
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
  listPending(all?: string) {
    return this.posting.listPending({ incluirResueltos: all === '1' });
  }

  retryPending(id: string) {
    return this.posting.retryPending(id);
  }

  // ---- Centros de costo ----
  listCostCenters(all?: string) { return this.costCenters.list(all === '1'); }
  
  createCostCenter(body: { code: string; name: string; parentId?: string | null }) { return this.costCenters.create(body); }
  
  deactivateCostCenter(id: string) { return this.costCenters.setActive(id, false); }
  /** Las sedes y el centro con que está enlazada cada una. */
  listCostCenterBranches() { return this.costCenters.sedes(); }
  /** Nombre, activo y sede vinculada (el código no se edita). */
  updateCostCenter(id: string, body: { name?: string; isActive?: boolean; branchLegacyId?: number | null }) {
    return this.costCenters.update(id, body ?? {});
  }

  // ---- Plan de cuentas ----
  listAccounts(all?: string) { return this.accounts.list(all === '1'); }
  tree(all?: string) { return this.accounts.tree(all === '1'); }
  createAccount(dto: CreateAccountDto) { return this.accounts.create(dto); }
  updateAccount(id: string, dto: UpdateAccountDto) { return this.accounts.update(id, dto); }
  deactivateAccount(id: string) { return this.accounts.deactivate(id); }

  // ---- Libro diario / asientos ----
  listJournal(from?: string, to?: string, status?: string) {
    return this.journal.list({ from, to, status });
  }
  getEntry(id: string) { return this.journal.get(id); }
  
  createEntry(dto: CreateJournalEntryDto, user: AuthUser) {
    return this.journal.createManual(dto, user?.name ?? user?.email ?? null);
  }
  
  reverse(id: string, user: AuthUser) {
    return this.journal.reverse(id, user?.name ?? user?.email ?? null);
  }

  // ---- Periodos fiscales y arrastre de fin de mes ----
  listPeriods() { return this.periods.list(); }
  createPeriod(dto: CreatePeriodDto) { return this.periods.create(dto); }
  /** El arrastre del periodo: saldo de entrada, movimientos y saldo que pasa al mes siguiente. */
  periodBalances(id: string) { return this.periods.balances(id); }
  /** Qué pasaría al cerrar (arrastre y asiento de cierre), sin escribir nada. */
  previewClose(id: string) { return this.periods.preview(id); }
  
  closePeriod(id: string, user: AuthUser) {
    return this.periods.close(id, user?.name ?? user?.email ?? null);
  }
  reopenPeriod(id: string) { return this.periods.reopen(id); }

  // ---- Mapeo de cuentas ----
  listMappings() { return this.mappings.list(); }
  upsertMapping(dto: UpsertMappingDto) { return this.mappings.upsert(dto); }

  // ---- Reportes ----
  ledger(accountId: string, from?: string, to?: string) {
    return this.reports.ledger(accountId, { from, to });
  }
  trialBalance(from?: string, to?: string) { return this.reports.trialBalance({ from, to }); }
  /** `costCenterId`: un centro, o `sin-asignar` para las líneas sin centro. Vacío = todo. */
  incomeStatement(from?: string, to?: string, costCenterId?: string) {
    const filtro = !costCenterId ? {} : { costCenterId: costCenterId === 'sin-asignar' ? null : costCenterId };
    return this.reports.incomeStatement({ from, to }, filtro);
  }
  /** Resultados por sede: cuentas de resultado × centro de costo, con su cuadre contra el total. */
  incomeStatementByCenter(from?: string, to?: string) { return this.reports.incomeStatementByCenter({ from, to }); }
  balanceSheet(from?: string, to?: string) { return this.reports.balanceSheet({ from, to }); }
  cashFlow(from?: string, to?: string) { return this.reports.cashFlow({ from, to }); }
  monthlySummary(months?: string) { return this.reports.monthlySummary(Number(months) || 6); }
}
