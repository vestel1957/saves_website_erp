/**
 * Rellena la `local-address` de los secrets que nacieron sin ella (creados por
 * nexus antes del 2026-09-16, ver `ipLocalDeLaRed`). Solo toca secrets cuya IP
 * local está VACÍA; la que ya hay no se cambia. Deja la IP en la ficha con
 * `editedAt` para que el sync no la devuelva vacía.
 *
 *   npx ts-node --transpile-only scripts/rellenar-ip-local.ts USUARIO1 USUARIO2   → simula
 *   npx ts-node --transpile-only scripts/rellenar-ip-local.ts USUARIO1 --aplicar
 */
import { PrismaClient } from '@prisma/client';
import { RouterosClient } from '../src/network/routeros/routeros-client';
import { decryptSecret } from '../src/common/secret-box';
import { MikrotikService, ipLocalDeLaRed } from '../src/network/mikrotik.service';
import { IpAllocatorService } from '../src/network/ip-allocator.service';

async function main() {
  const aplicar = process.argv.includes('--aplicar');
  const usuarios = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const prisma = new PrismaClient();
  const mk = new MikrotikService(prisma as any, {} as any, new IpAllocatorService(prisma as any));
  for (const usuario of usuarios) {
    const sub = await prisma.subscriber.findFirst({ where: { pppUsername: usuario }, include: { branch: true } as any });
    const abonado = `${sub?.abonado ?? '?'}`;
    if (!sub?.pppUsername) { console.log(abonado, '→ sin ficha o sin usuario PPPoE'); continue; }
    const router = await mk.resolveRouter(sub as any);
    const api = new RouterosClient();
    try {
      await api.connect(router.ip, Number(router.port), router.username, decryptSecret(router.password), { timeoutMs: 10000 });
      const name = sub.pppUsername.replace(/\s+/g, '');
      const [s] = await api.comm('/ppp/secret/getall', { '.proplist': '.id,name,remote-address,local-address,last-disconnect-reason,last-logged-out', '?name': name });
      const [act] = await api.comm('/ppp/active/getall', { '.proplist': 'name,address,uptime', '?name': name });
      if (!s) { console.log(abonado, name, router.name, '→ NO tiene secret'); continue; }
      const actual = (s['local-address'] ?? '').trim();
      const ficha = (sub.ipLocal ?? '').trim();
      const filas = await api.comm('/ppp/secret/getall', { '.proplist': 'remote-address,local-address' }, 30000);
      const nueva = actual ? null : (ficha || ipLocalDeLaRed(filas, s['remote-address'] ?? null));
      console.log(abonado, name, router.name, `remota=${s['remote-address'] ?? ''} local="${actual}" ficha="${ficha}"`,
        `desconexión=${s['last-disconnect-reason'] ?? ''} sesión=${act ? `${act.address} ${act.uptime}` : 'NO'}`,
        nueva ? `→ ${aplicar ? 'PONGO' : 'pondría'} ${nueva}` : '→ nada que hacer');
      if (aplicar && nueva) {
        await api.comm('/ppp/secret/set', { '.id': s['.id'], 'local-address': nueva });
        if (!ficha) await prisma.subscriber.update({ where: { id: sub.id }, data: { ipLocal: nueva, editedAt: new Date() } });
        await prisma.mikrotikActionLog.create({ data: {
          subscriberId: sub.id, mikrotikId: router.id, mikrotikName: router.name, action: 'EDIT', ok: true, dryRun: false,
          detail: `local-address vacía → ${nueva} (la de su red; rellenar-ip-local)`, pppUsername: name, userName: 'script',
        } as any });
      }
    } catch (e) {
      console.log(abonado, '→ error', (e as Error).message);
    } finally { api.close(); }
  }
  await prisma.$disconnect();
}
main();
