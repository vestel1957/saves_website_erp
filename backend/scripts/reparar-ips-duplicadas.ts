/**
 * Reparación de IPs repetidas en los Mikrotik (ver `IpAllocatorService.repararDuplicadas`).
 *
 * Por defecto SIMULA: enseña el plan y no toca ni el router ni la base. Para
 * ejecutar de verdad hay que pasar `--aplicar` a conciencia — cambia la IP de
 * clientes que están conectados y les cierra la sesión PPP.
 *
 *   npx ts-node --transpile-only scripts/reparar-ips-duplicadas.ts            (simula todos)
 *   npx ts-node --transpile-only scripts/reparar-ips-duplicadas.ts --router=Yopal
 *   npx ts-node --transpile-only scripts/reparar-ips-duplicadas.ts --router=Yopal --aplicar
 */
import 'reflect-metadata';
import { ipAllocatorService, prismaService } from '../src/core/contenedor';

async function main() {
  const args = process.argv.slice(2);
  const aplicar = args.includes('--aplicar');
  const filtro = args.find((a) => a.startsWith('--router='))?.split('=')[1];
  const limite = Number(args.find((a) => a.startsWith('--limite='))?.split('=')[1] ?? 0);

  const routers = (await prismaService.mikrotik.findMany()).filter(
    (r) => !filtro || r.name.toLowerCase().includes(filtro.toLowerCase()),
  );
  // EOC y EPON son la misma caja: se procesa una vez por host físico.
  const vistos = new Set<string>();

  console.log(aplicar ? '*** APLICANDO DE VERDAD ***\n' : '--- SIMULACIÓN (nada se toca) ---\n');
  for (const mk of routers) {
    const host = `${mk.ip}:${mk.port}`;
    if (vistos.has(host)) { console.log(`${mk.name}: mismo equipo que otro ya procesado (${host}), se omite.`); continue; }
    vistos.add(host);
    try {
      const r = await ipAllocatorService.repararDuplicadas(mk, { dryRun: !aplicar, limite });
      console.log(`\n=== ${r.router} (${r.host}) — ${r.total} a mudar${aplicar ? ` · ok ${r.aplicadas} · fallo ${r.fallidas}` : ''}`);
      for (const a of r.acciones.slice(0, 12)) {
        const marca = a.ok === true ? 'OK ' : a.ok === false ? 'ERR' : '   ';
        console.log(`   ${marca} ${a.usuario.padEnd(24)} ${a.ipVieja.padEnd(15)} -> ${a.ipNueva ?? '(sin IP libre)'}${a.cortado ? '  [CORTADO]' : ''}${a.activo ? '  [conectado]' : ''}${a.motivo ? `  ${a.motivo}` : ''}`);
      }
      if (r.acciones.length > 12) console.log(`   … y ${r.acciones.length - 12} más`);
    } catch (e) {
      console.log(`\n=== ${mk.name} === FALLO: ${(e as Error).message}`);
    }
  }
  await prismaService.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
