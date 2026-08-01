/**
 * Retro-sincronización  saves_vestel (PostgreSQL)  →  admin_vestel (MySQL VIVO del legacy).
 *
 * La pieza de vuelta del plan "los dos sistemas de la mano": lo que se capture en el
 * stack nuevo se refleja en el legacy, para poder conmutar a él si el nuevo falla y
 * que los trabajadores no paren ni se pierdan datos.
 *
 * Qué empuja (vertical Clientes+Facturación+Caja, mismo alcance que la ida):
 *   · INSERTS — filas creadas en el stack nuevo (legacyId=null): clientes, facturas
 *     (+ítems), transacciones, recibos (+puente), anulaciones y estados. Tras insertar
 *     en MySQL se guarda el id asignado como legacyId en PG (queda enlazada y el sync
 *     de ida la reconoce como propia: sus skipDuplicates evitan el eco).
 *   · UPDATES — cambios hechos en el nuevo sobre filas de origen legacy: clientes
 *     (comparación campo a campo) y facturas (huella status/pamnt/total/ron/…).
 *
 * REGLA DE ORO (un solo sistema activo a la vez):
 *   · Modo A (legacy activo, hoy): LEGACY_SYNC_ENABLED=true. Los INSERTS pueden ir en
 *     vivo (no chocan con la ida), pero los UPDATES se quedan en plan: si corrieran,
 *     pelearían con la ida (que restaura lo del legacy) en un ping-pong sin fin.
 *   · Modo B (nuevo activo, tras el go-live): LEGACY_SYNC_ENABLED=false +
 *     LEGACY_WRITEBACK_LIVE=true. Todo corre en vivo; el legacy queda de espejo.
 *
 * Gates: sin LEGACY_WRITEBACK_LIVE=true todo va en seco (plan, sin escribir).
 * `--target=copy` escribe en la BD de ensayo (LEGACY_WRITEBACK_TEST_DB, def.
 * `writeback_test`) ignorando los gates — SOLO para pruebas con filas de ensayo,
 * porque los legacyId que enlaza vienen de esa BD y no valen para producción.
 *
 * Uso:  node scripts/writeback-legacy.js [--dry] [--target=copy]
 * Siempre imprime un JSON de resumen en la última línea (lo consume CronService).
 */
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

try {
  const envFile = path.join(__dirname, '..', '.env');
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
  }
} catch {}

const { PrismaClient } = require('@prisma/client');
const dbUrl = (u => u ? u + (u.includes('?') ? '&' : '?') + 'connection_limit=5' : u)(process.env.DATABASE_URL);
const prisma = new PrismaClient(dbUrl ? { datasources: { db: { url: dbUrl } } } : undefined);

const TARGET = (process.argv.find((a) => a.startsWith('--target=')) || '--target=prod').split('=')[1];
const LIVE_GATE = process.env.LEGACY_WRITEBACK_LIVE === 'true';
const MODE_A = process.env.LEGACY_SYNC_ENABLED === 'true'; // legacy activo (la ida corre)
// En producción sin gate → todo seco. En copy → escribir siempre (BD de ensayo).
const DRY = process.argv.includes('--dry') || (TARGET !== 'copy' && !LIVE_GATE);
const UPDATES_LIVE = !DRY && (TARGET === 'copy' || !MODE_A);

const MYSQL = {
  host: process.env.LEGACY_DB_HOST || '127.0.0.1',
  port: Number(process.env.LEGACY_DB_PORT || 3306),
  user: process.env.LEGACY_DB_USER,
  password: process.env.LEGACY_DB_PASSWORD,
  database: TARGET === 'copy'
    ? (process.env.LEGACY_WRITEBACK_TEST_DB || 'writeback_test')
    : (process.env.LEGACY_DB_NAME || 'admin_vestel'),
  dateStrings: true, supportBigNumbers: true, bigNumberStrings: false,
};
const STATE_KEY = 'legacySync.state';
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);

const {
  mapCustomer, diffKeys,
  invCustomer, CUSTOMER_FIELD2COLS, invInvoice, invItem, invTx,
  inv, RON_INV, INV_STATUS_INV, SVC_STATUS_INV, SUB_STATUS_INV, toD, toDT, num,
} = require('./lib/vestel-map');

// ---------- helpers MySQL ----------
async function insertRow(my, table, obj) {
  const cols = Object.keys(obj);
  const [r] = await my.execute(
    `INSERT INTO \`${table}\` (${cols.map((c) => `\`${c}\``).join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
    cols.map((c) => obj[c] ?? null),
  );
  return r.insertId;
}
async function updateRow(my, table, idCol, id, obj) {
  const cols = Object.keys(obj);
  if (!cols.length) return;
  await my.execute(
    `UPDATE \`${table}\` SET ${cols.map((c) => `\`${c}\`=?`).join(',')} WHERE \`${idCol}\`=?`,
    [...cols.map((c) => obj[c] ?? null), id],
  );
}

// ---------- estado compartido con la ida ----------
async function loadState() {
  const row = await prisma.appSetting.findUnique({ where: { key: STATE_KEY } });
  try { return row?.value ? JSON.parse(row.value) : {}; } catch { return {}; }
}
async function saveState(patchWb) {
  if (DRY) return;
  // releer antes de guardar: la ida pudo tocar el estado mientras corríamos
  const st = await loadState();
  st.wb = { ...(st.wb ?? {}), ...patchWb };
  const value = JSON.stringify(st);
  await prisma.appSetting.upsert({ where: { key: STATE_KEY },
    update: { value, group: 'legacy', updatedBy: 'writeback-legacy' },
    create: { key: STATE_KEY, value, group: 'legacy', updatedBy: 'writeback-legacy' } });
}

// ---------- pasos ----------
async function pushCustomers(my, sum) {
  const rows = await prisma.subscriber.findMany({
    where: { legacyId: null }, include: { branch: { select: { legacyId: true } } },
  });
  sum.customers = { insertados: rows.length };
  if (DRY) return;
  for (const s of rows) {
    const id = await insertRow(my, 'customers', invCustomer(s, s.branch?.legacyId ?? null));
    await prisma.subscriber.update({ where: { id: s.id }, data: { legacyId: id } });
  }
  if (rows.length) log(`customers: +${rows.length} empujados al legacy`);
}

async function pushCustomerUpdates(my, sum) {
  const [rows] = await my.query('SELECT * FROM customers');
  const pgRows = await prisma.subscriber.findMany({ where: { legacyId: { not: null } } });
  const myById = new Map(rows.map((r) => [r.id, r]));
  const cambios = [];
  for (const pg of pgRows) {
    const r = myById.get(pg.legacyId);
    if (!r) continue; // aún no existe allá (lo cubre pushCustomers en la próxima)
    const keys = diffKeys(mapCustomer(r), pg).filter((k) => CUSTOMER_FIELD2COLS[k]);
    if (keys.length) cambios.push({ pg, keys });
  }
  sum.customersUpd = { pendientes: cambios.length, aplicados: 0 };
  if (!UPDATES_LIVE) {
    if (cambios.length) log(`customers-upd: ${cambios.length} cambios ${DRY ? 'en plan (seco)' : 'RETENIDOS (modo legacy-activo)'}`);
    return;
  }
  for (const c of cambios) {
    const full = invCustomer(c.pg, null);
    const setObj = {};
    for (const k of c.keys) for (const col of CUSTOMER_FIELD2COLS[k]) setObj[col] = full[col];
    await updateRow(my, 'customers', 'id', c.pg.legacyId, setObj);
  }
  sum.customersUpd.aplicados = cambios.length;
}

async function pushInvoices(my, sum) {
  const rows = await prisma.subInvoice.findMany({
    where: { legacyId: null },
    include: { subscriber: { select: { legacyId: true } }, items: true },
  });
  const conflictos = [], sinCliente = [];
  let ins = 0, items = 0;
  for (const f of rows) {
    const csd = f.subscriber?.legacyId;
    if (!csd) { sinCliente.push(f.tid); continue; }
    const [[dupe]] = await my.query('SELECT id FROM invoices WHERE tid = ? LIMIT 1', [f.tid]);
    if (dupe) { conflictos.push(f.tid); continue; }
    ins++; items += f.items.length;
    if (DRY) continue;
    const id = await insertRow(my, 'invoices', invInvoice(f, csd));
    await prisma.subInvoice.update({ where: { id: f.id }, data: { legacyId: id } });
    for (const it of f.items) {
      const itemId = await insertRow(my, 'invoice_items', invItem(it, f.tid));
      await prisma.subInvoiceItem.update({ where: { id: it.id }, data: { legacyId: itemId } });
    }
  }
  sum.invoices = { insertadas: ins, items, conflictosTid: conflictos, sinCliente: sinCliente.length };
  if (conflictos.length) log(`⚠️ invoices: ${conflictos.length} tid ya existen en el legacy (no se pisan): ${conflictos.slice(0, 10).join(',')}`);
}

/** Ítems del stack nuevo sobre facturas de origen legacy (p.ej. notas crédito). */
async function pushItems(my, sum) {
  const rows = await prisma.subInvoiceItem.findMany({
    where: { legacyId: null, invoice: { legacyId: { not: null } } },
    include: { invoice: { select: { tid: true } } },
  });
  sum.items = { insertados: rows.length };
  if (DRY) return;
  for (const it of rows) {
    const id = await insertRow(my, 'invoice_items', invItem(it, it.invoice.tid));
    await prisma.subInvoiceItem.update({ where: { id: it.id }, data: { legacyId: id } });
  }
}

async function pushInvoiceUpdates(my, sum) {
  const [fpMy] = await my.query('SELECT id,status,pamnt,total,ron,estado_tv,estado_combo,rec,promo,promo2 FROM invoices');
  const myById = new Map(fpMy.map((r) => [r.id, r]));
  const fpPg = await prisma.subInvoice.findMany({ where: { legacyId: { not: null } },
    select: { legacyId: true, status: true, paidAmount: true, total: true, ron: true,
      estadoTv: true, estadoCombo: true, rec: true, promo: true, promo2: true } });
  const cambios = [];
  for (const pg of fpPg) {
    const r = myById.get(pg.legacyId);
    if (!r) continue;
    const want = {
      status: inv(INV_STATUS_INV)(pg.status) ?? 'due', pamnt: num(pg.paidAmount), total: num(pg.total),
      ron: inv(RON_INV)(pg.ron), estado_tv: inv(SVC_STATUS_INV)(pg.estadoTv),
      estado_combo: inv(SVC_STATUS_INV)(pg.estadoCombo), rec: pg.rec ?? '',
      promo: pg.promo, promo2: pg.promo2,
    };
    if (want.status !== r.status || want.pamnt !== num(r.pamnt) || want.total !== num(r.total)
      || (want.ron ?? null) !== (r.ron === '' ? null : r.ron) || (want.estado_tv ?? null) !== (r.estado_tv === '' ? null : r.estado_tv)
      || (want.estado_combo ?? null) !== (r.estado_combo === '' ? null : r.estado_combo)
      || String(want.rec ?? '') !== String(r.rec ?? '') || (want.promo ?? null) !== (r.promo ?? null)
      || (want.promo2 ?? null) !== (r.promo2 ?? null)) {
      cambios.push({ id: pg.legacyId, want });
    }
  }
  sum.invoicesUpd = { pendientes: cambios.length, aplicados: 0 };
  if (!UPDATES_LIVE) {
    if (cambios.length) log(`invoices-upd: ${cambios.length} cambios ${DRY ? 'en plan (seco)' : 'RETENIDOS (modo legacy-activo)'}`);
    return;
  }
  for (const c of cambios) await updateRow(my, 'invoices', 'id', c.id, c.want);
  sum.invoicesUpd.aplicados = cambios.length;
}

async function pushTransactions(my, sum) {
  const rows = await prisma.transaction.findMany({
    where: { legacyId: null },
    include: { subscriber: { select: { legacyId: true } }, invoice: { select: { tid: true } } },
  });
  sum.transactions = { insertadas: rows.length };
  if (DRY) return;
  for (const t of rows) {
    const id = await insertRow(my, 'transactions', invTx(t, t.subscriber?.legacyId ?? 0, t.invoice?.tid ?? 0));
    await prisma.transaction.update({ where: { id: t.id }, data: { legacyId: id } });
  }
  if (rows.length) log(`transactions: +${rows.length} empujadas al legacy`);
}

async function pushReceipts(my, sum) {
  const rows = await prisma.paymentReceipt.findMany({
    where: { legacyId: null },
    include: { invoice: { select: { tid: true } }, transactions: { include: { transaction: { select: { legacyId: true } } } } },
  });
  let enlaces = 0;
  sum.recibos = { insertados: rows.length, enlaces: 0 };
  if (DRY) { sum.recibos.enlaces = rows.reduce((a, r) => a + r.transactions.length, 0); return; }
  for (const rc of rows) {
    const id = await insertRow(my, 'recibos_de_pago', {
      date: toDT(rc.date), file_name: rc.fileName ?? '', tid: rc.invoice?.tid ?? 0,
    });
    await prisma.paymentReceipt.update({ where: { id: rc.id }, data: { legacyId: id } });
    for (const link of rc.transactions) {
      const txLegacy = link.transaction?.legacyId;
      if (!txLegacy) continue;
      await insertRow(my, 'transactions_ids_recibos_de_pago', { id_recibo_de_pago: id, id_transaccion: txLegacy });
      enlaces++;
    }
  }
  sum.recibos.enlaces = enlaces;
}

async function pushVoidings(my, sum) {
  const rows = await prisma.voiding.findMany({
    where: { legacyId: null }, include: { transaction: { select: { legacyId: true } } },
  });
  const listos = rows.filter((v) => v.transaction?.legacyId);
  sum.anulaciones = { insertadas: listos.length, sinTransaccion: rows.length - listos.length };
  if (DRY) return;
  for (const v of listos) {
    const id = await insertRow(my, 'anulaciones', {
      fecha_hora: toDT(v.dateTime), detalle: v.detail ?? '', transactions_id: v.transaction.legacyId,
      razon_anulacion: v.reason ?? '', usuario_anula: v.voidedBy ?? '',
    });
    await prisma.voiding.update({ where: { id: v.id }, data: { legacyId: id } });
    await my.execute('UPDATE transactions SET estado = ? WHERE id = ?', ['Anulada', v.transaction.legacyId]);
  }
}

async function pushEstados(my, sum, st) {
  // PG no guarda legacyId de estados: candidatos = filas nuevas por createdAt, y se
  // filtran las que ya existen en MySQL (esas las trajo la ida, no son nuestras).
  // primera corrida: solo las últimas 24 h (el resto es historial que ya vino de la ida)
  const since = st.wb?.estadosPushedSince ? new Date(st.wb.estadosPushedSince) : new Date(Date.now() - 24 * 3600 * 1000);
  const rows = await prisma.subscriberStatusHistory.findMany({
    where: { createdAt: { gt: since } },
    include: { subscriber: { select: { legacyId: true } } },
    orderBy: { createdAt: 'asc' },
  });
  let insertados = 0, maxCreated = since;
  const pushedIds = [...(st.wb?.estadosPushed ?? [])];
  const plan = [];
  for (const h of rows) {
    if (h.createdAt > maxCreated) maxCreated = h.createdAt;
    const cid = h.subscriber?.legacyId;
    if (!cid) continue;
    const fecha = toDT(h.date), estado = inv(SUB_STATUS_INV)(h.status);
    if (!estado) continue;
    const [[dupe]] = await my.query('SELECT id FROM estados WHERE cid=? AND fecha=? AND estado=? LIMIT 1', [cid, fecha, estado]);
    if (dupe) continue; // vino del legacy vía la ida
    plan.push({ cid, fecha, estado, col: h.originTicketId ?? 0 });
  }
  sum.estados = { insertados: plan.length };
  if (DRY) return;
  for (const p of plan) {
    const id = await insertRow(my, 'estados', p);
    pushedIds.push(id); insertados++;
  }
  await saveState({ estadosPushedSince: maxCreated.toISOString(), estadosPushed: pushedIds });
}

// ---------- main ----------
async function main() {
  if (!MYSQL.user || !MYSQL.password) throw new Error('Faltan LEGACY_DB_USER / LEGACY_DB_PASSWORD en el entorno');
  const t0 = Date.now();
  const my = await mysql.createConnection(MYSQL);
  const st = await loadState();
  const sum = {
    ok: true, mode: 'writeback', dry: DRY, target: `${MYSQL.host}/${MYSQL.database}`,
    modoLegacyActivo: MODE_A, updatesEnVivo: UPDATES_LIVE,
  };
  log(`writeback → ${sum.target} · ${DRY ? 'SECO (plan)' : 'EN VIVO'} · updates ${UPDATES_LIVE ? 'en vivo' : 'retenidos'}`);

  await pushCustomers(my, sum);
  await pushCustomerUpdates(my, sum);
  await pushInvoices(my, sum);
  await pushItems(my, sum);
  await pushInvoiceUpdates(my, sum);
  await pushTransactions(my, sum);
  await pushReceipts(my, sum);
  await pushVoidings(my, sum);
  await pushEstados(my, sum, st);

  if (!DRY) await saveState({ lastWritebackAt: new Date().toISOString() });
  sum.ms = Date.now() - t0;
  console.log(JSON.stringify(sum));
  await my.end(); await prisma.$disconnect();
}

main().catch(async (e) => {
  console.log(JSON.stringify({ ok: false, error: e.message }));
  console.error(e);
  process.exit(1);
});
