/**
 * Quién puede emitir notas crédito/débito: consultar, añadir y quitar.
 *
 * `billing.notes.emit` es un permiso NOMINAL (ver `src/billing/emisor-de-notas.ts`):
 * se concede persona a persona y el superusuario no lo hereda. La ficha del empleado
 * sólo administra permisos de PANTALLA, así que ésta es la herramienta para moverlo
 * sin tocar código.
 *
 *   npx ts-node scripts/autorizar-emisor-notas.ts                      # quién puede hoy
 *   npx ts-node scripts/autorizar-emisor-notas.ts --agregar correo@…   # autorizar
 *   npx ts-node scripts/autorizar-emisor-notas.ts --quitar correo@…    # desautorizar
 *
 * Se pueden encadenar varios `--agregar` / `--quitar` en la misma corrida.
 * Ojo: quitárselo a todo el mundo deja el sistema SIN nadie que pueda emitir una
 * nota, y sin nota crédito DIAN no se anula una factura ya timbrada. El script
 * avisa, pero no lo impide: puede ser justo lo que se quiere.
 */
import { PrismaClient } from '@prisma/client';
import { APP_PERMISSIONS, ALL_PERMISSIONS } from '../src/auth/permissions.catalog';

const prisma = new PrismaClient();
const PERMISO = APP_PERMISSIONS.BILLING_NOTES_EMIT;

/** Lee los valores de una bandera repetible: --agregar a@b --agregar c@d */
function valoresDe(bandera: string): string[] {
  const out: string[] = [];
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === bandera && args[i + 1]) out.push(args[++i].trim().toLowerCase());
    else if (args[i].startsWith(`${bandera}=`)) out.push(args[i].slice(bandera.length + 1).trim().toLowerCase());
  }
  return out;
}

/** La cuenta por correo, sin distinguir mayúsculas (igual que el login). */
async function cuenta(email: string) {
  return prisma.user.findFirst({
    where: { email: { equals: email, mode: 'insensitive' } },
    orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }],
    select: { id: true, name: true, email: true, isActive: true },
  });
}

async function main() {
  const def = ALL_PERMISSIONS.find((p) => p.key === PERMISO)!;
  const perm = await prisma.permission.upsert({
    where: { key: PERMISO },
    update: { label: def.label },
    create: { key: PERMISO, label: def.label },
  });

  for (const email of valoresDe('--agregar')) {
    const u = await cuenta(email);
    if (!u) { console.log(`  ! no existe ninguna cuenta con el correo ${email}`); continue; }
    await prisma.userPermission.upsert({
      where: { userId_permissionId: { userId: u.id, permissionId: perm.id } },
      update: { effect: 'ALLOW' },
      create: { userId: u.id, permissionId: perm.id, effect: 'ALLOW' },
    });
    console.log(`  + ${u.name} <${u.email}>${u.isActive ? '' : ' (OJO: cuenta INACTIVA)'}`);
  }

  for (const email of valoresDe('--quitar')) {
    const u = await cuenta(email);
    if (!u) { console.log(`  ! no existe ninguna cuenta con el correo ${email}`); continue; }
    const { count } = await prisma.userPermission.deleteMany({ where: { userId: u.id, permissionId: perm.id } });
    console.log(count ? `  - ${u.name} <${u.email}>` : `  = ${u.name} <${u.email}> no lo tenía`);
  }

  const autorizados = await prisma.userPermission.findMany({
    where: { permissionId: perm.id, effect: 'ALLOW' },
    select: { user: { select: { name: true, email: true, isActive: true } } },
  });
  console.log(`\nEmiten notas crédito/débito (${autorizados.length}):`);
  for (const a of autorizados.sort((x, y) => x.user.name.localeCompare(y.user.name))) {
    console.log(`  · ${a.user.name} <${a.user.email}>${a.user.isActive ? '' : ' (INACTIVO)'}`);
  }
  const vivos = autorizados.filter((a) => a.user.isActive).length;
  if (!vivos) {
    console.log('\n! NADIE con cuenta activa puede emitir notas. Sin nota crédito DIAN tampoco se');
    console.log('  puede anular una factura ya timbrada: autoriza al menos a una persona.');
  }

  // Un rol que reparta el permiso lo dejaría de ser nominal: se avisa, no se toca.
  const roles = await prisma.rolePermission.findMany({
    where: { permissionId: perm.id },
    select: { role: { select: { key: true, name: true } } },
  });
  for (const r of roles) {
    console.log(`\n! el rol "${r.role.name}" (${r.role.key}) reparte ${PERMISO}: lo tiene TODO el que lleve ese rol.`);
    console.log('  Quítaselo desde Usuarios y roles si quieres que siga siendo persona a persona.');
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
