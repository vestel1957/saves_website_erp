/**
 * Rutas de cron — ── FICHERO GENERADO ──
 *
 * Lo genera `scripts/generar-routers.ts` desde el contrato extraído del
 * controlador. Cablea HTTP -> método: extrae los argumentos de `req` y llama.
 * La lógica sigue viviendo en CronController, que ya no lleva decoradores.
 *
 * Endpoints: 10
 */
import { crearRouter, manejar } from '../core/http/ruta';
import { validar } from '../core/http/validar';
import { autenticar, exigirArea, exigirPermisos, usuarioDe } from '../core/auth/instancias';
import { CronController, RunBillingDto, RunWaRemindersDto, WaRemindersConfigDto } from './cron.controller';
import { cronService } from '../core/contenedor';
import { IsBoolean, IsInt, IsOptional, IsString, Min, Max } from 'class-validator';
import { CronService } from './cron.service';
import { APP_PERMISSIONS } from '../auth/permissions.catalog';

/** Instancia única del controlador. Las dependencias salen del contenedor. */
const cron = new CronController(cronService);

export const cronRouter = crearRouter();
cronRouter.get(
  '/history',
  autenticar,
  exigirArea('contabilidad', 'sistemas'),
  manejar((req) => cron.history(req.query.limit as string)),
);

cronRouter.get(
  '/legacy/drift',
  autenticar,
  exigirArea('contabilidad', 'sistemas'),
  manejar((req) => cron.legacyDrift()),
);

cronRouter.post(
  '/run/cartera',
  autenticar,
  exigirArea('contabilidad', 'sistemas'),
  exigirPermisos(APP_PERMISSIONS.CRON_RUN),
  manejar((req) => cron.runCartera(usuarioDe(req))),
);

cronRouter.post(
  '/run/legacy-sync',
  autenticar,
  exigirArea('contabilidad', 'sistemas'),
  exigirPermisos(APP_PERMISSIONS.CRON_RUN),
  manejar((req) => cron.runLegacySync(usuarioDe(req))),
);

cronRouter.post(
  '/run/legacy-writeback',
  autenticar,
  exigirArea('contabilidad', 'sistemas'),
  exigirPermisos(APP_PERMISSIONS.CRON_RUN),
  manejar((req) => cron.runLegacyWriteback(usuarioDe(req))),
);

cronRouter.post(
  '/run/recurring-billing',
  autenticar,
  exigirArea('contabilidad', 'sistemas'),
  exigirPermisos(APP_PERMISSIONS.CRON_RUN),
  manejar((req) => cron.runBilling(validar(RunBillingDto, req.body), usuarioDe(req))),
);

cronRouter.post(
  '/run/reminders',
  autenticar,
  exigirArea('contabilidad', 'sistemas'),
  exigirPermisos(APP_PERMISSIONS.CRON_RUN),
  manejar((req) => cron.runReminders(usuarioDe(req))),
);

cronRouter.post(
  '/run/wa-reminders',
  autenticar,
  exigirArea('contabilidad', 'sistemas'),
  exigirPermisos(APP_PERMISSIONS.WHATSAPP_MANAGE),
  manejar((req) => cron.runWaReminders(validar(RunWaRemindersDto, req.body), usuarioDe(req))),
);

cronRouter.get(
  '/status',
  autenticar,
  exigirArea('contabilidad', 'sistemas'),
  manejar((req) => cron.status()),
);

cronRouter.put(
  '/wa-reminders/config',
  autenticar,
  exigirArea('contabilidad', 'sistemas'),
  exigirPermisos(APP_PERMISSIONS.WHATSAPP_MANAGE),
  manejar((req) => cron.setWaReminders(validar(WaRemindersConfigDto, req.body), usuarioDe(req))),
);
