/**
 * Inventario en el perfil de cajera (2026-07-29). Idempotente.
 *
 * Dos movimientos, por decisión de negocio:
 *   − COMPRAS fuera: `/ordenes` y `/ordenes/historial`.
 *   + Entrega de material a técnicos: `/inventario/traspasos`. Cada técnico tiene su
 *     bodega (`MaterialWarehouse.technicianRef`), así que "asignarle material" es un
 *     traspaso al almacén de ese técnico, y el acta se cierra cuando él la recibe.
 *
 * Ni conceder ni revocar se puede hacer sólo en el catálogo (`SCREENS`): la
 * concesión vive en `RolePermission`. Los overrides por usuario se reportan y NO se
 * tocan.
 *
 * Correr:  npx ts-node prisma/migrate-cajera-inventario-2026-07.ts
 */
import { PrismaClient } from '@prisma/client';
import { ALL_PERMISSIONS, SCREENS, screenKey } from '../src/auth/permissions.catalog';

const prisma = new PrismaClient();

const ROL = 'area-caja';
const QUITAR = ['/ordenes', '/ordenes/historial'];
const DAR = ['/inventario/traspasos'];

async function main() {
  // Coherencia con el catálogo: si no coincide, el próximo seed desharía esto.
  const malDadas = SCREENS.filter((s) => QUITAR.includes(s.href) && s.areas.includes('caja'));
  const malQuitadas = SCREENS.filter((s) => DAR.includes(s.href) && !s.areas.includes('caja'));
  if (malDadas.length || malQuitadas.length) {
    console.error('✗ El catálogo no concuerda con este script. Revisa SCREENS.');
    process.exitCode = 1;
    return;
  }

  for (const p of ALL_PERMISSIONS) {
    await prisma.permission.upsert({ where: { key: p.key }, update: { label: p.label }, create: { key: p.key, label: p.label } });
  }

  const rol = await prisma.role.findUnique({ where: { key: ROL }, select: { id: true, name: true } });
  if (!rol) { console.error(`✗ No existe el rol "${ROL}".`); process.exitCode = 1; return; }

  for (const href of QUITAR) {
    const key = screenKey(href);
    const permiso = await prisma.permission.findUnique({ where: { key }, select: { id: true } });
    if (!permiso) { console.log(`  − ${key.padEnd(28)} no existe (nada que revocar)`); continue; }
    const borradas = await prisma.rolePermission.deleteMany({ where: { roleId: rol.id, permissionId: permiso.id } });
    console.log(`  − ${key.padEnd(28)} ${borradas.count ? 'REVOCADA' : 'el rol no la tenía'}`);
    const overrides = await prisma.userPermission.findMany({
      where: { permissionId: permiso.id },
      select: { effect: true, user: { select: { name: true, email: true } } },
    });
    for (const o of overrides) console.log(`      ⚠ override por usuario: ${o.user.name} <${o.user.email}> (${o.effect}) — sin tocar`);
  }

  for (const href of DAR) {
    const key = screenKey(href);
    const permiso = await prisma.permission.findUnique({ where: { key }, select: { id: true } });
    if (!permiso) { console.error(`  + ${key} no se creó`); continue; }
    const ya = await prisma.rolePermission.findFirst({ where: { roleId: rol.id, permissionId: permiso.id } });
    if (ya) { console.log(`  + ${key.padEnd(28)} ya la tenía`); continue; }
    await prisma.rolePermission.create({ data: { roleId: rol.id, permissionId: permiso.id } });
    console.log(`  + ${key.padEnd(28)} CONCEDIDA`);
  }

  const restantes = await prisma.rolePermission.findMany({
    where: { roleId: rol.id, permission: { key: { startsWith: 'screen.' } } },
    select: { permission: { select: { key: true, label: true } } },
    orderBy: { permission: { key: 'asc' } },
  });
  console.log(`\n✓ Pantallas de "${rol.name}" (${restantes.length}):`);
  for (const r of restantes) console.log(`    · ${r.permission.key.padEnd(30)} ${r.permission.label}`);

  // Contexto útil: a qué técnicos se les puede entregar (bodega propia).
  const conBodega = await prisma.materialWarehouse.count({ where: { technicianRef: { not: null } } });
  const total = await prisma.materialWarehouse.count();
  console.log(`\n  ℹ ${conBodega} de ${total} bodegas de material son de un técnico (destino de la entrega).`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
