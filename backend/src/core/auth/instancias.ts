/**
 * Middleware de autenticación ya construidos, listos para montar en un router.
 *
 * Existe para separar dos cosas que no deben mezclarse:
 *  - `middlewares.ts` define el COMPORTAMIENTO y no sabe nada del contenedor. Así se
 *    puede probar pasándole un doble de `AuthService` sin levantar medio sistema.
 *  - este fichero hace la CONEXIÓN con las instancias reales.
 *
 * Si `middlewares.ts` importara el contenedor directamente, tendríamos un ciclo:
 * contenedor -> servicios -> (algún día) middlewares -> contenedor. Con esta capa
 * intermedia el sentido de las flechas es siempre el mismo.
 *
 * Los routers importan de aquí, así que en su cabecera se lee de un vistazo qué
 * exige cada uno.
 */
import { authService, prismaService } from '../contenedor';
import { crearApiKey, crearAutenticar } from './middlewares';

/** Autentica el Bearer de personal y puebla `req.user`. */
export const autenticar = crearAutenticar(authService);

/** Autentica por `X-API-Key` sin exigir scopes. Para exigirlos: `apiKeyCon(...)`. */
export const apiKey = crearApiKey(prismaService);

/** Autentica por `X-API-Key` exigiendo TODOS los scopes indicados. */
export const apiKeyCon = (...scopes: string[]) => crearApiKey(prismaService, ...scopes);

// El resto de middleware son funciones puras sobre `req` y no necesitan cablearse:
// se importan directamente de `./middlewares`. Se re-exportan aquí para que los
// routers tengan un único punto de importación y no haya que recordar cuál va dónde.
export {
  abiertoAlTecnico,
  abonadoDe,
  autenticarAbonado,
  crearFrenoDeLogin,
  exigirArea,
  exigirAreaCon,
  exigirPermisos,
  moduloRed,
  usuarioDe,
} from './middlewares';
