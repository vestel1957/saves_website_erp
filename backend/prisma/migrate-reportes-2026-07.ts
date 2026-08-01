/**
 * Alta de las pantallas de REPORTES (2026-07-28).
 * Idempotente — seguro de correr varias veces.
 *
 * `/reportes` se partió en una pantalla por reporte. Cada `href` nuevo genera su
 * llave `screen.reportes.*`, y esas llaves NO existen en la base: los permisos
 * viven en la tabla `Permission` y se conceden vía `RolePermission`, así que sin
 * este script el menú nuevo queda invisible para todos menos el superadmin.
 *
 * Qué hace:
 *  1. Da de alta (o actualiza la etiqueta de) todos los permisos del catálogo.
 *  2. Concede las pantallas de reportes al rol `area-gerencia`.
 *  3. Reporta quién queda con acceso, para poder verificarlo sin adivinar.
 *
 * Lo que NO hace: tocar los overrides por usuario. Si alguien tenía DENY sobre
 * `screen.reportes`, se respeta — quitar una denegación explícita es una decisión
 * de negocio, no de una migración.
 *
 * Correr:  npx ts-node prisma/migrate-reportes-2026-07.ts
 */
import { PrismaClient } from '@prisma/client';
import { ALL_PERMISSIONS, SCREENS, screenKey } from '../src/auth/permissions.catalog';

const prisma = new PrismaClient();

const ROL_GERENCIA = 'area-gerencia';

async function main() {
  // 1. Catálogo completo de permisos (alta/actualización de etiqueta).
  for (const p of ALL_PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key: p.key },
      update: { label: p.label },
      create: { key: p.key, label: p.label },
    });
  }
  console.log(`✓ ${ALL_PERMISSIONS.length} permisos del catálogo al día`);

  // 2. Las pantallas de reportes al rol de gerencia.
  const llaves = SCREENS.filter((s) => s.href.startsWith('/reportes')).map((s) => screenKey(s.href));
  console.log(`  pantallas de reportes: ${llaves.length}`);

  const rol = await prisma.role.findUnique({ where: { key: ROL_GERENCIA }, select: { id: true, name: true } });
  if (!rol) {
    console.error(`✗ No existe el rol "${ROL_GERENCIA}". Corre antes prisma/migrate-roles-2026-06.ts`);
    process.exitCode = 1;
    return;
  }

  const permisos = await prisma.permission.findMany({ where: { key: { in: llaves } }, select: { id: true, key: true } });
  let nuevos = 0;
  for (const p of permisos) {
    const ya = await prisma.rolePermission.findFirst({ where: { roleId: rol.id, permissionId: p.id } });
    if (ya) continue;
    await prisma.rolePermission.create({ data: { roleId: rol.id, permissionId: p.id } });
    nuevos += 1;
  }
  console.log(`✓ ${nuevos} pantallas concedidas a "${rol.name}" (${permisos.length - nuevos} ya las tenía)`);

  // 3. Quién queda viendo los reportes. Sin esto la migración es un acto de fe.
  const usuarios = await prisma.user.findMany({
    where: { roles: { some: { role: { key: ROL_GERENCIA } } }, isActive: true },
    select: { email: true, name: true },
  });
  console.log(`✓ ${usuarios.length} usuarios activos con el rol de gerencia:`);
  for (const u of usuarios) console.log(`    · ${u.name} <${u.email}>`);
  if (!usuarios.length) {
    console.log('  ⚠ Nadie tiene el rol de gerencia. Los reportes solo los verá el superadministrador.');
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
