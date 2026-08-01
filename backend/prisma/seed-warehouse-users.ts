/**
 * Crea/actualiza los usuarios REALES de bodega con su rol correcto (no todos admin).
 * Idempotente: puedes correrlo varias veces; actualiza nombre/clave/rol.
 *
 * 1) EDITA la lista USERS de abajo con los datos reales de tu equipo.
 * 2) Ejecuta:  npx ts-node prisma/seed-warehouse-users.ts
 * 3) Pídeles cambiar la contraseña al primer ingreso.
 *
 * Roles típicos de bodega (ya existen en el sistema):
 *   - 'warehouse-manager'  → jefe de bodega (crea OC, aprueba, ajustes, conteos…)
 *
 * Los roles 'warehouse-clerk' y 'maintenance-technician' se retiraron el
 * 2026-07-29: duplicaban al jefe de bodega en solo lectura y mandaban sobre un
 * módulo de órdenes de trabajo que no existe.
 *   - 'auditor'            → solo lectura / consulta
 * (Lista completa de roles: src/auth/permissions.catalog.ts → ALL_ROLES)
 */
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/auth/crypto.util';

const prisma = new PrismaClient();

// 👇 EDITA ESTO con tu equipo real antes de ejecutar.
const USERS: { email: string; name: string; password: string; roleKey: string }[] = [
  { email: 'jefe.bodega@tuempresa.com', name: 'Jefe de Bodega', password: 'Cambiar123*', roleKey: 'warehouse-manager' },
];

async function main() {
  console.log(`👥 Creando/actualizando ${USERS.length} usuarios de bodega…\n`);
  for (const u of USERS) {
    const role = await prisma.role.findUnique({ where: { key: u.roleKey } });
    if (!role) {
      console.log(`   ✗ ${u.email}: el rol '${u.roleKey}' no existe — revisa ALL_ROLES. Salto.`);
      continue;
    }
    const user = await prisma.user.upsert({
      where: { email: u.email },
      update: { name: u.name, passwordHash: hashPassword(u.password), isActive: true },
      create: { email: u.email, name: u.name, passwordHash: hashPassword(u.password) },
    });
    await prisma.userRole.upsert({
      where: { userId_roleId: { userId: user.id, roleId: role.id } },
      update: {},
      create: { userId: user.id, roleId: role.id },
    });
    console.log(`   ✓ ${u.email}  (${u.roleKey})`);
  }
  console.log('\n✅ Listo. Recuérdales cambiar la contraseña al primer ingreso.');
  console.log('   (También puedes gestionarlos desde la UI: /configuracion/usuarios)');
}

main()
  .catch((e) => { console.error('❌', e.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
