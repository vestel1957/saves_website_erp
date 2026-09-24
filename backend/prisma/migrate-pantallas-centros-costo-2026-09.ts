/**
 * Alta de las pantallas de contabilidad por sede (docs/centros-de-costo/PLAN.md, fase 5,
 * 2026-09-24). Idempotente.
 *
 *   /contabilidad/resultados-por-sede  — estado de resultados por centro de costo
 *   /contabilidad/centros-de-costo     — lista, alta y edición de los centros
 *
 * Siembra SÓLO sus dos llaves `screen.*` y las concede a los roles de las áreas que
 * declara SCREENS (contabilidad, administración y gerencia). Sin esto la entrada del
 * menú sólo la ve el superusuario (ver la nota «pantallas sin llave»). No toca ninguna
 * otra llave ni ningún otro rol.
 *
 * Correr:  npx ts-node --transpile-only prisma/migrate-pantallas-centros-costo-2026-09.ts
 */
import { PrismaClient } from '@prisma/client';
import { SCREENS, screenKey } from '../src/auth/permissions.catalog';

const prisma = new PrismaClient();
const HREFS = ['/contabilidad/resultados-por-sede', '/contabilidad/centros-de-costo'];
const ROL_DE_AREA: Record<string, string> = {
  gerencia: 'area-gerencia',
  administracion: 'area-administracion',
  contabilidad: 'area-contabilidad',
  tecnicos: 'area-tecnicos',
  sistemas: 'area-sistemas',
  caja: 'area-caja',
};

async function main() {
  for (const href of HREFS) {
    const def = SCREENS.find((s) => s.href === href);
    if (!def) throw new Error(`${href} no está en SCREENS`);
    const key = screenKey(href);
    const permiso = await prisma.permission.upsert({
      where: { key },
      update: { label: def.label },
      create: { key, label: def.label },
      select: { id: true },
    });
    for (const area of def.areas) {
      const rol = await prisma.role.findUnique({ where: { key: ROL_DE_AREA[area] }, select: { id: true, name: true } });
      if (!rol) { console.log(`· sin rol para ${area}`); continue; }
      const ya = await prisma.rolePermission.findFirst({ where: { roleId: rol.id, permissionId: permiso.id } });
      if (!ya) await prisma.rolePermission.create({ data: { roleId: rol.id, permissionId: permiso.id } });
      console.log(`${ya ? '·' : '✓'} ${key} → ${rol.name}`);
    }
  }
}

main().finally(() => prisma.$disconnect());
