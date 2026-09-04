import { ForbiddenException } from '../core/http/errores';
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
const P_CAJA = 'area.caja';
/** Áreas que mandan sobre el acotado de caja: con una de ellas se ve todo. */
const P_MANDO = ['area.contabilidad', 'area.administracion', 'area.gerencia'];

/**
 * ¿Es una cajera "pura"? Misma definición que usa `treasury/caja-scope.ts` para
 * acotarla a su caja, y por eso vive aquí, en un solo sitio: la de tesorería
 * delega en ésta.
 *
 * Importa que sea *pura*: quien además es de contabilidad, administración o
 * gerencia trabaja sobre todas las sedes aunque tenga una caja asignada.
 */
export function esCajeraPura(permisos: string[]): boolean {
  if (permisos.includes(P_SUPERADMIN)) return false;
  if (P_MANDO.some((m) => permisos.includes(m))) return false;
  return permisos.includes(P_CAJA);
}

/**
 * Sedes efectivas de una cuenta, a partir de sus dos fuentes.
 *
 * `sedesAccede` es la lista explícita, pero hay cajeras activas que la tienen VACÍA
 * y sólo traen caja asignada: sin la segunda vía se les abría el sistema entero,
 * porque aquí la lista vacía significa "sin límite". La caja dice de qué sede es
 * quien la maneja, así que se usa de respaldo (mismo rescate que hace
 * `support/agenda.service.ts` y `network/bodega-scope.ts`, contra los mismos datos
 * a medio migrar).
 *
 * Ese respaldo se aplica SÓLO a la cajera pura (`permisos`): contabilidad también
 * tiene caja asignada para sus asientos, y derivarle la sede de ahí la dejaría sin
 * ver el resto de la empresa, que es justo su trabajo.
 *
 * `branchLegacy = 0` es un BANCO, no una sede: no aporta alcance.
 */
export async function resolverSedes(
  prisma: PrismaService,
  cuenta: { sedesAccede?: number[] | null; cajaLegacyId?: number | null },
  permisos: string[] = [],
): Promise<number[]> {
  const sedes = (cuenta.sedesAccede ?? []).filter((n) => Number.isFinite(n) && n > 0);
  if (sedes.length) return [...new Set(sedes)];
  if (cuenta.cajaLegacyId == null || !esCajeraPura(permisos)) return [];
  const sede = await sedeDeLaCaja(prisma, cuenta.cajaLegacyId);
  return sede != null ? [sede] : [];
}

/**
 * Sede de una caja, memorizada. Esto se resuelve en CADA petición de quien tiene
 * caja pero no sedes marcadas (`resolveUser`), y la sede de una caja no cambia
 * nunca en la práctica: sin caché sería una consulta de más por petición.
 */
const CACHE_CAJA_TTL_MS = 5 * 60_000;
const cacheSedeDeCaja = new Map<number, { sede: number | null; exp: number }>();

async function sedeDeLaCaja(prisma: PrismaService, cajaLegacyId: number): Promise<number | null> {
  const ahora = Date.now();
  const hit = cacheSedeDeCaja.get(cajaLegacyId);
  if (hit && hit.exp > ahora) return hit.sede;
  const caja = await prisma.cashAccount.findUnique({
    where: { legacyId: cajaLegacyId },
    select: { branchLegacy: true },
  });
  // `branchLegacy = 0` es un banco, no una sede: no aporta alcance.
  const sede = caja?.branchLegacy != null && caja.branchLegacy > 0 ? caja.branchLegacy : null;
  cacheSedeDeCaja.set(cajaLegacyId, { sede, exp: ahora + CACHE_CAJA_TTL_MS });
  return sede;
}

/**
 * Sedes que puede ver el usuario. `null` = sin límite (no filtrar).
 *
 * Devolver `null` en vez de la lista completa es deliberado: permite que quien llama
 * NO añada ninguna condición al `where`, en vez de meter un `IN` con todas las sedes
 * que estorbaría a los índices sin acotar nada.
 *
 * Si la sesión ya trae el alcance resuelto (`AuthUser.sedes`, que rellena
 * `AuthService.resolveUser` en cada petición) se usa tal cual y no se vuelve a la BD.
 * El respaldo por consulta es para los "usuarios" que se arman a mano (cron, cargue
 * de pagos, chatbot), que no pasan por el guard.
 */
export async function sedesDe(prisma: PrismaService, user: AuthUser | undefined): Promise<number[] | null> {
  if (!user) return null;
  if ((user.permissions ?? []).includes(P_SUPERADMIN)) return null;
  if (user.sedes) return user.sedes.length ? user.sedes : null;
  if (!user.id) return null;
  const fila = await prisma.user.findUnique({
    where: { id: user.id },
    select: { sedesAccede: true, cajaLegacyId: true },
  });
  if (!fila) return null;
  const sedes = await resolverSedes(prisma, fila, user.permissions ?? []);
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
 * Exige que el usuario pueda ESCRIBIR en esa sede, o 403. Puerta del alta y la
 * edición de clientes: sin esto, quien está acotado a una sede no la vería en el
 * selector pero podría mandar el id de otra a mano y sacar al cliente de su alcance
 * (o meter uno nuevo donde no llega).
 *
 * `branchId` es el cuid de `Branch`; `undefined` = no se toca la sede.
 */
export async function exigirSedeDestino(
  prisma: PrismaService,
  user: AuthUser | undefined,
  branchId: string | null | undefined,
): Promise<void> {
  const sedes = await sedesDe(prisma, user);
  if (!sedes) return;
  if (branchId === undefined) return;
  // Dejar el cliente SIN sede lo sacaría de su propio alcance: para un usuario
  // acotado es tan inválido como mandarlo a otra sede.
  if (!branchId) throw new ForbiddenException('Tienes que indicar una sede de las tuyas.');
  const branch = await prisma.branch.findUnique({ where: { id: branchId }, select: { legacyId: true } });
  if (!branch || branch.legacyId == null || !sedes.includes(branch.legacyId)) {
    throw new ForbiddenException('No tienes acceso a esa sede.');
  }
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

/**
 * Las cajeras de una sede: quiénes pueden FIRMAR lo que llega a esa sede.
 *
 * Es el reverso de `sedesDe` —de la sede a las personas, y no al revés— y lo
 * necesitan los dos flujos en los que quien recibe no es una persona concreta sino
 * "la cajera de turno": la transferencia de equipos entre sedes
 * (`network-write.service.ts`) y la devolución de material del técnico a la bodega
 * principal de su sede (`inventory.service.ts`). Cualquiera de ellas puede firmar.
 *
 * OJO con la semántica de la lista vacía, que aquí se invierte respecto al resto
 * del fichero: una cajera sin sede resuelta NO entra (no se le puede atribuir la
 * sede de nadie), igual que en `network/bodega-scope.ts`. Es el lado seguro: se
 * prefiere que no haya quién firme —el acta lo dice y queda el superusuario— a que
 * la firme quien no responde por esa bodega.
 */
export async function cajerasDeSede(
  prisma: PrismaService,
  branchLegacy: number,
): Promise<{ id: string; name: string }[]> {
  const cajeras = await prisma.user.findMany({
    where: { isActive: true, roles: { some: { role: { key: 'area-caja' } } } },
    select: { id: true, name: true, sedesAccede: true, cajaLegacyId: true },
  });
  const suyas: { id: string; name: string }[] = [];
  for (const c of cajeras) {
    // `[P_CAJA]` a propósito: se resuelven como cajeras puras para que valga el
    // respaldo por caja asignada, que es de donde sale la sede de la mitad de ellas.
    const sedes = await resolverSedes(prisma, c, [P_CAJA]);
    if (sedes.includes(branchLegacy)) suyas.push({ id: c.id, name: c.name });
  }
  return suyas;
}
