/**
 * El técnico ve sólo lo suyo (2026-07-31). Idempotente.
 *
 * Decisión del usuario: en INVENTARIO el técnico ve únicamente sus equipos y su
 * bodega de material, y en soporte sólo las órdenes asignadas a él. El recorte de
 * DATOS ya lo hace el backend (`common/tecnico-scope.ts`); lo que este script mueve
 * son las CONCESIONES, que viven en `RolePermission` y no en el catálogo:
 *
 *   area-tecnicos       + screen.inventario.bodegas   (su bodega de material)
 *                       − screen.red.equipos          (administrar el parque)
 *                       − screen.red.equipos.nuevo    (dar de alta equipo)
 *                       − screen.red.transferencias   (armar transferencias)
 *
 *   area-administracion + screen.inventario.bodegas   (faltaba: la llave no existía)
 *                       + screen.red.equipos          } para que no queden huérfanas
 *                       + screen.red.equipos.nuevo    } al salir del área técnica
 *                       + screen.red.transferencias
 *
 * "Bodega de equipos" (`screen.red.bodegas`) NO se le quita al técnico: es la
 * pantalla que ahora le muestra los equipos que están a su nombre.
 *
 * Los overrides por usuario se REPORTAN y no se tocan: si alguien tiene un ALLOW
 * explícito seguirá viendo la pantalla, y eso debe decidirlo una persona.
 *
 * Correr:  npx ts-node prisma/migrate-tecnico-solo-lo-suyo-2026-07.ts
 */
import { PrismaClient } from '@prisma/client';
import { ALL_PERMISSIONS, SCREENS, screenKey } from '../src/auth/permissions.catalog';

const prisma = new PrismaClient();

const CAMBIOS: { rol: string; dar: string[]; quitar: string[] }[] = [
  {
    rol: 'area-tecnicos',
    dar: ['/inventario/bodegas'],
    quitar: ['/red/equipos', '/red/equipos/nuevo', '/red/transferencias'],
  },
  {
    rol: 'area-administracion',
    dar: ['/inventario/bodegas', '/red/equipos', '/red/equipos/nuevo', '/red/transferencias'],
    quitar: [],
  },
];

/** El catálogo manda: si no concuerda, el próximo seed desharía esto. */
function catalogoConcuerda(): boolean {
  const area = (rol: string) => rol.replace('area-', '');
  for (const c of CAMBIOS) {
    for (const href of c.dar) {
      const s = SCREENS.find((x) => x.href === href);
      if (!s) return console.error(`✗ ${href} no está en SCREENS`), false;
      if (!s.areas.includes(area(c.rol))) return console.error(`✗ SCREENS ${href} no incluye el área "${area(c.rol)}"`), false;
    }
    for (const href of c.quitar) {
      const s = SCREENS.find((x) => x.href === href);
      if (s?.areas.includes(area(c.rol))) return console.error(`✗ SCREENS ${href} todavía incluye "${area(c.rol)}"`), false;
    }
  }
  return true;
}

async function main() {
  if (!catalogoConcuerda()) { process.exitCode = 1; return; }

  // Siembra las llaves nuevas (screen.inventario.bodegas no existía en la BD).
  for (const p of ALL_PERMISSIONS) {
    await prisma.permission.upsert({ where: { key: p.key }, update: { label: p.label }, create: { key: p.key, label: p.label } });
  }

  for (const { rol: key, dar, quitar } of CAMBIOS) {
    const rol = await prisma.role.findUnique({ where: { key }, select: { id: true, name: true } });
    if (!rol) { console.error(`✗ No existe el rol "${key}".`); process.exitCode = 1; continue; }
    console.log(`\n▸ ${rol.name} (${key})`);

    for (const href of dar) {
      const llave = screenKey(href);
      const permiso = await prisma.permission.findUnique({ where: { key: llave }, select: { id: true } });
      if (!permiso) { console.error(`  + ${llave} no se creó`); continue; }
      const ya = await prisma.rolePermission.findFirst({ where: { roleId: rol.id, permissionId: permiso.id } });
      if (ya) { console.log(`  + ${llave.padEnd(32)} ya la tenía`); continue; }
      await prisma.rolePermission.create({ data: { roleId: rol.id, permissionId: permiso.id } });
      console.log(`  + ${llave.padEnd(32)} CONCEDIDA`);
    }

    for (const href of quitar) {
      const llave = screenKey(href);
      const permiso = await prisma.permission.findUnique({ where: { key: llave }, select: { id: true } });
      if (!permiso) { console.log(`  − ${llave.padEnd(32)} no existe`); continue; }
      const { count } = await prisma.rolePermission.deleteMany({ where: { roleId: rol.id, permissionId: permiso.id } });
      console.log(`  − ${llave.padEnd(32)} ${count ? 'RETIRADA' : 'no la tenía'}`);
      const overrides = await prisma.userPermission.findMany({
        where: { permissionId: permiso.id },
        select: { effect: true, user: { select: { name: true, email: true } } },
      });
      for (const o of overrides) console.log(`      ⚠ override por usuario: ${o.user.name} <${o.user.email}> (${o.effect}) — sin tocar`);
    }
  }

  // Foto final: qué pantallas le quedan al técnico.
  const tec = await prisma.role.findUnique({ where: { key: 'area-tecnicos' }, select: { id: true, name: true } });
  if (tec) {
    const pantallas = await prisma.rolePermission.findMany({
      where: { roleId: tec.id, permission: { key: { startsWith: 'screen.' } } },
      select: { permission: { select: { key: true, label: true } } },
      orderBy: { permission: { key: 'asc' } },
    });
    console.log(`\n✓ Pantallas de "${tec.name}" (${pantallas.length}):`);
    for (const p of pantallas) console.log(`    · ${p.permission.key.padEnd(34)} ${p.permission.label}`);
  }

  // Contexto: a cuántos técnicos les va a servir esto de verdad hoy.
  const conBodega = await prisma.materialWarehouse.count({ where: { technicianRef: { not: null } } });
  const conEquipos = await prisma.equipment.groupBy({
    by: ['assignedRaw'],
    where: { subscriberId: null, assignedRaw: { not: null } },
    _count: { _all: true },
  });
  const tecnicos = conEquipos.filter((e) => e.assignedRaw && !/^\d+$/.test(e.assignedRaw));
  console.log(`\n  ℹ ${conBodega} bodegas de material a nombre de un técnico.`);
  console.log(`  ℹ ${tecnicos.reduce((a, t) => a + t._count._all, 0)} equipos a nombre de ${tecnicos.length} técnico(s): ${tecnicos.map((t) => `${t.assignedRaw} (${t._count._all})`).join(', ') || '—'}`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
