/**
 * El usuario autenticado.
 *
 * Este fichero contenía además el decorador `@CurrentUser()`, que inyectaba el
 * usuario en los handlers. Ya no hace falta: los routers lo obtienen con
 * `usuarioDe(req)` (ver `core/auth/middlewares.ts`), que además falla en la frontera
 * si la ruta se montó sin autenticación, en vez de entregar `undefined` y reventar
 * más tarde y más lejos, dentro de un servicio.
 *
 * Se conserva la ruta del fichero —en vez de renombrarlo a algo como `auth-user.ts`—
 * porque lo importan decenas de servicios: moverlo ahora mezclaría un renombrado
 * masivo con la migración de framework. Es una limpieza aparte.
 */
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  roles: string[];
  permissions: string[];
  /**
   * Sedes (`Branch.legacyId`) a las que llega el usuario; `[]` = TODAS (sin
   * restricción, ojo con la semántica). Lo resuelve `AuthService.resolveUser` en
   * cada petición uniendo `User.sedesAccede` con la sede de su caja asignada —ver
   * `common/sede-scope.ts`—, para que el acotado no dependa de que quien filtra se
   * acuerde de consultarlo. Opcional porque los "usuarios" internos (cron, cargue
   * de pagos, chatbot) se arman a mano y no pasan por el middleware.
   */
  sedes?: number[];
  /**
   * Caja asignada (`CashAccount.legacyId`), o `null` si no tiene. Sale tal cual de
   * `User.cajaLegacyId`: la sesión ya carga esa fila, así que no cuesta una consulta.
   *
   * NO es el alcance —quién puede ver qué caja lo decide `treasury/caja-scope.ts`—,
   * es sólo "cuál es la suya". La pantalla lo necesita para ofrecerle su caja (abrirla,
   * ver su recaudo) a quien la tiene aunque NO sea cajera pura: hay superusuarios que
   * atienden ventanilla, y para ellos el panel de caja no se pintaba nunca.
   */
  caja?: number | null;
}
