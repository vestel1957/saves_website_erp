/**
 * El interruptor manual de MOROSOS es NOMINAL (2026-09-10).
 *
 * Se pidió recuperar el botón «Activar / Desactivar» de la ficha del legacy —el que
 * sólo mete o saca la IP del abonado de la address-list MOROSOS— y que lo tuviera
 * **una sola persona**: Santiago García. Un permiso normal no puede significar eso:
 * `exigirPermisos` deja pasar a `system.admin` y hay veinte superusuarios activos, así
 * que la comprobación se hace mirando el permiso TAL CUAL (ver `PERMISOS_NOMINALES`,
 * `MikrotikService.toggleMoroso` y `puedeMoverMorosos()` en el frontend).
 *
 * Qué hace, en orden:
 *   1. Da de alta `network.morosos.toggle` en el catálogo de la BD.
 *   2. Lo concede como override ALLOW al autorizado (por CORREO, que es la llave
 *      estable de la cuenta; el nombre se escribe de mil maneras).
 *   3. Lo RETIRA de cualquier rol que lo tuviera. No debería tenerlo ninguno —el
 *      catálogo lo deja fuera del rol `super-admin` a propósito—, pero una re-siembra
 *      vieja abriría el candado sin que nadie lo pidiera.
 *
 * Lo que NO toca: `network.cut` / `network.reconnect`. El corte y la reconexión de
 * verdad —los que además tumban la sesión, mueven el estado de la ficha y abren orden—
 * siguen exactamente donde estaban y para quien estaban.
 *
 * Idempotente. Correr:
 *   npx ts-node prisma/migrate-interruptor-morosos-2026-09.ts [--dry-run]
 */
import { PrismaClient } from '@prisma/client';
import { APP_PERMISSIONS, ALL_PERMISSIONS } from '../src/auth/permissions.catalog';

const prisma = new PrismaClient();
const PERMISO = APP_PERMISSIONS.NETWORK_MOROSOS_TOGGLE;

/** Los autorizados, por correo (la llave estable de la cuenta). */
const AUTORIZADOS = [{ email: 's4gk.23@gmail.com', quien: 'Santiago García' }];

async function main() {
  const soloSimular = process.argv.includes('--dry-run');
  const marca = soloSimular ? '[simulación] ' : '';

  // 1. El permiso en el catálogo de la BD.
  const def = ALL_PERMISSIONS.find((p) => p.key === PERMISO);
  if (!def) throw new Error(`El permiso ${PERMISO} no está en el catálogo del código.`);
  if (!soloSimular) {
    await prisma.permission.upsert({
      where: { key: def.key },
      update: { label: def.label },
      create: { key: def.key, label: def.label },
    });
  }
  console.log(`${marca}permiso: ${def.key} — ${def.label}`);

  const fila = await prisma.permission.findUnique({ where: { key: PERMISO } });
  if (!fila) {
    if (!soloSimular) throw new Error('No se pudo crear el permiso.');
    console.log('[simulación] el permiso aún no existe en la BD; se listan igual los efectos.');
  }

  // 2. Concesión persona a persona.
  for (const { email, quien } of AUTORIZADOS) {
    const user = await prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }],
      select: { id: true, name: true, email: true, isActive: true },
    });
    if (!user) {
      console.log(`  ! ${quien} <${email}>: NO existe esa cuenta — nadie quedó autorizado por esta línea`);
      continue;
    }
    if (!user.isActive) console.log(`  ! ojo: la cuenta de ${user.name} está INACTIVA (no podrá entrar)`);

    if (fila) {
      const yaEsta = await prisma.userPermission.findUnique({
        where: { userId_permissionId: { userId: user.id, permissionId: fila.id } },
      });
      if (yaEsta?.effect === 'ALLOW') {
        console.log(`  = ${user.name} <${user.email}> ya lo tenía`);
        continue;
      }
      if (!soloSimular) {
        await prisma.userPermission.upsert({
          where: { userId_permissionId: { userId: user.id, permissionId: fila.id } },
          update: { effect: 'ALLOW' },
          create: { userId: user.id, permissionId: fila.id, effect: 'ALLOW' },
        });
      }
    }
    console.log(`  + ${marca}${user.name} <${user.email}> puede activar/desactivar la IP en MOROSOS`);
  }

  // 3. Ningún ROL lo reparte: si lo tuviera, no sería nominal.
  if (fila) {
    const roles = await prisma.rolePermission.findMany({
      where: { permissionId: fila.id },
      select: { roleId: true, role: { select: { key: true } } },
    });
    for (const r of roles) {
      console.log(`  - ${marca}rol ${r.role.key}: se le retira ${PERMISO} (un permiso nominal no va en roles)`);
      if (!soloSimular) {
        await prisma.rolePermission.delete({
          where: { roleId_permissionId: { roleId: r.roleId, permissionId: fila.id } },
        });
      }
    }
    if (!roles.length) console.log('  · ningún rol lo reparte (correcto)');
  }

  // Foto de quién queda pudiendo, para poder pegarla en el acta del cambio.
  if (fila) {
    const conPermiso = await prisma.userPermission.findMany({
      where: { permissionId: fila.id, effect: 'ALLOW' },
      select: { user: { select: { name: true, email: true, isActive: true } } },
    });
    console.log(`\nMueven la IP entre ACTIVOS y MOROSOS a mano (${conPermiso.length}):`);
    for (const c of conPermiso) {
      console.log(`  · ${c.user.name} <${c.user.email}>${c.user.isActive ? '' : ' (INACTIVO)'}`);
    }
  }

  if (soloSimular) console.log('\nVuelve a ejecutarlo sin --dry-run para aplicarlo.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
