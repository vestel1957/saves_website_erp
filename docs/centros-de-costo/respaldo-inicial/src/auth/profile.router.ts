/**
 * Rutas de profile — ── FICHERO GENERADO ──
 *
 * Lo genera `scripts/generar-routers.ts` desde el contrato extraído del
 * controlador. Cablea HTTP -> método: extrae los argumentos de `req` y llama.
 * La lógica sigue viviendo en ProfileController, que ya no lleva decoradores.
 *
 * Endpoints: 9
 */
import { crearRouter, manejar } from '../core/http/ruta';
import { validar } from '../core/http/validar';
import { autenticar, usuarioDe } from '../core/auth/instancias';
import { ficheroDe, subirUno } from '../core/http/uploads';
import { ProfileController, MAX_FOTO_BYTES } from './profile.controller';
import { profileService } from '../core/contenedor';
import { BadRequestException, NotFoundException } from '../core/http/errores';
import { diskStorage } from 'multer';
import type { Response } from 'express';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { MIMES_IMAGEN, mimeAceptado, nombreEnDisco } from '../common/uploads';
import { ProfileService, FOTOS_ROOT } from './profile.service';
import { ChangePasswordDto, UpdateProfileDto } from './dto/profile.dto';

/** Instancia única del controlador. Las dependencias salen del contenedor. */
const profile = new ProfileController(profileService);

export const profileRouter = crearRouter();
profileRouter.get(
  '/',
  autenticar,
  manejar((req) => profile.get(usuarioDe(req))),
);

profileRouter.patch(
  '/',
  autenticar,
  manejar((req) => profile.update(usuarioDe(req), validar(UpdateProfileDto, req.body))),
);

profileRouter.get(
  '/logins',
  autenticar,
  manejar((req) => profile.logins(usuarioDe(req))),
);

profileRouter.post(
  '/password',
  autenticar,
  manejar((req) => profile.changePassword(usuarioDe(req), validar(ChangePasswordDto, req.body))),
);

profileRouter.post(
  '/password/code',
  autenticar,
  manejar((req) => profile.requestPasswordCode(usuarioDe(req))),
);

profileRouter.get(
  '/password/policy',
  autenticar,
  manejar((req) => profile.passwordPolicy(usuarioDe(req))),
);

profileRouter.delete(
  '/photo',
  autenticar,
  manejar((req) => profile.deletePhoto(usuarioDe(req))),
);

profileRouter.get(
  '/photo',
  autenticar,
  manejar((req, res) => profile.photo(usuarioDe(req), res)),
);

profileRouter.post(
  '/photo',
  autenticar,
  subirUno('file', {
      storage: diskStorage({
        destination: (_req, _file, cb) => {
          mkdirSync(FOTOS_ROOT, { recursive: true });
          cb(null, FOTOS_ROOT);
        },
        // La extensión sale del MIME ya validado, nunca del `originalname`.
        filename: (_req, file, cb) => cb(null, nombreEnDisco(randomUUID(), file.mimetype)),
      }),
      limits: { fileSize: MAX_FOTO_BYTES },
      fileFilter: (_req, file, cb) => {
        const ok = mimeAceptado(file.mimetype, MIMES_IMAGEN);
        cb(ok ? null : new BadRequestException('La foto debe ser una imagen (JPG, PNG, WEBP…)'), ok);
      },
    }),
  manejar((req) => profile.uploadPhoto(usuarioDe(req), ficheroDe(req))),
);
