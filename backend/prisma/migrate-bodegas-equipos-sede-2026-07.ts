/**
 * Sede de cada bodega de equipos (2026-07-30). Idempotente.
 *
 * `EquipmentWarehouse` no tenía sede (el legacy `almacen_equipos` solo guarda el
 * nombre), así que no había con qué acotar a una cajera ni con qué saber si una
 * transferencia va ENTRE SEDES —que es lo único que necesita firma con OTP—.
 *
 * La sede se deduce del NOMBRE, que en las 12 bodegas reales la dice: 6 se llaman
 * igual que la sede y 5 son las "cabecera" de una sede. La excepción es "Depurados"
 * (3.948 equipos dados de baja): no es una sede, se queda en NULL y por tanto solo
 * la mueve el jefe de bodega.
 *
 * Si mañana aparece una bodega nueva, este script la reporta como SIN MAPEAR en vez
 * de adivinar: una bodega sin sede queda fuera del alcance de las cajeras, que es el
 * lado seguro, pero conviene saberlo.
 *
 * Correr:  npx ts-node prisma/migrate-bodegas-equipos-sede-2026-07.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/** Bodegas que a propósito NO tienen sede (no son una sede, son un destino lógico). */
const SIN_SEDE = ['depurados'];

const normaliza = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // sin tildes
    .trim();

async function main() {
  const sedes = await prisma.branch.findMany({ select: { legacyId: true, name: true } });
  const bodegas = await prisma.equipmentWarehouse.findMany({
    orderBy: { legacyId: 'asc' },
    select: { id: true, legacyId: true, name: true, branchLegacy: true, _count: { select: { equipment: true } } },
  });

  const sinMapear: string[] = [];
  for (const b of bodegas) {
    const nombre = normaliza(b.name);
    if (SIN_SEDE.includes(nombre)) {
      if (b.branchLegacy != null) await prisma.equipmentWarehouse.update({ where: { id: b.id }, data: { branchLegacy: null } });
      console.log(`  ${String(b.legacyId).padStart(3)} ${b.name.padEnd(30)} → SIN SEDE (a propósito)`);
      continue;
    }
    // "Almacen cabecera Yopal", "CABECERA YOPAL", "Yopal" → todas son Yopal.
    const sede = sedes.find((s) => nombre.includes(normaliza(s.name)));
    if (!sede) {
      sinMapear.push(`${b.legacyId} ${b.name} (${b._count.equipment} equipos)`);
      console.log(`  ${String(b.legacyId).padStart(3)} ${b.name.padEnd(30)} → ⚠ SIN MAPEAR (queda sin sede)`);
      continue;
    }
    if (b.branchLegacy === sede.legacyId) {
      console.log(`  ${String(b.legacyId).padStart(3)} ${b.name.padEnd(30)} → ${sede.name} (ya estaba)`);
      continue;
    }
    await prisma.equipmentWarehouse.update({ where: { id: b.id }, data: { branchLegacy: sede.legacyId } });
    console.log(`  ${String(b.legacyId).padStart(3)} ${b.name.padEnd(30)} → ${sede.name} (sede ${sede.legacyId}) ✓`);
  }

  const conSede = await prisma.equipmentWarehouse.count({ where: { branchLegacy: { not: null } } });
  console.log(`\n✓ ${conSede} de ${bodegas.length} bodegas de equipos tienen sede.`);
  if (sinMapear.length) {
    console.log('\n⚠ Sin mapear (nadie que no sea jefe de bodega las va a ver):');
    for (const s of sinMapear) console.log(`    · ${s}`);
  }

  // Cuántas cajeras quedan con sede: sin sede no pueden crear ni firmar.
  const cajeras = await prisma.user.findMany({
    where: { roles: { some: { role: { key: 'area-caja' } } } },
    select: { name: true, email: true, whatsappPhone: true, cajaLegacyId: true, sedesAccede: true },
  });
  const cuentas = await prisma.cashAccount.findMany({ select: { legacyId: true, branchLegacy: true } });
  const sedeDeCaja = new Map(cuentas.filter((c) => c.legacyId != null).map((c) => [c.legacyId as number, c.branchLegacy]));
  const sinSede: string[] = []; const sinCelular: string[] = [];
  for (const c of cajeras) {
    const propias = new Set<number>(c.sedesAccede ?? []);
    const suya = c.cajaLegacyId != null ? sedeDeCaja.get(c.cajaLegacyId) : null;
    if (suya != null && suya > 0) propias.add(suya);
    if (!propias.size) sinSede.push(`${c.name} <${c.email}>`);
    if (!c.whatsappPhone) sinCelular.push(`${c.name} <${c.email}>`);
  }
  console.log(`\n  ℹ Cajeras: ${cajeras.length}. Sin sede (no crean ni firman): ${sinSede.length}. Sin celular (no reciben el OTP): ${sinCelular.length}.`);
  for (const s of sinSede) console.log(`    · SIN SEDE   ${s}`);
  for (const s of sinCelular) console.log(`    · SIN CELULAR ${s}`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
