/**
 * Liga a su OLT las VLANs del catálogo que la PROPIA OLT confirma (2026-09-22).
 *
 * Las 153 VLANs vinieron del legacy con la OLT como texto libre ("Duitama",
 * "Hub local"), sin decir a qué equipo pertenecen. Desde que `/red/vlans` elige
 * la OLT de las registradas (`Vlan.oltId`), las heredadas quedan sin ligar. Este
 * script lee los service-ports de cada OLT y solo liga una fila cuando la VLAN
 * del catálogo es la PRINCIPAL del puerto que dice su bandeja/puerto: eso no lo
 * decide nadie, lo demuestra el equipo. Lo que no casa se lista para revisar a
 * mano; no se toca.
 *
 * Solo lectura contra la OLT (`display board`, `display service-port all`).
 *
 * Uso (desde backend/):
 *   npx ts-node scripts/ligar-vlans-a-olt.ts            # en seco
 *   npx ts-node scripts/ligar-vlans-a-olt.ts --aplicar  # escribe oltId
 */
import { PrismaClient } from '@prisma/client';
import { createOltDriver } from '../src/network/olt/olt-factory';
import { decryptSecret } from '../src/common/secret-box';

const prisma = new PrismaClient();
const APLICAR = process.argv.includes('--aplicar');

async function main() {
  const olts = await prisma.olt.findMany({ where: { branchId: { not: null } }, include: { branch: { select: { name: true } } } });
  let ligadas = 0;
  for (const olt of olts) {
    const driver: any = createOltDriver(olt.brand, olt.ip, olt.port, olt.username, decryptSecret(olt.password), olt.transport as any);
    let puertos: { frame: number; slot: number; port: number; servicios: number; vlans: { vlan: number; servicios: number }[] }[] = [];
    try {
      if (!(await driver.connect())) { console.log(`\n${olt.name}: no conecta (${driver.getError()})`); continue; }
      await driver.prepare();
      puertos = (await driver.vlansPorPuerto()) || [];
    } finally {
      try { driver.disconnect(); } catch { /* cerrando */ }
    }

    const filas = await prisma.vlan.findMany({
      where: { branchId: olt.branchId, OR: [{ oltId: null }, { oltId: olt.id }] },
      orderBy: [{ tray: 'asc' }, { oltPort: 'asc' }, { vlan: 'asc' }],
    });
    const principal = (s: number | null, p: number | null) =>
      s == null || p == null ? undefined : puertos.find((x) => x.frame === 0 && x.slot === s && x.port === p);

    const casan: typeof filas = [];
    const noCasan: string[] = [];
    for (const v of filas) {
      const pto = principal(v.tray, v.oltPort);
      if (pto?.vlans[0]?.vlan === v.vlan) { if (!v.oltId) casan.push(v); continue; }
      noCasan.push(
        `  ${String(v.vlan).padStart(4)} ${v.detail.padEnd(28).slice(0, 28)} → ${v.tray ?? '-'}/${v.oltPort ?? '-'}: `
        + (v.tray == null ? 'sin puerto' : !pto ? 'la OLT no tiene servicios ahí' : `la OLT usa ${pto.vlans[0].vlan}`),
      );
    }
    const sinCatalogo = puertos.filter((p) =>
      p.servicios > 0 && !filas.some((v) => v.tray === p.slot && v.oltPort === p.port));

    console.log(`\n=== ${olt.name} (${olt.branch?.name}) · ${puertos.length} puertos con servicio · catálogo ${filas.length} ===`);
    console.log(`Confirmadas por la OLT y por ligar: ${casan.length}`);
    if (noCasan.length) console.log(`No casan (revisar a mano en Red › VLANs): ${noCasan.length}\n${noCasan.join('\n')}`);
    if (sinCatalogo.length) {
      console.log(`Puertos con servicio que el catálogo no tiene: ${sinCatalogo.length}`);
      console.log('  ' + sinCatalogo.map((p) => `0/${p.slot}/${p.port}=${p.vlans[0].vlan}`).join('  '));
    }
    if (APLICAR && casan.length) {
      await prisma.vlan.updateMany({ where: { id: { in: casan.map((v) => v.id) } }, data: { oltId: olt.id, olt: olt.name } });
      ligadas += casan.length;
    }
  }
  console.log(APLICAR ? `\nLigadas: ${ligadas}.` : '\nEn seco: nada escrito. Repetir con --aplicar.');
}

main().finally(() => prisma.$disconnect());
