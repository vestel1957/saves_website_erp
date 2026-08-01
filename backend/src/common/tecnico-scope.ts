import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/current-user.decorator';

/**
 * Qué ve un técnico de campo — SÓLO lo suyo (decisión del usuario, 2026-07-31).
 *
 * Hasta ahora el técnico entraba al inventario y a soporte con el mismo alcance que
 * administración: veía las 12 bodegas de equipos de la empresa, el catálogo entero de
 * material y las 139.000 órdenes de todo el mundo. La regla nueva es la del resto del
 * sistema (`treasury/caja-scope.ts` para la cajera, `network/bodega-scope.ts` para las
 * bodegas por sede): cada quien ve su parcela.
 *
 *   · Equipos  → los que están A SU NOMBRE (`Equipment.assignedRaw` = su username).
 *   · Material → SU bodega personal (`MaterialWarehouse.technicianRef` = su username).
 *   · Soporte  → las órdenes asignadas a él (por FK o por el texto libre del legacy).
 *
 * Tres trampas que conviene conocer antes de tocar esto:
 *
 * 1. Hay que mirar `user.permissions`, NUNCA `user.roles`: `resolveUser()` mete en
 *    `roles` el nombre para mostrar ('Técnicos'), no la clave del rol.
 * 2. El vínculo usuario↔empleado es por CORREO (o por nombre exacto, como respaldo):
 *    `User` y `Staff` son tablas distintas y sólo se casan así. Un técnico sin ficha
 *    de empleado no tiene forma de saber qué es suyo — y entonces no ve NADA, que es
 *    el lado seguro (y lo que ya hacía `mi-jornada`).
 * 3. `technicianRef` y `assignedRaw` vienen del legacy con basura de captura
 *    ('OmarTec ', mayúsculas distintas): se casan normalizados, nunca con un `equals`
 *    a pelo contra la columna.
 */

const P_SUPERADMIN = 'system.admin';
const P_TECNICOS = 'area.tecnicos';
/** Áreas que mandan sobre la restricción: si tienes una de estas, ves todo. */
const P_MANDO = ['area.gerencia', 'area.administracion', 'area.contabilidad'];
/** El jefe de bodega responde por TODO el inventario aunque sea del área técnica. */
const P_JEFE_BODEGA = 'inventory.admin';

/** ¿Es un técnico "puro" (de campo) y por tanto va acotado a lo suyo? */
export function esTecnicoDeCampo(user?: AuthUser | null): boolean {
  const p = user?.permissions ?? [];
  if (!user?.id) return false; // procesos internos (cron, chatbot): no hay a quién acotar
  if (p.includes(P_SUPERADMIN)) return false;
  if (p.includes(P_JEFE_BODEGA)) return false;
  if (P_MANDO.some((m) => p.includes(m))) return false;
  return p.includes(P_TECNICOS);
}

/** La ficha de empleado del usuario logueado (lo que ata su sesión con el legacy). */
export type FichaTecnico = { id: string; name: string; username: string | null };

/**
 * Empleado detrás del usuario logueado. Se casa por correo y, como respaldo, por
 * nombre exacto: hoy sólo una parte de las cuentas tiene el correo igual en las dos
 * tablas. `banned: false` a propósito — un ex-empleado no tiene trabajo asignado.
 */
export function fichaDelUsuario(prisma: PrismaService, user: AuthUser): Promise<FichaTecnico | null> {
  return prisma.staff.findFirst({
    where: {
      banned: false,
      OR: [{ email: { equals: user.email, mode: 'insensitive' } }, { name: { equals: user.name, mode: 'insensitive' } }],
    },
    select: { id: true, name: true, username: true },
  });
}

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

/**
 * Las formas en que su nombre puede estar escrito en las columnas de texto libre
 * heredadas del legacy: su nombre completo (órdenes nuevas) y su username (las viejas).
 */
export function clavesDe(ficha: FichaTecnico): string[] {
  return [ficha.name, ficha.username].filter((c): c is string => Boolean(c?.trim()));
}

/**
 * Su bodega personal de material, o `null` si no tiene (o no tiene ficha).
 *
 * Se resuelve en memoria y no con un `where`: `technicianRef` trae espacios y
 * mayúsculas del legacy, así que un `equals` en SQL dejaría fuera a los técnicos cuyo
 * dato quedó sucio. Son ~40 bodegas: cabe de sobra.
 */
export async function bodegaMaterialDelTecnico(
  prisma: PrismaService,
  user: AuthUser,
): Promise<{ id: string; title: string } | null> {
  const ficha = await fichaDelUsuario(prisma, user);
  if (!ficha?.username?.trim()) return null;
  const bodegas = await prisma.materialWarehouse.findMany({
    where: { technicianRef: { not: null } },
    select: { id: true, title: true, technicianRef: true },
  });
  const suya = bodegas.find((b) => norm(b.technicianRef) === norm(ficha.username));
  return suya ? { id: suya.id, title: suya.title } : null;
}
