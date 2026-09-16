/**
 * Migración puntual: sección de mensajes masivos (2026-09-14).
 * Idempotente — seguro de correr varias veces.
 *
 *  - Da de alta `screen.whatsapp.masivo` (la pantalla nueva `/whatsapp/masivo`).
 *  - Se la concede a los roles que YA pueden lanzar campañas, o sea los que tienen
 *    `system.whatsapp` — que es lo que exige la API —, más el superusuario. Dar la
 *    pantalla a quien no tiene el permiso de la API le enseñaría un menú que
 *    responde 403.
 *
 * Igual que `migrate-whatsapp-bandeja-2026-07.ts`: solo AÑADE, no pasa por
 * `migrate-roles-2026-06.ts`, que resincroniza todos los roles y revertiría
 * concesiones hechas a mano.
 *
 * Correr:  npx ts-node prisma/migrate-whatsapp-masivo-2026-09.ts
 */
import { PrismaClient } from '@prisma/client';
import { APP_PERMISSIONS, screenKey } from '../src/auth/permissions.catalog';

const prisma = new PrismaClient();

async function main() {
  const perm = await prisma.permission.upsert({
    where: { key: screenKey('/whatsapp/masivo') },
    update: { label: 'Mensajes masivos (campañas)' },
    create: { key: screenKey('/whatsapp/masivo'), label: 'Mensajes masivos (campañas)' },
  });
  console.log(`✓ permiso ${perm.key}`);

  const roles = await prisma.role.findMany({
    where: {
      OR: [
        { key: 'super-admin' },
        { permissions: { some: { permission: { key: APP_PERMISSIONS.WHATSAPP_MANAGE } } } },
      ],
    },
    select: { id: true, key: true },
  });

  for (const role of roles) {
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: role.id, permissionId: perm.id } },
      update: {},
      create: { roleId: role.id, permissionId: perm.id },
    });
    console.log(`✓ ${role.key} ve Mensajes masivos`);
  }

  console.log('\n✅ Sección de mensajes masivos habilitada.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
