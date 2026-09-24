/**
 * Diagnóstico de SOLO LECTURA de las VLANs en los Mikrotik (2026-09-23).
 *
 * Para que una VLAN de la OLT dé servicio, el router de la sede necesita una
 * interfaz VLAN con ese número sobre el puerto que va a la OLT y un servidor
 * PPPoE escuchando en ella. Este script vuelca, por router (una sola vez por
 * IP:puerto — EPON y EOC de Villanueva son el mismo equipo): identidad,
 * `/interface/vlan/print` y `/interface/pppoe-server/server/print`.
 *
 * Solo comandos `.../print`. Nada de add/set/remove.
 *
 * Uso (desde backend/):
 *   npx ts-node scripts/diagnostico-vlans-mikrotik.ts <carpeta-salida>
 */
import { writeFileSync } from 'fs';
import { join } from 'path';
import { PrismaClient } from '@prisma/client';
import { RouterosClient } from '../src/network/routeros/routeros-client';
import { decryptSecret } from '../src/common/secret-box';

const prisma = new PrismaClient();

async function main() {
  const carpeta = process.argv[2];
  if (!carpeta) { console.error('Uso: npx ts-node scripts/diagnostico-vlans-mikrotik.ts <carpeta-salida>'); process.exit(1); }
  const routers = await prisma.mikrotik.findMany({ orderBy: { name: 'asc' } });
  await prisma.$disconnect();
  const vistos = new Set<string>();
  for (const r of routers) {
    const clave = `${r.ip}:${r.port}`;
    if (vistos.has(clave)) { console.log(`${r.name}: mismo equipo que otro ya leído (${clave})`); continue; }
    vistos.add(clave);
    const api = new RouterosClient();
    const leer = async (cmd: string) => {
      if (!/\/print$/.test(cmd)) throw new Error(`comando no permitido: ${cmd}`);
      return api.comm(cmd, {}, 30000);
    };
    try {
      await api.connect(r.ip, Number(r.port), r.username, decryptSecret(r.password), { timeoutMs: 10000 });
      const salida = {
        router: r.name, host: clave, tech: r.tech, sedeLegacy: r.sedeLegacy,
        identidad: (await leer('/system/identity/print'))[0]?.name ?? null,
        vlans: await leer('/interface/vlan/print'),
        pppoe: await leer('/interface/pppoe-server/server/print'),
      };
      writeFileSync(join(carpeta, `${r.name}.json`), JSON.stringify(salida, null, 2));
      console.log(`${r.name} (${salida.identidad}): ${salida.vlans.length} VLANs, ${salida.pppoe.length} servidores PPPoE`);
    } catch (e) {
      console.log(`${r.name}: NO CONECTA — ${(e as Error).message}`);
    } finally {
      api.close();
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
