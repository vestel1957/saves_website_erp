/**
 * Cifra en reposo las contraseñas de routers Mikrotik y OLTs que aún estén en texto
 * plano (`secret-box`, AES-256-GCM).
 *
 * `decryptSecret` deja pasar sin tocar lo que no lleva el prefijo `enc:v1:`, así que
 * el sistema funciona igual antes y después; esto sólo cierra la ventana en la que
 * un volcado de la base entrega acceso root a todos los equipos de red.
 *
 * IMPORTANTE — la llave sale de `SECRET_ENC_KEY` (o `AUTH_SECRET` como respaldo).
 * Si se rota esa variable DESPUÉS de cifrar, las contraseñas quedan ilegibles y hay
 * que volver a escribirlas a mano en cada equipo. Por eso `SECRET_ENC_KEY` existe
 * aparte: rotar el secreto de sesión no debe tocar las credenciales de los equipos.
 *
 * Es idempotente: lo ya cifrado se salta.
 *
 * Uso:  npx ts-node scripts/encrypt-network-secrets.ts
 *       npx ts-node scripts/encrypt-network-secrets.ts --dry-run
 */
import { PrismaClient } from '@prisma/client';
import { encryptSecret, isEncrypted } from '../src/common/secret-box';

// Seguro: si la llave no está en el entorno, `secret-box` cae en su clave de
// DESARROLLO y cifraría con ella; el backend, que sí tiene la buena, no podría
// descifrar y todos los equipos de red quedarían inaccesibles. Antes que eso, abortar.
//
// (En la práctica el entorno suele estar poblado: importar `@prisma/client` carga el
// `.env` del proyecto. Comprobado. Pero eso es un efecto colateral de una dependencia,
// no un contrato: si `.env` no trae la llave, esto tiene que fallar y no cifrar nada.)
if (!process.env.SECRET_ENC_KEY && !process.env.AUTH_SECRET) {
  throw new Error(
    'Falta SECRET_ENC_KEY (o AUTH_SECRET) en el entorno. Ejecuta con las variables cargadas:\n' +
      '  set -a && . ./.env && set +a && npx ts-node scripts/encrypt-network-secrets.ts',
  );
}

const prisma = new PrismaClient();
const dryRun = process.argv.includes('--dry-run');

async function main() {
  let cifradas = 0;
  let yaEstaban = 0;
  let vacias = 0;

  for (const modelo of ['mikrotik', 'olt'] as const) {
    const filas: { id: string; name: string | null; password: string | null }[] =
      await (prisma[modelo] as never as {
        findMany: (a: unknown) => Promise<{ id: string; name: string | null; password: string | null }[]>;
      }).findMany({ select: { id: true, name: true, password: true } });

    for (const f of filas) {
      if (!f.password) { vacias++; continue; }
      if (isEncrypted(f.password)) { yaEstaban++; continue; }
      console.log(`  ${modelo} · ${f.name ?? f.id} → cifrando`);
      if (!dryRun) {
        await (prisma[modelo] as never as {
          update: (a: unknown) => Promise<unknown>;
        }).update({ where: { id: f.id }, data: { password: encryptSecret(f.password) } });
      }
      cifradas++;
    }
  }

  console.log(
    `\n${dryRun ? '[simulación] ' : ''}cifradas: ${cifradas} · ya cifradas: ${yaEstaban} · sin contraseña: ${vacias}`,
  );
  if (dryRun && cifradas) console.log('Vuelve a ejecutarlo sin --dry-run para aplicarlo.');
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
