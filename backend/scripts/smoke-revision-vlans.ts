/**
 * La revisión diaria de VLANs (cron `revision-vlans`) contra los equipos REALES,
 * sin escribir nada: el `cronRun` y el aviso al cargo `red-isp` se interceptan y
 * se imprimen. Solo lectura en OLT (`display`) y Mikrotik (`print`).
 *
 * Uso (desde backend/, salida a archivo): npx ts-node scripts/smoke-revision-vlans.ts > salida.txt
 */
import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { OltService } from '../src/network/olt.service';
import { MikrotikService } from '../src/network/mikrotik.service';
import { VlanEquiposService } from '../src/network/vlan-equipos.service';
import { CronService } from '../src/cron/cron.service';

async function main() {
  const real = new PrismaClient();
  const prisma: any = new Proxy(real, {
    get: (t: any, k) => (k === 'cronRun'
      ? { create: async (x: any) => { console.log('\n[cronRun interceptado]', JSON.stringify(x.data, null, 1)); return x.data; } }
      : t[k]),
  });
  const olt = new OltService(prisma);
  const mk = new MikrotikService(prisma, undefined as any, undefined as any);
  const vlanEquipos = new VlanEquiposService(prisma, olt, mk);
  const notifier: any = { notifyPost: async (post: string, input: any) => console.log(`\n[aviso interceptado → ${post}]`, JSON.stringify(input, null, 1)) };
  const u = undefined as any;
  const cron = new CronService(prisma, u, u, u, u, notifier, u, u, u, u, mk, vlanEquipos);
  const t = Date.now();
  const r = await cron.runRevisionVlans({ manual: true, avisar: true });
  console.log(`\n== ${Date.now() - t} ms`, JSON.stringify(r, null, 1));
  await real.$disconnect();
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
