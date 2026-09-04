/**
 * Facturación de ventanilla para la cajera (2026-08-27). Idempotente.
 *
 * Le faltaba lo más elemental de su trabajo: emitir una factura. Cobrar en
 * ventanilla algo que todavía no está facturado —una instalación, un traslado, una
 * reconexión, la venta de un equipo— la obligaba a pedirle la factura a
 * contabilidad con el cliente esperando en el mostrador.
 *
 * Se le concede la pantalla `/facturacion` (Administrar facturas). Lo que ve NO es
 * lo mismo que ve contabilidad:
 *   · el listado ya venía acotado a SU sede (`whereSedePorSuscriptor`);
 *   · "Generar facturas del mes", anular y la factura electrónica siguen gateados
 *     por `AREA_CONTABILIDAD` dentro de la propia pantalla;
 *   · las notas crédito/débito siguen fuera de su menú.
 *
 * La escritura que se abrió en el backend es SÓLO `POST /billing/invoices`, y allí
 * `createInvoice` exige que el cliente sea de su sede.
 *
 * Ni conceder ni revocar se puede hacer sólo en el catálogo (`SCREENS`): la
 * concesión vive en `RolePermission`. Los overrides por usuario se reportan y NO se
 * tocan.
 *
 * Correr:  npx ts-node prisma/migrate-cajera-facturacion-2026-08.ts
 */
import { PrismaClient } from '@prisma/client';
import { ALL_PERMISSIONS, SCREENS, screenKey } from '../src/auth/permissions.catalog';

const prisma = new PrismaClient();

const ROL = 'area-caja';
const DAR = ['/facturacion'];
/** Lo que NO se le da, para dejarlo escrito y que no se cuele por descuido. */
const FUERA = ['/facturacion/notas', '/facturacion/electronica', '/facturacion/recurrente'];

async function main() {
  // Coherencia con el catálogo: si no coincide, el próximo seed desharía esto.
  const malQuitadas = SCREENS.filter((s) => DAR.includes(s.href) && !s.areas.includes('caja'));
  const malDadas = SCREENS.filter((s) => FUERA.includes(s.href) && s.areas.includes('caja'));
  if (malQuitadas.length || malDadas.length) {
    console.error('✗ El catálogo no concuerda con este script. Revisa SCREENS.');
    process.exitCode = 1;
    return;
  }

  for (const p of ALL_PERMISSIONS) {
    await prisma.permission.upsert({ where: { key: p.key }, update: { label: p.label }, create: { key: p.key, label: p.label } });
  }

  const rol = await prisma.role.findUnique({ where: { key: ROL }, select: { id: true, name: true } });
  if (!rol) { console.error(`✗ No existe el rol "${ROL}".`); process.exitCode = 1; return; }

  for (const href of DAR) {
    const key = screenKey(href);
    const permiso = await prisma.permission.findUnique({ where: { key }, select: { id: true } });
    if (!permiso) { console.error(`  + ${key} no se creó`); continue; }
    const ya = await prisma.rolePermission.findFirst({ where: { roleId: rol.id, permissionId: permiso.id } });
    if (ya) { console.log(`  + ${key.padEnd(30)} ya la tenía`); continue; }
    await prisma.rolePermission.create({ data: { roleId: rol.id, permissionId: permiso.id } });
    console.log(`  + ${key.padEnd(30)} CONCEDIDA`);
    const overrides = await prisma.userPermission.findMany({
      where: { permissionId: permiso.id },
      select: { effect: true, user: { select: { name: true, email: true } } },
    });
    for (const o of overrides) console.log(`      ⚠ override por usuario: ${o.user.name} <${o.user.email}> (${o.effect}) — sin tocar`);
  }

  const restantes = await prisma.rolePermission.findMany({
    where: { roleId: rol.id, permission: { key: { startsWith: 'screen.' } } },
    select: { permission: { select: { key: true, label: true } } },
    orderBy: { permission: { key: 'asc' } },
  });
  console.log(`\n✓ Pantallas de "${rol.name}" (${restantes.length}):`);
  for (const r of restantes) console.log(`    · ${r.permission.key.padEnd(32)} ${r.permission.label}`);

  const cajeras = await prisma.user.count({ where: { isActive: true, roles: { some: { role: { key: ROL } } } } });
  console.log(`\n  ℹ ${cajeras} usuario(s) activo(s) con el rol "${rol.name}".`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
