/**
 * Alta de las pantallas de CAJA / TESORERÍA que faltaban en el catálogo (2026-07-29).
 * Idempotente — seguro de correr varias veces.
 *
 * Ingresos, Egresos, Nueva transacción, Transferencia entre cajas, Anulaciones y
 * Cajas y categorías llevaban tiempo en el menú (`frontend/src/lib/nav.ts`) pero NO
 * en `SCREENS`. Cada hoja del sidebar se gatea con `screen.<href>`, así que sin la
 * llave en la tabla `Permission` esas pantallas sólo las veía el superusuario: la
 * cajera —que es quien las usa todo el día— no las tenía en el menú.
 *
 * Qué hace:
 *  1. Da de alta (o actualiza la etiqueta de) todos los permisos del catálogo.
 *  2. Concede cada pantalla nueva a los roles de área que la traen por defecto,
 *     leyendo el propio catálogo (`ScreenDef.areas`) para no repetir aquí la regla.
 *  3. Reporta qué usuarios quedan viéndolas.
 *
 * Lo que NO hace: tocar los overrides por usuario (un DENY explícito se respeta), ni
 * dar a la cajera Anulaciones ni Cajas y categorías — el control de anulaciones se
 * mira desde fuera y el fondo fijo de cada caja lo pone administración.
 *
 * El acotado por sede NO depende de esto: lo impone `treasury/caja-scope.ts` sobre
 * los datos (su caja + los bancos), y ahora también sobre la escritura.
 *
 * Correr:  npx ts-node prisma/migrate-caja-tesoreria-2026-07.ts
 */
import { PrismaClient } from '@prisma/client';
import { ALL_PERMISSIONS, SCREENS, screenKey } from '../src/auth/permissions.catalog';

const prisma = new PrismaClient();

/** Las pantallas que este script da de alta (las de tesorería que faltaban). */
const NUEVAS = [
  '/tesoreria/ingresos',
  '/tesoreria/egresos',
  '/tesoreria/nueva',
  '/tesoreria/transferencia',
  '/tesoreria/anulaciones',
  '/tesoreria/cajas',
];

/** slug de área → clave del rol que la encarna. */
const ROL_DE_AREA: Record<string, string> = {
  caja: 'area-caja',
  contabilidad: 'area-contabilidad',
  administracion: 'area-administracion',
};

async function main() {
  // 1. Catálogo completo de permisos (alta/actualización de etiqueta).
  for (const p of ALL_PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key: p.key },
      update: { label: p.label },
      create: { key: p.key, label: p.label },
    });
  }
  console.log(`✓ ${ALL_PERMISSIONS.length} permisos del catálogo al día`);

  // 2. Cada pantalla nueva, a los roles de las áreas que la declaran.
  const pantallas = SCREENS.filter((s) => NUEVAS.includes(s.href));
  if (pantallas.length !== NUEVAS.length) {
    console.error('✗ El catálogo no declara todas las pantallas esperadas. Revisa SCREENS.');
    process.exitCode = 1;
    return;
  }

  for (const s of pantallas) {
    const key = screenKey(s.href);
    const permiso = await prisma.permission.findUnique({ where: { key }, select: { id: true } });
    if (!permiso) { console.error(`✗ No se creó el permiso ${key}`); continue; }

    const destinos = s.areas.map((a) => ROL_DE_AREA[a]).filter(Boolean);
    const concedidos: string[] = [];
    for (const roleKey of destinos) {
      const rol = await prisma.role.findUnique({ where: { key: roleKey }, select: { id: true, name: true } });
      if (!rol) { console.warn(`  ⚠ no existe el rol "${roleKey}"`); continue; }
      const ya = await prisma.rolePermission.findFirst({ where: { roleId: rol.id, permissionId: permiso.id } });
      if (ya) { concedidos.push(`${rol.name} (ya)`); continue; }
      await prisma.rolePermission.create({ data: { roleId: rol.id, permissionId: permiso.id } });
      concedidos.push(`${rol.name} ✚`);
    }
    console.log(`  · ${s.label.padEnd(28)} ${key.padEnd(34)} → ${concedidos.join(', ') || '—'}`);
  }

  // 3. Quién queda con la operación de caja completa. Sin esto la migración es fe.
  const cajeras = await prisma.user.findMany({
    where: { roles: { some: { role: { key: 'area-caja' } } }, isActive: true },
    select: { email: true, name: true, cajaLegacyId: true, sedesAccede: true },
    orderBy: { email: 'asc' },
  });
  console.log(`\n✓ ${cajeras.length} usuarios activos con el rol "Caja y ventas":`);
  for (const u of cajeras) {
    const caja = u.cajaLegacyId == null ? '⚠ SIN CAJA ASIGNADA' : `caja ${u.cajaLegacyId}`;
    const sedes = u.sedesAccede.length ? `sedes ${u.sedesAccede.join(',')}` : 'sin acotar por sede';
    console.log(`    · ${u.name} <${u.email}> — ${caja}, ${sedes}`);
  }
  if (cajeras.some((u) => u.cajaLegacyId == null)) {
    console.log(
      '\n  ⚠ Quien no tiene caja asignada verá las pantallas pero sólo los bancos, y no\n' +
      '    podrá registrar ingresos ni egresos (403). Asígnasela en /empleados/[id].',
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
