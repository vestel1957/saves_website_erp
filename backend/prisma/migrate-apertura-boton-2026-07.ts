/**
 * La apertura de caja deja de ser una pantalla (2026-07-29).
 * Idempotente — seguro de correr varias veces.
 *
 * `/tesoreria/apertura` se retiró: abrir la caja es ahora un botón en el panel de la
 * cajera, y la base ya no la teclea quien abre — la fija administración por caja
 * (`CashAccount.fixedFund`, en Cajas y categorías). Con la pantalla fuera del catálogo,
 * su llave `screen.tesoreria.apertura` queda huérfana en la base: nadie la comprueba,
 * pero sigue saliendo en el árbol de permisos por empleado como una pantalla que ya no
 * existe.
 *
 * Qué hace:
 *  1. Da de alta (o actualiza la etiqueta de) todos los permisos del catálogo.
 *  2. Borra la llave de la pantalla retirada, con sus concesiones por rol y sus
 *     ajustes por empleado (el borrado en cascada los arrastra).
 *
 * Lo que NO hace: tocar la tabla `CashOpen`. Las aperturas ya registradas son historia
 * contable y se quedan donde están.
 *
 * Correr:  npx ts-node prisma/migrate-apertura-boton-2026-07.ts
 */
import { PrismaClient } from '@prisma/client';
import { ALL_PERMISSIONS } from '../src/auth/permissions.catalog';

const prisma = new PrismaClient();

const RETIRADA = 'screen.tesoreria.apertura';

async function main() {
  // 1. Catálogo al día (altas de pantallas nuevas y etiquetas).
  for (const p of ALL_PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key: p.key },
      update: { label: p.label },
      create: { key: p.key, label: p.label },
    });
  }
  console.log(`✓ ${ALL_PERMISSIONS.length} permisos del catálogo al día`);

  // 2. Fuera la llave de la pantalla retirada.
  const permiso = await prisma.permission.findUnique({ where: { key: RETIRADA }, select: { id: true } });
  if (!permiso) {
    console.log(`✓ ${RETIRADA} no existe: nada que borrar`);
    return;
  }
  const [roles, usuarios] = await Promise.all([
    prisma.rolePermission.count({ where: { permissionId: permiso.id } }),
    prisma.userPermission.count({ where: { permissionId: permiso.id } }),
  ]);
  await prisma.permission.delete({ where: { id: permiso.id } });
  console.log(`✓ ${RETIRADA} borrado (${roles} concesiones por rol, ${usuarios} ajustes por empleado)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
