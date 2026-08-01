/**
 * El panel del técnico (2026-07-30).
 * Idempotente — seguro de correr varias veces.
 *
 * `/dashboard` ya servía dos paneles (ejecutivo y de caja); ahora sirve un tercero: la
 * jornada del técnico — las órdenes que le tocan hoy y su rendimiento. Pero el permiso
 * de esa pantalla (`screen.dashboard`) vive en la tabla `Permission` y se concede vía
 * `RolePermission`, así que sin este script el rol "Técnicos" no lo tiene: el ítem del
 * menú le queda invisible y `/` no lo aterriza ahí.
 *
 * Qué hace:
 *  1. Da de alta (o actualiza la etiqueta de) todos los permisos del catálogo.
 *  2. Concede `screen.dashboard` al rol `area-tecnicos`.
 *  3. Reporta a quién le queda y, sobre todo, CUÁNTOS de ellos se pueden ligar a una
 *     ficha de empleado: sin ese vínculo el panel no sabe cuáles órdenes son suyas y
 *     sale en modo "avísale a administración". Mejor enterarse aquí que por soporte.
 *
 * Lo que NO hace: tocar los overrides por usuario, ni el endpoint `/dashboard` del
 * backend (sigue siendo de gerencia — el técnico se sirve de `/support/mi-jornada` y
 * `/support/mi-rendimiento`, que se acotan solos por la sesión).
 *
 * Correr:  npx ts-node prisma/migrate-panel-tecnico-2026-07.ts
 */
import { PrismaClient } from '@prisma/client';
import { ALL_PERMISSIONS, screenKey } from '../src/auth/permissions.catalog';

const prisma = new PrismaClient();

const ROL_TECNICOS = 'area-tecnicos';
const LLAVE = screenKey('/dashboard');

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

  // 2. La pantalla del panel al rol de técnicos.
  const rol = await prisma.role.findUnique({ where: { key: ROL_TECNICOS }, select: { id: true, name: true } });
  if (!rol) {
    console.error(`✗ No existe el rol "${ROL_TECNICOS}". Corre antes prisma/migrate-roles-2026-06.ts`);
    process.exitCode = 1;
    return;
  }

  const permiso = await prisma.permission.findUnique({ where: { key: LLAVE }, select: { id: true } });
  if (!permiso) {
    console.error(`✗ No existe el permiso "${LLAVE}" ni siquiera tras sembrar el catálogo.`);
    process.exitCode = 1;
    return;
  }

  const ya = await prisma.rolePermission.findFirst({ where: { roleId: rol.id, permissionId: permiso.id } });
  if (ya) {
    console.log(`✓ "${rol.name}" ya tenía ${LLAVE}`);
  } else {
    await prisma.rolePermission.create({ data: { roleId: rol.id, permissionId: permiso.id } });
    console.log(`✓ ${LLAVE} concedido a "${rol.name}"`);
  }

  // 3. Quién queda viendo el panel — y quién lo verá vacío.
  const usuarios = await prisma.user.findMany({
    where: { roles: { some: { role: { key: ROL_TECNICOS } } }, isActive: true },
    select: { email: true, name: true },
  });
  console.log(`✓ ${usuarios.length} usuarios activos con el rol de técnicos:`);

  let sinFicha = 0;
  for (const u of usuarios) {
    // El mismo criterio que `SupportService.staffDelUsuario`: email y, si no, nombre.
    const staff = await prisma.staff.findFirst({
      where: {
        banned: false,
        OR: [{ email: { equals: u.email, mode: 'insensitive' } }, { name: { equals: u.name, mode: 'insensitive' } }],
      },
      select: { id: true, name: true, username: true },
    });
    if (!staff) {
      sinFicha++;
      console.log(`    · ${u.name} <${u.email}>  ⚠ sin ficha de empleado: verá el panel sin órdenes`);
      continue;
    }
    const clave = staff.username || staff.name;
    const abiertas = await prisma.ticket.count({
      where: {
        status: { in: ['PENDIENTE', 'REALIZANDO'] },
        OR: [{ assignedStaffId: staff.id }, ...(clave ? [{ assigned: clave }] : [])],
      },
    });
    console.log(`    · ${u.name} <${u.email}>  → ${staff.name} (${abiertas} orden(es) abierta(s))`);
  }

  if (!usuarios.length) {
    console.log('  ⚠ Nadie tiene el rol de técnicos: el panel sólo lo verá el superadministrador.');
  } else if (sinFicha) {
    console.log(
      `\n  ⚠ ${sinFicha} de ${usuarios.length} no se pueden ligar a una ficha de empleado. Para que su panel\n` +
        '    tenga contenido, el correo del usuario tiene que coincidir con el de Empleados.',
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
