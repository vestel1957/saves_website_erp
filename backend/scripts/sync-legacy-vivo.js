/**
 * Sincronización incremental  admin_vestel (MySQL VIVO)  →  saves_vestel (PostgreSQL).
 *
 * A diferencia de `etl-vestel.js` (carga histórica: trunca y recarga desde la COPIA
 * vestel_dev), este script corre en caliente contra la BD de PRODUCCIÓN del legacy y
 * solo aplica deltas, sin tocar jamás filas creadas por el stack nuevo (legacyId null).
 * Los dos sistemas quedan "de la mano": el legacy sigue siendo la fuente de verdad y
 * el stack nuevo se mantiene fresco como respaldo operable.
 *
 * Detección de cambios:
 *   · customers        → comparación fila a fila completa (22k filas, barato).
 *   · invoices         → huella (status/pamnt/total/ron/estados/rec/promos) sobre TODAS
 *                        + nuevas por id. `fecha_actualizacion` NO es confiable: la
 *                        operación diaria (pagos) no la toca (0 cambios en 3 días).
 *   · transactions, recibos_de_pago (+puente), estados, anulaciones,
 *     servicios_adicionales, facturacion_electronica_siigo → append por marca de agua
 *     (id legacy). Marcas en AppSetting `legacySync.state`, actualizadas por paso.
 *   · cierres_caja NO se sincroniza (tabla muerta en el legacy; ver modelo CashClose).
 *
 * `estados` no guarda legacyId en PG: su marca inicial sale del MAX(id) de la copia
 * vestel_dev (la fuente exacta de lo ya importado).
 *
 * Modos:
 *   · sync  → la pasada completa (todas las tablas de arriba). Cada 15 min.
 *   · caja  → pasada LIGERA: sólo `transactions`. Corre intercalada con la completa
 *             para que la ventanilla no vaya 15 min por detrás del legacy: el estado
 *             "caja abierta" se deduce del libro (ver `actividadDelDia`), así que
 *             hasta que no cruza el primer movimiento del día la caja se ve sin abrir
 *             aunque la cajera lleve rato cobrando. Usa la MISMA marca de agua `tx`,
 *             y `createMany` va con `skipDuplicates`, así que solaparse es inocuo.
 *   · drift → sólo conteos, no escribe.
 *
 * Uso:  node scripts/sync-legacy-vivo.js [--mode=sync|caja|drift] [--dry]
 * Siempre imprime un JSON de resumen en la última línea (lo consume CronService).
 */
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

// .env del backend (PM2 ya inyecta el entorno; esto cubre la corrida manual por consola)
try {
  const envFile = path.join(__dirname, '..', '.env');
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
  }
} catch {}

const { PrismaClient } = require('@prisma/client');
// Pool corto: convive con el backend en el mismo Postgres (los slots libres son pocos)
const dbUrl = (u => u ? u + (u.includes('?') ? '&' : '?') + 'connection_limit=5' : u)(process.env.DATABASE_URL);
const prisma = new PrismaClient(dbUrl ? { datasources: { db: { url: dbUrl } } } : undefined);

const MYSQL = {
  host: process.env.LEGACY_DB_HOST || '127.0.0.1',
  port: Number(process.env.LEGACY_DB_PORT || 3306),
  user: process.env.LEGACY_DB_USER,
  password: process.env.LEGACY_DB_PASSWORD,
  database: process.env.LEGACY_DB_NAME || 'admin_vestel',
  dateStrings: true, supportBigNumbers: true, bigNumberStrings: false,
};
const COPY_DB = process.env.LEGACY_DB_COPY || 'vestel_dev'; // fuente del ETL histórico

const MODE = (process.argv.find((a) => a.startsWith('--mode=')) || '--mode=sync').split('=')[1];
const DRY = process.argv.includes('--dry');
const STATE_KEY = 'legacySync.state';

const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);

// Mapeo y comparación compartidos con writeback-legacy.js (una sola fuente de reglas)
const {
  norm, bool, dOnly, dTime, subStatus, ron, invStatus, svcStatus, eiType, payMethod,
  mapCustomer, mapInvoice, mapItem, mapTx, num, diffKeys,
} = require('./lib/vestel-map');

async function inChunks(arr, size, fn) {
  for (let i = 0; i < arr.length; i += size) await fn(arr.slice(i, i + size));
}
async function pooled(arr, size, fn) {
  for (let i = 0; i < arr.length; i += size) await Promise.all(arr.slice(i, i + size).map(fn));
}
async function createMany(model, rows, chunk = 2000) {
  let n = 0;
  await inChunks(rows, chunk, async (slice) => { n += (await prisma[model].createMany({ data: slice, skipDuplicates: true })).count; });
  return n;
}
// IN (...) contra MySQL en tandas para no armar SQL kilométrico
async function mysqlIn(my, sqlTpl, ids, chunk = 5000) {
  const out = [];
  await inChunks(ids, chunk, async (slice) => {
    const [rows] = await my.query(sqlTpl.replace('??IDS??', slice.map(() => '?').join(',')), slice);
    out.push(...rows);
  });
  return out;
}

// ---------- estado (marcas de agua) ----------
async function loadState() {
  const row = await prisma.appSetting.findUnique({ where: { key: STATE_KEY } });
  try { return row?.value ? JSON.parse(row.value) : {}; } catch { return {}; }
}
async function saveState(st) {
  if (DRY) return;
  const value = JSON.stringify(st);
  await prisma.appSetting.upsert({ where: { key: STATE_KEY },
    update: { value, group: 'legacy', updatedBy: 'sync-legacy-vivo' },
    create: { key: STATE_KEY, value, group: 'legacy', updatedBy: 'sync-legacy-vivo' } });
}
async function pgMaxLegacy(model) {
  return (await prisma[model].aggregate({ _max: { legacyId: true } }))._max.legacyId ?? 0;
}

async function initWatermarks(st, my) {
  const init = async (key, model) => { if (st[key] == null) st[key] = await pgMaxLegacy(model); };
  await init('invoices', 'subInvoice');
  await init('tx', 'transaction');
  await init('recibos', 'paymentReceipt');
  await init('anulaciones', 'voiding');
  await init('addsvc', 'additionalService');
  await init('einvoice', 'electronicInvoice');
  if (st.estados == null) {
    // SubscriberStatusHistory no guarda legacyId: la marca inicial es el tope de la
    // copia vestel_dev, que es exactamente lo que el ETL ya importó.
    try {
      const [[r]] = await my.query(`SELECT MAX(id) m FROM \`${COPY_DB}\`.estados`);
      st.estados = r?.m ?? 0;
      log(`estados: marca inicial desde ${COPY_DB} = ${st.estados}`);
    } catch (e) {
      const [[r]] = await my.query('SELECT MAX(id) m FROM estados');
      st.estados = r?.m ?? 0;
      log(`⚠️ estados: sin acceso a ${COPY_DB} (${e.message}); marca desde BD viva = ${st.estados} (histórico intermedio omitido)`);
    }
  }
}

// ---------- drift (vigilancia: ¿van de la mano?) ----------
async function drift(my) {
  const pair = async (table, model, idCol = 'id') => {
    const [[m]] = await my.query(`SELECT COUNT(*) c, MAX(\`${idCol}\`) x FROM \`${table}\``);
    const legacyRows = await prisma[model].count(model === 'additionalService' ? undefined : { where: { legacyId: { not: null } } });
    const own = model === 'additionalService' ? 0 : await prisma[model].count({ where: { legacyId: null } });
    const maxL = await pgMaxLegacy(model);
    return { mysql: m.c, mysqlMaxId: m.x, pgLegacy: legacyRows, pgPropias: own, pgMaxLegacyId: maxL, atrasoIds: (m.x ?? 0) - maxL };
  };
  const st = await loadState();
  return {
    ok: true, mode: 'drift', db: `${MYSQL.host}/${MYSQL.database}`,
    tablas: {
      customers: await pair('customers', 'subscriber'),
      invoices: await pair('invoices', 'subInvoice'),
      transactions: await pair('transactions', 'transaction'),
      recibos_de_pago: await pair('recibos_de_pago', 'paymentReceipt'),
      anulaciones: await pair('anulaciones', 'voiding', 'id_anulacion'),
    },
    watermarks: st,
  };
}

// ---------- pasos de sincronización ----------
async function syncCustomers(my, sum) {
  const [rows] = await my.query('SELECT * FROM customers');
  const pgRows = await prisma.subscriber.findMany({ where: { legacyId: { not: null } } });
  const byLegacy = new Map(pgRows.map((r) => [r.legacyId, r]));
  const nuevos = [], cambios = [];
  for (const r of rows) {
    const mapped = mapCustomer(r);
    const pg = byLegacy.get(r.id);
    if (!pg) { nuevos.push(mapped); continue; }
    const keys = diffKeys(mapped, pg);
    if (keys.length) cambios.push({ legacyId: r.id, keys, mapped });
  }
  sum.customers = { nuevos: nuevos.length, actualizados: cambios.length };
  if (DRY) return;
  await createMany('subscriber', nuevos);
  await pooled(cambios, 5, async (c) => {
    const data = {};
    for (const k of c.keys) data[k] = c.mapped[k];
    // el cache fullName solo se recompone si cambió un campo de nombre
    if (c.keys.some((k) => ['firstName','secondName','lastName1','lastName2','companyName'].includes(k))) {
      const m = c.mapped;
      data.fullName = [m.firstName, m.secondName, m.lastName1, m.lastName2].map((p) => norm(p)).filter(Boolean).join(' ')
        || norm(m.companyName) || null;
    }
    await prisma.subscriber.update({ where: { legacyId: c.legacyId }, data });
  });
  if (nuevos.length || cambios.length) log(`customers: +${nuevos.length} nuevos, ~${cambios.length} actualizados`);
}

async function syncEstados(my, st, sum, subMap) {
  const [rows] = await my.query('SELECT id,cid,fecha,estado,col FROM estados WHERE id > ? ORDER BY id', [st.estados]);
  // anti-eco: los estados que el writeback empujó al legacy ya existen en PG;
  // re-importarlos duplicaría el historial (PG no guarda legacyId de estados).
  const pushed = new Set(st.wb?.estadosPushed ?? []);
  const data = [];
  let maxId = st.estados, ecos = 0;
  for (const r of rows) {
    maxId = Math.max(maxId, r.id);
    if (pushed.has(r.id)) { ecos++; continue; }
    const sid = subMap.get(r.cid); const s = subStatus(r.estado);
    if (sid && s) data.push({ subscriberId: sid, status: s, date: dTime(r.fecha) || new Date(0), originTicketId: r.col || null });
  }
  sum.estados = { nuevos: data.length, ecosOmitidos: ecos };
  if (DRY) return;
  await createMany('subscriberStatusHistory', data, 3000);
  st.estados = maxId;
  if (st.wb?.estadosPushed?.length) st.wb.estadosPushed = st.wb.estadosPushed.filter((id) => id > maxId);
  await saveState(st);
}

async function syncInvoices(my, st, sum, subMap) {
  // 1) nuevas por id
  const nuevasRows = (await my.query('SELECT * FROM invoices WHERE id > ? ORDER BY id', [st.invoices]))[0];
  // 2) modificadas por huella (los pagos NO tocan fecha_actualizacion)
  const [fpMy] = await my.query('SELECT id,status,pamnt,total,ron,estado_tv,estado_combo,rec,promo,promo2 FROM invoices WHERE id <= ?', [st.invoices]);
  const fpPg = await prisma.subInvoice.findMany({ where: { legacyId: { not: null } },
    select: { legacyId: true, status: true, paidAmount: true, total: true, ron: true, estadoTv: true, estadoCombo: true, rec: true, promo: true, promo2: true } });
  const pgFp = new Map(fpPg.map((r) => [r.legacyId, r]));
  const cambiadas = [];
  for (const r of fpMy) {
    const pg = pgFp.get(r.id);
    if (!pg) continue; // huérfana histórica (sin cliente en el ETL): se ignora
    if (invStatus(r.status) !== pg.status || num(r.pamnt) !== num(pg.paidAmount) || num(r.total) !== num(pg.total)
      || ron(r.ron) !== pg.ron || svcStatus(r.estado_tv) !== pg.estadoTv || svcStatus(r.estado_combo) !== pg.estadoCombo
      || (norm(r.rec) || null) !== pg.rec || (r.promo ?? null) !== (pg.promo ?? null) || (r.promo2 ?? null) !== (pg.promo2 ?? null)) {
      cambiadas.push(r.id);
    }
  }
  const cambiadasRows = cambiadas.length
    ? await mysqlIn(my, 'SELECT * FROM invoices WHERE id IN (??IDS??)', cambiadas) : [];

  // tid ya usado por una factura propia del stack nuevo → conflicto (no se pisa)
  const nuevasTids = nuevasRows.map((r) => r.tid);
  const tidExist = nuevasTids.length
    ? await prisma.subInvoice.findMany({ where: { tid: { in: nuevasTids } }, select: { tid: true, legacyId: true } }) : [];
  const tidTomado = new Map(tidExist.map((r) => [r.tid, r.legacyId]));
  const conflictos = [], inserts = [];
  let huerfanas = 0, maxId = st.invoices;
  for (const r of nuevasRows) {
    maxId = Math.max(maxId, r.id);
    const sid = subMap.get(r.csd);
    if (!sid) { huerfanas++; continue; }
    if (tidTomado.has(r.tid) && tidTomado.get(r.tid) !== r.id) { conflictos.push(r.tid); continue; }
    inserts.push(mapInvoice(r, sid));
  }
  sum.invoices = { nuevas: inserts.length, actualizadas: cambiadasRows.length, huerfanas, conflictosTid: conflictos };
  if (conflictos.length) log(`⚠️ invoices: ${conflictos.length} tid en conflicto con facturas propias del stack nuevo: ${conflictos.slice(0, 10).join(',')}`);
  if (DRY) return;
  await createMany('subInvoice', inserts);
  await pooled(cambiadasRows, 5, async (r) => {
    const sid = subMap.get(r.csd);
    if (!sid) return;
    const { legacyId, ...data } = mapInvoice(r, sid);
    await prisma.subInvoice.update({ where: { legacyId: r.id }, data }).catch((e) => log(`⚠️ invoice ${r.id}: ${e.message}`));
  });
  st.invoices = maxId; await saveState(st);

  // ítems de las facturas nuevas y modificadas
  const tids = [...new Set([...inserts.map((i) => i.tid), ...cambiadasRows.map((r) => r.tid)])];
  if (tids.length) {
    const items = await mysqlIn(my, 'SELECT * FROM invoice_items WHERE tid IN (??IDS??)', tids);
    const invRows = await prisma.subInvoice.findMany({ where: { tid: { in: tids } }, select: { id: true, tid: true } });
    const invByTid = new Map(invRows.map((r) => [r.tid, r.id]));
    let upserted = 0;
    await pooled(items, 5, async (r) => {
      const iid = invByTid.get(r.tid);
      if (!iid) return;
      const { legacyId, ...data } = mapItem(r, iid);
      await prisma.subInvoiceItem.upsert({ where: { legacyId: r.id }, update: data, create: { legacyId: r.id, ...data } });
      upserted++;
    });

    // Y los que el legacy YA NO tiene se borran. Cuando allá editan una factura,
    // el legacy BORRA sus renglones y los reinserta con ids nuevos; upsert solo
    // sumaba, así que la factura quedaba con el juego viejo MÁS el nuevo, el
    // detalle salía duplicado y no daba el total (108 facturas, 192 renglones
    // fantasma por 7,9 M cuando se detectó). Solo se tocan los que vinieron del
    // legacy: los renglones creados en este sistema (legacyId nulo) se respetan.
    const vivos = items.map((r) => r.id);
    const borrados = await prisma.subInvoiceItem.deleteMany({
      where: {
        invoiceId: { in: [...invByTid.values()] },
        legacyId: { not: null, notIn: vivos },
      },
    });
    if (borrados.count) {
      // `itemsCount` quedaría contando renglones que ya no están.
      for (const iid of invByTid.values()) {
        const n = await prisma.subInvoiceItem.count({ where: { invoiceId: iid } });
        await prisma.subInvoice.update({ where: { id: iid }, data: { itemsCount: n } }).catch(() => {});
      }
    }
    sum.items = { upserted, borrados: borrados.count };
  }
}

async function syncTransactions(my, st, sum, subMap) {
  const [rows] = await my.query('SELECT * FROM transactions WHERE id > ? ORDER BY id', [st.tx]);
  let maxId = st.tx;
  // La pasada ligera (--mode=caja) no trae el mapa completo de abonados (22k filas):
  // resuelve sólo los pagadores que aparecen en estas filas, que son un puñado.
  if (!subMap) {
    const payerIds = [...new Set(rows.map((r) => r.payerid).filter((p) => p))];
    const subs = payerIds.length
      ? await prisma.subscriber.findMany({ where: { legacyId: { in: payerIds } }, select: { id: true, legacyId: true } })
      : [];
    subMap = new Map(subs.map((r) => [r.legacyId, r.id]));
  }
  const tids = [...new Set(rows.map((r) => r.tid).filter((t) => t))];
  const invRows = tids.length ? await prisma.subInvoice.findMany({ where: { tid: { in: tids } }, select: { id: true, tid: true } }) : [];
  const invByTid = new Map(invRows.map((r) => [r.tid, r.id]));
  const data = rows.map((r) => { maxId = Math.max(maxId, r.id); return mapTx(r, subMap.get(r.payerid), invByTid.get(r.tid)); });
  sum.transactions = { nuevas: data.length };
  if (DRY) return;
  await createMany('transaction', data, 3000);
  st.tx = maxId; await saveState(st);
}

async function syncRecibos(my, st, sum) {
  const [rows] = await my.query('SELECT * FROM recibos_de_pago WHERE id > ? ORDER BY id', [st.recibos]);
  let maxId = st.recibos;
  const tids = [...new Set(rows.map((r) => r.tid).filter((t) => t))];
  const invRows = tids.length ? await prisma.subInvoice.findMany({ where: { tid: { in: tids } }, select: { id: true, tid: true } }) : [];
  const invByTid = new Map(invRows.map((r) => [r.tid, r.id]));
  const data = rows.map((r) => { maxId = Math.max(maxId, r.id); return { legacyId: r.id, date: dTime(r.date) || new Date(0), fileName: norm(r.file_name), invoiceId: invByTid.get(r.tid) || null }; });
  sum.recibos = { nuevos: data.length, enlaces: 0 };
  if (DRY) return;
  await createMany('paymentReceipt', data, 3000);
  st.recibos = maxId; await saveState(st);

  // puente recibo↔transacción de los recibos nuevos (unicidad compuesta = idempotente)
  const ids = rows.map((r) => r.id);
  if (!ids.length) return;
  const links = await mysqlIn(my, 'SELECT * FROM transactions_ids_recibos_de_pago WHERE id_recibo_de_pago IN (??IDS??)', ids);
  const rcRows = await prisma.paymentReceipt.findMany({ where: { legacyId: { in: ids } }, select: { id: true, legacyId: true } });
  const rcMap = new Map(rcRows.map((r) => [r.legacyId, r.id]));
  const txIds = [...new Set(links.map((l) => l.id_transaccion))];
  const txRows = txIds.length ? await prisma.transaction.findMany({ where: { legacyId: { in: txIds } }, select: { id: true, legacyId: true } }) : [];
  const txMap = new Map(txRows.map((r) => [r.legacyId, r.id]));
  const bridge = links.map((l) => ({ receiptId: rcMap.get(l.id_recibo_de_pago), transactionId: txMap.get(l.id_transaccion) }))
    .filter((b) => b.receiptId && b.transactionId);
  sum.recibos.enlaces = await createMany('receiptTransaction', bridge, 4000);
}

async function syncAnulaciones(my, st, sum) {
  const [rows] = await my.query('SELECT * FROM anulaciones WHERE id_anulacion > ? ORDER BY id_anulacion', [st.anulaciones]);
  let maxId = st.anulaciones;
  const txIds = rows.map((r) => r.transactions_id);
  const txRows = txIds.length ? await prisma.transaction.findMany({ where: { legacyId: { in: txIds } }, select: { id: true, legacyId: true } }) : [];
  const txMap = new Map(txRows.map((r) => [r.legacyId, r.id]));
  const data = [];
  for (const r of rows) {
    maxId = Math.max(maxId, r.id_anulacion);
    const tid = txMap.get(r.transactions_id);
    if (!tid) continue;
    data.push({ legacyId: r.id_anulacion, dateTime: dTime(r.fecha_hora) || new Date(0), detail: r.detalle,
      transactionId: tid, reason: norm(r.razon_anulacion), voidedBy: norm(r.usuario_anula) });
  }
  sum.anulaciones = { nuevas: data.length };
  if (DRY) return;
  await createMany('voiding', data);
  if (data.length) await prisma.transaction.updateMany({ where: { id: { in: data.map((d) => d.transactionId) } }, data: { status: 'ANULADA' } });
  st.anulaciones = maxId; await saveState(st);
}

async function syncAddSvc(my, st, sum) {
  const [rows] = await my.query('SELECT * FROM servicios_adicionales WHERE id > ? ORDER BY id', [st.addsvc]);
  let maxId = st.addsvc;
  const tids = [...new Set(rows.map((r) => r.tid_invoice).filter((t) => t))];
  const invRows = tids.length ? await prisma.subInvoice.findMany({ where: { tid: { in: tids } }, select: { id: true, tid: true } }) : [];
  const invByTid = new Map(invRows.map((r) => [r.tid, r.id]));
  const data = rows.map((r) => { maxId = Math.max(maxId, r.id); return { legacyId: r.id, invoiceId: invByTid.get(r.tid_invoice) || null,
    ticketId: r.idt_ticket, productId: r.pid, valor: norm(r.valor), subtotal: money(r.subtotal), total: money(r.total) }; });
  sum.serviciosAdicionales = { nuevos: data.length };
  if (DRY) return;
  await createMany('additionalService', data, 3000);
  st.addsvc = maxId; await saveState(st);
}

async function syncEInvoice(my, st, sum, subMap) {
  const [rows] = await my.query('SELECT * FROM facturacion_electronica_siigo WHERE id > ? ORDER BY id', [st.einvoice]);
  let maxId = st.einvoice;
  const tids = [...new Set(rows.map((r) => r.tid).filter((t) => t))];
  const invRows = tids.length ? await prisma.subInvoice.findMany({ where: { tid: { in: tids } }, select: { id: true, tid: true } }) : [];
  const invByTid = new Map(invRows.map((r) => [r.tid, r.id]));
  const data = rows.map((r) => { maxId = Math.max(maxId, r.id); return { legacyId: r.id, subscriberId: subMap.get(r.customer_id) || null,
    invoiceId: (r.tid && invByTid.get(r.tid)) || null, date: dOnly(r.fecha) || new Date(0),
    executedAt: dTime(r.fecha_ejecucion), servicesBilled: r.servicios_facturados,
    createdWithMultiple: bool(r.creado_con_multiple), type: eiType(r.tipo), payMethod: payMethod(r.metodo_pago),
    legacyConsecutive: r.consecutivo_siigo || 0, payloadJson: r.json }; });
  sum.facturacionElectronica = { nuevas: data.length };
  if (DRY) return;
  await createMany('electronicInvoice', data, 2000);
  st.einvoice = maxId; await saveState(st);
}

// ---------- main ----------
async function main() {
  if (!MYSQL.user || !MYSQL.password) throw new Error('Faltan LEGACY_DB_USER / LEGACY_DB_PASSWORD en el entorno');
  const t0 = Date.now();
  const my = await mysql.createConnection(MYSQL);

  if (MODE === 'drift') {
    const out = await drift(my);
    console.log(JSON.stringify(out));
    await my.end(); await prisma.$disconnect();
    return;
  }

  const st = await loadState();
  await initWatermarks(st, my);
  const sum = { ok: true, mode: MODE, dry: DRY, db: `${MYSQL.host}/${MYSQL.database}` };

  // Pasada ligera: sólo el libro, que es de donde sale el estado de la caja del día.
  // No toca `lastRunAt` — esa marca es de la pasada completa y la usa la vigilancia
  // de deriva; si la pisara, un sync completo caído pasaría por fresco.
  if (MODE === 'caja') {
    await syncTransactions(my, st, sum, null);
    st.lastCajaRunAt = new Date().toISOString();
    await saveState(st);
    sum.ms = Date.now() - t0;
    sum.watermarks = st;
    console.log(JSON.stringify(sum));
    await my.end(); await prisma.$disconnect();
    return;
  }

  await syncCustomers(my, sum);
  const subs = await prisma.subscriber.findMany({ where: { legacyId: { not: null } }, select: { id: true, legacyId: true } });
  const subMap = new Map(subs.map((r) => [r.legacyId, r.id]));

  await syncEstados(my, st, sum, subMap);
  await syncInvoices(my, st, sum, subMap);
  await syncTransactions(my, st, sum, subMap);
  await syncRecibos(my, st, sum);
  await syncAnulaciones(my, st, sum);
  await syncAddSvc(my, st, sum);
  await syncEInvoice(my, st, sum, subMap);

  st.lastRunAt = new Date().toISOString();
  await saveState(st);
  sum.ms = Date.now() - t0;
  sum.watermarks = st;
  console.log(JSON.stringify(sum));
  await my.end(); await prisma.$disconnect();
}

main().catch(async (e) => {
  console.log(JSON.stringify({ ok: false, error: e.message }));
  console.error(e);
  process.exit(1);
});
