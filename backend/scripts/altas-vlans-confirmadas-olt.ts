/**
 * Da de alta en el catálogo (`/red/vlans`) las VLANs que la OLT CONFIRMA como
 * principales de su PON y que el catálogo no tiene (2026-09-23, Fase 6 del
 * trabajo nocturno de VLANs). Ejemplo: la 600 de Villanueva 0/2/14, con 17
 * abonados, no estaba.
 *
 * Mismo criterio que `ligar-vlans-a-olt.ts`, más estricto para no duplicar:
 *  - el PON tiene service-ports y NINGUNA fila del catálogo apunta a él;
 *  - la VLAN es la principal de ese PON y de ningún otro;
 *  - ese número NO está ya en el catálogo de la sede (si está en otro puerto es
 *    una fila mal ubicada: se lista para corregirla en Red › VLANs, no se duplica).
 * Nada que la OLT no confirme. Solo lectura contra la OLT (`display`).
 * Las altas pasan por `NetworkWriteService.createVlan` (las mismas reglas que la
 * pantalla). El detalle (barrio) no lo sabe la OLT: queda "PON 0/s/p (revisar barrio)".
 *
 * Uso (desde backend/, salida a archivo):
 *   npx ts-node scripts/altas-vlans-confirmadas-olt.ts            # en seco
 *   npx ts-node scripts/altas-vlans-confirmadas-olt.ts --aplicar  # crea las filas
 */
import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { OltService } from '../src/network/olt.service';
import { NetworkWriteService } from '../src/network/network-write.service';

const APLICAR = process.argv.includes('--aplicar');

async function main() {
  const prisma = new PrismaClient();
  const oltSvc = new OltService(prisma as any);
  const u = undefined as any;
  const escritura = new NetworkWriteService(prisma as any, u, u, u);
  const olts = await prisma.olt.findMany({ where: { branchId: { not: null } }, include: { branch: { select: { name: true } } }, orderBy: { name: 'asc' } });
  let creadas = 0;
  for (const olt of olts) {
    const l = await oltSvc.lecturaVlansDeOlt(olt.id, true);
    if (!l.ok || !l.data) { console.log(`\n=== ${olt.name}: la OLT no respondió (${l.error}) — nada que dar de alta.`); continue; }
    const catalogo = await prisma.vlan.findMany({ where: { branchId: olt.branchId } });
    const principalDe = new Map<number, string[]>();
    for (const p of l.data.puertos) {
      const v = p.vlans[0]?.vlan;
      if (v) principalDe.set(v, [...(principalDe.get(v) ?? []), `${p.frame}/${p.slot}/${p.port}`]);
    }
    const alta: { vlan: number; slot: number; port: number; servicios: number }[] = [];
    const saltadas: string[] = [];
    for (const p of l.data.puertos) {
      if (p.servicios === 0 || !p.vlans[0]) continue;
      const fsp = `${p.frame}/${p.slot}/${p.port}`;
      const enCatalogo = catalogo.some((c) => c.tray === p.slot && c.oltPort === p.port && (c.oltId === olt.id || c.oltId == null));
      if (enCatalogo) continue;
      const v = p.vlans[0].vlan;
      const otrosPuertos = (principalDe.get(v) ?? []).filter((x) => x !== fsp);
      const yaEsta = catalogo.filter((c) => c.vlan === v);
      if (otrosPuertos.length) { saltadas.push(`${fsp}=${v}: también es la principal de ${otrosPuertos.join(', ')}`); continue; }
      if (yaEsta.length) {
        saltadas.push(`${fsp}=${v}: el catálogo ya tiene la ${v} en ${yaEsta.map((c) => (c.tray != null ? `${c.tray}/${c.oltPort}` : 'sin puerto')).join(', ')} → corregir esa fila`);
        continue;
      }
      alta.push({ vlan: v, slot: p.slot, port: p.port, servicios: p.servicios });
    }
    console.log(`\n=== ${olt.name} (${olt.branch?.name}) · ${alta.length} para dar de alta · ${saltadas.length} saltadas`);
    for (const a of alta) console.log(`  + VLAN ${a.vlan} en 0/${a.slot}/${a.port} (${a.servicios} service-ports)`);
    for (const s of saltadas) console.log(`  · ${s}`);
    if (!APLICAR) continue;
    for (const a of alta) {
      try {
        const r = await escritura.createVlan({
          branchId: olt.branchId!, vlan: a.vlan, detail: `PON 0/${a.slot}/${a.port} (revisar barrio)`,
          oltId: olt.id, tray: a.slot, oltPort: a.port,
        } as any);
        creadas++;
        console.log(`  ✓ creada ${r.vlan} (${r.id})`);
      } catch (e) {
        console.log(`  ✗ ${a.vlan} en 0/${a.slot}/${a.port}: ${(e as Error).message}`);
      }
    }
  }
  console.log(APLICAR ? `\nCreadas: ${creadas}.` : '\nEn seco: nada escrito. Repetir con --aplicar.');
  await prisma.$disconnect();
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
