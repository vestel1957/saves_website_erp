/* eslint-disable */
/**
 * Usuario TEMPORAL para tomar las capturas de pantalla de los manuales.
 *
 * Existe porque las capturas hay que sacarlas del sistema andando, y para eso
 * hace falta una sesión. En vez de usar la cuenta de una persona real (que
 * dejaría su nombre en la bitácora de cada pantalla visitada), se crea una
 * cuenta desechable, se toman las fotos y se borra.
 *
 * Por defecto recibe solo permisos de LECTURA (todo lo que termina en .read/.view
 * más los area.* que abren el menú).
 *
 * Con `--completo` recibe el catálogo entero. Hace falta para las capturas: el
 * menú lateral se dibuja permiso por permiso, y con una cuenta de solo lectura
 * sale casi vacío — el manual mostraría un sistema que nadie reconoce. El riesgo
 * se acota por el lado del tiempo, no del permiso: la cuenta se crea, se toman
 * las fotos y se BORRA en la misma sesión (el capturador solo navega, nunca
 * envía un formulario).
 *
 * Uso:
 *   node scripts/usuario-capturas.js crear [--completo]   # imprime la clave
 *   node scripts/usuario-capturas.js borrar
 */
const { PrismaClient } = require('@prisma/client');
const { randomBytes, scryptSync } = require('crypto');

const EMAIL = 'capturas@vestel.com.co';
const NOMBRE = 'Capturas de manuales (temporal)';
const prisma = new PrismaClient();

// Mismo formato que backend/src/auth/crypto.util.ts: `salt:hash` en hex.
function hashPassword(plain) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(plain, salt, 64).toString('hex')}`;
}

/** Solo lectura: ver y navegar, nunca escribir. */
const esLectura = (key) =>
  key.endsWith('.read') || key.endsWith('.view') || key.startsWith('area.');

async function crear() {
  const completo = process.argv.includes('--completo');
  const clave = randomBytes(12).toString('base64url');
  const permisos = await prisma.permission.findMany({ select: { id: true, key: true } });
  const lectura = completo ? permisos : permisos.filter((p) => esLectura(p.key));

  const user = await prisma.user.upsert({
    where: { email: EMAIL },
    update: { passwordHash: hashPassword(clave), isActive: true, name: NOMBRE },
    create: {
      email: EMAIL,
      name: NOMBRE,
      passwordHash: hashPassword(clave),
      isActive: true,
      sedesAccede: [], // vacío = todas las sedes (igual que gerencia)
    },
  });

  // Los overrides se reponen enteros: si el catálogo creció desde la última vez,
  // la cuenta queda al día sin arrastrar permisos que ya no existen.
  await prisma.userPermission.deleteMany({ where: { userId: user.id } });
  await prisma.userPermission.createMany({
    data: lectura.map((p) => ({ userId: user.id, permissionId: p.id, effect: 'ALLOW' })),
    skipDuplicates: true,
  });

  const omitidos = permisos.length - lectura.length;
  console.log(`Usuario listo: ${EMAIL}`);
  console.log(`Clave:  ${clave}`);
  console.log(completo
    ? `Permisos: ${lectura.length} (catálogo completo, solo para capturar)`
    : `Permisos de lectura: ${lectura.length}  (omitidos ${omitidos} de escritura)`);
  console.log('\nCuando termines:  node scripts/usuario-capturas.js borrar');
}

async function borrar() {
  const user = await prisma.user.findUnique({ where: { email: EMAIL } });
  if (!user) return console.log(`No existe ${EMAIL}: nada que borrar.`);
  await prisma.userPermission.deleteMany({ where: { userId: user.id } });
  await prisma.user.delete({ where: { id: user.id } });
  console.log(`Borrado ${EMAIL} y sus ${'permisos'} temporales.`);
}

const cmd = process.argv[2];
const acciones = { crear, borrar };
if (!acciones[cmd]) {
  console.error('Uso: node scripts/usuario-capturas.js crear|borrar');
  process.exit(1);
}
acciones[cmd]()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
