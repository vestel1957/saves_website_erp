/**
 * Rutas de auth — ── FICHERO GENERADO ──
 *
 * Lo genera `scripts/generar-routers.ts` desde el contrato extraído del
 * controlador. Cablea HTTP -> método: extrae los argumentos de `req` y llama.
 * La lógica sigue viviendo en AuthController, que ya no lleva decoradores.
 *
 * Endpoints: 25
 */
import { crearRouter, manejar } from '../core/http/ruta';
import { validar } from '../core/http/validar';
import { autenticar, exigirPermisos, usuarioDe, crearFrenoDeLogin } from '../core/auth/instancias';
import { AuthController } from './auth.controller';
import { authService } from '../core/contenedor';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { ForgotCheckDto, ForgotPasswordDto, ForgotResetDto } from './dto/forgot-password.dto';
import { SetRolesDto } from './dto/set-roles.dto';
import { SetScreensDto } from './dto/set-screens.dto';
import { SetActiveDto } from './dto/set-active.dto';
import { CreateRoleDto, UpdateRoleDto } from './dto/role.dto';
import { APP_PERMISSIONS, ALL_PERMISSIONS } from './permissions.catalog';

/** Freno propio de este router: su contador no se comparte con otros logins. */
const frenoDeLogin = crearFrenoDeLogin();

/** Instancia única del controlador. Las dependencias salen del contenedor. */
const auth = new AuthController(authService);

export const authRouter = crearRouter();
authRouter.get(
  '/branches',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.USERS_MANAGE),
  manejar((req) => auth.listBranches()),
);

authRouter.post(
  '/login',
  frenoDeLogin,
  manejar((req) => auth.login(validar(LoginDto, req.body), req.ip as string)),
);

authRouter.post(
  '/logout',
  manejar((req) => auth.logout()),
);

authRouter.get(
  '/me',
  autenticar,
  manejar((req) => auth.me(usuarioDe(req))),
);

authRouter.post(
  '/password/forgot',
  frenoDeLogin,
  manejar((req) => auth.forgotPassword(validar(ForgotPasswordDto, req.body), req.ip as string)),
);

authRouter.get(
  '/password/forgot/available',
  manejar((req) => auth.forgotAvailability()),
);

authRouter.post(
  '/password/forgot/check',
  frenoDeLogin,
  manejar((req) => auth.forgotCheck(validar(ForgotCheckDto, req.body))),
);

authRouter.post(
  '/password/forgot/reset',
  frenoDeLogin,
  manejar((req) => auth.forgotReset(validar(ForgotResetDto, req.body), req.ip as string)),
);

authRouter.get(
  '/permissions',
  autenticar,
  manejar((req) => auth.permissions()),
);

authRouter.get(
  '/roles',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.USERS_MANAGE),
  manejar((req) => auth.listRoles()),
);

authRouter.post(
  '/roles',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.SYSTEM_ADMIN),
  manejar((req) => auth.createRole(validar(CreateRoleDto, req.body))),
);

authRouter.delete(
  '/roles/:id',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.SYSTEM_ADMIN),
  manejar((req) => auth.deleteRole(req.params.id)),
);

authRouter.patch(
  '/roles/:id',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.SYSTEM_ADMIN),
  manejar((req) => auth.updateRole(req.params.id, validar(UpdateRoleDto, req.body))),
);

authRouter.get(
  '/screens',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.USERS_MANAGE),
  manejar((req) => auth.screenTree()),
);

authRouter.get(
  '/users',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.USERS_MANAGE),
  manejar((req) => auth.listUsers()),
);

authRouter.post(
  '/users',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.USERS_MANAGE),
  manejar((req) => auth.createUser(validar(CreateUserDto, req.body))),
);

authRouter.patch(
  '/users/:id',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.USERS_MANAGE),
  manejar((req) => auth.updateUser(req.params.id, validar(UpdateUserDto, req.body))),
);

authRouter.get(
  '/users/:id/access',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.USERS_MANAGE),
  manejar((req) => auth.userAccess(req.params.id)),
);

authRouter.patch(
  '/users/:id/active',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.USERS_MANAGE),
  manejar((req) => auth.setActive(req.params.id, validar(SetActiveDto, req.body))),
);

authRouter.post(
  '/users/:id/password',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.USERS_MANAGE),
  manejar((req) => auth.resetPassword(req.params.id, validar(ResetPasswordDto, req.body))),
);

authRouter.post(
  '/users/:id/password/code',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.USERS_MANAGE),
  manejar((req) => auth.requestPasswordCode(req.params.id, usuarioDe(req))),
);

authRouter.get(
  '/users/:id/password/policy',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.USERS_MANAGE),
  manejar((req) => auth.passwordPolicy(req.params.id)),
);

authRouter.patch(
  '/users/:id/roles',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.USERS_MANAGE),
  manejar((req) => auth.setRoles(req.params.id, validar(SetRolesDto, req.body), usuarioDe(req))),
);

authRouter.patch(
  '/users/:id/screens',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.USERS_MANAGE),
  manejar((req) => auth.setScreens(req.params.id, validar(SetScreensDto, req.body))),
);

authRouter.get(
  '/users/options',
  autenticar,
  manejar((req) => auth.userOptions()),
);
