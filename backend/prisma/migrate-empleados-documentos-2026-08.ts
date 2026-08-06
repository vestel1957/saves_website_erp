/**
 * Migración puntual: Empleados → CONFIGURACIÓN y Documentos → PERSONAS / PROYECTOS
 * (2026-08-05). Idempotente — seguro de correr varias veces.
 *
 * Las dos pantallas se movieron de sección Y de ruta (/empleados →
 * /configuracion/empleados, /configuracion/documentos → /documentos), porque la
 * llave de permiso se deriva del href (`screenKey`) y el gate por área del
 * middleware también va por ruta: dejar el menú diciendo una cosa y la URL otra
 * descuadra las dos. Al cambiar el href cambia la llave, así que hay que
 * renombrarla en base o quien tuviera la pantalla concedida la pierde.
 *
 * Se hace con UPDATE sobre `Permission.key` (no borrar+crear) para CONSERVAR las
 * concesiones: `RolePermission` y `UserPermission` apuntan a `permissionId`, no a
 * la llave, así que el rename no toca a nadie.
 *
 * Después conviene correr `migrate-roles-2026-06.ts`, que resincroniza los roles
 * del catálogo: `screensForArea` ahora le da `screen.configuracion.empleados` al
 * área de sistemas (además de administración, que ya la tenía) y
 * `screen.documentos` a administración (además de sistemas).
 *
 * Correr:  npx ts-node prisma/migrate-empleados-documentos-2026-08.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const RENAMES: [from: string, to: string, label: string][] = [
  ['screen.empleados', 'screen.configuracion.empleados', 'Empleados'],
  ['screen.configuracion.documentos', 'screen.documentos', 'Documentos'],
];

async function main() {
  for (const [from, to, label] of RENAMES) {
    const old = await prisma.permission.findUnique({ where: { key: from } });
    if (!old) {
      console.log(`· ${from} no existe (ya migrado o nunca sembrado) — se omite`);
      continue;
    }
    // Si el destino ya existe, el rename chocaría con el @unique: se consolidan
    // las concesiones del viejo sobre el nuevo y se elimina el viejo.
    const existing = await prisma.permission.findUnique({ where: { key: to } });
    if (existing) {
      const roles = await prisma.rolePermission.findMany({ where: { permissionId: old.id } });
      for (const rp of roles) {
        await prisma.rolePermission.upsert({
          where: { roleId_permissionId: { roleId: rp.roleId, permissionId: existing.id } },
          update: {},
          create: { roleId: rp.roleId, permissionId: existing.id },
        });
      }
      const users = await prisma.userPermission.findMany({ where: { permissionId: old.id } });
      for (const up of users) {
        await prisma.userPermission.upsert({
          where: { userId_permissionId: { userId: up.userId, permissionId: existing.id } },
          update: { effect: up.effect },
          create: { userId: up.userId, permissionId: existing.id, effect: up.effect },
        });
      }
      await prisma.rolePermission.deleteMany({ where: { permissionId: old.id } });
      await prisma.userPermission.deleteMany({ where: { permissionId: old.id } });
      await prisma.permission.delete({ where: { id: old.id } });
      console.log(
        `✓ ${from} consolidado sobre ${to} (${roles.length} rol(es), ${users.length} usuario(s))`,
      );
      continue;
    }
    const roles = await prisma.rolePermission.count({ where: { permissionId: old.id } });
    const users = await prisma.userPermission.count({ where: { permissionId: old.id } });
    await prisma.permission.update({ where: { id: old.id }, data: { key: to, label } });
    console.log(`✓ ${from} → ${to} (${roles} rol(es) y ${users} usuario(s) conservados)`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
