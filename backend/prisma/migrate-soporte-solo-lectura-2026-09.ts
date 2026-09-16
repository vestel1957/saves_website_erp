/**
 * Separa VER las órdenes de servicio de TOCARLAS (2026-09).
 *
 * Hasta ahora /soporte era una sola puerta: quien entraba a la pantalla podía
 * abrir órdenes, corregirlas, reasignarlas, cambiarles el estado, documentarlas
 * y firmarlas. No había forma de dejar a una jefatura seguir el trabajo de los
 * técnicos sin darle también el poder de alterarlo.
 *
 * El permiso nuevo `support.write` cubre las 14 escrituras de la orden. Sin él,
 * /soporte queda en consulta: lista, detalle, PDF y Excel.
 *
 * REGLA DE DESPLIEGUE — nadie pierde acceso el día 1: se concede a TODO rol que
 * hoy tenga alguna de las áreas que ya abrían esas rutas (técnicos, caja,
 * administración), derivándolo del estado REAL de la base y no del catálogo,
 * porque hay roles personalizados creados desde el constructor de roles.
 *
 * Quitarlo a alguien es, a partir de aquí, una decisión explícita:
 *   --consulta <email>   deja a esa persona en SOLO LECTURA de soporte:
 *                        le abre la pantalla (ALLOW screen.soporte), le quita la
 *                        escritura (DENY support.write) y le cierra el
 *                        agendamiento (DENY screen.soporte.agenda) — sin la
 *                        escritura esa pantalla solo daría 403 al mover una
 *                        orden. Es lo mismo que hace la ficha del empleado al
 *                        desmarcar las casillas.
 *
 * Idempotente. Correr:
 *   npx ts-node prisma/migrate-soporte-solo-lectura-2026-09.ts [--dry-run]
 *   npx ts-node prisma/migrate-soporte-solo-lectura-2026-09.ts --consulta redes@vestel.com.co
 */
import { PrismaClient } from '@prisma/client';
import { APP_PERMISSIONS, ALL_PERMISSIONS, screenKey } from '../src/auth/permissions.catalog';

const prisma = new PrismaClient();
const A = APP_PERMISSIONS;

/** Áreas que HOY ya permitían escribir en una orden (ver support.router.ts). */
const AREAS_QUE_YA_ESCRIBIAN = [A.AREA_TECNICOS, A.AREA_CAJA, A.AREA_ADMINISTRACION];

/** Pantalla de órdenes de trabajo — lo que hay que abrirle a quien solo consulta. */
const PANTALLA_SOPORTE = screenKey('/soporte');
/** Agendamiento: repartir el trabajo es MOVER órdenes, así que no es consulta. */
const PANTALLA_AGENDA = screenKey('/soporte/agenda');

const soloSimular = process.argv.includes('--dry-run');

/** Alta del permiso en el catálogo de la BD (el guard compara contra estas filas). */
async function alta(key: string) {
  const def = ALL_PERMISSIONS.find((p) => p.key === key);
  const label = def?.label ?? key;
  if (soloSimular) return prisma.permission.findUnique({ where: { key } });
  return prisma.permission.upsert({ where: { key }, update: { label }, create: { key, label } });
}

/** Paso 1: que nadie que hoy escribe deje de poder hacerlo. */
async function concederALosQueYaEscribian() {
  const permiso = await alta(A.SUPPORT_WRITE);
  console.log(`  permiso: ${A.SUPPORT_WRITE}`);

  const roles = await prisma.role.findMany({
    where: { permissions: { some: { permission: { key: { in: AREAS_QUE_YA_ESCRIBIAN } } } } },
    select: { id: true, key: true, permissions: { select: { permission: { select: { key: true } } } } },
  });

  let concedidos = 0, yaTenian = 0;
  for (const rol of roles) {
    if (rol.permissions.some((rp) => rp.permission.key === A.SUPPORT_WRITE)) { yaTenian++; continue; }
    console.log(`  + ${rol.key.padEnd(28)} ${A.SUPPORT_WRITE}`);
    if (!soloSimular && permiso) {
      await prisma.rolePermission.create({ data: { roleId: rol.id, permissionId: permiso.id } });
    }
    concedidos++;
  }
  console.log(`\n${soloSimular ? '[simulación] ' : ''}roles con escritura: ${concedidos} nuevos · ${yaTenian} ya la tenían`);
}

/** Paso 2 (opcional): dejar a una persona concreta en solo lectura. */
async function dejarEnConsulta(email: string) {
  const user = await prisma.user.findFirst({
    where: { email: { equals: email, mode: 'insensitive' } },
    select: { id: true, name: true, email: true },
  });
  if (!user) { console.log(`  ! no existe usuario con correo ${email}`); process.exitCode = 1; return; }

  const pantalla = await alta(PANTALLA_SOPORTE);
  const agenda = await alta(PANTALLA_AGENDA);
  const escritura = await alta(A.SUPPORT_WRITE);
  if (!pantalla || !agenda || !escritura) { console.log('  ! faltan permisos en el catálogo (¿--dry-run?)'); return; }

  // ALLOW la pantalla, DENY la escritura: los dos overrides que resuelve
  // `AuthService.resolveUser` (rol ∪ ALLOW − DENY).
  const overrides: { permissionId: string; effect: 'ALLOW' | 'DENY'; key: string }[] = [
    { permissionId: pantalla.id, effect: 'ALLOW', key: PANTALLA_SOPORTE },
    { permissionId: escritura.id, effect: 'DENY', key: A.SUPPORT_WRITE },
    { permissionId: agenda.id, effect: 'DENY', key: PANTALLA_AGENDA },
  ];
  for (const o of overrides) {
    console.log(`  ${o.effect === 'ALLOW' ? '+' : '−'} ${user.name} (${user.email}) ${o.key}`);
    if (soloSimular) continue;
    await prisma.userPermission.upsert({
      where: { userId_permissionId: { userId: user.id, permissionId: o.permissionId } },
      update: { effect: o.effect },
      create: { userId: user.id, permissionId: o.permissionId, effect: o.effect },
    });
  }
  console.log(`\n${soloSimular ? '[simulación] ' : ''}${user.name}: ve /soporte y NO puede modificar nada.`);
}

async function main() {
  await concederALosQueYaEscribian();

  const i = process.argv.indexOf('--consulta');
  if (i >= 0) {
    const email = process.argv[i + 1];
    if (!email) { console.log('  ! --consulta necesita un correo'); process.exitCode = 1; return; }
    console.log('');
    await dejarEnConsulta(email);
  }

  if (soloSimular) console.log('Vuelve a ejecutarlo sin --dry-run para aplicarlo.');
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
