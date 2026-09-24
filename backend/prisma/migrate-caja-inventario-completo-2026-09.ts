/**
 * La CAJERA ve el INVENTARIO COMPLETO (2026-09-17).
 *
 * Pedido del usuario: «que las cajeras puedan sí o sí ver todo el módulo de
 * inventario, con todos sus submódulos y todos los accesos». Hasta hoy tenía sólo
 * traspasos, actas, transferencias, equipos disponibles y compras en lectura.
 *
 * Concede a todo rol que tenga `area.caja` (derivado de la BD, no del catálogo, por
 * los roles hechos a mano) las pantallas de la sección INVENTARIO que le faltaban y
 * `inventory.admin` (aprobar/despachar transferencias de equipos, mandarlas entre
 * sedes). La API ya le abre las rutas por área (`caja` en inventory, orders, returns
 * y las de equipos de network). No concede `purchases.approve`.
 *
 * Idempotente. Correr:
 *   npx ts-node prisma/migrate-caja-inventario-completo-2026-09.ts [--dry-run]
 */
import { PrismaClient } from '@prisma/client';
import { APP_PERMISSIONS, ALL_PERMISSIONS, INV_PERMISSIONS, SCREENS, SEDES_DISPONIBLES, screenKey } from '../src/auth/permissions.catalog';

const prisma = new PrismaClient();

/** Todas las hojas de la sección INVENTARIO del menú (espejo de `nav.ts`). */
const HREFS = [
  '/red/equipos', '/red/equipos/nuevo', '/red/bodegas', '/red/transferencias',
  ...SEDES_DISPONIBLES.map((s) => `/red/disponibles/${s.slug}`),
  '/inventario', '/inventario/categorias', '/inventario/bodegas', '/inventario/traspasos', '/inventario/actas',
  '/ordenes', '/ordenes/servicios', '/ordenes/historial', '/ordenes/categorias',
  '/devoluciones', '/proveedores',
];

const soloSimular = process.argv.includes('--dry-run');

/** Alta del permiso en el catálogo de la BD (el gate compara contra estas filas). */
async function alta(key: string) {
  const def = ALL_PERMISSIONS.find((p) => p.key === key);
  const label = def?.label ?? key;
  if (soloSimular) return prisma.permission.findUnique({ where: { key } });
  return prisma.permission.upsert({ where: { key }, update: { label }, create: { key, label } });
}

async function main() {
  for (const href of HREFS) {
    if (!SCREENS.some((s) => s.href === href)) throw new Error(`${href} no está en SCREENS: revisa permissions.catalog.ts`);
  }
  const llaves = [...HREFS.map(screenKey), INV_PERMISSIONS.ADMIN];

  const roles = await prisma.role.findMany({
    // El superusuario ya lo ve todo por `system.admin`: no hace falta tocarlo.
    where: {
      AND: [
        { permissions: { some: { permission: { key: APP_PERMISSIONS.AREA_CAJA } } } },
        { permissions: { none: { permission: { key: APP_PERMISSIONS.SYSTEM_ADMIN } } } },
      ],
    },
    select: { id: true, key: true, permissions: { select: { permission: { select: { key: true } } } } },
  });
  console.log(`roles con ${APP_PERMISSIONS.AREA_CAJA}: ${roles.length}${roles.length ? ` (${roles.map((r) => r.key).join(', ')})` : ''}`);

  let concedidos = 0, yaTenian = 0;
  for (const key of llaves) {
    const permiso = await alta(key);
    for (const rol of roles) {
      if (rol.permissions.some((rp) => rp.permission.key === key)) { yaTenian++; continue; }
      console.log(`  + ${rol.key.padEnd(28)} ${key}${permiso ? '' : '  (permiso nuevo)'}`);
      if (!soloSimular && permiso) {
        await prisma.rolePermission.upsert({
          where: { roleId_permissionId: { roleId: rol.id, permissionId: permiso.id } },
          update: {},
          create: { roleId: rol.id, permissionId: permiso.id },
        });
      }
      concedidos++;
    }
  }

  console.log(`\n${soloSimular ? '[simulación] ' : ''}concesiones: ${concedidos} nuevas · ${yaTenian} ya estaban`);
  if (soloSimular) console.log('Vuelve a ejecutarlo sin --dry-run para aplicarlo.');
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
