/**
 * Pagos fijos programados (2026-07-31). Idempotente.
 *
 * Pantalla nueva `/tesoreria/pagos-fijos`: CONTABILIDAD define cada pago (qué,
 * cuánto, de qué caja, qué día del mes) y la CAJERA de esa caja registra la
 * ejecución — un egreso en efectivo que cae a su cierre del día con comprobante.
 * Este script siembra la llave de pantalla y se la concede a los roles de caja y
 * contabilidad; el DATO va acotado por caja en el backend (la cajera solo ve y
 * ejecuta los pagos de la suya).
 *
 * Correr:  npx ts-node prisma/migrate-pagos-fijos-2026-07.ts
 */
import { PrismaClient } from '@prisma/client';
import { ALL_PERMISSIONS, SCREENS, screenKey } from '../src/auth/permissions.catalog';

const prisma = new PrismaClient();

const PANTALLA = '/tesoreria/pagos-fijos';
const ROLES = ['area-caja', 'area-contabilidad'];

async function main() {
  const s = SCREENS.find((x) => x.href === PANTALLA);
  if (!s || !s.areas.includes('caja') || !s.areas.includes('contabilidad')) {
    console.error('✗ El catálogo (SCREENS) no concuerda: la pantalla debe ser de caja + contabilidad.');
    process.exitCode = 1;
    return;
  }

  for (const p of ALL_PERMISSIONS) {
    await prisma.permission.upsert({ where: { key: p.key }, update: { label: p.label }, create: { key: p.key, label: p.label } });
  }

  const llave = screenKey(PANTALLA);
  const permiso = await prisma.permission.findUnique({ where: { key: llave }, select: { id: true } });
  if (!permiso) { console.error(`✗ No se creó ${llave}.`); process.exitCode = 1; return; }

  for (const key of ROLES) {
    const rol = await prisma.role.findUnique({ where: { key }, select: { id: true, name: true } });
    if (!rol) { console.error(`✗ No existe el rol "${key}".`); process.exitCode = 1; continue; }
    const ya = await prisma.rolePermission.findFirst({ where: { roleId: rol.id, permissionId: permiso.id } });
    if (ya) { console.log(`  + ${rol.name.padEnd(20)} ${llave} ya la tenía`); continue; }
    await prisma.rolePermission.create({ data: { roleId: rol.id, permissionId: permiso.id } });
    console.log(`  + ${rol.name.padEnd(20)} ${llave} CONCEDIDA`);
  }

  const pagos = await prisma.scheduledPayment.count();
  console.log(`\n  ℹ ${pagos} pagos fijos definidos hasta ahora (la tabla arranca vacía: los crea contabilidad).`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
