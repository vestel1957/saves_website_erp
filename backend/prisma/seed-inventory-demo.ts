/**
 * Datos de PRUEBA de inventario para ver las tablas/secciones con contenido real.
 * Idempotente: el catálogo se hace con upsert; los movimientos solo se crean
 * para productos que aún no tengan ninguno (así re-ejecutar no duplica historial).
 *
 * El catálogo (unidades, marcas, categorías, bodegas, productos) se inserta con
 * Prisma. Los MOVIMIENTOS se envían por la API real (POST /inventory/movements),
 * que pasa por el kardex → stock, costo promedio y existencias quedan consistentes.
 *
 * Requiere el backend corriendo. Ejecutar:
 *   npx ts-node prisma/seed-inventory-demo.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const API = process.env.API_URL ?? 'http://localhost:3051/api';
const ADMIN = { email: 'admin@bhdc.dev', password: 'admin123' };

const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

async function login(): Promise<string> {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ADMIN),
  });
  if (!res.ok) throw new Error(`Login falló (${res.status}). ¿Backend corriendo y seed base ejecutado?`);
  return (await res.json()).token as string;
}

async function move(token: string, body: Record<string, unknown>) {
  const res = await fetch(`${API}/inventory/movements`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Movimiento falló: ${JSON.stringify(err.message ?? err)}`);
  }
}

async function main() {
  // ---- unidades ----------------------------------------------------------
  const uomDefs = [
    { code: 'UND', name: 'Unidad' },
    { code: 'KG', name: 'Kilogramo' },
    { code: 'MT', name: 'Metro' },
    { code: 'LT', name: 'Litro' },
    { code: 'CAJA', name: 'Caja' },
    { code: 'PAR', name: 'Par' },
  ];
  const uoms: Record<string, string> = {};
  for (const u of uomDefs) {
    const r = await prisma.unitOfMeasure.upsert({ where: { code: u.code }, update: { name: u.name }, create: u });
    uoms[u.code] = r.id;
  }

  // ---- marcas ------------------------------------------------------------
  const brandNames = ['Atlas Copco', 'Caterpillar', '3M', 'Shell', 'Bosch', 'Genérica'];
  const brands: Record<string, string> = {};
  for (const name of brandNames) {
    const r = await prisma.brand.upsert({ where: { name }, update: {}, create: { name } });
    brands[name] = r.id;
  }

  // ---- categorías (con jerarquía) ---------------------------------------
  // categorías planas (sin jerarquía: ninguna depende de otra)
  const categoryDefs = [
    { code: 'REPUESTOS', name: 'Repuestos' },
    { code: 'CONSUMIBLES', name: 'Consumibles' },
    { code: 'HERRAMIENTAS', name: 'Herramientas' },
    { code: 'EPP', name: 'EPP — Protección personal' },
    { code: 'LUBRICANTES', name: 'Lubricantes' },
    { code: 'FILTROS', name: 'Filtros' },
    { code: 'RODAMIENTOS', name: 'Rodamientos' },
  ];
  const cats: Record<string, string> = {};
  for (const c of categoryDefs) {
    const r = await prisma.category.upsert({
      where: { code: c.code },
      update: { name: c.name, parentId: null },
      create: c,
    });
    cats[c.code] = r.id;
  }

  // ---- bodegas -----------------------------------------------------------
  const whDefs = [
    { code: 'BOD-01', name: 'Bodega Principal', type: 'MAIN' as const, address: 'Planta 1' },
    { code: 'BOD-02', name: 'Taller Central', type: 'WORKSHOP' as const, address: 'Taller' },
    { code: 'BOD-03', name: 'Almacén de Campo', type: 'SECONDARY' as const, address: 'Campo Norte' },
  ];
  const whs: Record<string, string> = {};
  for (const w of whDefs) {
    const r = await prisma.warehouse.upsert({ where: { code: w.code }, update: { name: w.name }, create: w });
    whs[w.code] = r.id;
  }

  // ---- productos ---------------------------------------------------------
  // c1/c2: costos de las dos compras (para que el promedio se mueva).
  // q1/q2: cantidades compradas. tIn: transferencia a otra bodega. out: salida.
  type PD = {
    sku: string; name: string; type: any; cat: string; brand: string; uom: string;
    c1: number; c2: number; q1: number; q2: number; tIn: number; toWh: string; out: number; outReason: string;
  };
  const products: PD[] = [
    { sku: 'FIL-001', name: 'Filtro de aceite motor CAT 320', type: 'SPARE_PART', cat: 'FILTROS', brand: 'Caterpillar', uom: 'UND', c1: 85000, c2: 92000, q1: 40, q2: 30, tIn: 10, toWh: 'BOD-02', out: 18, outReason: 'INTERNAL_CONSUMPTION' },
    { sku: 'FIL-002', name: 'Filtro de aire compresor', type: 'SPARE_PART', cat: 'FILTROS', brand: 'Atlas Copco', uom: 'UND', c1: 120000, c2: 118000, q1: 25, q2: 20, tIn: 8, toWh: 'BOD-02', out: 12, outReason: 'INTERNAL_CONSUMPTION' },
    { sku: 'ROD-001', name: 'Rodamiento SKF 6205', type: 'SPARE_PART', cat: 'RODAMIENTOS', brand: 'Bosch', uom: 'UND', c1: 45000, c2: 48000, q1: 60, q2: 40, tIn: 15, toWh: 'BOD-02', out: 22, outReason: 'INTERNAL_CONSUMPTION' },
    { sku: 'ROD-002', name: 'Rodamiento cónico 30206', type: 'SPARE_PART', cat: 'RODAMIENTOS', brand: 'Bosch', uom: 'UND', c1: 62000, c2: 65000, q1: 35, q2: 25, tIn: 10, toWh: 'BOD-03', out: 9, outReason: 'INTERNAL_CONSUMPTION' },
    { sku: 'LUB-001', name: 'Aceite hidráulico ISO 68 (caneca 5gal)', type: 'CONSUMABLE', cat: 'LUBRICANTES', brand: 'Shell', uom: 'LT', c1: 18500, c2: 19800, q1: 200, q2: 150, tIn: 40, toWh: 'BOD-03', out: 80, outReason: 'INTERNAL_CONSUMPTION' },
    { sku: 'LUB-002', name: 'Grasa multipropósito EP2', type: 'CONSUMABLE', cat: 'LUBRICANTES', brand: 'Shell', uom: 'KG', c1: 22000, c2: 23500, q1: 80, q2: 60, tIn: 20, toWh: 'BOD-02', out: 35, outReason: 'INTERNAL_CONSUMPTION' },
    { sku: 'EPP-001', name: 'Guantes de nitrilo (par)', type: 'CONSUMABLE', cat: 'EPP', brand: '3M', uom: 'PAR', c1: 8500, c2: 9200, q1: 300, q2: 200, tIn: 60, toWh: 'BOD-03', out: 140, outReason: 'INTERNAL_CONSUMPTION' },
    { sku: 'EPP-002', name: 'Casco de seguridad blanco', type: 'CONSUMABLE', cat: 'EPP', brand: '3M', uom: 'UND', c1: 32000, c2: 33000, q1: 120, q2: 80, tIn: 30, toWh: 'BOD-03', out: 25, outReason: 'INTERNAL_CONSUMPTION' },
    { sku: 'EPP-003', name: 'Gafas de protección antiempañante', type: 'CONSUMABLE', cat: 'EPP', brand: '3M', uom: 'UND', c1: 14000, c2: 15500, q1: 150, q2: 100, tIn: 40, toWh: 'BOD-02', out: 55, outReason: 'INTERNAL_CONSUMPTION' },
    { sku: 'HER-001', name: 'Llave de impacto neumática 1/2"', type: 'TOOL', cat: 'HERRAMIENTAS', brand: 'Atlas Copco', uom: 'UND', c1: 580000, c2: 595000, q1: 8, q2: 4, tIn: 2, toWh: 'BOD-02', out: 1, outReason: 'LOSS' },
    { sku: 'HER-002', name: 'Juego de brocas HSS (19 pzas)', type: 'TOOL', cat: 'HERRAMIENTAS', brand: 'Bosch', uom: 'CAJA', c1: 145000, c2: 152000, q1: 20, q2: 15, tIn: 5, toWh: 'BOD-02', out: 6, outReason: 'INTERNAL_CONSUMPTION' },
    { sku: 'CON-001', name: 'Electrodo soldadura 6011 (kg)', type: 'CONSUMABLE', cat: 'CONSUMIBLES', brand: 'Genérica', uom: 'KG', c1: 12500, c2: 13200, q1: 250, q2: 180, tIn: 50, toWh: 'BOD-02', out: 110, outReason: 'INTERNAL_CONSUMPTION' },
    { sku: 'CON-002', name: 'Cinta teflón industrial', type: 'CONSUMABLE', cat: 'CONSUMIBLES', brand: 'Genérica', uom: 'UND', c1: 2200, c2: 2500, q1: 500, q2: 300, tIn: 100, toWh: 'BOD-03', out: 220, outReason: 'INTERNAL_CONSUMPTION' },
    { sku: 'REP-001', name: 'Manguera hidráulica 1" (metro)', type: 'SPARE_PART', cat: 'REPUESTOS', brand: 'Genérica', uom: 'MT', c1: 28000, c2: 30000, q1: 120, q2: 90, tIn: 30, toWh: 'BOD-03', out: 48, outReason: 'INTERNAL_CONSUMPTION' },
  ];

  const productIds: Record<string, string> = {};
  for (const p of products) {
    const r = await prisma.product.upsert({
      where: { sku: p.sku },
      update: { name: p.name },
      create: {
        sku: p.sku,
        name: p.name,
        type: p.type,
        categoryId: cats[p.cat],
        brandId: brands[p.brand],
        uomId: uoms[p.uom],
        costingMethod: 'AVERAGE',
      },
    });
    productIds[p.sku] = r.id;
  }
  console.log(`✓ catálogo: ${uomDefs.length} unidades, ${brandNames.length} marcas, ${Object.keys(cats).length} categorías, ${whDefs.length} bodegas, ${products.length} productos`);

  // ---- movimientos por la API (solo si el producto no tiene historial) ---
  const token = await login();
  let created = 0;
  let skipped = 0;
  for (const p of products) {
    const productId = productIds[p.sku];
    const existing = await prisma.inventoryMovement.count({ where: { productId } });
    if (existing > 0) { skipped++; continue; }

    // 2 compras a la bodega principal (distinto costo → mueve el promedio)
    await move(token, { productId, type: 'IN', reason: 'PURCHASE', quantity: p.q1, unitCost: p.c1, warehouseToId: whs['BOD-01'], date: daysAgo(90), reference: `OC-${p.sku}-A` });
    await move(token, { productId, type: 'IN', reason: 'PURCHASE', quantity: p.q2, unitCost: p.c2, warehouseToId: whs['BOD-01'], date: daysAgo(45), reference: `OC-${p.sku}-B` });
    // transferencia a otra bodega
    await move(token, { productId, type: 'TRANSFER', reason: 'TRANSFER', quantity: p.tIn, warehouseFromId: whs['BOD-01'], warehouseToId: whs[p.toWh], date: daysAgo(30), reference: `TR-${p.sku}` });
    // consumo / salida
    await move(token, { productId, type: 'OUT', reason: p.outReason, quantity: p.out, warehouseFromId: whs['BOD-01'], date: daysAgo(15), reference: `SAL-${p.sku}` });
    created++;
  }
  console.log(`✓ movimientos: ${created} productos con historial nuevo, ${skipped} ya tenían (sin tocar)`);

  // ---- mantenimientos de prueba (sin descontar stock: sin warehouseId) ---
  {
    const areaByCode = Object.fromEntries((await prisma.area.findMany()).map((a) => [a.code, a.id]));
    const maintPlan = [
      { sku: 'FIL-001', kind: 'PREVENTIVE', days: 40, cost: 120000, tech: 'Tomás Técnico', area: 'PERFORACION', desc: 'Cambio de filtro programado', parts: [{ sku: 'FIL-001', qty: 2 }] },
      { sku: 'FIL-001', kind: 'CORRECTIVE', days: 10, cost: 180000, tech: 'Tomás Técnico', area: 'PERFORACION', desc: 'Reemplazo por obstrucción imprevista', parts: [{ sku: 'FIL-001', qty: 1 }] },
      { sku: 'ROD-001', kind: 'CORRECTIVE', days: 20, cost: 250000, tech: 'Tomás Técnico', area: 'TALLER', desc: 'Cambio de rodamiento por ruido excesivo', parts: [{ sku: 'ROD-001', qty: 2 }] },
      { sku: 'HER-001', kind: 'PREVENTIVE', days: 25, cost: 90000, tech: 'Tomás Técnico', area: 'TALLER', desc: 'Mantenimiento de llave de impacto', parts: [] },
      { sku: 'LUB-001', kind: 'PREVENTIVE', days: 15, cost: 60000, tech: 'Bruno Bodeguero', area: 'PLANTA', desc: 'Lubricación general de equipos', parts: [] },
    ];
    let m = 0;
    let skip = 0;
    for (const mt of maintPlan) {
      const productId = productIds[mt.sku];
      if (!productId) continue;
      // idempotente: no duplica si ya existe ese mantenimiento (producto + descripción)
      const dup = await prisma.maintenanceOrder.findFirst({ where: { productId, description: mt.desc } });
      if (dup) { skip++; continue; }
      const res = await fetch(`${API}/inventory/maintenance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          kind: mt.kind,
          productId,
          areaId: areaByCode[mt.area],
          date: daysAgo(mt.days),
          technician: mt.tech,
          cost: mt.cost,
          description: mt.desc,
          parts: mt.parts.map((p) => ({ productId: productIds[p.sku], quantity: p.qty })),
        }),
      });
      if (res.ok) m++;
      else console.warn(`  ⚠ mantenimiento ${mt.sku} falló: ${res.status}`);
    }
    console.log(`✓ mantenimientos: ${m} creados, ${skip} ya existían`);
  }

  console.log('\n✅ Datos de prueba de inventario listos.');
}

main()
  .catch((e) => {
    console.error('✗', e.message ?? e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
