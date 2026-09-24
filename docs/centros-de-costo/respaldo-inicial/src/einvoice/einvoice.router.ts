/**
 * Rutas de einvoice — ── FICHERO GENERADO ──
 *
 * Lo genera `scripts/generar-routers.ts` desde el contrato extraído del
 * controlador. Cablea HTTP -> método: extrae los argumentos de `req` y llama.
 * La lógica sigue viviendo en EinvoiceController, que ya no lleva decoradores.
 *
 * Endpoints: 16
 */
import { crearRouter, manejar } from '../core/http/ruta';
import { validar } from '../core/http/validar';
import { autenticar, exigirArea, usuarioDe } from '../core/auth/instancias';
import { EinvoiceController, CreditNoteDto } from './einvoice.controller';
import { einvoiceEmitService, einvoiceService } from '../core/contenedor';
import { IsInt, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';
import { EinvoiceService } from './einvoice.service';
import { EinvoiceEmitService } from './einvoice-emit.service';
import { BranchBulkEflagsDto, BulkEflagsDto, SetEflagsDto, UpdateSiigoAccountDto } from './dto/einvoice.dto';

/** Instancia única del controlador. Las dependencias salen del contenedor. */
const einvoice = new EinvoiceController(einvoiceService, einvoiceEmitService);

export const einvoiceRouter = crearRouter();
einvoiceRouter.get(
  '/',
  autenticar,
  exigirArea('contabilidad'),
  manejar((req) => einvoice.list(req.query.search as string, req.query.type as string, req.query.from as string, req.query.to as string, req.query.all as string, req.query.page as string, req.query.pageSize as string, req.query.sortBy as string, req.query.sortDir as string)),
);

einvoiceRouter.get(
  '/accounts',
  autenticar,
  exigirArea('contabilidad'),
  manejar((req) => einvoice.accounts()),
);

einvoiceRouter.patch(
  '/accounts/:id',
  autenticar,
  exigirArea('contabilidad'),
  manejar((req) => einvoice.updateAccount(req.params.id, validar(UpdateSiigoAccountDto, req.body))),
);

einvoiceRouter.post(
  '/accounts/:id/test',
  autenticar,
  exigirArea('contabilidad'),
  manejar((req) => einvoice.testAccount(req.params.id)),
);

einvoiceRouter.get(
  '/branches',
  autenticar,
  exigirArea('contabilidad'),
  manejar((req) => einvoice.branches()),
);

einvoiceRouter.post(
  '/branches/:id/eflags-bulk',
  autenticar,
  exigirArea('contabilidad'),
  manejar((req) => einvoice.branchBulkEflags(req.params.id, validar(BranchBulkEflagsDto, req.body))),
);

einvoiceRouter.get(
  '/branches/:id/subscribers',
  autenticar,
  exigirArea('contabilidad'),
  manejar((req) => einvoice.branchSubscribers(req.params.id, req.query.search as string, req.query.page as string, req.query.pageSize as string, req.query.sort as string, req.query.dir as string, req.query.estado as string, req.query.marcados as string)),
);

einvoiceRouter.post(
  '/credit-note/:invoiceId',
  autenticar,
  exigirArea('contabilidad'),
  manejar((req) => einvoice.creditNote(req.params.invoiceId, validar(CreditNoteDto, req.body), usuarioDe(req))),
);

einvoiceRouter.post(
  '/eflags-bulk',
  autenticar,
  exigirArea('contabilidad'),
  manejar((req) => einvoice.bulkEflags(validar(BulkEflagsDto, req.body))),
);

einvoiceRouter.post(
  '/emit/:invoiceId',
  autenticar,
  exigirArea('contabilidad'),
  manejar((req) => einvoice.emitInvoice(req.params.invoiceId, req.query.forzar as string, usuarioDe(req))),
);

einvoiceRouter.post(
  '/emit-branch/:branchId',
  autenticar,
  exigirArea('contabilidad'),
  manejar((req) => einvoice.emitBranch(req.params.branchId, req.query.mes as string, usuarioDe(req))),
);

einvoiceRouter.get(
  '/mode',
  autenticar,
  exigirArea('contabilidad'),
  manejar((req) => einvoice.mode()),
);

einvoiceRouter.get(
  '/stats',
  autenticar,
  exigirArea('contabilidad'),
  manejar((req) => einvoice.stats()),
);

einvoiceRouter.patch(
  '/subscribers/:id/eflags',
  autenticar,
  exigirArea('contabilidad'),
  manejar((req) => einvoice.setEflags(req.params.id, validar(SetEflagsDto, req.body))),
);

einvoiceRouter.get(
  '/:id',
  autenticar,
  exigirArea('contabilidad'),
  manejar((req) => einvoice.detail(req.params.id)),
);

einvoiceRouter.post(
  '/:id/retry',
  autenticar,
  exigirArea('contabilidad'),
  manejar((req) => einvoice.retry(req.params.id, usuarioDe(req))),
);
