/**
 * Inventory + Auth seed. Idempotent — safe to run multiple times.
 * Run with:  npx ts-node prisma/seed-inventory.ts
 *
 * Seeds: permissions, default roles, an admin user, and a small demo catalog
 * (unit, category, warehouse, two products) so the module is usable immediately.
 *
 * Default admin login →  admin@bhdc.dev  /  admin123
 */
import { PrismaClient } from '@prisma/client';
import { ALL_PERMISSIONS, ALL_ROLES } from '../src/auth/permissions.catalog';
import { hashPassword } from '../src/auth/crypto.util';

const prisma = new PrismaClient();

async function main() {
  // ---- permissions -------------------------------------------------------
  for (const p of ALL_PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key: p.key },
      update: { label: p.label },
      create: { key: p.key, label: p.label },
    });
  }
  console.log(`✓ ${ALL_PERMISSIONS.length} permisos`);

  // ---- roles + role-permissions -----------------------------------------
  for (const r of ALL_ROLES) {
    const role = await prisma.role.upsert({
      where: { key: r.key },
      update: { name: r.name, description: r.description },
      create: { key: r.key, name: r.name, description: r.description },
    });
    const perms = await prisma.permission.findMany({ where: { key: { in: r.permissions } } });
    for (const perm of perms) {
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId: perm.id } },
        update: {},
        create: { roleId: role.id, permissionId: perm.id },
      });
    }
    // Sincroniza: elimina permisos que el rol ya no debe tener (p. ej. al
    // degradar un rol a solo lectura). Sin esto, los permisos viejos quedarían
    // pegados en la BD porque el upsert de arriba solo agrega, nunca quita.
    await prisma.rolePermission.deleteMany({
      where: { roleId: role.id, permissionId: { notIn: perms.map((p) => p.id) } },
    });
  }
  console.log(`✓ ${ALL_ROLES.length} roles`);

  // ---- demo users (one per representative role) --------------------------
  // Idempotent: upserts the user, then ensures the role assignment exists.
  // Passwords are reset on every seed run so the demo logins always work.
  const demoUsers: { email: string; name: string; password: string; roleKey: string }[] = [
    { email: 'admin@bhdc.dev', name: 'Administrador', password: 'admin123', roleKey: 'super-admin' },
    // Un usuario demo por cada área Vestel (para probar el sidebar por área).
    { email: 'gerencia@vestel.dev', name: 'Gloria Gerente', password: 'gerencia123', roleKey: 'area-gerencia' },
    { email: 'administracion@vestel.dev', name: 'Andrés Admin', password: 'admin123', roleKey: 'area-administracion' },
    { email: 'contabilidad@vestel.dev', name: 'Camila Contadora', password: 'conta123', roleKey: 'area-contabilidad' },
    { email: 'tecnicos@vestel.dev', name: 'Tomás Técnico', password: 'tecnico123', roleKey: 'area-tecnicos' },
    { email: 'sistemas@vestel.dev', name: 'Sara Sistemas', password: 'sistemas123', roleKey: 'area-sistemas' },
    { email: 'caja@vestel.dev', name: 'Carla Cajera', password: 'caja123', roleKey: 'area-caja' },
  ];

  for (const u of demoUsers) {
    const role = await prisma.role.findUnique({ where: { key: u.roleKey } });
    const user = await prisma.user.upsert({
      where: { email: u.email },
      update: { name: u.name, passwordHash: hashPassword(u.password), isActive: true },
      create: { email: u.email, name: u.name, passwordHash: hashPassword(u.password) },
    });
    if (role) {
      await prisma.userRole.upsert({
        where: { userId_roleId: { userId: user.id, roleId: role.id } },
        update: {},
        create: { userId: user.id, roleId: role.id },
      });
    }
    console.log(`✓ usuario ${u.email} / ${u.password}  (${u.roleKey})`);
  }

  // ---- demo catalog ------------------------------------------------------
  const und = await prisma.unitOfMeasure.upsert({
    where: { code: 'UND' },
    update: {},
    create: { code: 'UND', name: 'Unidad' },
  });
  const category = await prisma.category.upsert({
    where: { code: 'GEN' },
    update: {},
    create: { code: 'GEN', name: 'General' },
  });
  const warehouse = await prisma.warehouse.upsert({
    where: { code: 'BOD-01' },
    update: {},
    create: { code: 'BOD-01', name: 'Bodega Principal', type: 'MAIN', address: 'Planta 1' },
  });

  const demo = [
    { sku: 'PROD-001', name: 'Producto demo A', type: 'PHYSICAL' as const },
    { sku: 'PROD-002', name: 'Producto demo B', type: 'CONSUMABLE' as const },
  ];
  for (const d of demo) {
    await prisma.product.upsert({
      where: { sku: d.sku },
      update: {},
      create: {
        sku: d.sku,
        name: d.name,
        type: d.type,
        categoryId: category.id,
        uomId: und.id,
      },
    });
  }
  console.log(`✓ catálogo demo (bodega ${warehouse.code}, ${demo.length} productos)`);

  // ---- áreas / departamentos (donde se usa/consume el material) ----------
  const areas = [
    { code: 'PERFORACION', name: 'Perforación' },
    { code: 'TALLER', name: 'Taller / Mantenimiento' },
    { code: 'PLANTA', name: 'Planta' },
    { code: 'LOGISTICA', name: 'Logística / Transporte' },
    { code: 'ADMIN', name: 'Administración' },
    { code: 'HSE', name: 'HSE / Seguridad' },
  ];
  for (const a of areas) {
    await prisma.area.upsert({ where: { code: a.code }, update: { name: a.name }, create: a });
  }
  console.log(`✓ ${areas.length} áreas`);

  console.log('\n✅ Seed de inventario completado.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
