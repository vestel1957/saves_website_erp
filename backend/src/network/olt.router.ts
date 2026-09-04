/**
 * Rutas de network — ── FICHERO GENERADO ──
 *
 * Lo genera `scripts/generar-routers.ts` desde el contrato extraído del
 * controlador. Cablea HTTP -> método: extrae los argumentos de `req` y llama.
 * La lógica sigue viviendo en OltController, que ya no lleva decoradores.
 *
 * Endpoints: 37
 */
import { crearRouter, manejar } from '../core/http/ruta';
import { validar } from '../core/http/validar';
import { autenticar, exigirArea, exigirPermisos, moduloRed, usuarioDe } from '../core/auth/instancias';
import { OltController, AdoptarDto, CatvSetDto, CatvStateDto, LinkDto, OltUpsertDto, OnuActionDto, OnuDescDto, OnusQueryDto, PlanOltProfileDto, PlanOltProfileLoteDto, ProvisionDto, SlotDto } from './olt.controller';
import { oltPlanProfileService, oltService } from '../core/contenedor';
import { Allow, IsOptional, IsString } from 'class-validator';
import { OltService } from './olt.service';
import { OltPlanProfileService } from './olt-plan-profile.service';
import { APP_PERMISSIONS } from '../auth/permissions.catalog';

/** Instancia única del controlador. Las dependencias salen del contenedor. */
const olt = new OltController(oltService, oltPlanProfileService);

export const oltRouter = crearRouter();
oltRouter.post(
  '/olt/auto-link',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  exigirPermisos(APP_PERMISSIONS.NETWORK_OLT_MANAGE),
  moduloRed,
  manejar((req) => olt.autoLink(req.body?.oltId, usuarioDe(req))),
);

oltRouter.get(
  '/olt/dashboard',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => olt.dashboard()),
);

oltRouter.get(
  '/olt/history',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  exigirPermisos(APP_PERMISSIONS.AREA_ADMINISTRACION),
  moduloRed,
  manejar((req) => olt.history(req.query.oltId as string, req.query.limit as string)),
);

oltRouter.get(
  '/olt/inventory',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => olt.inventory(req.query.search as string, req.query.oltId as string, req.query.estado as string, req.query.senal as string, req.query.cliente as string, req.query.page as string, req.query.pageSize as string, req.query.sortBy as string, req.query.sortDir as string)),
);

oltRouter.get(
  '/olt/mode',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => olt.mode()),
);

oltRouter.get(
  '/olt/olts',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => olt.olts()),
);

oltRouter.post(
  '/olt/olts',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => olt.create(validar(OltUpsertDto, req.body), usuarioDe(req))),
);

oltRouter.delete(
  '/olt/olts/:id',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => olt.remove(req.params.id, usuarioDe(req))),
);

oltRouter.patch(
  '/olt/olts/:id',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  exigirPermisos(APP_PERMISSIONS.NETWORK_OLT_MANAGE),
  moduloRed,
  manejar((req) => olt.update(req.params.id, validar(OltUpsertDto, req.body), usuarioDe(req))),
);

oltRouter.post(
  '/olt/olts/:id/default',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => olt.setDefault(req.params.id)),
);

oltRouter.post(
  '/olt/onus/:onuId/link',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => olt.link(req.params.onuId, validar(LinkDto, req.body), usuarioDe(req))),
);

oltRouter.get(
  '/olt/plan-profiles',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => olt.planProfilesList(req.query.oltId as string)),
);

oltRouter.post(
  '/olt/plan-profiles',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  exigirPermisos(APP_PERMISSIONS.NETWORK_OLT_MANAGE),
  moduloRed,
  manejar((req) => olt.planProfileSave(validar(PlanOltProfileDto, req.body))),
);

oltRouter.get(
  '/olt/plan-profiles/deducir',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => olt.planProfilesDeducir(req.query.oltId as string)),
);

oltRouter.post(
  '/olt/plan-profiles/lote',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  exigirPermisos(APP_PERMISSIONS.NETWORK_OLT_MANAGE),
  moduloRed,
  manejar((req) => olt.planProfilesLote(validar(PlanOltProfileLoteDto, req.body))),
);

oltRouter.delete(
  '/olt/plan-profiles/:planId',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  exigirPermisos(APP_PERMISSIONS.NETWORK_OLT_MANAGE),
  moduloRed,
  manejar((req) => olt.planProfileDelete(req.params.planId, req.query.oltId as string)),
);

oltRouter.get(
  '/olt/subscribers',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => olt.subscribers(req.query.q as string)),
);

oltRouter.get(
  '/olt/:id/autofind',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => olt.autofind(req.params.id)),
);

oltRouter.get(
  '/olt/:id/boards',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => olt.boards(req.params.id, req.query.frame as string, req.query.refresh as string)),
);

oltRouter.post(
  '/olt/:id/onu/adoptar',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  exigirPermisos(APP_PERMISSIONS.NETWORK_OLT_MANAGE),
  moduloRed,
  manejar((req) => olt.adoptar(req.params.id, validar(AdoptarDto, req.body), usuarioDe(req))),
);

oltRouter.post(
  '/olt/:id/onu/catv',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  exigirPermisos(APP_PERMISSIONS.NETWORK_OLT_MANAGE),
  moduloRed,
  manejar((req) => olt.setCatv(req.params.id, validar(CatvSetDto, req.body), usuarioDe(req))),
);

oltRouter.post(
  '/olt/:id/onu/catv-state',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => olt.catvState(req.params.id, validar(CatvStateDto, req.body))),
);

oltRouter.post(
  '/olt/:id/onu/delete',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  exigirPermisos(APP_PERMISSIONS.NETWORK_OLT_MANAGE),
  moduloRed,
  manejar((req) => olt.deleteOnu(req.params.id, validar(OnuActionDto, req.body), usuarioDe(req))),
);

oltRouter.post(
  '/olt/:id/onu/desc',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  exigirPermisos(APP_PERMISSIONS.NETWORK_OLT_MANAGE),
  moduloRed,
  manejar((req) => olt.setDesc(req.params.id, validar(OnuDescDto, req.body), usuarioDe(req))),
);

oltRouter.post(
  '/olt/:id/onu/detail',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => olt.detail(req.params.id, validar(OnuActionDto, req.body))),
);

oltRouter.post(
  '/olt/:id/onu/find',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => olt.find(req.params.id, req.body?.sn)),
);

oltRouter.post(
  '/olt/:id/onu/optical',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => olt.optical(req.params.id, validar(OnuActionDto, req.body))),
);

oltRouter.post(
  '/olt/:id/onu/provision',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  exigirPermisos(APP_PERMISSIONS.NETWORK_OLT_MANAGE),
  moduloRed,
  manejar((req) => olt.provision(req.params.id, validar(ProvisionDto, req.body), usuarioDe(req))),
);

oltRouter.post(
  '/olt/:id/onu/reboot',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  exigirPermisos(APP_PERMISSIONS.NETWORK_OLT_MANAGE),
  moduloRed,
  manejar((req) => olt.reboot(req.params.id, validar(OnuActionDto, req.body), usuarioDe(req))),
);

oltRouter.post(
  '/olt/:id/onus',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => olt.onus(req.params.id, validar(OnusQueryDto, req.body))),
);

oltRouter.get(
  '/olt/:id/profiles',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => olt.profiles(req.params.id, req.query.refresh as string)),
);

oltRouter.post(
  '/olt/:id/slot-summary',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => olt.slotSummary(req.params.id, validar(SlotDto, req.body))),
);

oltRouter.get(
  '/olt/:id/sugerencia',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => olt.sugerencia(req.params.id, req.query.frame as string, req.query.slot as string, req.query.port as string, req.query.model as string)),
);

oltRouter.post(
  '/olt/:id/sync',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => olt.sync(req.params.id, validar(SlotDto, req.body), usuarioDe(req))),
);

oltRouter.get(
  '/olt/:id/system',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => olt.system(req.params.id, req.query.refresh as string)),
);

oltRouter.post(
  '/olt/:id/test',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => olt.test(req.params.id, usuarioDe(req))),
);

oltRouter.get(
  '/olt/:id/traffic-tables',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => olt.trafficTables(req.params.id, req.query.refresh as string)),
);
