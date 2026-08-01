/**
 * "Mi agenda" como pantalla propia del técnico (2026-07-31). Idempotente.
 *
 * La agenda del técnico salió de dentro de "Mis órdenes de trabajo" a su propia ruta
 * `/mi-agenda`, primera hoja de PRINCIPAL — y por tanto su landing al entrar
 * (`firstAccessibleHref` toma la primera hoja visible, y el middleware manda al área
 * técnica ahí). Este script le concede la llave de pantalla.
 *
 * Es la cara del técnico de `/soporte/agenda`: allá la cajera reparte, aquí él ve lo
 * que le tocó y en qué orden. Por eso NO se le da a caja ni a administración — ellas
 * no tienen agenda propia, tienen el tablero.
 *
 * Correr:  npx ts-node prisma/migrate-mi-agenda-tecnico-2026-07.ts
 */
import { PrismaClient } from '@prisma/client';
import { ALL_PERMISSIONS, SCREENS, screenKey } from '../src/auth/permissions.catalog';

const prisma = new PrismaClient();

const PANTALLA = '/mi-agenda';
const ROL = 'area-tecnicos';

async function main() {
  const s = SCREENS.find((x) => x.href === PANTALLA);
  if (!s?.areas.includes('tecnicos')) {
    console.error('✗ El catálogo (SCREENS) no concuerda: /mi-agenda debe ser del área técnica.');
    process.exitCode = 1;
    return;
  }

  for (const p of ALL_PERMISSIONS) {
    await prisma.permission.upsert({ where: { key: p.key }, update: { label: p.label }, create: { key: p.key, label: p.label } });
  }

  const llave = screenKey(PANTALLA);
  const permiso = await prisma.permission.findUnique({ where: { key: llave }, select: { id: true } });
  const rol = await prisma.role.findUnique({ where: { key: ROL }, select: { id: true, name: true } });
  if (!permiso || !rol) { console.error('✗ Falta el permiso o el rol.'); process.exitCode = 1; return; }

  const ya = await prisma.rolePermission.findFirst({ where: { roleId: rol.id, permissionId: permiso.id } });
  if (ya) console.log(`  + ${rol.name.padEnd(12)} ${llave} ya la tenía`);
  else {
    await prisma.rolePermission.create({ data: { roleId: rol.id, permissionId: permiso.id } });
    console.log(`  + ${rol.name.padEnd(12)} ${llave} CONCEDIDA`);
  }

  const pantallas = await prisma.rolePermission.findMany({
    where: { roleId: rol.id, permission: { key: { startsWith: 'screen.' } } },
    select: { permission: { select: { key: true, label: true } } },
    orderBy: { permission: { key: 'asc' } },
  });
  console.log(`\n✓ Pantallas de "${rol.name}" (${pantallas.length}) — la primera de PRINCIPAL es su landing:`);
  for (const p of pantallas) console.log(`    · ${p.permission.key.padEnd(30)} ${p.permission.label}`);

  const agendadas = await prisma.ticket.count({ where: { scheduledFor: { not: null } } });
  console.log(`\n  ℹ ${agendadas} orden(es) agendada(s) en total.`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
