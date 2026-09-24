/**
 * Proyectos para técnicos concretos (2026-09-21).
 *
 * Pedido: que los técnicos puedan entrar a Proyectos, pero SOLO los que se nombran
 * aquí —no el área técnica entera—. La llave es la propia pantalla, `screen.proyectos`,
 * concedida persona a persona:
 *   - el menú la pinta (el Sidebar mira `screen.proyectos`);
 *   - el login la embebe en el token (`prj`) y el edge deja pasar /proyectos;
 *   - la API de /projects la acepta como `orPermission` además de las áreas.
 * Hoy sólo la tienen por rol `super-admin` y `area-administracion`, que ya entraban.
 *
 * El técnico tiene que volver a iniciar sesión para que el token lleve el claim.
 *
 * Idempotente. Correr:
 *   npx ts-node --transpile-only prisma/migrate-proyectos-tecnicos-2026-09.ts [--dry-run]
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const PERMISO = 'screen.proyectos';

/** Los autorizados, por correo (la llave estable de la cuenta). */
const AUTORIZADOS = [{ email: 'diego.parra.1090@gmail.com', quien: 'Diego Amando Salamanca Parra' }];

async function main() {
  const soloSimular = process.argv.includes('--dry-run');
  const marca = soloSimular ? '[simulación] ' : '';

  const fila = await prisma.permission.findUnique({ where: { key: PERMISO } });
  if (!fila) throw new Error(`El permiso ${PERMISO} no está en la BD (¿falta el seed de pantallas?).`);

  for (const { email, quien } of AUTORIZADOS) {
    const user = await prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      select: { id: true, name: true },
    });
    if (!user) { console.log(`${marca}NO existe la cuenta ${email} (${quien})`); continue; }
    if (!soloSimular) {
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
