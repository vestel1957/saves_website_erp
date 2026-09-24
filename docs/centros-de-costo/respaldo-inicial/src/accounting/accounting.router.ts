/**
 * Rutas de accounting — ── FICHERO GENERADO ──
 *
 * Lo genera `scripts/generar-routers.ts` desde el contrato extraído del
 * controlador. Cablea HTTP -> método: extrae los argumentos de `req` y llama.
 * La lógica sigue viviendo en AccountingController, que ya no lleva decoradores.
 *
 * Endpoints: 28
 */
import { crearRouter, manejar } from '../core/http/ruta';
import { validar } from '../core/http/validar';
import { autenticar, exigirArea, usuarioDe } from '../core/auth/instancias';
import { AccountingController } from './accounting.controller';
import { accountingReportsService, accountsService, costCentersService, journalService, mappingsService, periodsService, postingService } from '../core/contenedor';
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

/** Instancia única del controlador. Las dependencias salen del contenedor. */
const accounting = new AccountingController(accountsService, journalService, periodsService, mappingsService, accountingReportsService, costCentersService, postingService);

export const accountingRouter = crearRouter();
accountingRouter.get(
  '/accounts',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'gerencia'),
  manejar((req) => accounting.listAccounts(req.query.all as string)),
);

accountingRouter.post(
  '/accounts',
  autenticar,
  exigirArea('administracion', 'contabilidad'),
  manejar((req) => accounting.createAccount(validar(CreateAccountDto, req.body))),
);

accountingRouter.get(
  '/accounts/tree',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'gerencia'),
  manejar((req) => accounting.tree(req.query.all as string)),
);

accountingRouter.delete(
  '/accounts/:id',
  autenticar,
  exigirArea('administracion', 'contabilidad'),
  manejar((req) => accounting.deactivateAccount(req.params.id)),
);

accountingRouter.patch(
  '/accounts/:id',
  autenticar,
  exigirArea('administracion', 'contabilidad'),
  manejar((req) => accounting.updateAccount(req.params.id, validar(UpdateAccountDto, req.body))),
);

accountingRouter.get(
  '/cost-centers',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'gerencia'),
  manejar((req) => accounting.listCostCenters(req.query.all as string)),
);

accountingRouter.post(
  '/cost-centers',
  autenticar,
  exigirArea('administracion', 'contabilidad'),
  manejar((req) => accounting.createCostCenter(req.body)),
);

accountingRouter.delete(
  '/cost-centers/:id',
  autenticar,
  exigirArea('administracion', 'contabilidad'),
  manejar((req) => accounting.deactivateCostCenter(req.params.id)),
);

accountingRouter.get(
  '/journal-entries',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'gerencia'),
  manejar((req) => accounting.listJournal(req.query.from as string, req.query.to as string, req.query.status as string)),
);

accountingRouter.post(
  '/journal-entries',
  autenticar,
  exigirArea('administracion', 'contabilidad'),
  manejar((req) => accounting.createEntry(validar(CreateJournalEntryDto, req.body), usuarioDe(req))),
);

accountingRouter.get(
  '/journal-entries/:id',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'gerencia'),
  manejar((req) => accounting.getEntry(req.params.id)),
);

accountingRouter.post(
  '/journal-entries/:id/reverse',
  autenticar,
  exigirArea('administracion', 'contabilidad'),
  manejar((req) => accounting.reverse(req.params.id, usuarioDe(req))),
);

accountingRouter.get(
  '/ledger/:accountId',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'gerencia'),
  manejar((req) => accounting.ledger(req.params.accountId, req.query.from as string, req.query.to as string)),
);

accountingRouter.get(
  '/mappings',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'gerencia'),
  manejar((req) => accounting.listMappings()),
);

accountingRouter.post(
  '/mappings',
  autenticar,
  exigirArea('administracion', 'contabilidad'),
  manejar((req) => accounting.upsertMapping(validar(UpsertMappingDto, req.body))),
);

accountingRouter.get(
  '/pending',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'gerencia'),
  manejar((req) => accounting.listPending(req.query.all as string)),
);

accountingRouter.post(
  '/pending/:id/retry',
  autenticar,
  exigirArea('administracion', 'contabilidad'),
  manejar((req) => accounting.retryPending(req.params.id)),
);

accountingRouter.get(
  '/periods',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'gerencia'),
  manejar((req) => accounting.listPeriods()),
);

accountingRouter.post(
  '/periods',
  autenticar,
  exigirArea('administracion', 'contabilidad'),
  manejar((req) => accounting.createPeriod(validar(CreatePeriodDto, req.body))),
);

accountingRouter.get(
  '/periods/:id/balances',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'gerencia'),
  manejar((req) => accounting.periodBalances(req.params.id)),
);

accountingRouter.post(
  '/periods/:id/close',
  autenticar,
  exigirArea('administracion', 'contabilidad'),
  manejar((req) => accounting.closePeriod(req.params.id, usuarioDe(req))),
);

accountingRouter.get(
  '/periods/:id/preview',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'gerencia'),
  manejar((req) => accounting.previewClose(req.params.id)),
);

accountingRouter.post(
  '/periods/:id/reopen',
  autenticar,
  exigirArea('administracion', 'contabilidad'),
  manejar((req) => accounting.reopenPeriod(req.params.id)),
);

accountingRouter.get(
  '/reports/balance-sheet',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'gerencia'),
  manejar((req) => accounting.balanceSheet(req.query.from as string, req.query.to as string)),
);

accountingRouter.get(
  '/reports/cash-flow',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'gerencia'),
  manejar((req) => accounting.cashFlow(req.query.from as string, req.query.to as string)),
);

accountingRouter.get(
  '/reports/income-statement',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'gerencia'),
  manejar((req) => accounting.incomeStatement(req.query.from as string, req.query.to as string)),
);

accountingRouter.get(
  '/reports/monthly-summary',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'gerencia'),
  manejar((req) => accounting.monthlySummary(req.query.months as string)),
);

accountingRouter.get(
  '/reports/trial-balance',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'gerencia'),
  manejar((req) => accounting.trialBalance(req.query.from as string, req.query.to as string)),
);
