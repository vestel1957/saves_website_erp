/**
 * Agendamiento de órdenes de trabajo (2026-07-31). Idempotente.
 *
 * La pantalla nueva `/soporte/agenda` es de la CAJERA (y de administración): ella
 * reparte el día entre los técnicos y fija el orden de las visitas. Este script
 * concede esa llave de pantalla; el técnico NO la recibe a propósito — él sigue la
 * agenda, no la arma, y `AgendaService.mover` se lo niega también por API.
 *
 * La agenda arranca VACÍA (decisión del usuario): no se agenda hacia atrás nada de
 * las 509 órdenes abiertas. Cada técnico las sigue viendo todas en su lista; lo que
 * la cajera vaya agendando aparece arriba, numerado. El script sólo reporta el
 * panorama para saber qué hay que repartir.
 *
 * Correr:  npx ts-node prisma/migrate-agendamiento-2026-07.ts
 */
import { PrismaClient } from '@prisma/client';
import { ALL_PERMISSIONS, SCREENS, screenKey } from '../src/auth/permissions.catalog';

const prisma = new PrismaClient();

const PANTALLA = '/soporte/agenda';
const ROLES = ['area-caja', 'area-administracion'];

async function main() {
  const s = SCREENS.find((x) => x.href === PANTALLA);
  if (!s || s.areas.includes('tecnicos')) {
    console.error('✗ El catálogo (SCREENS) no concuerda: la agenda no debe ser del área técnica.');
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

  // Que el técnico NO la tenga es parte de la regla: si alguien se la concedió a
  // mano, conviene enterarse ahora y no cuando reordene la agenda de su compañero.
  const tec = await prisma.role.findUnique({ where: { key: 'area-tecnicos' }, select: { id: true } });
  if (tec && await prisma.rolePermission.findFirst({ where: { roleId: tec.id, permissionId: permiso.id } })) {
    console.log(`  ⚠ El rol Técnicos TIENE ${llave} — no debería. Se retira.`);
    await prisma.rolePermission.deleteMany({ where: { roleId: tec.id, permissionId: permiso.id } });
  }
  const ovs = await prisma.userPermission.findMany({
    where: { permissionId: permiso.id },
    select: { effect: true, user: { select: { name: true, email: true } } },
  });
  for (const o of ovs) console.log(`  ⚠ override por usuario: ${o.user.name} <${o.user.email}> (${o.effect}) — sin tocar`);

  // Panorama de lo que hay por repartir.
  const abiertas: any = { status: { in: ['PENDIENTE', 'REALIZANDO'] } };
  const [sinAgendar, agendadas, tecnicos] = await Promise.all([
    prisma.ticket.count({ where: { ...abiertas, scheduledFor: null } }),
    prisma.ticket.count({ where: { scheduledFor: { not: null } } }),
    prisma.staff.count({ where: { banned: false, role: 2 } }),
  ]);
  console.log(`\n  ℹ ${sinAgendar} órdenes abiertas sin agendar · ${agendadas} ya agendadas · ${tecnicos} técnicos activos para repartir.`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
