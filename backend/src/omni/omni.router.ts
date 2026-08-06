/**
 * Rutas de omni — ── FICHERO GENERADO ──
 *
 * Lo genera `scripts/generar-routers.ts` desde el contrato extraído del
 * controlador. Cablea HTTP -> método: extrae los argumentos de `req` y llama.
 * La lógica sigue viviendo en OmniController, que ya no lleva decoradores.
 *
 * Endpoints: 11
 */
import { crearRouter, manejar } from '../core/http/ruta';
import { validar } from '../core/http/validar';
import { autenticar, exigirArea, usuarioDe } from '../core/auth/instancias';
import { OmniController } from './omni.controller';
import { omniService } from '../core/contenedor';
import { OmniService, CreateQuoteDto, EventDto, QuoteStatusDto, UpdateEventDto } from './omni.service';

/** Instancia única del controlador. Las dependencias salen del contenedor. */
const omni = new OmniController(omniService);

export const omniRouter = crearRouter();
omniRouter.get(
  '/events',
  autenticar,
  exigirArea('contabilidad', 'administracion', 'caja'),
  manejar((req) => omni.events(req.query.search as string, req.query.from as string, req.query.to as string, req.query.priority as string, req.query.assignedBy as string, req.query.page as string, req.query.pageSize as string, req.query.sortBy as string, req.query.sortDir as string)),
);

omniRouter.post(
  '/events',
  autenticar,
  exigirArea('contabilidad', 'administracion', 'caja'),
  manejar((req) => omni.createEvent(validar(EventDto, req.body), usuarioDe(req))),
);

omniRouter.delete(
  '/events/:id',
  autenticar,
  exigirArea('contabilidad', 'administracion', 'caja'),
  manejar((req) => omni.deleteEvent(req.params.id)),
);

omniRouter.patch(
  '/events/:id',
  autenticar,
  exigirArea('contabilidad', 'administracion', 'caja'),
  manejar((req) => omni.updateEvent(req.params.id, validar(UpdateEventDto, req.body))),
);

omniRouter.get(
  '/events/filters',
  autenticar,
  exigirArea('contabilidad', 'administracion', 'caja'),
  manejar((req) => omni.eventFilters()),
);

omniRouter.get(
  '/events/stats',
  autenticar,
  exigirArea('contabilidad', 'administracion', 'caja'),
  manejar((req) => omni.eventsStats(req.query.search as string, req.query.from as string, req.query.to as string, req.query.priority as string, req.query.assignedBy as string)),
);

omniRouter.get(
  '/quotes',
  autenticar,
  exigirArea('contabilidad', 'administracion', 'caja'),
  manejar((req) => omni.quotes(req.query.search as string, req.query.page as string, req.query.pageSize as string, req.query.sortBy as string, req.query.sortDir as string)),
);

omniRouter.post(
  '/quotes',
  autenticar,
  exigirArea('contabilidad', 'administracion'),
  manejar((req) => omni.createQuote(validar(CreateQuoteDto, req.body), usuarioDe(req))),
);

omniRouter.get(
  '/quotes/:id',
  autenticar,
  exigirArea('contabilidad', 'administracion', 'caja'),
  manejar((req) => omni.quoteDetail(req.params.id)),
);

omniRouter.post(
  '/quotes/:id/convert',
  autenticar,
  exigirArea('contabilidad'),
  manejar((req) => omni.convertQuote(req.params.id, usuarioDe(req))),
);

omniRouter.patch(
  '/quotes/:id/status',
  autenticar,
  exigirArea('contabilidad', 'administracion'),
  manejar((req) => omni.quoteStatus(req.params.id, validar(QuoteStatusDto, req.body))),
);
