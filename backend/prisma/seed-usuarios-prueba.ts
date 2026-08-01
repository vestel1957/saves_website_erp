/**
 * Crea/actualiza UN usuario de PRUEBA por cada rol existente en la base.
 *
 * Sirve para que alguien pueda entrar al sistema "con los ojos" de cada rol y ver
 * exactamente qué sidebar, qué pantallas y qué permisos le quedan, sin tocar la
 * cuenta de un empleado real.
 *
 * Idempotente: se puede correr varias veces (reescribe nombre, clave y rol).
 *
 *   npx ts-node prisma/seed-usuarios-prueba.ts
 *
 * Todos comparten la misma contraseña a propósito: son cuentas desechables de
 * ambiente de pruebas, pensadas para que quien las use no tenga que apuntar 11
 * claves distintas. NO usar este script contra producción.
 *
 * Para borrarlos después:
 *   DELETE FROM "User" WHERE email LIKE 'prueba.%@vestel.com.co';
 */
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/auth/crypto.util';

const prisma = new PrismaClient();

/** Clave única para todas las cuentas de prueba. */
const CLAVE = 'Prueba2026*';

/**
 * Caja y sede que se le asignan al perfil de cajera: sin `cajaLegacyId` una
 * cajera sólo ve los bancos (ver `src/treasury/caja-scope.ts`) y el perfil no
 * serviría para probar nada. 3 = caja "Yopal", sede 2 = Yopal.
 */
const CAJA_PRUEBA = { cajaLegacyId: 3, sedesAccede: [2] };

type PerfilPrueba = {
  roleKey: string;
  slug: string;
  /** Nombre visible; lleva el prefijo PRUEBA para que se distinga en Usuarios y roles. */
  etiqueta: string;
  caja?: boolean;
};

const PERFILES: PerfilPrueba[] = [
  { roleKey: 'super-admin', slug: 'superusuario', etiqueta: 'Superusuario' },
  { roleKey: 'area-gerencia', slug: 'gerencia', etiqueta: 'Gerencia' },
  { roleKey: 'area-administracion', slug: 'administracion', etiqueta: 'Administración' },
  { roleKey: 'area-contabilidad', slug: 'contabilidad', etiqueta: 'Contabilidad' },
  { roleKey: 'area-tecnicos', slug: 'tecnicos', etiqueta: 'Técnicos' },
  { roleKey: 'area-sistemas', slug: 'sistemas', etiqueta: 'Sistemas' },
  { roleKey: 'area-caja', slug: 'caja', etiqueta: 'Caja y ventas', caja: true },
  { roleKey: 'auditor', slug: 'auditoria', etiqueta: 'Auditoría / Consulta' },
  { roleKey: 'warehouse-manager', slug: 'bodega', etiqueta: 'Jefe de bodega' },
  { roleKey: 'hr-director', slug: 'rrhh', etiqueta: 'Director de RRHH' },
  { roleKey: 'accountant', slug: 'contador', etiqueta: 'Contador' },
];

async function main() {
  const roles = await prisma.role.findMany({ select: { id: true, key: true, name: true } });
  const porKey = new Map(roles.map((r) => [r.key, r]));

  // Si mañana alguien añade un rol y no lo pone aquí, el perfil de prueba de ese
  // rol no existiría y nadie se enteraría: mejor gritarlo.
  const sinPerfil = roles.filter((r) => !PERFILES.some((p) => p.roleKey === r.key));
  if (sinPerfil.length) {
    console.log(`⚠️  Roles en la BD SIN perfil de prueba en este script: ${sinPerfil.map((r) => r.key).join(', ')}\n`);
  }

  console.log(`👥 Creando/actualizando ${PERFILES.length} perfiles de prueba…\n`);
  const creados: { email: string; rol: string; pantallas: number }[] = [];

  for (const p of PERFILES) {
    const role = porKey.get(p.roleKey);
    if (!role) {
      console.log(`   ✗ ${p.roleKey}: el rol no existe en la BD. Salto.`);
      continue;
    }
    const email = `prueba.${p.slug}@vestel.com.co`;
    const datos = {
      name: `PRUEBA · ${p.etiqueta}`,
      passwordHash: hashPassword(CLAVE),
      isActive: true,
      ...(p.caja ? CAJA_PRUEBA : {}),
    };
    const user = await prisma.user.upsert({
      where: { email },
      update: datos,
      create: { email, ...datos },
    });

    // El perfil debe llevar EXACTAMENTE un rol: si arrastra otro de una corrida
    // anterior, ya no representa al rol que dice representar.
    await prisma.userRole.deleteMany({ where: { userId: user.id, roleId: { not: role.id } } });
    await prisma.userRole.upsert({
      where: { userId_roleId: { userId: user.id, roleId: role.id } },
      update: {},
      create: { userId: user.id, roleId: role.id },
    });

    const pantallas = await prisma.rolePermission.count({
      where: { roleId: role.id, permission: { key: { startsWith: 'screen.' } } },
    });
    creados.push({ email, rol: role.name, pantallas });
    const aviso = pantallas === 0 ? '  ⚠️ el rol no tiene pantallas concedidas: entra pero sin menú' : '';
    console.log(`   ✓ ${email.padEnd(36)} ${role.name}${aviso}`);
  }

  console.log(`\n✅ ${creados.length} perfiles listos. Clave para todos: ${CLAVE}`);
  const mudos = creados.filter((c) => c.pantallas === 0);
  if (mudos.length) {
    console.log(`\n⚠️  ${mudos.length} rol(es) sin ninguna pantalla en el sidebar (${mudos.map((m) => m.rol).join(', ')}).`);
    console.log('   Son roles secundarios que nunca se cablearon a SCREENS: el login funciona,');
    console.log('   pero la raíz no encuentra a dónde llevarlos y rebota a /login.');
  }
}

main()
  .catch((e) => { console.error('❌', e.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
