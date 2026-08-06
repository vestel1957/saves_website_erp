/**
 * Rutas de treasury — ── FICHERO GENERADO ──
 *
 * Lo genera `scripts/generar-routers.ts` desde el contrato extraído del
 * controlador. Cablea HTTP -> método: extrae los argumentos de `req` y llama.
 * La lógica sigue viviendo en TreasuryController, que ya no lleva decoradores.
 *
 * Endpoints: 39
 */
import { crearRouter, manejar } from '../core/http/ruta';
import { validar } from '../core/http/validar';
import { autenticar, exigirArea, usuarioDe } from '../core/auth/instancias';
import { ficheroDe, subirUno } from '../core/http/uploads';
import { TreasuryController, TREASURY_ROOT } from './treasury.controller';
import { cobranzasService, pagosFijosService, treasuryService } from '../core/contenedor';
import { BadRequestException } from '../core/http/errores';
import { diskStorage } from 'multer';
import { existsSync, mkdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { TreasuryService } from './treasury.service';
import { cashClosePdf, receiptPdf } from '../common/pdf/pdf-docs';
import { reciboRolloPdf } from '../common/pdf/recibo-rollo';
import { CobranzasService } from './cobranzas.service';
import { EjecutarPagoFijoDto, PagoFijoDto, PagosFijosService, UpdatePagoFijoDto } from './pagos-fijos.service';
import {
  CashAccountDto, CashCloseDto, CashOpenDto, CollectDto, EditTxDto, ExpenseDto,
  IncomeDto, TransferDto, TxCategoryDto, VoidTxDto,
} from './dto/cobranzas.dto';
import { enviarAdjuntoSeguro, mimeAceptado, nombreEnDisco } from '../common/uploads';

/** Instancia única del controlador. Las dependencias salen del contenedor. */
const treasury = new TreasuryController(treasuryService, cobranzasService, pagosFijosService);

export const treasuryRouter = crearRouter();
treasuryRouter.get(
  '/cash-accounts',
  autenticar,
  exigirArea('contabilidad', 'administracion', 'caja'),
  manejar((req) => treasury.cashAccounts(usuarioDe(req))),
);

treasuryRouter.post(
  '/cash-accounts',
  autenticar,
  exigirArea('contabilidad', 'administracion'),
  manejar((req) => treasury.createCashAccount(validar(CashAccountDto, req.body), usuarioDe(req))),
);

treasuryRouter.delete(
  '/cash-accounts/:id',
  autenticar,
  exigirArea('contabilidad', 'administracion'),
  manejar((req) => treasury.deleteCashAccount(req.params.id)),
);

treasuryRouter.patch(
  '/cash-accounts/:id',
  autenticar,
  exigirArea('contabilidad', 'administracion'),
  manejar((req) => treasury.updateCashAccount(req.params.id, validar(CashAccountDto, req.body), usuarioDe(req))),
);

treasuryRouter.post(
  '/cash-accounts/:id/recompute',
  autenticar,
  exigirArea('contabilidad', 'administracion'),
  manejar((req) => treasury.recomputeCashAccount(req.params.id)),
);

treasuryRouter.post(
  '/cash-close',
  autenticar,
  exigirArea('contabilidad', 'administracion', 'caja'),
  manejar((req) => treasury.cashClose(validar(CashCloseDto, req.body), usuarioDe(req))),
);

treasuryRouter.get(
  '/cash-close/preview',
  autenticar,
  exigirArea('contabilidad', 'administracion', 'caja'),
  manejar((req) => treasury.cashClosePreview(req.query.cashAccountId as string, req.query.date as string, usuarioDe(req))),
);

treasuryRouter.get(
  '/cash-close/report',
  autenticar,
  exigirArea('contabilidad', 'administracion', 'caja'),
  manejar((req) => treasury.cashCloseReport(req.query.cashAccountId as string, req.query.date as string, usuarioDe(req))),
);

treasuryRouter.get(
  '/cash-closes',
  autenticar,
  exigirArea('contabilidad', 'administracion', 'caja'),
  manejar((req) => treasury.cashCloses(req.query.page as string, req.query.pageSize as string, req.query.from as string, req.query.to as string, req.query.all as string, req.query.cashAccountId as string, usuarioDe(req))),
);

treasuryRouter.get(
  '/cash-closes/:id',
  autenticar,
  exigirArea('contabilidad', 'administracion', 'caja'),
  manejar((req) => treasury.cashCloseDetail(req.params.id, usuarioDe(req))),
);

treasuryRouter.get(
  '/cash-closes/:id/pdf',
  autenticar,
  exigirArea('contabilidad', 'administracion', 'caja'),
  manejar((req, res) => treasury.cashClosePdf(req.params.id, res, usuarioDe(req))),
);

treasuryRouter.get(
  '/cash-closes/summary',
  autenticar,
  exigirArea('contabilidad', 'administracion', 'caja'),
  manejar((req) => treasury.cashClosesSummary(req.query.group as string, req.query.from as string, req.query.to as string, req.query.all as string, req.query.cashAccountId as string, usuarioDe(req))),
);

treasuryRouter.get(
  '/cash-daily',
  autenticar,
  exigirArea('contabilidad', 'administracion', 'caja'),
  manejar((req) => treasury.cashDaily(req.query.cashAccountId as string, req.query.date as string, req.query.days as string | undefined, usuarioDe(req))),
);

treasuryRouter.post(
  '/cash-open',
  autenticar,
  exigirArea('contabilidad', 'administracion', 'caja'),
  manejar((req) => treasury.cashOpen(validar(CashOpenDto, req.body), usuarioDe(req))),
);

treasuryRouter.get(
  '/cash-open-suggest',
  autenticar,
  exigirArea('contabilidad', 'administracion', 'caja'),
  manejar((req) => treasury.cashOpenSuggest(req.query.cashAccountId as string, req.query.date as string, usuarioDe(req))),
);

treasuryRouter.get(
  '/categories',
  autenticar,
  exigirArea('contabilidad', 'administracion', 'caja'),
  manejar((req) => treasury.categories()),
);

treasuryRouter.post(
  '/categories',
  autenticar,
  exigirArea('contabilidad', 'administracion'),
  manejar((req) => treasury.createCategory(validar(TxCategoryDto, req.body))),
);

treasuryRouter.delete(
  '/categories/:id',
  autenticar,
  exigirArea('contabilidad', 'administracion'),
  manejar((req) => treasury.deleteCategory(req.params.id)),
);

treasuryRouter.patch(
  '/categories/:id',
  autenticar,
  exigirArea('contabilidad', 'administracion'),
  manejar((req) => treasury.updateCategory(req.params.id, validar(TxCategoryDto, req.body))),
);

treasuryRouter.post(
  '/collect',
  autenticar,
  exigirArea('contabilidad', 'administracion', 'caja'),
  manejar((req) => treasury.collect(validar(CollectDto, req.body), usuarioDe(req))),
);

treasuryRouter.post(
  '/expenses',
  autenticar,
  exigirArea('contabilidad', 'administracion', 'caja'),
  manejar((req) => treasury.expense(validar(ExpenseDto, req.body), usuarioDe(req))),
);

treasuryRouter.post(
  '/income',
  autenticar,
  exigirArea('contabilidad', 'administracion', 'caja'),
  manejar((req) => treasury.income(validar(IncomeDto, req.body), usuarioDe(req))),
);

treasuryRouter.get(
  '/mi-caja',
  autenticar,
  exigirArea('contabilidad', 'administracion', 'caja'),
  manejar((req) => treasury.miCaja(usuarioDe(req))),
);

treasuryRouter.get(
  '/receipts/:id/pdf',
  autenticar,
  exigirArea('contabilidad', 'administracion', 'caja'),
  manejar((req, res) => treasury.receiptPdf(req.params.id, res, req.query.formato as string, usuarioDe(req))),
);

treasuryRouter.get(
  '/scheduled-payments',
  autenticar,
  exigirArea('contabilidad', 'administracion', 'caja'),
  manejar((req) => treasury.pagosFijosList(usuarioDe(req))),
);

treasuryRouter.post(
  '/scheduled-payments',
  autenticar,
  exigirArea('contabilidad'),
  manejar((req) => treasury.pagosFijosCreate(validar(PagoFijoDto, req.body), usuarioDe(req))),
);

treasuryRouter.delete(
  '/scheduled-payments/:id',
  autenticar,
  exigirArea('contabilidad'),
  manejar((req) => treasury.pagosFijosRemove(req.params.id)),
);

treasuryRouter.patch(
  '/scheduled-payments/:id',
  autenticar,
  exigirArea('contabilidad'),
  manejar((req) => treasury.pagosFijosUpdate(req.params.id, validar(UpdatePagoFijoDto, req.body))),
);

treasuryRouter.post(
  '/scheduled-payments/:id/execute',
  autenticar,
  exigirArea('contabilidad', 'administracion', 'caja'),
  manejar((req) => treasury.pagosFijosEjecutar(req.params.id, validar(EjecutarPagoFijoDto, req.body), usuarioDe(req))),
);

treasuryRouter.get(
  '/scheduled-payments/:id/runs',
  autenticar,
  exigirArea('contabilidad', 'administracion', 'caja'),
  manejar((req) => treasury.pagosFijosRuns(req.params.id)),
);

treasuryRouter.get(
  '/stats',
  autenticar,
  exigirArea('contabilidad', 'administracion', 'caja'),
  manejar((req) => treasury.stats(req.query.from as string, req.query.to as string, req.query.all as string, usuarioDe(req))),
);

treasuryRouter.get(
  '/subscribers/:id/debt',
  autenticar,
  exigirArea('contabilidad', 'administracion', 'caja'),
  manejar((req) => treasury.subscriberDebt(req.params.id)),
);

treasuryRouter.get(
  '/transactions',
  autenticar,
  exigirArea('contabilidad', 'administracion', 'caja'),
  manejar((req) => treasury.list(req.query.search as string, req.query.type as string, req.query.category as string, req.query.status as string, req.query.from as string, req.query.to as string, req.query.all as string, req.query.cashAccountId as string, req.query.page as string, req.query.pageSize as string, req.query.sortBy as string, req.query.sortDir as string, usuarioDe(req))),
);

treasuryRouter.get(
  '/transactions/:id',
  autenticar,
  exigirArea('contabilidad', 'administracion', 'caja'),
  manejar((req) => treasury.detail(req.params.id, usuarioDe(req))),
);

treasuryRouter.patch(
  '/transactions/:id',
  autenticar,
  exigirArea('contabilidad'),
  manejar((req) => treasury.editTx(req.params.id, validar(EditTxDto, req.body), usuarioDe(req))),
);

treasuryRouter.post(
  '/transactions/:id/attach',
  autenticar,
  exigirArea('contabilidad', 'administracion', 'caja'),
  subirUno('file', {
      storage: diskStorage({
        destination: (_req, _file, cb) => { if (!existsSync(TREASURY_ROOT)) mkdirSync(TREASURY_ROOT, { recursive: true }); cb(null, TREASURY_ROOT); },
        filename: (_req, file, cb) => cb(null, nombreEnDisco(randomUUID(), file.mimetype)),
      }),
      limits: { fileSize: 15 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => cb(null, mimeAceptado(file.mimetype)),
    }),
  manejar((req) => treasury.attach(req.params.id, ficheroDe(req), usuarioDe(req))),
);

treasuryRouter.get(
  '/transactions/:id/attachment',
  autenticar,
  exigirArea('contabilidad', 'administracion', 'caja'),
  manejar((req, res) => treasury.attachment(req.params.id, res, usuarioDe(req))),
);

treasuryRouter.post(
  '/transactions/:id/void',
  autenticar,
  exigirArea('contabilidad'),
  manejar((req) => treasury.voidTx(req.params.id, validar(VoidTxDto, req.body), usuarioDe(req))),
);

treasuryRouter.post(
  '/transfer',
  autenticar,
  exigirArea('contabilidad', 'administracion', 'caja'),
  manejar((req) => treasury.transfer(validar(TransferDto, req.body), usuarioDe(req))),
);
