/**
 * ETL del grupo "valores" (Stock): material, categorías, bodegas, proveedores,
 * órdenes de compra/servicio y actas de traspaso. vestel_dev (MySQL) → saves_vestel (PG).
 * Idempotente por legacyId (borra y recarga estos modelos).
 */
const mysql = require('mysql2/promise');
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

const dOnly = (d) => (d ? new Date(d) : null);
const n = (v) => (v == null ? 0 : Number(v));
const s = (v) => (v == null || v === '' ? null : String(v));

async function chunkedCreate(model, rows, size = 1000) {
  let done = 0;
  for (let i = 0; i < rows.length; i += size) {
    await p[model].createMany({ data: rows.slice(i, i + size), skipDuplicates: true });
    done += Math.min(size, rows.length - i);
  }
  return done;
}
async function mapBy(model, key = 'legacyId') {
  const rows = await p[model].findMany({ select: { id: true, [key]: true } });
  const m = new Map();
  for (const r of rows) if (r[key] != null) m.set(r[key], r.id);
  return m;
}

(async () => {
  const my = await mysql.createConnection({ host: 'localhost', user: 'admin_vestel', password: 'Vestel_2025!', database: 'vestel_dev' });
  const q = async (sql) => (await my.query(sql))[0];

  console.log('Limpiando modelos valores…');
  await p.materialActaItem.deleteMany({});
  await p.materialActa.deleteMany({});
  await p.supplyOrderItem.deleteMany({});
  await p.supplyOrder.deleteMany({});
  await p.stockReturnItem.deleteMany({});
  await p.stockReturn.deleteMany({});
  await p.material.deleteMany({});
  await p.materialCategory.deleteMany({});
  await p.materialWarehouse.deleteMany({});
  await p.supplier.deleteMany({});

  // 1. Categorías
  const cats = await q('SELECT * FROM product_cat');
  await chunkedCreate('materialCategory', cats.map((c) => ({ legacyId: c.id, title: s(c.title) || `Cat ${c.id}`, extra: s(c.extra) })));
  const catMap = await mapBy('materialCategory');
  console.log('categorías:', cats.length);

  // 2. Bodegas de material
  const whs = await q('SELECT * FROM product_warehouse');
  await chunkedCreate('materialWarehouse', whs.map((w) => ({ legacyId: w.id, title: s(w.title) || `Bodega ${w.id}`, extra: s(w.extra), technicianRef: s(w.id_tecnico) })));
  const whMap = await mapBy('materialWarehouse');
  console.log('bodegas:', whs.length);

  // 3. Material
  const prods = await q('SELECT * FROM products');
  await chunkedCreate('material', prods.map((r) => ({
    legacyId: r.pid, categoryId: catMap.get(r.pcat) || null, categoryLegacy: r.pcat,
    warehouseId: whMap.get(r.warehouse) || null, warehouseLegacy: r.warehouse, branchRef: r.sede ?? null,
    name: s(r.product_name) || `Material ${r.pid}`, code: s(r.product_code),
    price: n(r.product_price), cost: n(r.fproduct_price), taxRate: n(r.taxrate), discRate: n(r.disrate),
    qty: n(r.qty), description: s(r.product_des), alert: r.alert ?? null,
    serviceType: s(r.tipo_servicio), tvOrNet: s(r.pertence_a_tv_o_net),
  })));
  const matMap = await mapBy('material');
  console.log('material:', prods.length);

  // 4. Proveedores
  const sups = await q('SELECT * FROM supplier');
  await chunkedCreate('supplier', sups.map((r) => ({
    legacyId: r.id, category: r.categoria ?? 1, name: s(r.name) || `Proveedor ${r.id}`,
    nit: s(r.nit), phone: s(r.phone), email: s(r.email), address: s(r.address), city: s(r.city), region: s(r.region),
    payMethod: s(r.pago), account: s(r.cuenta), accountType: s(r.typo), bank: s(r.banco), company: s(r.company), branchRef: r.gid ?? null,
  })));
  const supMap = await mapBy('supplier');
  const supCat = new Map(sups.map((r) => [r.id, r.categoria ?? 1]));
  console.log('proveedores:', sups.length);

  // 5. Órdenes (purchase) — tid es la clave; kind por categoría del proveedor
  const orders = await q('SELECT * FROM purchase');
  await chunkedCreate('supplyOrder', orders.map((r) => ({
    legacyId: r.id, tid: r.tid, supplierId: supMap.get(r.csd) || null, supplierLegacy: r.csd ?? null,
    orderDate: dOnly(r.invoicedate), dueDate: dOnly(r.invoiceduedate),
    subtotal: n(r.subtotal), shipping: n(r.shipping), discount: n(r.discount), tax: n(r.tax), total: n(r.total),
    paidAmount: n(r.pamnt), status: s(r.status) || 'pendiente', categoryRef: s(r.idcat),
    warehouseRef: r.almacen_seleccionado ?? null, branchRef: s(r.refer), notes: s(r.notes), itemsCount: n(r.items),
    receivedBy: r.recibe ?? null, receivedAt: r.fcha_recibido ? new Date(r.fcha_recibido) : null,
    retentionType: s(r.tipo_retencion), retention: n(r.retencion),
    kind: (supCat.get(r.csd) === 2) ? 'servicio' : 'compra',
  })));
  const orderMap = await mapBy('supplyOrder', 'tid'); // tid → id
  console.log('órdenes:', orders.length);

  // 6. Ítems de orden (por tid)
  const oitems = await q('SELECT * FROM purchase_items');
  await chunkedCreate('supplyOrderItem', oitems.map((r) => ({
    legacyId: r.id, orderId: orderMap.get(r.tid), materialId: matMap.get(r.pid) || null, materialLegacy: r.pid ?? null,
    product: s(r.product), qty: n(r.qty), price: n(r.price), taxRate: n(r.tax), discount: n(r.discount),
    subtotal: n(r.subtotal), taxTotal: n(r.totaltax), discountTotal: n(r.totaldiscount), description: s(r.product_des),
    receivedQty: n(r.qty_en_almacen),
  })).filter((x) => x.orderId));
  console.log('ítems de orden:', oitems.length);

  // 7. Actas de material
  const actas = await q('SELECT * FROM acta_transferencias');
  const whName = new Map(whs.map((w) => [w.id, s(w.title)]));
  await chunkedCreate('materialActa', actas.map((r) => ({
    legacyId: r.id, date: r.fecha ? new Date(r.fecha) : new Date(),
    fromWarehouseLegacy: r.almacen_origen ?? null, toWarehouseLegacy: r.almacen_destino ?? null,
    fromWarehouseName: whName.get(r.almacen_origen) || null, toWarehouseName: whName.get(r.almacen_destino) || null,
    observations: s(r.observaciones), userId: r.id_usuario_que_transfiere ?? null,
    status: s(r.estado) || 'Emitida', receivedBy: r.id_usuario_recibe ?? null,
    receivedAt: r.fecha_recepcion ? new Date(r.fecha_recepcion) : null,
  })));
  const actaMap = await mapBy('materialActa');
  console.log('actas:', actas.length);

  // 8. Ítems de acta (resolver pid vía transferencias.producto_a)
  const aitems = await q(`SELECT i.id, i.id_acta_transferencia, i.cantidad, t.producto_a AS pid
                          FROM items_acta_transferencias i
                          LEFT JOIN transferencias t ON t.id_transferencia = i.id_transferencia`);
  await chunkedCreate('materialActaItem', aitems.map((r) => ({
    legacyId: r.id, actaId: actaMap.get(r.id_acta_transferencia),
    materialId: matMap.get(r.pid) || null, materialLegacy: r.pid ?? null, qty: n(r.cantidad),
  })).filter((x) => x.actaId));
  console.log('ítems de acta:', aitems.length);

  // Conteos finales
  for (const m of ['materialCategory', 'materialWarehouse', 'material', 'supplier', 'supplyOrder', 'supplyOrderItem', 'materialActa', 'materialActaItem']) {
    console.log('  ✔', m, await p[m].count());
  }
  await my.end(); await p.$disconnect();
  console.log('ETL valores OK');
})().catch((e) => { console.error(e); process.exit(1); });
