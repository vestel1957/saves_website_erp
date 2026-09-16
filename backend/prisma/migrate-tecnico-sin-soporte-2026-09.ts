/**
 * El módulo de Soporte sale del perfil del TÉCNICO (2026-09-10). Idempotente.
 *
 * Lo pidió el usuario: «quitemos este módulo completo para los técnicos, es más, todo
 * el módulo de clientes». Resulta ser un solo permiso: `screen.soporte` era la ÚNICA
 * pantalla que el rol `area-tecnicos` tenía en la sección CLIENTES / CRM —el listado
 * de clientes nunca fue suyo—, así que al retirarla desaparece la sección entera de
 * su menú.
 *
 * Hace falta este script y no basta con el catálogo: `permissions.catalog.ts` sólo
 * decide qué se le CONCEDE a un rol nuevo. El rol vive en la base con sus permisos
 * ya otorgados (58 usuarios lo llevan), así que quitarlo del código no se lo quita a
 * nadie y el enlace le seguiría saliendo en el sidebar.
 *
 * ── LO QUE NO SE TOCA, A PROPÓSITO ──────────────────────────────────────────
 *  · `support.write` y las rutas de la API: el técnico ABRE y CIERRA sus órdenes.
 *    Quitarle la API lo dejaría sin poder trabajar, que no es lo que se pidió.
 *  · `/soporte/:id` (su orden) y `/clientes/:id` (la ficha, de consulta, a pedido del
 *    usuario el 2026-08-31): no son hojas del menú, así que `PantallaGate` no las
 *    bloquea. Llega a ellas desde su agenda, que es como trabaja.
 *  · El módulo para caja, administración y el superusuario: intacto.
 *
 * Correr:  npx ts-node --transpile-only prisma/migrate-tecnico-sin-soporte-2026-09.ts [--dry]
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const DRY = process.argv.includes('--dry');

const ROL_TECNICOS = 'area-tecnicos';
const PANTALLA = 'screen.soporte';

async function main() {
  const rol = await prisma.role.findUnique({ where: { key: ROL_TECNICOS }, select: { id: true, name: true } });
  if (!rol) { console.log(`· rol ${ROL_TECNICOS}: no existe, nada que hacer`); return; }

  const permiso = await prisma.permission.findUnique({ where: { key: PANTALLA }, select: { id: true } });
  if (!permiso) { console.log(`· permiso ${PANTALLA}: no existe, nada que hacer`); return; }

  const tiene = await prisma.rolePermission.findFirst({
    where: { roleId: rol.id, permissionId: permiso.id },
    select: { roleId: true },
  });
  if (!tiene) { console.log(`· ${rol.name} ya no tiene ${PANTALLA}`); return; }

  const cuantos = await prisma.userRole.count({ where: { roleId: rol.id } });
  if (DRY) { console.log(`· ${rol.name}: se le quitaría ${PANTALLA} (${cuantos} usuarios) — SECO`); return; }
  await prisma.rolePermission.deleteMany({ where: { roleId: rol.id, permissionId: permiso.id } });
  console.log(`· ${rol.name}: ${PANTALLA} retirado (afecta a ${cuantos} usuarios)`);

  // Una concesión SUELTA a un técnico concreto le devolvería la pantalla por la
  // puerta de atrás. Se avisa, pero no se borra: un override es la decisión de
  // alguien y puede haberse puesto para una persona a propósito.
  const sueltos = await prisma.userPermission.findMany({
    where: { permissionId: permiso.id, user: { roles: { some: { roleId: rol.id } } } },
    select: { user: { select: { name: true, email: true } } },
  });
  if (sueltos.length) {
    console.log(`⚠️  ${sueltos.length} técnico(s) conservan ${PANTALLA} por concesión individual:`);
    for (const s of sueltos) console.log(`     · ${s.user.name} <${s.user.email}>`);
    console.log('   Se quitan desde /configuracion/usuarios si tampoco deben verla.');
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
