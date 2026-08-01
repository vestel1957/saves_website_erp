/**
 * Transferencias de equipos en el perfil de cajera (2026-07-30). Idempotente.
 *
 * La pantalla `/red/transferencias` ya estaba escrita pensando en ella —RECIBIR en
 * la sede destino se gatea con `area.caja`, y el backend ya la dejaba leer la
 * lista— pero la llave de pantalla `screen.red.transferencias` sólo se concedía al
 * área de técnicos, así que la cajera no la veía en el menú ni pasaba el
 * middleware. Este script concede esa llave al rol `area-caja`.
 *
 * Conceder no se puede hacer sólo en el catálogo (`SCREENS`): la concesión vive en
 * `RolePermission`. Los overrides por usuario se reportan y NO se tocan.
 *
 * Correr:  npx ts-node prisma/migrate-cajera-transferencias-equipos-2026-07.ts
 */
import { PrismaClient } from '@prisma/client';
import { ALL_PERMISSIONS, SCREENS, screenKey } from '../src/auth/permissions.catalog';

const prisma = new PrismaClient();

const ROL = 'area-caja';
const DAR = ['/red/transferencias'];

async function main() {
  // Coherencia con el catálogo: si no coincide, el próximo seed desharía esto.
  const malQuitadas = SCREENS.filter((s) => DAR.includes(s.href) && !s.areas.includes('caja'));
  if (malQuitadas.length) {
    console.error('✗ El catálogo no concuerda con este script. Revisa SCREENS.');
    process.exitCode = 1;
    return;
  }

  for (const p of ALL_PERMISSIONS) {
    await prisma.permission.upsert({ where: { key: p.key }, update: { label: p.label }, create: { key: p.key, label: p.label } });
  }

  const rol = await prisma.role.findUnique({ where: { key: ROL }, select: { id: true, name: true } });
  if (!rol) { console.error(`✗ No existe el rol "${ROL}".`); process.exitCode = 1; return; }

  for (const href of DAR) {
    const key = screenKey(href);
    const permiso = await prisma.permission.findUnique({ where: { key }, select: { id: true } });
    if (!permiso) { console.error(`  + ${key} no se creó`); continue; }
    const ya = await prisma.rolePermission.findFirst({ where: { roleId: rol.id, permissionId: permiso.id } });
    if (ya) { console.log(`  + ${key.padEnd(30)} ya la tenía`); continue; }
    await prisma.rolePermission.create({ data: { roleId: rol.id, permissionId: permiso.id } });
    console.log(`  + ${key.padEnd(30)} CONCEDIDA`);
    const overrides = await prisma.userPermission.findMany({
      where: { permissionId: permiso.id },
      select: { effect: true, user: { select: { name: true, email: true } } },
    });
    for (const o of overrides) console.log(`      ⚠ override por usuario: ${o.user.name} <${o.user.email}> (${o.effect}) — sin tocar`);
  }

  const restantes = await prisma.rolePermission.findMany({
    where: { roleId: rol.id, permission: { key: { startsWith: 'screen.' } } },
    select: { permission: { select: { key: true, label: true } } },
    orderBy: { permission: { key: 'asc' } },
  });
  console.log(`\n✓ Pantallas de "${rol.name}" (${restantes.length}):`);
  for (const r of restantes) console.log(`    · ${r.permission.key.padEnd(32)} ${r.permission.label}`);

  // Contexto útil: cuántas transferencias esperan recepción en este momento.
  const enTransito = await prisma.equipmentTransfer.count({ where: { status: 'En tránsito' } });
  const pendientes = await prisma.equipmentTransfer.count({ where: { status: 'Pendiente' } });
  console.log(`\n  ℹ ${enTransito} transferencia(s) "En tránsito" (para recibir) y ${pendientes} "Pendiente" de aprobación.`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
