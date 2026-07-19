import { ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/current-user.decorator';

/**
 * Acceso por sede — el equivalente a `treasury/caja-scope.ts` para el resto de datos.
 *
 * `User.sedesAccede` guarda los `Branch.legacyId` a los que llega el usuario. Hasta
 * ahora sólo lo leía tesorería, así que clientes, facturas y tickets se consultaban
 * por id sin filtrar: bastaba cambiar el id de la URL para leer los de otra sede.
 *
 * SEMÁNTICA (la misma que caja-scope, y hay que respetarla):
 *   - lista **vacía = SIN restricción** (ve todas las sedes). No es "ninguna".
 *   - lista con sedes = ve sólo esas.
 *
 * El superusuario nunca queda acotado.
 *
 * Ojo con el enganche: `sedesAccede` son `legacyId` (enteros), mientras que
 * `Subscriber.branchId` es el `id` (cuid) de `Branch`. Por eso se filtra por la
 * relación (`branch: { legacyId: { in } }`) y no comparando ids sueltos.
 */

const P_SUPERADMIN = 'system.admin';

/**
 * Sedes que puede ver el usuario. `null` = sin límite (no filtrar).
 *
 * Devolver `null` en vez de la lista completa es deliberado: permite que quien llama
 * NO añada ninguna condición al `where`, en vez de meter un `IN` con todas las sedes
 * que estorbaría a los índices sin acotar nada.
 */
export async function sedesDe(prisma: PrismaService, user: AuthUser | undefined): Promise<number[] | null> {
  if (!user) return null;
  if ((user.permissions ?? []).includes(P_SUPERADMIN)) return null;
  const fila = await prisma.user.findUnique({
    where: { id: user.id },
    select: { sedesAccede: true },
  });
  const sedes = fila?.sedesAccede ?? [];
  return sedes.length ? sedes : null;
}

/**
 * Condición para filtrar SUSCRIPTORES por sede. Devuelve `{}` si no hay límite, para
 * poder mezclarlo con un spread sin condicionales en cada sitio.
 *
 * Un suscriptor sin sede (`branchId` null) NO lo ve un usuario acotado: ante la duda,
 * no enseñar datos de un cliente cuya sede no consta.
 */
export function whereSedeSuscriptor(sedes: number[] | null) {
  if (!sedes) return {};
  return { branch: { legacyId: { in: sedes } } };
}

/** Igual, para entidades que cuelgan de un suscriptor (facturas, tickets, órdenes). */
export function whereSedePorSuscriptor(sedes: number[] | null) {
  if (!sedes) return {};
  return { subscriber: { branch: { legacyId: { in: sedes } } } };
}

/**
 * Exige que el usuario pueda ver ESE suscriptor, o 403. Puerta de los endpoints que
 * reciben un id del cliente.
 */
export async function exigirSedeSuscriptor(
  prisma: PrismaService,
  user: AuthUser | undefined,
  subscriberId: string,
): Promise<void> {
  const sedes = await sedesDe(prisma, user);
  if (!sedes) return;
  const sub = await prisma.subscriber.findUnique({
    where: { id: subscriberId },
    select: { branch: { select: { legacyId: true } } },
  });
  // Si no existe, no se filtra aquí: que el propio servicio lance su 404 y no
  // convertirlo en 403, que además revelaría si el id existe o no.
  if (!sub) return;
  const legacy = sub.branch?.legacyId ?? null;
  if (legacy == null || !sedes.includes(legacy)) {
    throw new ForbiddenException('No tienes acceso a los datos de esta sede.');
  }
}
