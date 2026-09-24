/**
 * Alta de la pantalla /reportes/cartera-seguimiento (seguimiento mensual de cartera, 2026-09-23). Idempotente.
 *
 * Siembra el catálogo de permisos y concede su `screen.*` a los roles de las
 * áreas que declara SCREENS (gerencia). Sin esto la entrada del menú
 * sólo la ve el superusuario (ver la nota «pantallas sin llave»).
 *
 * Correr:  npx ts-node --transpile-only prisma/migrate-pantalla-cartera-seguimiento-2026-09.ts
 */
import { PrismaClient } from '@prisma/client';
import { ALL_PERMISSIONS, SCREENS, screenKey } from '../src/auth/permissions.catalog';

const prisma = new PrismaClient();
const HREF = '/reportes/cartera-seguimiento';
const ROL_DE_AREA: Record<string, string> = {
  gerencia: 'area-gerencia',
  administracion: 'area-administracion',
  contabilidad: 'area-contabilidad',
  tecnicos: 'area-tecnicos',
  sistemas: 'area-sistemas',
  caja: 'area-caja',
};

async function main() {
  for (const p of ALL_PERMISSIONS) {
    await prisma.permission.upsert({ where: { key: p.key }, update: { label: p.label }, create: { key: p.key, label: p.label } });
  }
  const def = SCREENS.find((s) => s.href === HREF);
  if (!def) throw new Error(`${HREF} no está en SCREENS`);
  const permiso = await prisma.permission.findUniqueOrThrow({ where: { key: screenKey(HREF) }, select: { id: true } });
  for (const area of def.areas) {
    const rol = await prisma.role.findUnique({ where: { key: ROL_DE_AREA[area] }, select: { id: true, name: true } });
    if (!rol) { console.log(`· sin rol para ${area}`); continue; }
    const ya = await prisma.rolePermission.findFirst({ where: { roleId: rol.id, permissionId: permiso.id } });
    if (!ya) await prisma.rolePermission.create({ data: { roleId: rol.id, permissionId: permiso.id } });
    console.log(`${ya ? '·' : '✓'} ${screenKey(HREF)} → ${rol.name}`);
  }
}

main().finally(() => prisma.$disconnect());
