/**
 * La sede de las cajas NAP y las VLANs (2026-09-19). Idempotente.
 *
 * El ETL de red montó `Nap.branchId` y `Vlan.branchId` con el catálogo equivocado.
 * En el legacy, `naps.sede` / `vlans.sede` / `puertos.sede` NO apuntan a
 * `customers_group` (las sedes de los clientes) sino a `almacen_equipos` (las
 * bodegas), como se ve en su propio modelo:
 *
 *   Redes_model.php:250  join('almacen_equipos', 'almacen_equipos.id = naps.sede')
 *
 * Los dos catálogos se parecen —números bajos, los mismos pueblos— pero están
 * corridos, así que `scripts/etl-red.js` (bid(x.sede) = Branch.legacyId) dejó TODAS
 * las cajas en la sede de al lado: las 199 de "Villavicencio" eran de Tauramena, las
 * 305 de "Mocoa" eran de Monterrey, las 508 de "Yopal" eran de Villanueva.
 *
 * Lo confirmaron por separado el GPS de las cajas (461 con coordenada: 462/466
 * aciertos contra el pueblo más cercano) y los clientes colgados de sus puertos.
 *
 * El mapa bueno ya estaba en la base: `EquipmentWarehouse.branchLegacy`, que dedujo
 * `migrate-bodegas-equipos-sede-2026-07.ts` del nombre de la bodega. De cada sede se
 * toma la bodega de `legacyId` más bajo (la que se llama igual que el pueblo, no las
 * "cabecera"), que es la que usan naps/vlans.
 *
 * Qué toca:
 *  1. `Nap.branchId` y `Vlan.branchId` ← bodega de `sedeLegacy`.
 *  2. El `sedeLegacy` de lo nacido en Nexus: `createNap`/`createVlan` guardaban el id
 *     de `customers_group`, que en el catálogo de bodegas es otro pueblo o no existe
 *     (las 8 cajas VLLC3 quedaron con 3, que no es ninguna bodega). Se traduce al id
 *     de bodega, y con él los puertos de esas cajas.
 *
 * Una sede sin bodega (Mocoa) o una bodega nueva sin mapear se reportan, no se
 * adivinan: la caja se queda como está y sale en la lista de pendientes.
 *
 * Respaldo: escribe `prisma/_respaldo-sede-naps-<fecha>.json` con el estado previo de
 * cada NAP, VLAN y puerto tocado antes de escribir nada.
 *
 * Correr:  npx ts-node prisma/migrate-sede-naps-almacen-2026-09.ts [--aplicar]
 * Sin `--aplicar` solo enseña lo que haría.
 */
import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();
const APLICAR = process.argv.includes('--aplicar');

async function main() {
  // --- Mapa bodega (almacen_equipos.id) → sede -------------------------------
  const bodegas = await prisma.equipmentWarehouse.findMany({
    where: { branchLegacy: { not: null } },
    orderBy: { legacyId: 'asc' },
    select: { legacyId: true, name: true, branchLegacy: true },
  });
  const sedes = await prisma.branch.findMany({ select: { id: true, legacyId: true, name: true } });
  const sedePorLegacy = new Map(sedes.map((s) => [s.legacyId, s]));

  /** bodega → sede */
  const sedeDeBodega = new Map<number, { id: string; legacyId: number; name: string }>();
  /** sede → bodega (la de id más bajo: la del pueblo, no la "cabecera") */
  const bodegaDeSede = new Map<number, number>();
  for (const b of bodegas) {
    const sede = sedePorLegacy.get(b.branchLegacy!);
    if (!sede) continue;
    sedeDeBodega.set(b.legacyId, sede);
    if (!bodegaDeSede.has(sede.legacyId)) bodegaDeSede.set(sede.legacyId, b.legacyId);
  }

  console.log('Catálogo de bodegas (así se lee `sede` en naps/vlans/puertos):');
  for (const [alm, sede] of [...sedeDeBodega].sort((a, b) => a[0] - b[0])) {
    console.log(`  almacén ${String(alm).padStart(2)} → ${sede.name}`);
  }
  const sinBodega = sedes.filter((s) => !bodegaDeSede.has(s.legacyId)).map((s) => s.name);
  if (sinBodega.length) console.log(`  (sedes sin bodega, no pueden tener cajas: ${sinBodega.join(', ')})`);
  console.log('');

  // --- Respaldo --------------------------------------------------------------
  const napsAntes = await prisma.nap.findMany({ select: { id: true, legacyId: true, name: true, sedeLegacy: true, branchId: true } });
  const vlansAntes = await prisma.vlan.findMany({ select: { id: true, legacyId: true, vlan: true, sedeLegacy: true, branchId: true } });
  const puertosAntes = await prisma.port.findMany({ select: { id: true, legacyId: true, sedeLegacy: true } });
  const respaldo = path.join(__dirname, `_respaldo-sede-naps-${new Date().toISOString().slice(0, 10)}.json`);
  if (APLICAR) {
    fs.writeFileSync(respaldo, JSON.stringify({ naps: napsAntes, vlans: vlansAntes, ports: puertosAntes }, null, 1));
    console.log(`Respaldo: ${respaldo} (${napsAntes.length} NAPs, ${vlansAntes.length} VLANs, ${puertosAntes.length} puertos)\n`);
  }

  // --- 1. sedeLegacy de lo nacido en Nexus -----------------------------------
  // Son las filas cuyo `sedeLegacy` no es ninguna bodega pero sí es una sede: las
  // guardó `createNap`/`createVlan` con el catálogo de clientes.
  const traduce = (sedeLegacy: number) => {
    if (sedeDeBodega.has(sedeLegacy)) return null; // ya está en el catálogo bueno
    return bodegaDeSede.get(sedeLegacy) ?? null;
  };

  const napsATraducir = napsAntes.filter((n) => traduce(n.sedeLegacy) != null);
  const vlansATraducir = vlansAntes.filter((v) => traduce(v.sedeLegacy) != null);
  if (napsATraducir.length || vlansATraducir.length) {
    console.log('Nacidas en Nexus con el catálogo de clientes (se traduce `sedeLegacy`):');
    for (const n of napsATraducir) console.log(`  NAP  ${n.name.padEnd(12)} ${n.sedeLegacy} → ${traduce(n.sedeLegacy)}`);
    for (const v of vlansATraducir) console.log(`  VLAN ${String(v.vlan).padEnd(12)} ${v.sedeLegacy} → ${traduce(v.sedeLegacy)}`);
    if (APLICAR) {
      for (const n of napsATraducir) {
        const alm = traduce(n.sedeLegacy)!;
        await prisma.nap.update({ where: { id: n.id }, data: { sedeLegacy: alm } });
        await prisma.port.updateMany({ where: { napId: n.id }, data: { sedeLegacy: alm } });
      }
      for (const v of vlansATraducir) await prisma.vlan.update({ where: { id: v.id }, data: { sedeLegacy: traduce(v.sedeLegacy)! } });
    }
    console.log('');
  }

  // --- 2. branchId de NAPs y VLANs -------------------------------------------
  const sedeFinalDe = (sedeLegacy: number) => sedeDeBodega.get(traduce(sedeLegacy) ?? sedeLegacy) ?? null;

  const mueve = new Map<string, number>(); // "de → a" : cuántas
  const pendientes: string[] = [];
  let napsTocadas = 0;
  for (const n of napsAntes) {
    const destino = sedeFinalDe(n.sedeLegacy);
    if (!destino) {
      pendientes.push(`NAP ${n.name} (sede ${n.sedeLegacy})`);
      continue;
    }
    if (n.branchId === destino.id) continue;
    const antes = sedes.find((s) => s.id === n.branchId)?.name ?? '(sin sede)';
    mueve.set(`${antes} → ${destino.name}`, (mueve.get(`${antes} → ${destino.name}`) ?? 0) + 1);
    napsTocadas++;
    if (APLICAR) await prisma.nap.update({ where: { id: n.id }, data: { branchId: destino.id } });
  }

  let vlansTocadas = 0;
  const mueveV = new Map<string, number>();
  for (const v of vlansAntes) {
    const destino = sedeFinalDe(v.sedeLegacy);
    if (!destino) {
      pendientes.push(`VLAN ${v.vlan} (sede ${v.sedeLegacy})`);
      continue;
    }
    if (v.branchId === destino.id) continue;
    const antes = sedes.find((s) => s.id === v.branchId)?.name ?? '(sin sede)';
    mueveV.set(`${antes} → ${destino.name}`, (mueveV.get(`${antes} → ${destino.name}`) ?? 0) + 1);
    vlansTocadas++;
    if (APLICAR) await prisma.vlan.update({ where: { id: v.id }, data: { branchId: destino.id } });
  }

  console.log(`Cajas NAP que ${APLICAR ? 'se movieron' : 'se moverían'} (${napsTocadas}):`);
  for (const [k, n] of [...mueve].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`);
  console.log(`\nVLANs (${vlansTocadas}):`);
  for (const [k, n] of [...mueveV].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`);

  if (pendientes.length) {
    console.log(`\nSIN MAPEAR (se quedan como están, hay que mirarlas a mano) — ${pendientes.length}:`);
    for (const p of pendientes.slice(0, 20)) console.log(`  ${p}`);
    if (pendientes.length > 20) console.log(`  … y ${pendientes.length - 20} más`);
  }

  // --- Cómo queda ------------------------------------------------------------
  if (APLICAR) {
    const final = await prisma.branch.findMany({
      orderBy: { name: 'asc' },
      select: { name: true, _count: { select: { naps: true, vlans: true } } },
    });
    console.log('\nComo queda:');
    for (const b of final) console.log(`  ${b.name.padEnd(14)} ${String(b._count.naps).padStart(4)} cajas · ${String(b._count.vlans).padStart(3)} VLANs`);
    const huerfanas = await prisma.nap.count({ where: { branchId: null } });
    if (huerfanas) console.log(`  (sin sede)     ${String(huerfanas).padStart(4)} cajas`);
  } else {
    console.log('\n(ensayo: nada se escribió — corre con --aplicar)');
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
