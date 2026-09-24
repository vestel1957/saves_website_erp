/**
 * Diagnóstico de SOLO LECTURA de las VLANs de una OLT Huawei (2026-09-23).
 *
 * Una VLAN solo da servicio si, además de existir, sale por el uplink de la OLT:
 * la 590 de Villanueva existía (`vlan 590 smart`) con clientes y `display vlan
 * 590` decía "Standard port number: 0" → la ONU en línea y sin PPPoE. Este
 * script vuelca, por OLT: `display vlan all`, `display service-port all`,
 * `display vlan N` de cada VLAN y lo que acepte del autosave. Nada más.
 *
 * Solo ejecuta comandos que empiezan por `display ` (se comprueba antes de
 * enviar). La salida va SIEMPRE a un archivo; nunca pipear a `head` (SIGPIPE
 * deja la sesión VTY colgada en la OLT).
 *
 * Uso (desde backend/):
 *   npx ts-node scripts/diagnostico-vlans-olt.ts <nombre-olt> <archivo-salida>
 *   SOLO_EXTRA=1 EXTRA_CMDS='display port vlan 0/8/0' npx ts-node scripts/diagnostico-vlans-olt.ts ...
 */
import { writeFileSync, appendFileSync } from 'fs';
import { PrismaClient } from '@prisma/client';
import { createOltDriver } from '../src/network/olt/olt-factory';
import { decryptSecret } from '../src/common/secret-box';
import { vlansDeSalida } from '../src/network/olt/olt-huawei.driver';

const prisma = new PrismaClient();

async function main() {
  const [filtro, archivo] = process.argv.slice(2);
  if (!filtro || !archivo) {
    console.error('Uso: npx ts-node scripts/diagnostico-vlans-olt.ts <nombre-olt> <archivo-salida>');
    process.exit(1);
  }
  const olt = (await prisma.olt.findMany()).find((o) => o.name.toLowerCase() === filtro.toLowerCase());
  await prisma.$disconnect();
  if (!olt) { console.error(`No hay OLT "${filtro}".`); process.exit(1); }

  writeFileSync(archivo, `=== ${olt.name} · ${olt.ip}:${olt.port} · ${olt.transport} · ${new Date().toISOString()}\n`);
  const log = (s: string) => appendFileSync(archivo, s + '\n');

  const driver = createOltDriver(olt.brand, olt.ip, olt.port, olt.username, decryptSecret(olt.password), olt.transport as any);
  let cerrado = false;
  const cerrar = (motivo: string) => {
    if (cerrado) return;
    cerrado = true;
    try { driver.disconnect(); } catch { /* cerrando */ }
    if (motivo !== 'fin') process.exit(1);
  };
  for (const sig of ['SIGPIPE', 'SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => cerrar(sig));
  process.on('uncaughtException', (e) => { log('ERROR ' + String(e)); cerrar('error'); });

  if (!(await driver.connect())) {
    log('NO CONECTA: ' + driver.getError());
    process.exit(2);
  }
  try {
    await driver.prepare();
    const enviar = async (cmd: string) => {
      if (!/^display /.test(cmd)) throw new Error(`comando no permitido: ${cmd}`);
      log('\n' + '─'.repeat(72) + `\n$ ${cmd}\n` + '─'.repeat(72));
      let out = '';
      try { out = await (driver as any).sendCommand(cmd); } catch (e) { out = 'ERROR: ' + (e as Error).message; }
      log(out || '(sin salida)');
      return out;
    };

    // SOLO_EXTRA=1 + EXTRA_CMDS="display ...;display ..." → solo esos comandos.
    const extra = (process.env.EXTRA_CMDS ?? '').split(';').map((c) => c.trim()).filter(Boolean);
    if (process.env.SOLO_EXTRA === '1') {
      for (const cmd of extra) await enviar(cmd);
      return;
    }
    const todas = await enviar('display vlan all');
    await enviar('display service-port all');
    for (const cmd of ['display autosave interval', 'display autosave configuration', 'display autosave time']) {
      await enviar(cmd);
    }
    for (const v of vlansDeSalida(todas)) {
      if (v.estandar === 0 && v.servicePorts === 0) continue;
      await enviar(`display vlan ${v.vlan}`);
    }
  } finally {
    cerrar('fin');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
