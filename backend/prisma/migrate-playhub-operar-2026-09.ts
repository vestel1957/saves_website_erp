/**
 * PlayHub en la ficha para una persona (2026-09-17).
 *
 * Pedido: que Edgar Esteban Rodriguez —rol cajero— pueda operar PlayHub en el perfil de
 * cada cliente (crear la cuenta, activar y cancelar paquetes) y ver el reporte. Las rutas
 * exigían área administración/técnicos/gerencia/sistemas; ahora aceptan también el
 * permiso `playhub.operate`, que se concede aquí persona a persona. La barrida masiva
 * sigue siendo sólo de las áreas.
 *
 * Idempotente. Correr:
 *   npx ts-node --transpile-only prisma/migrate-playhub-operar-2026-09.ts [--dry-run]
 */
import { PrismaClient } from '@prisma/client';
import { APP_PERMISSIONS, ALL_PERMISSIONS } from '../src/auth/permissions.catalog';

const prisma = new PrismaClient();
const PERMISO = APP_PERMISSIONS.PLAYHUB_OPERATE;

/** Los autorizados, por correo (la llave estable de la cuenta). */
const AUTORIZADOS = [{ email: 'cardozoedgar889@gmail.com', quien: 'Edgar Esteban Rodriguez Cardozo' }];

async function main() {
  const soloSimular = process.argv.includes('--dry-run');
  const marca = soloSimular ? '[simulación] ' : '';

  const def = ALL_PERMISSIONS.find((p) => p.key === PERMISO);
  if (!def) throw new Error(`El permiso ${PERMISO} no está en el catálogo del código.`);
  if (!soloSimular) {
    await prisma.permission.upsert({
      where: { key: def.key },
      update: { label: def.label },
      create: { key: def.key, label: def.label },
    });
  }
  console.log(`${marca}permiso: ${def.key} — ${def.label}`);
  const fila = await prisma.permission.findUnique({ where: { key: PERMISO } });

  for (const { email, quien } of AUTORIZADOS) {
    const user = await prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      select: { id: true, name: true },
    });
    if (!user) { console.log(`${marca}NO existe la cuenta ${email} (${quien})`); continue; }
    if (!soloSimular && fila) {
      await prisma.userPermission.upsert({
        where: { userId_permissionId: { userId: user.id, permissionId: fila.id } },
        update: { effect: 'ALLOW' },
        create: { userId: user.id, permissionId: fila.id, effect: 'ALLOW' },
      });
    }
    console.log(`${marca}concedido a ${user.name} <${email}>`);
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
