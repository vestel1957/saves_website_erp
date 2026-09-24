/**
 * Salud de VLANs contra la BD y los equipos REALES (2026-09-23). SOLO LECTURA:
 * la OLT recibe `display board`, `display service-port all`, `display vlan all`,
 * `display vlan 1`, `display port vlan …`; los Mikrotik `/print`. Los planes de
 * configuración se piden en dry-run (el servicio no llama a ningún escritor).
 *
 * Uso (desde backend/, salida a archivo): npx ts-node scripts/smoke-vlan-salud.ts > salida.txt
 */
import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { OltService } from '../src/network/olt.service';
import { MikrotikService } from '../src/network/mikrotik.service';
import { VlanEquiposService } from '../src/network/vlan-equipos.service';

async function main() {
  const prisma = new PrismaClient();
  const olt = new OltService(prisma as any);
  const mk = new MikrotikService(prisma as any, undefined as any, undefined as any);
  const svc = new VlanEquiposService(prisma as any, olt, mk);
  // SEDES=Villanueva,Yopal limita (una OLT ocupada por otro proceso rechaza sesiones).
  const nombres = (process.env.SEDES ?? 'Villanueva,Yopal,Monterrey,Tauramena').split(',');
  const sedes = await prisma.branch.findMany({ where: { name: { in: nombres } } });
  // SOLO_CHEQUEO=1: solo el aviso rápido de puerto (lo que ve el técnico antes de autenticar).
  if (process.env.SOLO_CHEQUEO === '1') {
    const vill = await prisma.olt.findFirst({ where: { name: 'VILLANUEVA' } });
    for (const [slot, port, vlan] of [[2, 13, null], [0, 14, 102], [2, 15, null]] as const) {
      const t = Date.now();
      const r = await svc.chequeoDePuerto(vill!.id, 0, slot, port, vlan);
      console.log(`\n== chequeo VILLANUEVA 0/${slot}/${port}${vlan ? ` (VLAN forzada ${vlan})` : ''} · ${Date.now() - t} ms:`, JSON.stringify(r));
    }
    await prisma.$disconnect();
    return;
  }
  for (const s of sedes) {
    let t = Date.now();
    const r = await svc.salud(s.id, true);
    console.log(`\n== ${s.name}: salud en ${Date.now() - t} ms · errores Mikrotik: ${r.mikrotikErrores.join('; ') || '—'}`);
    for (const o of r.olts) {
      const cuenta: Record<string, number> = {};
      for (const f of o.filas) cuenta[f.estado] = (cuenta[f.estado] ?? 0) + 1;
      console.log(`  OLT ${o.name}: ok=${o.ok} ${o.error ?? ''} uplink=${JSON.stringify(o.uplink)} router=${o.router?.name ?? '—'} estados=${JSON.stringify(cuenta)}`);
      for (const f of o.filas.filter((x) => x.estado !== 'OK')) console.log(`    ${f.vlan} ${f.estado}: ${f.falta.join('; ')}`);
    }
    t = Date.now();
    const r2 = await svc.salud(s.id, false);
    console.log(`  segunda lectura (caché): ${Date.now() - t} ms, cached=${r2.olts.map((o: any) => o.cached).join(',')}`);
  }

  // Planes en dry-run.
  const cat = async (sede: string, vlan: number) => prisma.vlan.findFirst({ where: { vlan, branch: { name: sede } } });
  for (const [sede, vlan] of [['Villanueva', 590], ['Villanueva', 580], ['Yopal', 185]] as const) {
    if (!nombres.includes(sede)) continue;
    const v = await cat(sede, vlan);
    if (!v) { console.log(`\n(sin fila de catálogo ${sede} ${vlan})`); continue; }
    const t = Date.now();
    const r = await svc.configurarEquipos(v.id, { dryRun: true });
    console.log(`\n== dry-run ${sede} ${vlan} (${Date.now() - t} ms):`);
    console.dir(r, { depth: 5 });
  }

  // Monterrey 330 (creada en la OLT, fuera del catálogo): el plan directo.
  const mont = nombres.includes('Monterrey') ? await prisma.olt.findFirst({ where: { name: 'MONTERREY' } }) : null;
  if (mont) {
    const l = await olt.lecturaVlansDeOlt(mont.id, false);
    const { routers } = await mk.vlansDeRoutersDeSede(mont.branchId!);
    const p1: any = svc.plan(330, l.data!, routers, null);
    console.log('\n== plan Monterrey 330 sin uplink elegido:', JSON.stringify({ necesitaUplink: p1.necesitaUplink, candidatos: p1.candidatos, avisos: p1.avisos }));
    const p2: any = svc.plan(330, l.data!, routers, '0/3/0');
    console.log('== plan Monterrey 330 con 0/3/0:', JSON.stringify({ olt: p2.olt, interfaz: p2.interfaz, mk: p2.mk.pasos, avisos: p2.avisos }));
  }

  const vill = nombres.includes('Villanueva') ? await prisma.olt.findFirst({ where: { name: 'VILLANUEVA' } }) : null;
  if (vill) {
    for (const [slot, port] of [[2, 15], [2, 13], [1, 3]]) {
      console.log(`\n== sugerir VILLANUEVA 0/${slot}/${port}:`, JSON.stringify(await svc.sugerir(vill.id, 0, slot, port)));
    }
  }
  await prisma.$disconnect();
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
