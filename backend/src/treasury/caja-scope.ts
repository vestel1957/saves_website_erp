import { ForbiddenException, NotFoundException } from '../core/http/errores';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/current-user.decorator';
import { esCajeraPura } from '../common/sede-scope';

/**
 * Quién puede ver qué caja — port de `Transactions_model::acc_list()` del legacy.
 *
 * La regla del legacy:
 *   - `asignaciones` (detalle='caja', colaborador=usuario) -> `tipo` = SU caja.
 *   - Si el usuario no tiene el permiso `testran`: `WHERE id = <su caja> OR sede = '0'`,
 *     o sea **su caja + los bancos** (los necesita para consolidar el cierre).
 *   - Si lo tiene: ve todas.
 *
 * Aquí `testran` se traduce a los permisos de área de SAVES: una cajera "pura" queda
 * acotada a su caja; contabilidad, administración, gerencia y el superusuario ven todas.
 *
 * OJO con dos trampas:
 *  - **Hay que mirar `user.permissions`, NO `user.roles`**: `resolveUser()` mete en
 *    `roles` el NOMBRE PARA MOSTRAR ('Caja y ventas'), no la clave ('area-caja'), así que
 *    comparar contra la clave no casaría nunca y la restricción no se aplicaría jamás.
 *  - Una cajera SIN caja asignada ve sólo los bancos. Es exactamente lo que hace el
 *    legacy (allá `$asignacion` sale null y el `where('id', null)` no casa con nada), y
 *    además es el lado seguro: ante la duda, no enseñar el efectivo de otra sede.
 */

/** `accounts.sede = 0` = no es una sede, es un banco. Todo el mundo los ve. */
export const SEDE_BANCO = 0;

export type AlcanceCajas = {
  /** true = ve todas las cajas (no es cajera, o es superusuario). */
  todas: boolean;
  /** La caja asignada (legacyId). Sólo tiene sentido si `todas` es false. */
  caja: number | null;
  /** Sedes a las que accede (`Branch.legacyId`). Vacío = todas. */
  sedes: number[];
};

/**
 * ¿Este usuario es una cajera "pura" (y por tanto va acotada a su caja)?
 *
 * La definición vive en `common/sede-scope.ts` porque la comparten los dos
 * acotados —el de cajas y el de sedes— y tenerla por duplicado era pedir que se
 * separaran con el tiempo.
 */
export function esCajera(user: AuthUser): boolean {
  return esCajeraPura(user?.permissions ?? []);
}

/** Sin límite: lo que se le concede a un proceso interno, que no tiene sede. */
const SIN_LIMITE: AlcanceCajas = { todas: true, caja: null, sedes: [] };

/** Resuelve qué puede ver este usuario. */
export async function alcanceDe(prisma: PrismaService, user: AuthUser): Promise<AlcanceCajas> {
  // Procesos internos (cargue de pagos Efecty, cron) llaman con un "usuario" de
  // pega que no tiene id: no hay a quién acotar, y preguntarle a Prisma por
  // `id: undefined` revienta con un error de validación en vez de no acotar nada.
  if (!user?.id) return SIN_LIMITE;
  const fila = await prisma.user.findUnique({
    where: { id: user.id },
    select: { cajaLegacyId: true, sedesAccede: true },
  });
  return {
    todas: !esCajera(user),
    caja: fila?.cajaLegacyId ?? null,
    sedes: fila?.sedesAccede ?? [],
  };
}

/**
 * ¿Puede este alcance ver esta caja? `branchLegacy` es la sede de la caja (0 = banco).
 * Se pasa aparte porque las cajas "derivadas" no tienen fila `CashAccount` y por tanto
 * no tienen sede: a esas se las trata como no-banco.
 */
export function puedeVer(a: AlcanceCajas, cajaLegacyId: number, branchLegacy: number | null): boolean {
  const esBanco = branchLegacy === SEDE_BANCO;
  // Los bancos los ve todo el mundo: sin ellos no se puede consolidar un cierre.
  if (esBanco) return true;
  if (!a.todas && a.caja !== cajaLegacyId) return false;
  // `sedesAccede` acota a cualquiera (también a quien "ve todas"): vacío = sin límite.
  if (a.sedes.length && (branchLegacy == null || !a.sedes.includes(branchLegacy))) return false;
  return true;
}

/**
 * Los ids de caja que este usuario puede consultar. `null` = sin límite (no filtrar).
 * Se usa para acotar los listados de cierres.
 */
export async function cajasPermitidas(prisma: PrismaService, user: AuthUser): Promise<number[] | null> {
  const a = await alcanceDe(prisma, user);
  if (a.todas && !a.sedes.length) return null; // sin límite

  const cuentas = await prisma.cashAccount.findMany({
    select: { legacyId: true, branchLegacy: true },
  });
  const ids = cuentas
    .filter((c) => c.legacyId != null && puedeVer(a, c.legacyId, c.branchLegacy))
    .map((c) => c.legacyId as number);
  // Su caja puede ser "derivada" (sin fila CashAccount): que no se pierda.
  if (a.caja != null && !ids.includes(a.caja)) ids.push(a.caja);
  return ids;
}

/**
 * Exige que el usuario pueda consultar ESA caja, o 403. Es la puerta de todos los
 * endpoints que reciben un `cashAccountId` del cliente — hasta ahora se confiaba en él
 * sin comprobar nada, así que una cajera podía pedir el cierre de otra sede.
 */
export async function exigirAcceso(prisma: PrismaService, user: AuthUser, cajaLegacyId: number): Promise<void> {
  const a = await alcanceDe(prisma, user);
  if (a.todas && !a.sedes.length) return;
  const cuenta = await prisma.cashAccount.findUnique({
    where: { legacyId: cajaLegacyId },
    select: { branchLegacy: true },
  });
  if (!puedeVer(a, cajaLegacyId, cuenta?.branchLegacy ?? null)) {
    throw new ForbiddenException('No tienes acceso a esta caja.');
  }
}

/**
 * La caja sobre la que este usuario va a ESCRIBIR, a partir de la que pidió el
 * cliente. Puerta de ingreso/egreso/recaudo.
 *
 * Hasta ahora el acotado era sólo de lectura: la cajera no VEÍA la caja de otra
 * sede, pero podía meterle un egreso mandando su `cashAccountId` a mano (el
 * selector de la pantalla venía filtrado, el endpoint no comprobaba nada).
 *
 * Reglas:
 *  - Quien está acotado y no manda caja → se le pone la SUYA. Antes ese
 *    movimiento nacía sin caja: no salía en su cierre y no lo veía ni ella.
 *  - Quien está acotado y no tiene caja asignada → 403 con instrucción, no un
 *    movimiento huérfano.
 *  - Quien manda una caja → tiene que ser una que pueda ver (403 si no).
 *  - Quien ve todas puede seguir registrando sin caja (asientos de administración),
 *    salvo que se pida `propiaSiFalta`: entonces, si tiene caja asignada, se usa la
 *    suya. Lo pide el recaudo interactivo, donde el selector de caja ya no se le
 *    enseña a nadie más que al superusuario y el movimiento tiene que caer en la
 *    caja de quien lo registra, no quedar suelto.
 */
export async function exigirCajaDeEscritura(
  prisma: PrismaService,
  user: AuthUser,
  pedida?: number | null,
  opts?: { propiaSiFalta?: boolean },
): Promise<number | null> {
  if (pedida != null) {
    await exigirAcceso(prisma, user, pedida);
    return pedida;
  }
  const a = await alcanceDe(prisma, user);
  if (a.todas) return opts?.propiaSiFalta ? a.caja : null;
  if (a.caja == null) {
    throw new ForbiddenException('No tienes una caja asignada; pídesela a administración.');
  }
  return a.caja;
}

/**
 * Exige acceso a la caja del movimiento `id`, o 403. Puerta común de todo lo que
 * recibe un id de transacción del cliente (ver detalle, adjuntar comprobante,
 * editar, anular): sin esto una cajera podía tocar el movimiento de otra sede
 * con sólo tener su id.
 */
export async function exigirAccesoAlMovimiento(
  prisma: PrismaService,
  user: AuthUser,
  id: string,
): Promise<void> {
  const t = await prisma.transaction.findUnique({
    where: { id },
    select: { cashAccountId: true },
  });
  if (!t) throw new NotFoundException('Movimiento no encontrado');
  if (t.cashAccountId != null) {
    await exigirAcceso(prisma, user, t.cashAccountId);
    return;
  }
  // Sin caja no hay nada contra lo que contrastar: se lo negamos a quien esté
  // acotado y se lo permitimos a quien ve todas. Hoy no hay filas así, pero el
  // schema lo permite y el lado seguro es no enseñar dinero ajeno.
  if ((await cajasPermitidas(prisma, user)) !== null) {
    throw new ForbiddenException('No tienes acceso a este movimiento.');
  }
}
