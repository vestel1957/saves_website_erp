/**
 * Rutas de admin — ── FICHERO GENERADO ──
 *
 * Lo genera `scripts/generar-routers.ts` desde el contrato extraído del
 * controlador. Cablea HTTP -> método: extrae los argumentos de `req` y llama.
 * La lógica sigue viviendo en MailController, que ya no lleva decoradores.
 *
 * Endpoints: 4
 */
import { crearRouter, manejar } from '../../core/http/ruta';
import { validar } from '../../core/http/validar';
import { autenticar, exigirArea } from '../../core/auth/instancias';
import { MailController, TestMailDto, UpdateEmailTemplateDto } from './mail.controller';
import { mailService } from '../../core/contenedor';
import { IsBoolean, IsEmail, IsOptional, IsString } from 'class-validator';
import { MailService } from './mail.service';

/** Instancia única del controlador. Las dependencias salen del contenedor. */
const mail = new MailController(mailService);

export const mailRouter = crearRouter();
mailRouter.get(
  '/mail/status',
  autenticar,
  exigirArea('administracion', 'sistemas', 'contabilidad'),
  manejar((req) => mail.status()),
);

mailRouter.get(
  '/mail/templates',
  autenticar,
  exigirArea('administracion', 'sistemas', 'contabilidad'),
  manejar((req) => mail.templates()),
);

mailRouter.patch(
  '/mail/templates/:id',
  autenticar,
  exigirArea('administracion', 'sistemas', 'contabilidad'),
  manejar((req) => mail.updateTemplate(req.params.id, validar(UpdateEmailTemplateDto, req.body))),
);

mailRouter.post(
  '/mail/test',
  autenticar,
  exigirArea('administracion', 'sistemas', 'contabilidad'),
  manejar((req) => mail.test(validar(TestMailDto, req.body))),
);
