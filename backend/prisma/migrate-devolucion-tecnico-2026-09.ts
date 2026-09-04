/**
 * El técnico devuelve material (2026-09-03). Idempotente.
 *
 * Le concede al rol de técnicos la pantalla `/inventario/traspasos`, que es donde
 * emite la devolución de lo que le sobró a la bodega principal de su sede. La API
 * ya lo aceptaba (áreas `TRASPASOS`: administración, técnicos y caja) y el contexto
 * del traspaso le sirve un único modo, "devolver": no puede entregarle material a
 * nadie ni mover otras bodegas (`InventoryService.transferContext` +
 * `resolveTransfer`).
 *
 * Quien recibe y firma NO es una persona designada sino la CAJERA de esa sede
 * (`MaterialActa.assignedBranchLegacy`), como en las transferencias de equipos.
 *
 * Correr:  npx ts-node prisma/migrate-devolucion-tecnico-2026-09.ts
 */
import { PrismaClient } from '@prisma/client';
import { ALL_PERMISSIONS, SCREENS, screenKey } from '../src/auth/permissions.catalog';

const prisma = new PrismaClient();

const HREF = '/inventario/traspasos';
const ROLES = ['area-tecnicos'];

async function main() {
  // Coherencia con el catálogo: si no concuerda, el próximo seed desharía esto.
  const def = SCREENS.find((s) => s.href === HREF);
  const faltan = ROLES.filter((r) => !def?.areas.includes(r.replace('area-', '')));
  if (!def || faltan.length) {
    console.error(`✗ El catálogo no concuerda con este script (faltan áreas: ${faltan.join(', ') || HREF}). Revisa SCREENS.`);
    process.exitCode = 1;
    return;
  }

  for (const p of ALL_PERMISSIONS) {
    await prisma.permission.upsert({ where: { key: p.key }, update: { label: p.label }, create: { key: p.key, label: p.label } });
  }

  const key = screenKey(HREF);
  const permiso = await prisma.permission.findUnique({ where: { key }, select: { id: true } });
  if (!permiso) { console.error(`✗ ${key} no se creó.`); process.exitCode = 1; return; }

  for (const rolKey of ROLES) {
    const rol = await prisma.role.findUnique({ where: { key: rolKey }, select: { id: true, name: true } });
    if (!rol) { console.log(`  ⚠ no existe el rol "${rolKey}" — se omite`); continue; }
    const ya = await prisma.rolePermission.findFirst({ where: { roleId: rol.id, permissionId: permiso.id } });
    if (ya) { console.log(`  + ${rol.name.padEnd(20)} ya la tenía`); continue; }
    await prisma.rolePermission.create({ data: { roleId: rol.id, permissionId: permiso.id } });
    console.log(`  + ${rol.name.padEnd(20)} CONCEDIDA (${key})`);
  }

  // Contexto: quién va a poder devolver de verdad y quién no, que es lo que hay que
  // arreglar a mano (sede del técnico, bodega principal de la sede, cajeras).
  const principales = await prisma.materialWarehouse.findMany({ where: { isMain: true }, select: { title: true, branchLegacy: true } });
  const branches = await prisma.branch.findMany({ select: { legacyId: true, name: true }, orderBy: { legacyId: 'asc' } });
  console.log('\n  ℹ Bodega principal por sede:');
  for (const b of branches) {
    const p = principales.find((x) => x.branchLegacy === b.legacyId);
    const cajeras = await prisma.user.count({ where: { isActive: true, roles: { some: { role: { key: 'area-caja' } } }, sedesAccede: { has: b.legacyId! } } });
    console.log(`    ${p ? '✓' : '✗'} ${b.name.padEnd(15)} ${(p?.title ?? '— sin bodega principal').padEnd(26)} ${cajeras} cajera(s) con la sede marcada`);
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
