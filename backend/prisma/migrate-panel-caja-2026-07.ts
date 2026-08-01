/**
 * El panel de caja para las cajeras (2026-07-29).
 * Idempotente — seguro de correr varias veces.
 *
 * `/dashboard` dejó de ser sólo el panel ejecutivo: quien tiene `area.caja` ve ahí el
 * informe del recaudo del día de SU caja. Pero el permiso de esa pantalla
 * (`screen.dashboard`) vive en la tabla `Permission` y se concede vía `RolePermission`,
 * así que sin este script el rol "Caja y ventas" no lo tiene: el ítem del menú le queda
 * invisible y `/` no la aterriza ahí.
 *
 * Qué hace:
 *  1. Da de alta (o actualiza la etiqueta de) todos los permisos del catálogo.
 *  2. Concede `screen.dashboard` al rol `area-caja`.
 *  3. Reporta a quién le queda, para poder verificarlo sin adivinar.
 *
 * Lo que NO hace: tocar los overrides por usuario, ni el endpoint `/dashboard` del
 * backend (sigue siendo de gerencia — la cajera se sirve de los de tesorería, que ya
 * están acotados a su caja por `caja-scope`).
 *
 * Correr:  npx ts-node prisma/migrate-panel-caja-2026-07.ts
 */
import { PrismaClient } from '@prisma/client';
import { ALL_PERMISSIONS, screenKey } from '../src/auth/permissions.catalog';

const prisma = new PrismaClient();

const ROL_CAJA = 'area-caja';
const LLAVE = screenKey('/dashboard');

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

  // 2. La pantalla del panel al rol de caja.
  const rol = await prisma.role.findUnique({ where: { key: ROL_CAJA }, select: { id: true, name: true } });
  if (!rol) {
    console.error(`✗ No existe el rol "${ROL_CAJA}". Corre antes prisma/migrate-roles-2026-06.ts`);
    process.exitCode = 1;
    return;
  }

  const permiso = await prisma.permission.findUnique({ where: { key: LLAVE }, select: { id: true } });
  if (!permiso) {
    console.error(`✗ No existe el permiso "${LLAVE}" ni siquiera tras sembrar el catálogo.`);
    process.exitCode = 1;
    return;
  }

  const ya = await prisma.rolePermission.findFirst({ where: { roleId: rol.id, permissionId: permiso.id } });
  if (ya) {
    console.log(`✓ "${rol.name}" ya tenía ${LLAVE}`);
  } else {
    await prisma.rolePermission.create({ data: { roleId: rol.id, permissionId: permiso.id } });
    console.log(`✓ ${LLAVE} concedido a "${rol.name}"`);
  }

  // 3. Quién queda viendo el panel de caja. Sin esto la migración es un acto de fe.
  const usuarios = await prisma.user.findMany({
    where: { roles: { some: { role: { key: ROL_CAJA } } }, isActive: true },
    select: { email: true, name: true, cajaLegacyId: true },
  });
  console.log(`✓ ${usuarios.length} usuarios activos con el rol de caja:`);
  for (const u of usuarios) {
    console.log(`    · ${u.name} <${u.email}>${u.cajaLegacyId == null ? '  ⚠ sin caja asignada' : `  (caja ${u.cajaLegacyId})`}`);
  }
  if (!usuarios.length) {
    console.log('  ⚠ Nadie tiene el rol de caja: el panel sólo lo verá el superadministrador.');
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
