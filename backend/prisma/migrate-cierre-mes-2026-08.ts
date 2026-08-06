/**
 * Alta del permiso de pantalla del CIERRE DE MES (2026-08-04). Idempotente.
 *
 * Una pantalla nueva del sidebar no basta con declararla en el catálogo: el gate de
 * pantalla (`PantallaGate` + `AreaGuard`) pregunta por un permiso que tiene que EXISTIR
 * en la BD y estar colgado de los roles. Sin esto, la ruta queda en el menú de nadie y
 * quien la abre a mano ve "Esta pantalla no es de tu perfil".
 *
 * Se toca sólo lo de esta pantalla, y no se sincroniza el catálogo entero, para no
 * pisar de rebote los permisos que se hayan ajustado a mano en Usuarios y roles.
 *
 * Correr:  npx ts-node prisma/migrate-cierre-mes-2026-08.ts
 */
import { PrismaClient } from '@prisma/client';
import { ALL_ROLES, SCREENS, screenKey } from '../src/auth/permissions.catalog';

const prisma = new PrismaClient();
const HREF = '/contabilidad/cierres';

async function main() {
  const pantalla = SCREENS.find((s) => s.href === HREF);
  if (!pantalla) throw new Error(`${HREF} no está en SCREENS: revisa permissions.catalog.ts`);
  const key = screenKey(HREF);

  const permiso = await prisma.permission.upsert({
    where: { key },
    update: { label: pantalla.label },
    create: { key, label: pantalla.label },
  });
  console.log(`✓ permiso ${key}`);

  // Los roles que el catálogo dice que deben tenerla (por área).
  const claves = ALL_ROLES.filter((r) => r.permissions.includes(key)).map((r) => r.key);
  const roles = await prisma.role.findMany({ where: { key: { in: claves } }, select: { id: true, key: true } });
  for (const rol of roles) {
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: rol.id, permissionId: permiso.id } },
      update: {},
      create: { roleId: rol.id, permissionId: permiso.id },
    });
  }
  console.log(`✓ asignado a ${roles.length} rol(es): ${roles.map((r) => r.key).join(', ')}`);

  const faltan = claves.filter((k) => !roles.some((r) => r.key === k));
  if (faltan.length) console.log(`⚠ roles del catálogo que no existen en la BD: ${faltan.join(', ')}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
