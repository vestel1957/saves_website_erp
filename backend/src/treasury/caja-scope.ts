import { ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/current-user.decorator';

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

const P_SUPERADMIN = 'system.admin';
const P_CAJA = 'area.caja';
/** Áreas que mandan sobre la restricción de cajera: si tienes una de estas, ves todo. */
const P_MANDO = ['area.contabilidad', 'area.administracion', 'area.gerencia'];

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

/** ¿Este usuario es una cajera "pura" (y por tanto va acotada a su caja)? */
export function esCajera(user: AuthUser): boolean {
  const p = user?.permissions ?? [];
  if (p.includes(P_SUPERADMIN)) return false;
  if (P_MANDO.some((m) => p.includes(m))) return false;
  return p.includes(P_CAJA);
}

/** Resuelve qué puede ver este usuario. */
export async function alcanceDe(prisma: PrismaService, user: AuthUser): Promise<AlcanceCajas> {
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
