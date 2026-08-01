/**
 * RED / ISP y MIKROTIK fuera del perfil del técnico (2026-07-31). Idempotente.
 *
 * Decisión del usuario: al técnico de campo se le quitan esas dos secciones del
 * sidebar y el acceso a esos módulos. Las pantallas pasan a administración —que es
 * donde ya viven equipos y transferencias, y donde están todas las personas que de
 * verdad operan la OLT y los routers (tienen esa área además de la técnica)—, así que
 * ninguna queda huérfana.
 *
 *   area-tecnicos       − screen.red / red.conexiones / red.naps / red.olt
 *                       − screen.red.genieacs / red.onus
 *                       − screen.mikrotik / mikrotik.masivo / mikrotik.ips
 *                       − network.cut, network.reconnect, network.routers.manage
 *
 *   area-administracion + esas nueve pantallas
 *
 * DOS cosas que NO se tocan, y conviene saber por qué:
 *
 *  1. `screen.red.bodegas` se queda con el técnico: esa pantalla ya no lista bodegas,
 *     le muestra los equipos que están a su nombre (ver `equipmentWarehouses`).
 *  2. `network.olt.manage` se queda con el técnico. Parece contradictorio, pero ese
 *     permiso es lo que le deja AUTENTICAR LA ONU y aplicar la velocidad DENTRO de una
 *     orden de trabajo (`SupportController`, rutas `tickets/:id/onu/*`) — su trabajo
 *     de campo, no el módulo de Red. Quitárselo lo deja sin poder instalar. El módulo
 *     en sí ya no lo alcanza: lo cierra `network/modulo-red.guard.ts`, que bloquea los
 *     controladores de red salvo las dos lecturas de sus equipos.
 *
 * Los overrides por usuario se REPORTAN y no se tocan.
 *
 * Correr:  npx ts-node prisma/migrate-tecnico-sin-red-mikrotik-2026-07.ts
 */
import { PrismaClient } from '@prisma/client';
import { ALL_PERMISSIONS, SCREENS, screenKey } from '../src/auth/permissions.catalog';

const prisma = new PrismaClient();

const PANTALLAS = [
  '/red', '/red/conexiones', '/red/naps', '/red/olt', '/red/genieacs', '/red/onus',
  '/mikrotik', '/mikrotik/masivo', '/mikrotik/ips',
];
/** Acciones destructivas que sólo se disparaban desde esos módulos. */
const ACCIONES = ['network.cut', 'network.reconnect', 'network.routers.manage'];

async function llave(key: string) {
  return prisma.permission.findUnique({ where: { key }, select: { id: true } });
}

async function overrides(permissionId: string, key: string) {
  const ovs = await prisma.userPermission.findMany({
    where: { permissionId },
    select: { effect: true, user: { select: { name: true, email: true } } },
  });
  for (const o of ovs) console.log(`      ⚠ override por usuario: ${o.user.name} <${o.user.email}> (${o.effect}) sobre ${key} — sin tocar`);
}

async function main() {
  // El catálogo manda: si no concuerda, el próximo seed desharía esto.
  const mal = PANTALLAS.filter((h) => {
    const s = SCREENS.find((x) => x.href === h);
    return !s || s.areas.includes('tecnicos') || !s.areas.includes('administracion');
  });
  if (mal.length) {
    console.error('✗ El catálogo (SCREENS) no concuerda con este script:', mal.join(', '));
    process.exitCode = 1;
    return;
  }

  for (const p of ALL_PERMISSIONS) {
    await prisma.permission.upsert({ where: { key: p.key }, update: { label: p.label }, create: { key: p.key, label: p.label } });
  }

  const tec = await prisma.role.findUnique({ where: { key: 'area-tecnicos' }, select: { id: true, name: true } });
  const adm = await prisma.role.findUnique({ where: { key: 'area-administracion' }, select: { id: true, name: true } });
  if (!tec || !adm) { console.error('✗ Falta el rol area-tecnicos o area-administracion.'); process.exitCode = 1; return; }

  console.log(`\n▸ ${tec.name}: se le retiran las pantallas de Red/ISP y Mikrotik`);
  for (const href of [...PANTALLAS.map(screenKey), ...ACCIONES]) {
    const permiso = await llave(href);
    if (!permiso) { console.log(`  − ${href.padEnd(32)} no existe`); continue; }
    const { count } = await prisma.rolePermission.deleteMany({ where: { roleId: tec.id, permissionId: permiso.id } });
    console.log(`  − ${href.padEnd(32)} ${count ? 'RETIRADA' : 'no la tenía'}`);
    if (count) await overrides(permiso.id, href);
  }

  // `/red/bodegas` no se le quita al técnico (son SUS equipos) pero administración
  // tampoco la tenía: sin esto, INVENTARIO ▸ Equipos ▸ Bodega de equipos sólo la
  // vería el superusuario, ahora que el resto del módulo pasó a esa área.
  console.log(`\n▸ ${adm.name}: recibe las pantallas para que no queden huérfanas`);
  for (const href of [...PANTALLAS, '/red/bodegas'].map(screenKey)) {
    const permiso = await llave(href);
    if (!permiso) { console.log(`  + ${href.padEnd(32)} no se creó`); continue; }
    const ya = await prisma.rolePermission.findFirst({ where: { roleId: adm.id, permissionId: permiso.id } });
    if (ya) { console.log(`  + ${href.padEnd(32)} ya la tenía`); continue; }
    await prisma.rolePermission.create({ data: { roleId: adm.id, permissionId: permiso.id } });
    console.log(`  + ${href.padEnd(32)} CONCEDIDA`);
  }

  // Foto final del técnico: pantallas y permisos de acción que le quedan.
  const restantes = await prisma.rolePermission.findMany({
    where: { roleId: tec.id },
    select: { permission: { select: { key: true, label: true } } },
    orderBy: { permission: { key: 'asc' } },
  });
  console.log(`\n✓ Lo que le queda a "${tec.name}" (${restantes.length}):`);
  for (const r of restantes) console.log(`    · ${r.permission.key.padEnd(30)} ${r.permission.label}`);
  const olt = restantes.some((r) => r.permission.key === 'network.olt.manage');
  console.log(`\n  ${olt ? '✓' : '✗'} network.olt.manage ${olt ? 'CONSERVADO' : 'PERDIDO'} — es lo que le deja autenticar la ONU dentro de una orden.`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
