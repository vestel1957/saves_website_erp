/**
 * Diagnóstico de SOLO LECTURA: ¿dónde están configuradas las megas en la OLT?
 *
 * En Huawei GPON la velocidad no es un campo del `ont add`. Llega por dos vías
 * distintas y hay que saber cuál usa el operador antes de poder ofrecer
 * "elegir el plan" en la UI de autenticación:
 *
 *   1) DBA profile   → colgado del ont-lineprofile vía T-CONT. Rige la SUBIDA.
 *   2) traffic-table → aplicada al service-port. Rige BAJADA y subida (CIR/PIR).
 *
 * Este script se conecta por SSH, ejecuta solo comandos `display` y vuelca la
 * salida cruda. NO escribe nada en el equipo.
 *
 * Uso:  npx ts-node scripts/olt-anchos-banda.ts [nombre-o-ip-de-la-olt]
 */
import { PrismaClient } from '@prisma/client';
import { createOltDriver } from '../src/network/olt/olt-factory';
import { decryptSecret } from '../src/common/secret-box';

const prisma = new PrismaClient();

/** Comandos de lectura a ejecutar, en orden. */
const COMANDOS = [
  ['display dba-profile all', 'Perfiles DBA (ancho de banda de SUBIDA, en kbps)'],
  ['display ont-lineprofile gpon all', 'Perfiles de línea (uno por plan, normalmente)'],
  ['display ont-srvprofile gpon all', 'Perfiles de servicio (capacidades del equipo)'],
  // `display traffic table ip` a secas deja la CLI pidiendo un parámetro:
  // hay que arrancar por índice.
  ['display traffic table ip from-index 0', 'Traffic tables (CIR/PIR del service-port — bajada)'],
];

async function main() {
  const filtro = process.argv[2];
  const olts = await prisma.olt.findMany();
  const olt = filtro
    ? olts.find((o) => o.name.toLowerCase().includes(filtro.toLowerCase()) || o.ip === filtro)
    : olts.find((o) => o.isDefault) ?? olts[0];

  if (!olt) {
    console.error(filtro ? `No hay ninguna OLT que coincida con "${filtro}".` : 'No hay OLTs registradas.');
    console.error('Disponibles: ' + olts.map((o) => `${o.name} (${o.ip})`).join(', '));
    process.exit(1);
  }

  console.log(`\n=== ${olt.name} · ${olt.brand} · ${olt.ip}:${olt.port} ===`);
  console.log('Solo lectura: no se ejecuta ningún comando de escritura.\n');

  const driver = createOltDriver(olt.brand, olt.ip, olt.port, olt.username, decryptSecret(olt.password));

  // Si el proceso muere sin cerrar la sesión (SIGPIPE al pipear a `head`, Ctrl+C,
  // kill), la sesión VTY queda colgada en la OLT hasta el timeout de inactividad.
  // Con pocas sesiones disponibles, unas cuantas de esas dejan al equipo
  // inaccesible para todo el mundo. Cerrar siempre.
  let cerrado = false;
  const cerrar = (motivo: string) => {
    if (cerrado) return;
    cerrado = true;
    try { driver.disconnect(); } catch { /* cerrando */ }
    if (motivo !== 'fin') process.exit(motivo === 'SIGPIPE' ? 0 : 1);
  };
  for (const sig of ['SIGPIPE', 'SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => cerrar(sig));
  }
  process.on('uncaughtException', (e) => { console.error(e); cerrar('error'); });
  process.stdout.on('error', () => cerrar('SIGPIPE'));

  if (!(await driver.connect())) {
    console.error('No se pudo conectar: ' + driver.getError());
    process.exit(1);
  }

  try {
    await driver.prepare();
    // `sendCommand` es protected: lo usamos vía un cast, es un script de apoyo.
    const enviar = (cmd: string) => (driver as any).sendCommand(cmd) as Promise<string>;

    for (const [cmd, titulo] of COMANDOS) {
      console.log('\n' + '─'.repeat(72));
      console.log(`▸ ${titulo}`);
      console.log(`  $ ${cmd}`);
      console.log('─'.repeat(72));
      try {
        console.log((await enviar(cmd)) || '(sin salida)');
      } catch (e) {
        console.log('ERROR: ' + (e as Error).message);
      }
    }

    // Comandos extra ad-hoc (separados por ";"), para inspeccionar casos reales.
    for (const cmd of (process.env.EXTRA_CMDS ?? '').split(';').map((s) => s.trim()).filter(Boolean)) {
      console.log('\n' + '─'.repeat(72));
      console.log(`  $ ${cmd}`);
      console.log('─'.repeat(72));
      try {
        console.log((await enviar(cmd)) || '(sin salida)');
      } catch (e) {
        console.log('ERROR: ' + (e as Error).message);
      }
    }

    // Detalle de los line-profiles realmente en uso: ahí se ve el T-CONT y a qué
    // DBA apunta, que es el eslabón que conecta "plan" con "megas".
    const enUso = process.env.LINE_PROFILES ?? '380';
    for (const id of enUso.split(',').map((s) => s.trim()).filter(Boolean)) {
      const cmd = `display ont-lineprofile gpon profile-id ${id}`;
      console.log('\n' + '─'.repeat(72));
      console.log(`▸ Detalle del line-profile ${id} (T-CONT → DBA)`);
      console.log(`  $ ${cmd}`);
      console.log('─'.repeat(72));
      try {
        console.log((await enviar(cmd)) || '(sin salida)');
      } catch (e) {
        console.log('ERROR: ' + (e as Error).message);
      }
    }
  } finally {
    driver.disconnect();
    await prisma.$disconnect();
  }
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
