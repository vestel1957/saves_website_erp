/**
 * Actas de traspaso: la pantalla donde se FIRMA el recibido (2026-08-29). Idempotente.
 *
 * `/inventario/actas` llevaba tiempo en el menú pero NO estaba en el catálogo
 * (`SCREENS`), así que no existía ni la llave de permiso: la veía únicamente el
 * superusuario. Consecuencia real: a un técnico se le entregaba material, el acta
 * quedaba EN TRÁNSITO y él no tenía ninguna pantalla donde recibirla — ni acreditaba
 * su stock ni cerraba el acta. La API siempre la aceptó (áreas `TRASPASOS`:
 * administración, técnicos y caja); lo que faltaba era la llave y el gate del front.
 *
 * Se concede a los tres roles de área. Cada quien ve lo suyo: al técnico de campo el
 * backend le devuelve sólo las actas de su almacén (`InventoryService.actas`).
 *
 * Correr:  npx ts-node prisma/migrate-actas-tecnico-2026-08.ts
 */
import { PrismaClient } from '@prisma/client';
import { ALL_PERMISSIONS, SCREENS, screenKey } from '../src/auth/permissions.catalog';

const prisma = new PrismaClient();

const HREF = '/inventario/actas';
const ROLES = ['area-administracion', 'area-tecnicos', 'area-caja'];

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

  // Contexto: qué hay hoy sin recibir, que es exactamente lo que esto desbloquea.
  const pendientes = await prisma.materialActa.findMany({
    where: { status: { not: 'Recibida' }, toWarehouseId: { not: null } },
    select: { toWarehouseName: true, assignedToName: true, date: true, itemsCount: true },
    orderBy: { date: 'desc' },
  });
  console.log(`\n  ℹ ${pendientes.length} acta(s) en tránsito esperando firma:`);
  for (const a of pendientes) {
    console.log(`    · ${a.date.toISOString().slice(0, 10)}  ${(a.toWarehouseName ?? '—').padEnd(28)} ${a.assignedToName ?? 'sin designado'} · ${a.itemsCount} ítem(s)`);
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
