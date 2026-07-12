/**
 * Seed DEMO de los módulos nuevos de inventario.
 *
 * No inserta a mano en la BD: llama a los endpoints REALES con el token de admin,
 * de modo que ejercita los servicios de verdad (kardex, numeración, motor de
 * alertas, flujos de estado). Pensado para "ver cómo funciona".
 *
 * Uso:  npx ts-node prisma/seed-inventory-modules.ts
 */

const API = process.env.API_URL ?? 'http://localhost:3051/api';
const CREDS = { email: 'admin@bhdc.dev', password: 'admin123' };

let TOKEN = '';

async function api(path: string, init: any = {}): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const msg = body?.message ?? body ?? res.statusText;
    throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status}: ${Array.isArray(msg) ? msg.join(', ') : msg}`);
  }
  return body;
}

const iso = (daysFromNow = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString();
};

async function main() {
  console.log('🔐 Login admin…');
  const login = await api('/auth/login', { method: 'POST', body: JSON.stringify(CREDS) });
  TOKEN = login.token;

  // ---- datos base ----
  const productsRaw = await api('/inventory/products');
  const products: any[] = Array.isArray(productsRaw) ? productsRaw : productsRaw.data ?? [];
  const warehouses: any[] = await api('/inventory/warehouses');
  const stock: any[] = await api('/inventory/stock');

  const bySku = (sku: string) => products.find((p) => p.sku === sku);
  const whByCode = (code: string) => warehouses.find((w) => w.code === code);
  const onHand = (sku: string, whName: string) =>
    Number(stock.find((s) => s.product.sku === sku && s.warehouse.name === whName)?.onHand ?? 0);

  const principal = whByCode('BOD-01'); // Bodega Principal
  const taller = whByCode('BOD-02'); // Taller Central
  const campo = whByCode('BOD-03'); // Almacén de Campo

  if (!principal || !taller || !campo) throw new Error('Faltan bodegas base (corre seed-inventory primero).');

  console.log(`\n📦 ${products.length} productos · ${warehouses.length} bodegas · ${stock.length} filas de stock`);

  // ============================================================
  // 1) LÍMITES (reglas de reorden) — algunos forzando alertas
  // ============================================================
  console.log('\n🎚️  Creando LÍMITES de stock (reorden)…');
  const rules = [
    // bajo el límite → LOW_STOCK
    { sku: 'FIL-002', wh: taller, min: 5, reorderPoint: 15, max: 40 }, // onHand 8
    { sku: 'FIL-001', wh: taller, min: 8, reorderPoint: 20, max: 50 }, // onHand 10
    { sku: 'LUB-001', wh: campo, min: 20, reorderPoint: 50, max: 200 }, // onHand 40
    // sin stock en esa bodega → OUT_OF_STOCK
    { sku: 'EPP-002', wh: taller, min: 10, reorderPoint: 25, max: 100 }, // onHand 0
    // saludable → sin alerta (límite configurado pero ok)
    { sku: 'CON-002', wh: principal, min: 50, reorderPoint: 100, max: 600 }, // onHand 480
    { sku: 'EPP-002', wh: campo, min: 10, reorderPoint: 25, max: 100 }, // onHand 30 (ok)
  ];
  for (const r of rules) {
    const p = bySku(r.sku);
    if (!p) { console.log(`   ⚠️  ${r.sku} no existe, salto`); continue; }
    await api('/inventory/reorder/rules', {
      method: 'POST',
      body: JSON.stringify({ productId: p.id, warehouseId: r.wh.id, minQty: r.min, maxQty: r.max, reorderPoint: r.reorderPoint }),
    });
    console.log(`   ✓ ${r.sku} @ ${r.wh.name}: min ${r.min} / reorden ${r.reorderPoint} / máx ${r.max}`);
  }

  // ============================================================
  // 2) LOTES por vencer → LOT_EXPIRING
  // ============================================================
  console.log('\n⏰ Creando LOTES por vencer…');
  const lots = [
    { sku: 'LUB-001', number: 'LOTE-LUB-2406', days: 12 },
    { sku: 'FIL-001', number: 'LOTE-FIL-2406', days: 25 },
  ];
  for (const l of lots) {
    const p = bySku(l.sku);
    if (!p) continue;
    await api('/inventory/lots', {
      method: 'POST',
      body: JSON.stringify({ productId: p.id, number: l.number, receivedAt: iso(-30), expiresAt: iso(l.days) }),
    });
    console.log(`   ✓ ${l.number} (${l.sku}) vence en ${l.days} días`);
  }

  // ============================================================
  // 3) RECEPCIÓN de mercancía (entrada directa, sin OC)
  // ============================================================
  console.log('\n📥 Registrando RECEPCIÓN de mercancía…');
  {
    const p = bySku('FIL-002');
    if (p) {
      const gr = await api('/inventory/goods-receipts', {
        method: 'POST',
        body: JSON.stringify({
          warehouseId: principal.id,
          receivedAt: iso(0),
          notes: 'Compra directa a proveedor — demo',
          lines: [{ productId: p.id, quantity: 60, unitCost: 32000, condition: 'OK' }],
        }),
      });
      console.log(`   ✓ Recepción ${gr.number}: +60 FIL-002 en Bodega Principal`);
    }
  }

  // ============================================================
  // 4) SOLICITUDES INTERNAS en 3 estados
  // ============================================================
  console.log('\n✅ Creando SOLICITUDES internas (pendiente / aprobada / despachada)…');
  // pendiente
  {
    const p = bySku('CON-001');
    if (p) {
      const ir = await api('/inventory/internal-requests', {
        method: 'POST',
        body: JSON.stringify({ area: 'Mantenimiento Mecánico', warehouseId: principal.id, notes: 'Pendiente de aprobar', lines: [{ productId: p.id, quantity: 5 }] }),
      });
      console.log(`   ✓ ${ir.number} (PENDIENTE) · Mantenimiento Mecánico`);
    }
  }
  // aprobada
  {
    const p = bySku('CON-002');
    if (p) {
      const ir = await api('/inventory/internal-requests', {
        method: 'POST',
        body: JSON.stringify({ area: 'Producción', warehouseId: principal.id, lines: [{ productId: p.id, quantity: 10 }] }),
      });
      await api(`/inventory/internal-requests/${ir.id}/approve`, { method: 'POST' });
      console.log(`   ✓ ${ir.number} (APROBADA) · Producción`);
    }
  }
  // despachada (consume stock real)
  {
    const p = bySku('FIL-001');
    if (p && onHand('FIL-001', 'Bodega Principal') >= 2) {
      const ir = await api('/inventory/internal-requests', {
        method: 'POST',
        body: JSON.stringify({ area: 'Taller', warehouseId: principal.id, lines: [{ productId: p.id, quantity: 2 }] }),
      });
      await api(`/inventory/internal-requests/${ir.id}/approve`, { method: 'POST' });
      await api(`/inventory/internal-requests/${ir.id}/dispatch`, { method: 'POST' });
      console.log(`   ✓ ${ir.number} (DESPACHADA) · Taller · -2 FIL-001`);
    }
  }

  // ============================================================
  // 5) AJUSTES de inventario
  // ============================================================
  console.log('\n🎚️  Creando AJUSTES…');
  {
    const lub = bySku('LUB-001');
    if (lub) {
      const aj = await api('/inventory/adjustments', {
        method: 'POST',
        body: JSON.stringify({ warehouseId: principal.id, reason: 'DAMAGE', date: iso(0), notes: 'Merma por derrame', lines: [{ productId: lub.id, quantityDelta: -3 }] }),
      });
      console.log(`   ✓ ${aj.number} (DAÑO) · -3 LUB-001`);
    }
    const epp = bySku('EPP-002');
    if (epp) {
      const aj = await api('/inventory/adjustments', {
        method: 'POST',
        body: JSON.stringify({ warehouseId: principal.id, reason: 'ADMIN_CORRECTION', date: iso(0), notes: 'Corrección de inventario inicial', lines: [{ productId: epp.id, quantityDelta: 5, unitCost: 18000 }] }),
      });
      console.log(`   ✓ ${aj.number} (CORRECCIÓN) · +5 EPP-002`);
    }
  }

  // ============================================================
  // 6) CONTEO físico con diferencias (queda en BORRADOR)
  // ============================================================
  console.log('\n🧮 Creando CONTEO físico (borrador con diferencias)…');
  {
    const con = bySku('CON-002');
    const fil = bySku('FIL-001');
    const lines: any[] = [];
    if (con) lines.push({ productId: con.id, countedQty: onHand('CON-002', 'Bodega Principal') - 5 }); // faltante
    if (fil) lines.push({ productId: fil.id, countedQty: onHand('FIL-001', 'Bodega Principal') + 2 }); // sobrante
    if (lines.length) {
      const c = await api('/inventory/counts', {
        method: 'POST',
        body: JSON.stringify({ warehouseId: principal.id, type: 'PARTIAL', notes: 'Conteo cíclico de demo', lines }),
      });
      console.log(`   ✓ Conteo ${c.number} (BORRADOR) con ${lines.length} diferencias — apruébalo desde la UI para reconciliar`);
    }
  }

  // ============================================================
  // 7) Disparar el MOTOR DE ALERTAS
  // ============================================================
  console.log('\n🔔 Ejecutando escaneo de ALERTAS…');
  const scan = await api('/inventory/alerts/run', { method: 'POST' });
  console.log(`   ✓ Escaneadas ${scan.scanned} · nuevas ${scan.created}`);
  const alerts: any[] = await api('/inventory/alerts');
  console.log(`\n   📋 Alertas activas (${alerts.length}):`);
  for (const a of alerts.slice(0, 15)) console.log(`      • [${a.type}] ${a.message}`);

  console.log('\n🎉 Datos de demo creados. Revisa la campana 🔔 y el menú de Inventario.');
}

main().catch((e) => {
  console.error('\n❌ Error:', e.message);
  process.exit(1);
});
