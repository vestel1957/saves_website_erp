import { ForbiddenException } from '../core/http/errores';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/current-user.decorator';
import { esCajera } from '../treasury/caja-scope';

/**
 * Quién puede mover qué bodega de equipos — el mismo criterio que ya acota la caja
 * (`treasury/caja-scope.ts`), aplicado al inventario técnico.
 *
 * Regla (2026-07-30, decisión del usuario): una cajera es la encargada de SU sede, así
 * que solo ve y mueve las bodegas de sus sedes; enviar de una sede a otra es del
 * encargado de bodega. Contabilidad, administración, gerencia, técnicos y el
 * superusuario no están acotados (`esCajera` ya los deja fuera de la restricción).
 *
 * OJO con la sede vacía: en `caja-scope` una lista de sedes vacía significa "sin
 * límite", pero aquí NO. Una cajera sin sede asignada se queda sin bodegas —el lado
 * seguro, igual que allá una cajera sin caja solo ve los bancos—; el script
 * `prisma/migrate-bodegas-equipos-sede-2026-07.ts` reporta a quién le falta.
 */

/** Permiso del encargado de bodega (jefe de inventario). */
const P_JEFE_BODEGA = 'inventory.admin';
const P_SUPERADMIN = 'system.admin';

/** ¿Es el encargado de bodega (o el superusuario, que puede todo)? */
export function esJefeDeBodega(user: AuthUser): boolean {
  const p = user?.permissions ?? [];
  return p.includes(P_JEFE_BODEGA) || p.includes(P_SUPERADMIN);
}

/** ¿Es superusuario? (puede firmar en lugar de una cajera si hace falta). */
export function esSuperusuario(user: AuthUser): boolean {
  return (user?.permissions ?? []).includes(P_SUPERADMIN);
}

/**
 * Sedes (`Branch.legacyId`) a las que este usuario pertenece.
 * `null` = sin límite (no es cajera: no se le acota nada).
 * `[]`   = cajera sin sede asignada: no puede con ninguna bodega.
 */
export async function sedesDeUsuario(prisma: PrismaService, user: AuthUser): Promise<number[] | null> {
  if (!user?.id) return null; // procesos internos (cron, cargues): no hay a quién acotar
  if (!esCajera(user)) return null;

  const fila = await prisma.user.findUnique({
    where: { id: user.id },
    select: { cajaLegacyId: true, sedesAccede: true },
  });
  const sedes = new Set<number>(fila?.sedesAccede ?? []);
  // Su caja también dice de qué sede es: la mitad de las cajeras no tiene
  // `sedesAccede` cargado pero sí caja asignada, y sin esto se quedarían fuera.
  if (fila?.cajaLegacyId != null) {
    const cuenta = await prisma.cashAccount.findUnique({
      where: { legacyId: fila.cajaLegacyId },
      select: { branchLegacy: true },
    });
    // `branchLegacy = 0` es un banco, no una sede: no aporta.
    if (cuenta?.branchLegacy != null && cuenta.branchLegacy > 0) sedes.add(cuenta.branchLegacy);
  }
  return [...sedes];
}

/** Exige que la bodega sea de una de sus sedes, o 403 con el porqué. */
export function exigirBodegaDeSuSede(
  sedes: number[] | null,
  bodega: { name: string; branchLegacy: number | null },
): void {
  if (sedes === null) return; // sin límite
  if (!sedes.length) {
    throw new ForbiddenException(
      'No tienes una sede asignada, así que no puedes mover equipos. Pídele a Sistemas que te asigne la sede en tu usuario.',
    );
  }
  if (bodega.branchLegacy == null || !sedes.includes(bodega.branchLegacy)) {
    throw new ForbiddenException(`La bodega "${bodega.name}" no es de tu sede.`);
  }
}
