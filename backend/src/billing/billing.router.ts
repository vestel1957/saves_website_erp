/**
 * Rutas de billing — ── FICHERO GENERADO ──
 *
 * Lo genera `scripts/generar-routers.ts` desde el contrato extraído del
 * controlador. Cablea HTTP -> método: extrae los argumentos de `req` y llama.
 * La lógica sigue viviendo en BillingController, que ya no lleva decoradores.
 *
 * Endpoints: 21
 */
import { crearRouter, manejar } from '../core/http/ruta';
import { validar } from '../core/http/validar';
import { autenticar, exigirArea, usuarioDe } from '../core/auth/instancias';
import { BillingController } from './billing.controller';
import { billingService, catalogoService, facturasService } from '../core/contenedor';
import type { Response } from 'express';
import { BillingService } from './billing.service';
import { invoicePdf } from './billing-pdf';
import { reciboRolloPdf } from '../common/pdf/recibo-rollo';
import { FacturasService } from './facturas.service';
import { CatalogoService } from './catalogo.service';
import { AsignarServicioDto, CreateInvoiceDto, CreateNoteDto, CreateNotesBulkDto, GenerateInvoicesDto, UpdateInvoiceDto, VoidInvoiceDto } from './dto/facturas.dto';

/** Instancia única del controlador. Las dependencias salen del contenedor. */
const billing = new BillingController(billingService, facturasService, catalogoService);

export const billingRouter = crearRouter();
billingRouter.get(
  '/aging',
  autenticar,
  exigirArea('contabilidad', 'caja'),
  manejar((req) => billing.aging()),
);

billingRouter.get(
  '/catalog',
  autenticar,
  exigirArea('contabilidad', 'caja'),
  manejar((req) => billing.catalog(req.query.search as string, req.query.limit as string)),
);

billingRouter.get(
  '/invoices',
  autenticar,
  exigirArea('contabilidad', 'caja'),
  manejar((req) => billing.list(req.query.search as string, req.query.status as string, req.query.ron as string, req.query.branchId as string, req.query.from as string, req.query.to as string, req.query.all as string, req.query.overdue as string, req.query.page as string, req.query.pageSize as string, req.query.sortBy as string, req.query.sortDir as string, usuarioDe(req))),
);

billingRouter.post(
  '/invoices',
  autenticar,
  exigirArea('contabilidad', 'caja'),
  manejar((req) => billing.create(validar(CreateInvoiceDto, req.body), usuarioDe(req))),
);

billingRouter.post(
  '/invoices/generate',
  autenticar,
  exigirArea('contabilidad'),
  manejar((req) => billing.generate(validar(GenerateInvoicesDto, req.body), usuarioDe(req))),
);

billingRouter.get(
  '/invoices/:id',
  autenticar,
  exigirArea('contabilidad', 'caja'),
  manejar((req) => billing.detail(req.params.id, usuarioDe(req))),
);

billingRouter.patch(
  '/invoices/:id',
  autenticar,
  exigirArea('contabilidad'),
  manejar((req) => billing.update(req.params.id, validar(UpdateInvoiceDto, req.body), usuarioDe(req))),
);

billingRouter.post(
  '/invoices/:id/email',
  autenticar,
  exigirArea('contabilidad', 'caja'),
  manejar((req) => billing.sendEmail(req.params.id)),
);

billingRouter.get(
  '/invoices/:id/historial',
  autenticar,
  exigirArea('contabilidad', 'caja'),
  manejar((req) => billing.historial(req.params.id, usuarioDe(req))),
);

billingRouter.post(
  '/invoices/:id/notes',
  autenticar,
  exigirArea('contabilidad'),
  manejar((req) => billing.createNote(req.params.id, validar(CreateNoteDto, req.body), usuarioDe(req))),
);

billingRouter.get(
  '/invoices/:id/pdf',
  autenticar,
  exigirArea('contabilidad', 'caja'),
  manejar((req, res) => billing.invoicePdf(req.params.id, res, req.query.formato as string, usuarioDe(req))),
);

billingRouter.get(
  '/invoices/:id/servicio',
  autenticar,
  exigirArea('contabilidad', 'caja'),
  manejar((req) => billing.servicioAsignado(req.params.id, usuarioDe(req))),
);

billingRouter.post(
  '/invoices/:id/servicio',
  autenticar,
  exigirArea('contabilidad'),
  manejar((req) => billing.asignarServicio(req.params.id, validar(AsignarServicioDto, req.body), usuarioDe(req))),
);

billingRouter.post(
  '/invoices/:id/void',
  autenticar,
  exigirArea('contabilidad'),
  manejar((req) => billing.voidInvoice(req.params.id, validar(VoidInvoiceDto, req.body), usuarioDe(req))),
);

billingRouter.post(
  '/invoices/:id/whatsapp',
  autenticar,
  exigirArea('contabilidad', 'caja'),
  manejar((req) => billing.sendWhatsapp(req.params.id)),
);

billingRouter.get(
  '/motivos',
  autenticar,
  exigirArea('contabilidad', 'caja'),
  manejar((req) => billing.motivos()),
);

billingRouter.get(
  '/notes',
  autenticar,
  exigirArea('contabilidad', 'caja'),
  manejar((req) => billing.listNotes(req.query.page as string, req.query.pageSize as string, req.query.search as string, req.query.type as string, req.query.branchId as string, req.query.from as string, req.query.to as string, req.query.authorId as string, req.query.montoMin as string, req.query.montoMax as string, req.query.sortBy as string, req.query.sortDir as string, usuarioDe(req))),
);

billingRouter.post(
  '/notes',
  autenticar,
  exigirArea('contabilidad'),
  manejar((req) => billing.createNotes(validar(CreateNotesBulkDto, req.body), usuarioDe(req))),
);

billingRouter.get(
  '/stats',
  autenticar,
  exigirArea('contabilidad', 'caja'),
  manejar((req) => billing.stats(req.query.from as string, req.query.to as string, req.query.all as string)),
);

billingRouter.get(
  '/subscribers/:id/invoices',
  autenticar,
  exigirArea('contabilidad', 'caja'),
  manejar((req) => billing.subscriberInvoices(req.params.id, req.query.scope as string | undefined, usuarioDe(req))),
);

billingRouter.get(
  '/subscribers/:id/last-invoice',
  autenticar,
  exigirArea('contabilidad', 'caja'),
  manejar((req) => billing.lastInvoice(req.params.id)),
);
