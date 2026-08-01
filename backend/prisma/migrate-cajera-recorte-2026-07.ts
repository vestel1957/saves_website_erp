/**
 * Recorte del perfil de cajera (2026-07-29). Idempotente.
 *
 * Se le quitan cuatro pantallas por decisión de negocio:
 *   · /tesoreria                  Movimientos (vista transversal de todas las cajas)
 *   · /tesoreria/importar-pagos   Cargue masivo de Efecty
 *   · /facturacion                Administrar facturas
 *   · /facturacion/notas          Notas crédito/débito
 *
 * Quitarlas del catálogo (`SCREENS`) no basta: la concesión vive en la BD
 * (`RolePermission`), así que quien ya tenía el rol seguiría con el permiso en su
 * token. Este script revoca la concesión del ROL y avisa de los overrides por
 * usuario, que NO toca: un permiso dado a mano a una persona concreta es una
 * decisión de alguien, no un residuo de la plantilla.
 *
 * La cajera sigue llegando al DETALLE de una factura (`/facturacion/[id]`) desde la
 * ficha del cliente y desde su arqueo: eso no es una pantalla del menú y se gatea
 * por área, no por llave de pantalla.
 *
 * Correr:  npx ts-node prisma/migrate-cajera-recorte-2026-07.ts
 */
import { PrismaClient } from '@prisma/client';
import { SCREENS, screenKey } from '../src/auth/permissions.catalog';

const prisma = new PrismaClient();

const ROL = 'area-caja';
const QUITAR = ['/tesoreria', '/tesoreria/importar-pagos', '/facturacion', '/facturacion/notas'];

async function main() {
  // Guarda: si el catálogo todavía declara alguna de estas pantallas para 'caja',
  // revocarla aquí la repondría el próximo seed. Mejor fallar ruidosamente.
  const incoherentes = SCREENS.filter((s) => QUITAR.includes(s.href) && s.areas.includes('caja'));
  if (incoherentes.length) {
    console.error(`✗ El catálogo aún da a 'caja': ${incoherentes.map((s) => s.href).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const rol = await prisma.role.findUnique({ where: { key: ROL }, select: { id: true, name: true } });
  if (!rol) {
    console.error(`✗ No existe el rol "${ROL}".`);
    process.exitCode = 1;
    return;
  }

  for (const href of QUITAR) {
    const key = screenKey(href);
    const permiso = await prisma.permission.findUnique({ where: { key }, select: { id: true } });
    if (!permiso) { console.log(`  · ${key.padEnd(34)} no existe en la BD (nada que revocar)`); continue; }

    const borradas = await prisma.rolePermission.deleteMany({ where: { roleId: rol.id, permissionId: permiso.id } });
    console.log(`  · ${key.padEnd(34)} ${borradas.count ? 'REVOCADA del rol' : 'el rol no la tenía'}`);

    // Overrides por usuario: se reportan, no se tocan.
    const overrides = await prisma.userPermission.findMany({
      where: { permissionId: permiso.id },
      select: { user: { select: { email: true, name: true } }, effect: true },
    });
    for (const o of overrides) {
      console.log(`      ⚠ override por usuario: ${o.user.name} <${o.user.email}> (${o.effect}) — sin tocar`);
    }
  }

  // Qué le queda a la cajera, para verificarlo sin adivinar.
  const restantes = await prisma.rolePermission.findMany({
    where: { roleId: rol.id, permission: { key: { startsWith: 'screen.' } } },
    select: { permission: { select: { key: true, label: true } } },
    orderBy: { permission: { key: 'asc' } },
  });
  console.log(`\n✓ Pantallas que le quedan a "${rol.name}" (${restantes.length}):`);
  for (const r of restantes) console.log(`    · ${r.permission.key.padEnd(34)} ${r.permission.label}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
