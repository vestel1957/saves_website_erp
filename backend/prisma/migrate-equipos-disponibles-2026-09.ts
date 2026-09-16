/**
 * Módulo "Equipos disponibles" (2026-09-14). Idempotente.
 *
 * Una pantalla por sede (`/red/disponibles/<sede>`). Sus llaves se declaran en
 * `SCREENS`, pero la concesión vive en `RolePermission`: este script crea los
 * permisos y los da a los roles que las deben ver — administración, caja, jefe de
 * bodega y superusuario. Retira además la llave de la primera versión
 * (`screen.red.disponibles`, una sola pantalla para todas las sedes), que ya no es
 * hoja del menú. Los overrides por usuario se reportan y NO se tocan.
 *
 * Correr:  npx ts-node prisma/migrate-equipos-disponibles-2026-09.ts
 */
import { PrismaClient } from '@prisma/client';
import { ALL_PERMISSIONS, SCREENS, SEDES_DISPONIBLES, screenKey } from '../src/auth/permissions.catalog';

const prisma = new PrismaClient();

const HREFS = SEDES_DISPONIBLES.map((s) => `/red/disponibles/${s.slug}`);
const ROLES = ['area-administracion', 'area-caja', 'warehouse-manager', 'super-admin'];
const LLAVE_VIEJA = 'screen.red.disponibles';

async function main() {
  const faltan = HREFS.filter((h) => !SCREENS.some((s) => s.href === h));
  if (faltan.length) {
    console.error(`✗ No están en SCREENS: ${faltan.join(', ')}. Revisa el catálogo.`);
    process.exitCode = 1;
    return;
  }

  for (const p of ALL_PERMISSIONS) {
    await prisma.permission.upsert({ where: { key: p.key }, update: { label: p.label }, create: { key: p.key, label: p.label } });
  }

  const roles = await prisma.role.findMany({ where: { key: { in: ROLES } }, select: { id: true, key: true, name: true } });
  for (const k of ROLES.filter((k) => !roles.some((r) => r.key === k))) console.log(`  ⚠ no existe el rol "${k}"`);

  for (const href of HREFS) {
    const key = screenKey(href);
    const permiso = await prisma.permission.findUnique({ where: { key }, select: { id: true } });
    if (!permiso) { console.error(`  ✗ ${key} no se creó`); continue; }
    for (const rol of roles) {
      const ya = await prisma.rolePermission.findFirst({ where: { roleId: rol.id, permissionId: permiso.id } });
      if (ya) continue;
      await prisma.rolePermission.create({ data: { roleId: rol.id, permissionId: permiso.id } });
      console.log(`  + ${key.padEnd(40)} → ${rol.name}`);
    }
  }

  // La llave de la primera versión: ya no es hoja del menú.
  const vieja = await prisma.permission.findUnique({ where: { key: LLAVE_VIEJA }, select: { id: true } });
  if (vieja) {
    const overrides = await prisma.userPermission.count({ where: { permissionId: vieja.id } });
    if (overrides) {
      console.log(`  ⚠ ${LLAVE_VIEJA} tiene ${overrides} override(s) por usuario — se deja sin tocar`);
    } else {
      const { count } = await prisma.rolePermission.deleteMany({ where: { permissionId: vieja.id } });
      await prisma.permission.delete({ where: { id: vieja.id } });
      console.log(`  − ${LLAVE_VIEJA} retirada (${count} concesión(es) de rol)`);
    }
  }

  console.log(`\n✓ ${HREFS.length} pantallas de equipos disponibles listas.`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
