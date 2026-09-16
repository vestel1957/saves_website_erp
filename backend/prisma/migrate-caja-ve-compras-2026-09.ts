/**
 * La CAJERA ve las órdenes de compra para subirles el papel (2026-09-08).
 *
 * Compras salió del perfil de caja en 2026-07-29 ("quien recauda no ordena compras")
 * y con ello se fue también lo único que sí es de ventanilla: PONER EL PAPEL. La
 * factura del proveedor y el comprobante del pago los tiene en la mano la cajera, y
 * hasta ahora tenía que pasárselos a alguien de administración para que los subiera.
 *
 * Esto le abre las dos pantallas de compras (Órdenes de compra y su Historial). Lo
 * que puede hacer dentro lo decide la API, que le sigue exigiendo `administracion`
 * para crear, editar, aprobar, cancelar, finalizar, recibir, pagar, notas y borrar:
 * de `caja` sólo aceptan leer, el PDF, el Excel y los ADJUNTOS (subir y descargar).
 * Por eso aquí no hay ningún permiso de escritura que conceder.
 *
 * Se derivan los roles del estado REAL de la base (todo rol que tenga `area.caja`),
 * no del catálogo, porque hay roles hechos a mano desde el constructor de roles. Y
 * se toca sólo estas dos pantallas, para no pisar de rebote permisos ajustados a mano.
 *
 * Idempotente. Correr:
 *   npx ts-node prisma/migrate-caja-ve-compras-2026-09.ts [--dry-run]
 */
import { PrismaClient } from '@prisma/client';
import { APP_PERMISSIONS, ALL_PERMISSIONS, SCREENS, screenKey } from '../src/auth/permissions.catalog';

const prisma = new PrismaClient();

/** Las dos pantallas de compras que se le abren. */
const HREFS = ['/ordenes', '/ordenes/historial'];

const soloSimular = process.argv.includes('--dry-run');

/** Alta del permiso en el catálogo de la BD (el gate compara contra estas filas). */
async function alta(key: string) {
  const def = ALL_PERMISSIONS.find((p) => p.key === key);
  const label = def?.label ?? key;
  if (soloSimular) return prisma.permission.findUnique({ where: { key } });
  return prisma.permission.upsert({ where: { key }, update: { label }, create: { key, label } });
}

async function main() {
  for (const href of HREFS) {
    if (!SCREENS.some((s) => s.href === href)) throw new Error(`${href} no está en SCREENS: revisa permissions.catalog.ts`);
  }

  const roles = await prisma.role.findMany({
    where: { permissions: { some: { permission: { key: APP_PERMISSIONS.AREA_CAJA } } } },
    select: { id: true, key: true, permissions: { select: { permission: { select: { key: true } } } } },
  });
  console.log(`roles con ${APP_PERMISSIONS.AREA_CAJA}: ${roles.length}${roles.length ? ` (${roles.map((r) => r.key).join(', ')})` : ''}`);

  let concedidos = 0, yaTenian = 0;
  for (const href of HREFS) {
    const key = screenKey(href);
    const permiso = await alta(key);
    console.log(`\n  pantalla: ${key}`);
    for (const rol of roles) {
      if (rol.permissions.some((rp) => rp.permission.key === key)) { yaTenian++; continue; }
      console.log(`  + ${rol.key.padEnd(28)} ${key}`);
      if (!soloSimular && permiso) {
        await prisma.rolePermission.upsert({
          where: { roleId_permissionId: { roleId: rol.id, permissionId: permiso.id } },
          update: {},
          create: { roleId: rol.id, permissionId: permiso.id },
        });
      }
      concedidos++;
    }
  }

  console.log(`\n${soloSimular ? '[simulación] ' : ''}concesiones: ${concedidos} nuevas · ${yaTenian} ya estaban`);
  if (soloSimular) console.log('Vuelve a ejecutarlo sin --dry-run para aplicarlo.');
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
