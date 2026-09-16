/**
 * Emitir notas crédito/débito pasa a ser NOMINAL (2026-09-10).
 *
 * Hasta hoy podía emitirlas el área de contabilidad entera y, por el atajo de
 * `system.admin`, los trece superusuarios activos. Una nota crédito le rebaja al
 * abonado lo que debe sin que entre un peso —y la débito se lo sube—, así que por
 * decisión de negocio la firman dos personas y nadie más.
 *
 * Qué hace, en orden:
 *   1. Da de alta el permiso `billing.notes.emit` en el catálogo de la BD.
 *   2. Lo concede como override ALLOW a los dos autorizados (por CORREO, que es la
 *      llave estable; el nombre se escribe de mil maneras).
 *   3. Lo RETIRA de cualquier rol que lo tuviera. No debería tenerlo ninguno —el
 *      catálogo lo deja fuera del rol `super-admin` a propósito—, pero si una
 *      re-siembra vieja lo hubiera repartido, dejarlo ahí abriría el candado sin
 *      que nadie lo pidiera.
 *
 * Lo que NO toca: las notas que genera el SISTEMA solo (descuento de pronto pago
 * del portal, reversa de un descuento vencido, aplicación de un anticipo). Ésas
 * pasan por `aplicarNotaEnTx` sin persona detrás y siguen igual.
 *
 * Idempotente. Correr:
 *   npx ts-node prisma/migrate-notas-emisor-2026-09.ts [--dry-run]
 */
import { PrismaClient } from '@prisma/client';
import { APP_PERMISSIONS, ALL_PERMISSIONS } from '../src/auth/permissions.catalog';

const prisma = new PrismaClient();
const PERMISO = APP_PERMISSIONS.BILLING_NOTES_EMIT;

/** Los autorizados, por correo (la llave estable de la cuenta). */
const AUTORIZADOS = [
  { email: 'johanamancipediaz@gmail.com', quien: 'Johana Mancipe Diaz' },
  { email: 'luisfernandohurtadoc@gmail.com', quien: 'Luis Fernando Hurtado' },
];

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
    console.log(`  + ${marca}${user.name} <${user.email}> puede emitir notas crédito/débito`);
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
    console.log(`\nEmiten notas crédito/débito (${conPermiso.length}):`);
    for (const c of conPermiso) {
      console.log(`  · ${c.user.name} <${c.user.email}>${c.user.isActive ? '' : ' (INACTIVO)'}`);
    }
  }

  if (soloSimular) console.log('\nVuelve a ejecutarlo sin --dry-run para aplicarlo.');
  else console.log('\nQuien no salga en esa lista recibe un 403 al intentar emitir, superusuario incluido.');
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
