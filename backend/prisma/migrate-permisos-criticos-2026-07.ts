/**
 * Separa las ACCIONES DESTRUCTIVAS del "pertenecer a un área" (2026-07).
 *
 * Hasta ahora, cortar el servicio de todo el parque, borrar una ONU por SSH o
 * disparar la facturación de 21k abonados sólo exigía tener el área correspondiente.
 * Con `MIKROTIK_LIVE` y `OLT_LIVE` encendidos, eso se ejecuta de verdad.
 *
 * REGLA DE DESPLIEGUE — nadie pierde acceso el día 1:
 * los permisos nuevos se conceden a TODO rol que hoy pueda hacer esa operación,
 * derivándolo del estado REAL de la base y no del catálogo. Es la diferencia que
 * importa: hay 23 roles y varios son personalizados (creados desde el constructor
 * de roles); guiarse por el catálogo dejaría a esos sin poder cortar el lunes.
 *
 * A partir de aquí, restringir es una decisión de negocio explícita: se quita el
 * permiso al rol que no deba tenerlo, y sólo entonces cambia el comportamiento.
 *
 * Idempotente. Correr:  npx ts-node prisma/migrate-permisos-criticos-2026-07.ts
 */
import { PrismaClient } from '@prisma/client';
import { APP_PERMISSIONS, ALL_PERMISSIONS } from '../src/auth/permissions.catalog';

const prisma = new PrismaClient();
const A = APP_PERMISSIONS;

/** Permiso nuevo → áreas que HOY ya permitían esa operación. */
const CONCESIONES: { permiso: string; deAreas: string[] }[] = [
  // network.controller y subscribers.controller: @RequireArea('tecnicos','administracion')
  { permiso: A.NETWORK_CUT, deAreas: [A.AREA_TECNICOS, A.AREA_ADMINISTRACION] },
  { permiso: A.NETWORK_RECONNECT, deAreas: [A.AREA_TECNICOS, A.AREA_ADMINISTRACION] },
  // mikrotik.controller y olt.controller: @RequireArea('tecnicos','administracion')
  { permiso: A.NETWORK_ROUTERS_MANAGE, deAreas: [A.AREA_TECNICOS, A.AREA_ADMINISTRACION, A.AREA_SISTEMAS] },
  { permiso: A.NETWORK_OLT_MANAGE, deAreas: [A.AREA_TECNICOS, A.AREA_ADMINISTRACION, A.AREA_SISTEMAS] },
  // cron.controller: @RequireArea('contabilidad','sistemas')
  { permiso: A.CRON_RUN, deAreas: [A.AREA_CONTABILIDAD, A.AREA_SISTEMAS] },
];

async function main() {
  const soloSimular = process.argv.includes('--dry-run');

  // 1. Alta de los permisos nuevos en el catálogo de la BD.
  const nuevos = ALL_PERMISSIONS.filter((p) => CONCESIONES.some((c) => c.permiso === p.key));
  for (const p of nuevos) {
    if (!soloSimular) {
      await prisma.permission.upsert({
        where: { key: p.key },
        update: { label: p.label },
        create: { key: p.key, label: p.label },
      });
    }
    console.log(`  permiso: ${p.key}`);
  }

  // 2. Concesión derivada del estado REAL, rol por rol.
  let concedidos = 0;
  let yaTenian = 0;

  for (const { permiso, deAreas } of CONCESIONES) {
    // En simulación el permiso aún no existe en la BD; se calculan igualmente los
    // roles afectados para poder REVISAR el impacto antes de aplicar nada.
    const permFila = await prisma.permission.findUnique({ where: { key: permiso } });
    if (!permFila && !soloSimular) {
      console.log(`  ! ${permiso} no se pudo crear`);
      continue;
    }
    // Roles que hoy tienen alguna de las áreas que habilitaban la operación.
    const roles = await prisma.role.findMany({
      where: { permissions: { some: { permission: { key: { in: deAreas } } } } },
      select: { id: true, key: true, permissions: { select: { permission: { select: { key: true } } } } },
    });

    for (const rol of roles) {
      const tiene = rol.permissions.some((rp) => rp.permission.key === permiso);
      if (tiene) { yaTenian++; continue; }
      console.log(`  + ${rol.key.padEnd(28)} ${permiso}`);
      if (!soloSimular && permFila) {
        await prisma.rolePermission.create({ data: { roleId: rol.id, permissionId: permFila.id } });
      }
      concedidos++;
    }
  }

  console.log(
    `\n${soloSimular ? '[simulación] ' : ''}concesiones: ${concedidos} · ya lo tenían: ${yaTenian}`,
  );
  if (soloSimular) console.log('Vuelve a ejecutarlo sin --dry-run para aplicarlo.');
  else console.log('Nadie pierde acceso. Restringir ahora es quitar el permiso al rol que no deba tenerlo.');
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
