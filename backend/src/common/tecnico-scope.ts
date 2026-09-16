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
 *   · Material → SU bodega personal (`MaterialWarehouse.technicianRef` = su username
 *                 o su nombre, según se creara en el legacy o aquí).
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
export type FichaTecnico = { id: string; name: string; username: string | null; legacyId: number | null };

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
    select: { id: true, name: true, username: true, legacyId: true },
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
  if (!ficha) return null;
  // Se casa contra sus dos llaves —username y nombre— y no sólo contra el username:
  // las bodegas heredadas del legacy lo guardan así, pero las que se crean aquí
  // apuntan al empleado por su nombre. Exigir username dejaba sin bodega (y sin
  // poder gastar material) a todo técnico dado de alta en nexus.
  const claves = clavesDe(ficha).map(norm);
  if (!claves.length) return null;
  const bodegas = await prisma.materialWarehouse.findMany({
    where: { technicianRef: { not: null } },
    select: { id: true, title: true, technicianRef: true },
  });
  const suya = bodegas.find((b) => claves.includes(norm(b.technicianRef)));
  return suya ? { id: suya.id, title: suya.title } : null;
}

/**
 * La CUENTA del técnico a partir de su nombre en una orden (`Ticket.assigned`), o
 * `null` si no se le encuentra login.
 *
 * Es el camino inverso de `fichaDelUsuario`: allí se va de la sesión a la ficha,
 * aquí del texto libre de la orden a la cuenta con la que entra. Se resuelve en dos
 * saltos —texto → `Staff` → `User`— porque son las mismas tres columnas sucias de
 * siempre: la orden guarda el nombre completo (las nuevas) o el username (las del
 * legacy), y `User` y `Staff` sólo se casan por correo o por nombre exacto.
 *
 * Devolver `null` es normal y no es un error: hay técnicos del legacy sin login.
 */
export async function usuarioDelTecnico(
  prisma: PrismaService,
  tecnico: string | null | undefined,
): Promise<{ id: string; name: string } | null> {
  const clave = norm(tecnico);
  if (!clave) return null;
  const ficha = await prisma.staff.findFirst({
    where: {
      banned: false,
      OR: [{ name: { equals: tecnico!.trim(), mode: 'insensitive' } }, { username: { equals: tecnico!.trim(), mode: 'insensitive' } }],
    },
    select: { name: true, email: true },
  });
  if (!ficha) return null;
  return prisma.user.findFirst({
    where: {
      isActive: true,
      OR: [
        ...(ficha.email ? [{ email: { equals: ficha.email, mode: 'insensitive' as const } }] : []),
        { name: { equals: ficha.name, mode: 'insensitive' as const } },
      ],
    },
    select: { id: true, name: true },
  });
}

/**
 * ¿Este abonado es de alguna orden SUYA? (2026-09-10, a pedido del usuario: «los
 * técnicos solo podrán visualizar los usuarios correspondientes a las órdenes
 * asignadas en su agendamiento».)
 *
 * Es el segundo tramo del cierre del buscador. El 2026-09-10 se le quitó el ⌘K y el
 * listado de clientes (`SubscribersController.sinBuscador`), pero la FICHA seguía
 * abierta por URL para cualquiera de los 20.000 abonados: bastaba teclear un id —o
 * probar los del historial de otro— para leer teléfono, dirección, deuda y equipos de
 * un cliente que no tenía nada que ver con su trabajo.
 *
 * "Suya" es lo mismo que en todas partes: por la FK (`assignedStaffId`) o por el texto
 * libre del legacy (`assigned`), que se reparten su cola casi por mitades. **Y de
 * CUALQUIER fecha**, no sólo de hoy: su pantalla se acotó al día, pero desde su
 * historial abre la visita del martes, y desde ella el cliente. Acotarlo también aquí
 * dejaría su propio historial lleno de enlaces muertos.
 *
 * Sin ficha de empleado no es de nadie: `false`, que es el lado seguro de siempre.
 */
export async function esClienteDeSuOrden(
  prisma: PrismaService,
  user: AuthUser,
  subscriberId: string,
): Promise<boolean> {
  const ficha = await fichaDelUsuario(prisma, user);
  if (!ficha) return false;
  const claves = clavesDe(ficha);
  const orden = await prisma.ticket.findFirst({
    where: {
      subscriberId,
      OR: [{ assignedStaffId: ficha.id }, ...(claves.length ? [{ assigned: { in: claves } }] : [])],
    },
    select: { id: true },
  });
  return Boolean(orden);
}

/**
 * Filtro de abonados "sólo los de MIS órdenes", o `null` si a este usuario no hay
 * que acotarlo (2026-09-10).
 *
 * Es la versión en `where` de `esClienteDeSuOrden`, para las pantallas que listan
 * abonados en vez de abrir uno: hoy el MAPA, que además trae buscador por nombre y
 * dirección — o sea, el buscador de clientes que se acababa de cerrar, entrando por
 * otra puerta. Con esto el técnico sigue viendo en el mapa a dónde tiene que ir (y
 * el "cómo llegar" de su visita), pero no la vecindad entera de su sede.
 *
 * Un técnico sin ficha recibe un filtro imposible y no la lista completa, que es el
 * criterio de siempre.
 */
export async function whereSuscriptoresDeSusOrdenes(
  prisma: PrismaService,
  user?: AuthUser | null,
): Promise<{ id?: { in: string[] }; tickets?: object } | null> {
  if (!esTecnicoDeCampo(user)) return null;
  const ficha = await fichaDelUsuario(prisma, user!);
  if (!ficha) return { id: { in: [] } };
  const claves = clavesDe(ficha);
  return {
    tickets: {
      some: { OR: [{ assignedStaffId: ficha.id }, ...(claves.length ? [{ assigned: { in: claves } }] : [])] },
    },
  };
}
