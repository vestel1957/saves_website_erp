/**
 * Migración puntual del catálogo de roles (2026-06).
 * Idempotente — seguro de correr varias veces.
 *
 *  - Agrega el permiso hr.access.manage y los roles hr-director / hr-assistant.
 *  - Sincroniza los permisos de CADA rol del catálogo (agrega faltantes y
 *    quita los que ya no correspondan, p.ej. comerciales en super-admin).
 *  - Migra los usuarios de hr-manager → hr-director.
 *  - Elimina roles redundantes (hr-manager, inventory-viewer, sst-viewer, area-manager).
 *  - Elimina permisos comerciales huérfanos (crm.view, sales.view, purchases.view).
 *
 * Correr:  npx ts-node prisma/migrate-roles-2026-06.ts
 */
import { PrismaClient } from '@prisma/client';
import { ALL_PERMISSIONS, ALL_ROLES } from '../src/auth/permissions.catalog';

const prisma = new PrismaClient();

const REMOVED_ROLES = ['hr-manager', 'inventory-viewer', 'sst-viewer', 'area-manager'];
const REMOVED_PERMS = ['crm.view', 'sales.view', 'purchases.view'];
const ROLE_MIGRATIONS: Record<string, string> = { 'hr-manager': 'hr-director' };

async function main() {
  // 1. permisos del catálogo (alta/actualización)
  for (const p of ALL_PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key: p.key },
      update: { label: p.label },
      create: { key: p.key, label: p.label },
    });
  }
  console.log(`✓ ${ALL_PERMISSIONS.length} permisos upsertados`);

  // 2. roles + sincronización exacta de sus permisos
  for (const r of ALL_ROLES) {
    const role = await prisma.role.upsert({
      where: { key: r.key },
      update: { name: r.name, description: r.description },
      create: { key: r.key, name: r.name, description: r.description },
    });
    const perms = await prisma.permission.findMany({ where: { key: { in: r.permissions } } });
    const wantIds = perms.map((p) => p.id);
    for (const perm of perms) {
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId: perm.id } },
        update: {},
        create: { roleId: role.id, permissionId: perm.id },
      });
    }
    // quita permisos que ya no están en el catálogo de ese rol
    await prisma.rolePermission.deleteMany({
      where: { roleId: role.id, permissionId: { notIn: wantIds } },
    });
  }
  console.log(`✓ ${ALL_ROLES.length} roles sincronizados`);

  // 3. migrar usuarios de roles eliminados a su reemplazo
  for (const [fromKey, toKey] of Object.entries(ROLE_MIGRATIONS)) {
    const from = await prisma.role.findUnique({ where: { key: fromKey } });
    const to = await prisma.role.findUnique({ where: { key: toKey } });
    if (from && to) {
      const assignments = await prisma.userRole.findMany({ where: { roleId: from.id } });
      for (const a of assignments) {
        await prisma.userRole.upsert({
          where: { userId_roleId: { userId: a.userId, roleId: to.id } },
          update: {},
          create: { userId: a.userId, roleId: to.id },
        });
      }
      console.log(`✓ ${assignments.length} usuario(s) migrados ${fromKey} → ${toKey}`);
    }
  }

  // 4. eliminar roles redundantes
  for (const key of REMOVED_ROLES) {
    const role = await prisma.role.findUnique({ where: { key } });
    if (!role) continue;
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    await prisma.userRole.deleteMany({ where: { roleId: role.id } });
    await prisma.role.delete({ where: { id: role.id } });
    console.log(`✓ rol eliminado: ${key}`);
  }

  // 5. eliminar permisos comerciales huérfanos
  for (const key of REMOVED_PERMS) {
    const perm = await prisma.permission.findUnique({ where: { key } });
    if (!perm) continue;
    await prisma.rolePermission.deleteMany({ where: { permissionId: perm.id } });
    await prisma.permission.delete({ where: { id: perm.id } });
    console.log(`✓ permiso eliminado: ${key}`);
  }

  console.log('\n✅ Migración de roles completada.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
