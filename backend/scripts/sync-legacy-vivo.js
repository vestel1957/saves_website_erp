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
 *   · tickets (órdenes de servicio) → nuevas por id + relectura de las VIVAS y las
 *                        recientes (60 d). El resto del histórico no se vuelve a mirar.
 *   · tickets_th (hilo de la orden) → append por marca de agua.
 *   · transactions, recibos_de_pago (+puente), estados, anulaciones,
 *     servicios_adicionales, facturacion_electronica_siigo → append por marca de agua
 *     (id legacy). Marcas en AppSetting `legacySync.state`, actualizadas por paso.
 *   · equipos, purchase (+purchase_items) → comparación fila a fila completa, con el
 *                        blindaje `editedAt`: la fila que movió NEXUS ya no acepta lo
 *                        del legacy (el inventario no viaja de vuelta, así que allá
 *                        nunca se entera). Ver `syncInventario`.
 *   · products → comparación fila a fila (incluido `qty`), con el mismo blindaje
 *                        `editedAt`. El stock del material se mueve HOY en el legacy;
 *                        traerlo es lo que mantiene vivo el inventario de aquí.
 *   · product_cat, product_warehouse, supplier, almacen_equipos → SOLO ALTAS (son
 *                        dimensiones: basta con que exista la fila a la que apuntar).
 *   · transfer_equipos, item_transfer_equipos, acta_transferencias (+ítems) → altas por
 *                        marca de agua; es historial y no cambia.
 *   · historiales (OBSERVACIONES del perfil del cliente) y meta_data type=6 (sus
 *                        ARCHIVOS) → altas por marca de agua. Los adjuntos traen
 *                        binario: se bajan del legacy vivo por HTTP, con tope por
 *                        pasada y reintento de lo que falle (ver `syncArchivos`).
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
const { mapObservacion, mimeDe, nombreVisible, nombreEnDisco, traductorDeNombres } = require('./lib/observaciones-legacy');
const { traerArchivo, UPLOAD_ROOT } = require('./lib/archivos-legacy');
// Fecha/hora de Colombia: la misma fuente que usa el writeback para hablarle al legacy.
const { FECHA_CO, INSTANTE_CO, DIA_UTC } = require('./lib/hora-co');
// La misma función con la que TODO el sistema arma una dirección de sus casillas
// (`common/subscriber-address.ts`). Se toma del compilado en vez de copiarla aquí:
// sus reglas costaron —el '#' y el '-' solo van si están las dos mitades, una vía
// sin número se descarta, '0' cuenta como vacío— y dos copias acabarían diciendo
// direcciones distintas para el mismo abonado.
// Del compilado, y entre `try`: si alguien corre el script sin haber construido el
// backend, lo que falta es UN paso —el destino de los traslados—, no el sync entero.
let direccionDe = null;
try { ({ direccionDe } = require('../dist/src/common/subscriber-address')); } catch { /* sin dist */ }
const {
  // `money` lo usa syncAddSvc y faltaba en esta lista: el paso reventaba
  // ("money is not defined") en cuanto el legacy creaba un servicio adicional, y con
  // él se caía la pasada entera (los pasos siguientes ni corrían).
  norm, bool, dOnly, dTime, money, subStatus, ron, invStatus, svcStatus, eiType, payMethod,
  mapCustomer, mapInvoice, mapItem, mapTx, esPagoDeCompra, num, diffKeys,
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
  await init('tickets', 'ticket');
  await init('ticketsTh', 'ticketThread');
  await init('observaciones', 'subscriberNote');
  await init('archivos', 'subscriberFile');
  await init('cargues', 'paymentImportBatch');
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
      tickets: await pair('tickets', 'ticket', 'idt'),
    },
    watermarks: st,
  };
}

/**
 * LÁPIDAS: lo que se borró aquí a conciencia y no se puede volver a crear.
 *
 * La ida da de alta todo lo que ve en el legacy y no tiene en Postgres. Sin esta lista,
 * borrar una factura, un material o una orden en Nexus duraba lo que tardara la
 * siguiente pasada: quince minutos después estaba de vuelta, con otro id y sin que nadie
 * entendiera por qué. Ver el modelo `LegacyDeletion` y `anotarBorradoLegacy`.
 */
async function cargarLapidas() {
  const filas = await prisma.legacyDeletion.findMany({ select: { entity: true, legacyId: true } });
  const porEntidad = new Map();
  for (const f of filas) {
    if (!porEntidad.has(f.entity)) porEntidad.set(f.entity, new Set());
    porEntidad.get(f.entity).add(f.legacyId);
  }
  return {
    tiene: (entity, legacyId) => porEntidad.get(entity)?.has(legacyId) ?? false,
    total: filas.length,
  };
}

// ---------- pasos de sincronización ----------
/**
 * Lo que el legacy sigue mandando AUNQUE la ficha se haya editado aquí.
 *
 * El blindaje `editedAt` no puede ser total: mientras los dos sistemas convivan, el
 * ESTADO del abonado (corte, reconexión, cartera) y sus SALDOS los mueve el legacy, y
 * congelarlos dejaría al cliente con el estado del día en que alguien le corrigió el
 * teléfono. Lo que sí se congela es el PERFIL —nombre, documento, dirección, contacto,
 * datos de red—, que es lo que se edita a mano de este lado.
 */
const CAMPOS_DE_ALLA = new Set([
  'status', 'previousStatus', 'statusChangedAt', 'statusGenDate',
  'balance', 'debitCache', 'creditCache',
]);

/**
 * `customers.gid` (sede del legacy) → `Branch.id`.
 *
 * No está en `mapCustomer` porque ese mapeo es puro —fila legacy a data Prisma— y
 * esto necesita mirar la tabla `Branch`. Se resuelve una vez por corrida.
 *
 * Por qué existe (2026-08-28): la sede del abonado se había cargado UNA sola vez,
 * con `scripts/backfill-branch.js`, y el sync nunca la trajo. Todo cliente dado de
 * alta en el legacy desde entonces llegaba SIN sede, y un cliente sin sede es
 * invisible para cualquiera que esté acotado —el `where` es
 * `subscriber.branch.legacyId IN (…)`—: sus órdenes no salían en la bandeja del
 * agendamiento ni en el listado de soporte de las cajeras, aunque el legacy sí supiera
 * de qué sede son. Eran 96 clientes cuando se arregló.
 */
async function mapaDeSedes() {
  const filas = await prisma.branch.findMany({ select: { id: true, legacyId: true } });
  return new Map(filas.flatMap((b) => (b.legacyId != null ? [[b.legacyId, b.id]] : [])));
}

async function syncCustomers(my, sum) {
  const [rows] = await my.query('SELECT * FROM customers');
  const pgRows = await prisma.subscriber.findMany({ where: { legacyId: { not: null } } });
  const byLegacy = new Map(pgRows.map((r) => [r.legacyId, r]));
  const sedes = await mapaDeSedes();
  const nuevos = [], cambios = [];
  let blindados = 0;
  for (const r of rows) {
    const mapped = mapCustomer(r);
    // `gid = 0` (o una sede que aquí no existe) NO es "sin sede": es que el legacy no
    // la tiene puesta. En ese caso ni se toca el campo, para no borrar una sede que
    // alguien haya corregido de este lado.
    const branchId = sedes.get(Number(r.gid));
    if (branchId) mapped.branchId = branchId;
    const pg = byLegacy.get(r.id);
    if (!pg) { nuevos.push(mapped); continue; }
    let keys = diffKeys(mapped, pg);
    if (keys.length && pg.editedAt) {
      // Ficha editada aquí: del legacy sólo entra lo operativo. El resto es
      // precisamente lo que este sistema corrigió, y el writeback lo lleva allá.
      const antes = keys.length;
      keys = keys.filter((k) => CAMPOS_DE_ALLA.has(k));
      if (keys.length < antes) blindados++;
    }
    if (keys.length) cambios.push({ legacyId: r.id, keys, mapped });
  }
  sum.customers = { nuevos: nuevos.length, actualizados: cambios.length, blindados };
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
  if (nuevos.length || cambios.length || blindados) {
    log(`customers: +${nuevos.length} nuevos, ~${cambios.length} actualizados`
      + (blindados ? ` · ${blindados} fichas editadas aquí (sólo se aceptó estado y saldos)` : ''));
  }
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

async function syncInvoices(my, st, sum, subMap, lapidas) {
  // 1) nuevas por id — menos las que aquí se borraron a conciencia (ver `cargarLapidas`)
  const nuevasRows = (await my.query('SELECT * FROM invoices WHERE id > ? ORDER BY id', [st.invoices]))[0]
    .filter((r) => !lapidas.tiene('subInvoice', r.id));
  // 2) modificadas por huella (los pagos NO tocan fecha_actualizacion)
  const [fpMy] = await my.query('SELECT id,status,pamnt,total,ron,estado_tv,estado_combo,rec,promo,promo2 FROM invoices WHERE id <= ?', [st.invoices]);
  const fpPg = await prisma.subInvoice.findMany({ where: { legacyId: { not: null } },
    select: { legacyId: true, status: true, paidAmount: true, total: true, ron: true, estadoTv: true, estadoCombo: true, rec: true, promo: true, promo2: true, editedAt: true, serviceAssignedAt: true, serviceStatusAt: true } });
  const pgFp = new Map(fpPg.map((r) => [r.legacyId, r]));
  const cambiadas = [], editadas = [];
  /**
   * El dinero de la factura, comparado con la tolerancia del legacy.
   *
   * Allá `invoices.pamnt` y `invoices.total` son `int(16)`: los céntimos no caben. Una
   * factura de 69.492,50 pagada entera viaja al legacy como 69.492 y vuelve así, y
   * compararla al céntimo la marcaba cambiada en CADA pasada y —peor— la dejaba
   * PARTIAL: el cliente salía "con un abono" de 50 céntimos que nunca debió (98
   * facturas así el 02-09-2026, todas por el 5 % de pronto pago, que parte el peso).
   * Menos de un peso de diferencia es la truncación del legacy, no un saldo.
   */
  const mismoDinero = (a, b) => Math.abs(num(a) - num(b)) < 1;
  /**
   * Factura con el CORTE POR SERVICIO movido aquí: `estado_tv`/`estado_combo` son de
   * este lado hasta que el writeback los iguale allá (`pushEstadoServicio`, que además
   * borra la marca en cuanto coinciden). Sin este candado la suspensión duraba quince
   * minutos: se cerraba la orden de 'Suspension Television', esta huella veía la
   * diferencia y le devolvía a la factura el 'al aire' del legacy (orden #502150).
   */
  const estadoEsDeAqui = (pg) => !!pg.serviceStatusAt;
  for (const r of fpMy) {
    const pg = pgFp.get(r.id);
    if (!pg) continue; // huérfana histórica (sin cliente en el ETL): se ignora
    // Factura EDITADA en este sistema: sus valores mandan. Si entrara por la vía
    // normal, la huella (el total nunca vuelve a coincidir) la marcaría cambiada en
    // cada pasada y le restauraría los montos y los renglones viejos del legacy.
    // Del legacy sólo se sigue aceptando lo del cobro —lo que la cajera registra
    // allá— y el estado se recalcula contra el total de acá. Ver `updateInvoice`.
    if (pg.editedAt) {
      if (!mismoDinero(r.pamnt, pg.paidAmount) || ron(r.ron) !== pg.ron
        || (!estadoEsDeAqui(pg) && (svcStatus(r.estado_tv) !== pg.estadoTv || svcStatus(r.estado_combo) !== pg.estadoCombo))
        || (norm(r.rec) || null) !== pg.rec || (r.promo ?? null) !== (pg.promo ?? null) || (r.promo2 ?? null) !== (pg.promo2 ?? null)
        || (invStatus(r.status) === 'CANCELED' && pg.status !== 'CANCELED')) {
        editadas.push({ r, pg });
      }
      continue;
    }
    if (invStatus(r.status) !== pg.status || !mismoDinero(r.pamnt, pg.paidAmount) || !mismoDinero(r.total, pg.total)
      || ron(r.ron) !== pg.ron
      || (!estadoEsDeAqui(pg) && (svcStatus(r.estado_tv) !== pg.estadoTv || svcStatus(r.estado_combo) !== pg.estadoCombo))
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
  sum.invoices = { nuevas: inserts.length, actualizadas: cambiadasRows.length, editadasAqui: editadas.length, huerfanas, conflictosTid: conflictos };
  if (conflictos.length) log(`⚠️ invoices: ${conflictos.length} tid en conflicto con facturas propias del stack nuevo: ${conflictos.slice(0, 10).join(',')}`);
  if (DRY) return;
  await createMany('subInvoice', inserts);
  await pooled(cambiadasRows, 5, async (r) => {
    const sid = subMap.get(r.csd);
    if (!sid) return;
    const { legacyId, ...data } = mapInvoice(r, sid);
    // Factura con el SERVICIO ASIGNADO a mano aquí: el plan es el de este lado.
    // La huella no mira television/combo/puntos, pero cualquier otro cambio de la
    // factura (un abono, un corte) la trae por esta vía con el `mapInvoice` completo
    // y le devolvería el plan viejo del legacy. Es exactamente lo que hay que evitar:
    // el cliente cambió de plan y a los 15 minutos volvería a tener el anterior.
    // El writeback (`pushServicioAsignado`) es quien iguala los dos lados.
    if (pgFp.get(r.id)?.serviceAssignedAt) {
      delete data.serviceTv; delete data.serviceCombo; delete data.puntos;
    }
    // Y con el CORTE POR SERVICIO igual: la factura entra por esta vía en cuanto cambie
    // cualquier otra cosa suya (un abono), y con el `mapInvoice` completo le devolvería
    // el estado viejo del legacy —deshaciendo la suspensión que se acaba de hacer aquí—.
    if (pgFp.get(r.id)?.serviceStatusAt) {
      delete data.estadoTv; delete data.estadoCombo;
    }
    // Céntimos: si la diferencia es la truncación del legacy (`int(16)`), lo de aquí
    // es lo exacto y no se pisa con el entero de allá.
    const pgf = pgFp.get(r.id);
    if (pgf && mismoDinero(r.pamnt, pgf.paidAmount)) delete data.paidAmount;
    if (pgf && mismoDinero(r.total, pgf.total)) delete data.total;
    await prisma.subInvoice.update({ where: { legacyId: r.id }, data }).catch((e) => log(`⚠️ invoice ${r.id}: ${e.message}`));
  });

  // Facturas editadas aquí: actualización PARCIAL (sólo el cobro y el estado de
  // servicio que se movieron en el legacy). Los montos y los renglones son los de
  // este sistema y no se tocan.
  await pooled(editadas, 5, async ({ r, pg }) => {
    // Lo de aquí manda cuando la única diferencia es la truncación del legacy.
    const paid = mismoDinero(r.pamnt, pg.paidAmount) ? num(pg.paidAmount) : num(r.pamnt);
    const total = num(pg.total);
    const data = {
      paidAmount: paid, ron: ron(r.ron),
      ...(estadoEsDeAqui(pg) ? {} : { estadoTv: svcStatus(r.estado_tv), estadoCombo: svcStatus(r.estado_combo) }),
      rec: norm(r.rec) || null, reconnectFlag: norm(r.rec) === '1',
      promo: r.promo, promo2: r.promo2,
      status: invStatus(r.status) === 'CANCELED' ? 'CANCELED'
        : mismoDinero(paid, total) || paid >= total ? 'PAID' : paid > 0 ? 'PARTIAL' : 'DUE',
    };
    await prisma.subInvoice.update({ where: { legacyId: r.id }, data }).catch((e) => log(`⚠️ invoice editada ${r.id}: ${e.message}`));
  });
  if (editadas.length) log(`invoices: ${editadas.length} editadas aquí → sólo se refrescó el cobro (montos y renglones se respetan)`);
  st.invoices = maxId; await saveState(st);

  // ítems de las facturas nuevas y modificadas (las editadas aquí quedan fuera:
  // el upsert por legacyId les devolvería los renglones que la edición quitó)
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
  // `tid` allá significa dos cosas según la categoría: en un cobro es la FACTURA y en
  // un pago de compra (`cat = 'Purchase'`) es la ORDEN. Se resuelven por separado; si
  // no, el egreso de una compra quedaba colgando de la factura de un cliente con ese
  // mismo número (ver `mapTx`).
  const tidsFactura = [...new Set(rows.filter((r) => !esPagoDeCompra(r)).map((r) => r.tid).filter((t) => t))];
  const tidsOrden = [...new Set(rows.filter(esPagoDeCompra).map((r) => r.tid).filter((t) => t))];
  const invRows = tidsFactura.length ? await prisma.subInvoice.findMany({ where: { tid: { in: tidsFactura } }, select: { id: true, tid: true } }) : [];
  const invByTid = new Map(invRows.map((r) => [r.tid, r.id]));
  const ordRows = tidsOrden.length ? await prisma.supplyOrder.findMany({ where: { tid: { in: tidsOrden } }, select: { id: true, tid: true } }) : [];
  const ordByTid = new Map(ordRows.map((r) => [r.tid, r.id]));
  const data = rows.map((r) => {
    maxId = Math.max(maxId, r.id);
    const compra = esPagoDeCompra(r);
    return mapTx(r, subMap.get(r.payerid), compra ? null : invByTid.get(r.tid), compra ? ordByTid.get(r.tid) : null);
  });
  sum.transactions = { nuevas: data.length };
  if (DRY) return;
  await createMany('transaction', data, 3000);
  st.tx = maxId; await saveState(st);
}

/**
 * Cuelga cada pago de compra (`cat = 'Purchase'`) de SU orden.
 *
 * Va en un paso aparte y no dentro de `syncTransactions` por el ORDEN de las pasadas:
 * las órdenes bajan en `syncInventario`, que corre DESPUÉS de los movimientos, así que
 * el pago de una orden nueva llega cuando la orden todavía no existe de este lado. La
 * marca de agua no vuelve a mirar esa fila jamás, y sin este repaso el pago se quedaría
 * suelto para siempre.
 *
 * Además limpia el `invoiceId` que traían de antes: en estos movimientos `tid` es el
 * número de la ORDEN, y casarlo contra `invoices.tid` los colgó de la factura de un
 * cliente cualquiera (766 de 777). El `tid` bueno se relee del legacy —aquí no se
 * guarda— para no depender de ese enlace equivocado.
 */
async function enlazarPagosDeCompra(my, sum) {
  const sueltos = await prisma.transaction.findMany({
    where: { category: 'Purchase', supplyOrderId: null, legacyId: { not: null } },
    select: { id: true, legacyId: true, invoiceId: true },
  });
  sum.pagosDeCompra = { sueltos: sueltos.length, enlazados: 0, sinOrden: 0 };
  if (!sueltos.length) return;

  const filas = await mysqlIn(my, "SELECT id, tid FROM transactions WHERE cat = 'Purchase' AND id IN (??IDS??)",
    sueltos.map((t) => t.legacyId));
  const tidPorLegacy = new Map(filas.map((r) => [r.id, r.tid]));
  const tids = [...new Set(filas.map((r) => r.tid).filter((t) => t))];
  const ordenes = tids.length
    ? await prisma.supplyOrder.findMany({ where: { tid: { in: tids } }, select: { id: true, tid: true } })
    : [];
  const ordPorTid = new Map(ordenes.map((o) => [o.tid, o.id]));

  const cambios = [];
  for (const t of sueltos) {
    const orden = ordPorTid.get(tidPorLegacy.get(t.legacyId));
    if (!orden) { if (t.invoiceId) cambios.push({ id: t.id, data: { invoiceId: null } }); sum.pagosDeCompra.sinOrden++; continue; }
    cambios.push({ id: t.id, data: { supplyOrderId: orden, invoiceId: null } });
    sum.pagosDeCompra.enlazados++;
  }
  if (DRY || !cambios.length) return;
  await pooled(cambios, 5, (c) => prisma.transaction.update({ where: { id: c.id }, data: c.data }));
  log(`pagos de compra: ${sum.pagosDeCompra.enlazados} enlazados a su orden`
    + `${sum.pagosDeCompra.sinOrden ? `, ${sum.pagosDeCompra.sinOrden} sin orden en este lado` : ''}`);
}

/**
 * Re-lectura de los pagos RECIENTES (lo que `syncTransactions` no puede hacer).
 *
 * POR QUÉ (2026-08-26): `transactions` se trae por marca de agua —sólo `id > st.tx`—,
 * así que una fila ya importada no se vuelve a mirar NUNCA. Si allá EDITAN el importe
 * de un movimiento (que pasa: un egreso mal digitado, un recibo de luz corregido), aquí
 * se queda el valor viejo para siempre y las dos cajas dejan de cuadrar sin que nada lo
 * avise. Medido ese día: 7 filas descuadradas en agosto, hasta 100.000 COP en una sola.
 *
 * Sólo se refrescan los campos que son del legacy. `attach`/`attachName` (el comprobante
 * que se sube aquí) no se tocan: allá no existe esa columna y volverían a null.
 *
 * Ventana corta a propósito: releer 510.000 filas cada 15 min para pillar un puñado de
 * ediciones sale carísimo, y una edición sobre un movimiento de hace meses no es la
 * operación normal — para eso está la conciliación de caja, que sí mira todo.
 */
const DIAS_REFRESCO_TX = Number(process.env.LEGACY_SYNC_REFRESH_TX_DIAS || 30);
const CAMPOS_TX_DEL_LEGACY = ['type', 'category', 'debit', 'credit', 'method', 'date',
  'payerName', 'note', 'status', 'noShow', 'cashAccountId', 'accountName', 'bankName', 'bankId', 'ext'];

async function refrescarTransacciones(my, sum) {
  const [rows] = await my.query(
    'SELECT * FROM transactions WHERE date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)', [DIAS_REFRESCO_TX]);
  if (!rows.length) { sum.refrescoPagos = { revisados: 0, actualizados: 0 }; return; }
  const ids = rows.map((r) => r.id);
  const pgRows = await prisma.transaction.findMany({ where: { legacyId: { in: ids } } });
  const byLegacy = new Map(pgRows.map((r) => [r.legacyId, r]));
  const cambios = [];
  for (const r of rows) {
    const pg = byLegacy.get(r.id);
    if (!pg) continue; // alta nueva: de eso se encarga syncTransactions
    const mapped = mapTx(r, pg.subscriberId, pg.invoiceId, pg.supplyOrderId);
    // sólo los campos que manda el legacy; el resto (comprobante, enlaces) es de aquí
    const recorte = {};
    for (const k of CAMPOS_TX_DEL_LEGACY) recorte[k] = mapped[k];
    const keys = diffKeys(recorte, pg);
    if (keys.length) cambios.push({ legacyId: r.id, keys, mapped: recorte });
  }
  sum.refrescoPagos = { revisados: rows.length, actualizados: cambios.length };
  if (DRY || !cambios.length) return;
  await pooled(cambios, 5, async (c) => {
    const data = {};
    for (const k of c.keys) data[k] = c.mapped[k];
    await prisma.transaction.update({ where: { legacyId: c.legacyId }, data });
  });
  log(`pagos: ~${cambios.length} refrescados (editados en el legacy)`);
}

/**
 * COMPROBANTES de los movimientos de caja (`meta_data` → `Transaction.legacyAttach`).
 *
 * En el legacy el soporte de un egreso NO está en `transactions`: la pantalla de allá
 * lo busca en `meta_data` con dos reglas distintas (ver `Transactions.php`):
 *
 *   · gasto corriente → type 77, `rid` = id del movimiento (o `col3` en 256 filas
 *     viejas donde se guardó ahí), y `col1` = el fichero.
 *   · pago de una orden de compra (`cat = 'Purchase'`) → type 4 con `col2 = 'Pago'` y
 *     `rid` = el `tid` del movimiento, que allí es la orden, no la factura.
 *
 * Se trae SÓLO EL NOMBRE, no el binario: los 26.153 comprobantes pesan 5,8 GB y ya
 * están en la copia local de `userfiles/attach/`, de donde el backend los sirve tal
 * cual (`rutaDeComprobanteLegacy`). Duplicarlos aquí no aportaba nada.
 *
 * La marca de agua retrocede `COMPROBANTES_RETRO` ids en cada pasada: un comprobante
 * puede entrar en el legacy ANTES de que su movimiento haya cruzado para acá, y sin
 * ese solape la fila se perdería para siempre por haber llegado un minuto antes.
 */
const COMPROBANTES_RETRO = Number(process.env.LEGACY_SYNC_COMPROBANTES_RETRO || 500);

async function syncComprobantes(my, st, sum) {
  const desde = Math.max(0, (st.comprobantes ?? 0) - COMPROBANTES_RETRO);
  const [gastos] = await my.query(
    "SELECT id, rid, col3, col1 FROM meta_data WHERE type = 77 AND col1 <> '' AND id > ? ORDER BY id", [desde]);
  // Los pagos de compras se resuelven contra `transactions` allá mismo: aquí no hay
  // columna `tid` en el movimiento con la que rehacer ese cruce.
  const [compras] = await my.query(
    `SELECT m.id, t.id AS txid, m.col1
       FROM meta_data m JOIN transactions t ON t.tid = m.rid AND t.cat = 'Purchase'
      WHERE m.type = 4 AND m.col2 = 'Pago' AND m.col1 <> '' AND m.id > ? ORDER BY m.id`, [desde]);

  let maxId = st.comprobantes ?? 0;
  const porTx = new Map();
  for (const r of gastos) {
    maxId = Math.max(maxId, r.id);
    const tx = r.rid || r.col3;
    if (tx) porTx.set(tx, norm(r.col1));
  }
  for (const r of compras) {
    maxId = Math.max(maxId, r.id);
    if (r.txid) porTx.set(r.txid, norm(r.col1));
  }

  sum.comprobantes = { revisados: porTx.size };
  if (DRY || !porTx.size) return;

  // Un UPDATE por lote (no uno por fila): en la primera pasada esto son 26.000
  // movimientos y hacerlo de a uno tardaba minutos con el pool corto de este script.
  // `legacyAttach IS DISTINCT FROM` deja fuera lo que ya está igual, así que las
  // pasadas siguientes no escriben nada.
  let tocados = 0;
  const pares = [...porTx.entries()];
  await inChunks(pares, 1000, async (slice) => {
    // Parametrizado: el nombre del fichero viene de la BD del legacy y no se
    // interpola nunca en el SQL.
    const params = [];
    const values = slice.map(([tx, f]) => {
      params.push(Number(tx), f);
      return `($${params.length - 1}::int, $${params.length}::text)`;
    }).join(',');
    tocados += await prisma.$executeRawUnsafe(
      `UPDATE "Transaction" t SET "legacyAttach" = v.f
         FROM (VALUES ${values}) AS v(lid, f)
        WHERE t."legacyId" = v.lid AND t."legacyAttach" IS DISTINCT FROM v.f`, ...params);
  });
  sum.comprobantes.enlazados = tocados;
  if (tocados) log(`comprobantes: ${tocados} movimientos con soporte del legacy`);
  st.comprobantes = maxId; await saveState(st);
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

/**
 * Anulaciones de movimientos.
 *
 * La marca de agua avanza SIEMPRE, también sobre las que no se pudieron mapear, así que
 * la que llegue antes que su movimiento (la anulación es una fila aparte y el orden
 * entre las dos tablas no está garantizado) se perdería para siempre. Por eso las
 * descartadas se guardan en el estado y se reintentan en cada pasada, igual que los
 * archivos que fallan al bajarse: la próxima vez su transacción ya suele estar.
 *
 * Medido el 2026-08-27: 16 anulaciones de 2020-2025 quedaron por el camino así. Su
 * efecto sí está (el movimiento figura ANULADO), lo que falta es el motivo y quién
 * anuló; 2 de ellas son irrecuperables por modelo —el legacy dejó anular dos veces el
 * mismo movimiento y aquí `Voiding.transactionId` es único—, así que el reintento las
 * deja quietas después del primer intento fallido de escritura.
 */
async function syncAnulaciones(my, st, sum) {
  const pendientes = st.anulacionesPendientes ?? [];
  const [rows] = await my.query('SELECT * FROM anulaciones WHERE id_anulacion > ? ORDER BY id_anulacion', [st.anulaciones]);
  // Los reintentos van por delante: son más viejos que todo lo que traiga esta pasada.
  const reintentos = pendientes.length
    ? (await mysqlIn(my, 'SELECT * FROM anulaciones WHERE id_anulacion IN (??IDS??)', pendientes))
    : [];
  const todas = [...reintentos, ...rows];

  let maxId = st.anulaciones;
  const txIds = todas.map((r) => r.transactions_id);
  const txRows = txIds.length ? await prisma.transaction.findMany({ where: { legacyId: { in: txIds } }, select: { id: true, legacyId: true } }) : [];
  const txMap = new Map(txRows.map((r) => [r.legacyId, r.id]));
  const data = [], sinMovimiento = [];
  for (const r of todas) {
    maxId = Math.max(maxId, r.id_anulacion);
    const tid = txMap.get(r.transactions_id);
    if (!tid) { sinMovimiento.push(r.id_anulacion); continue; }
    data.push({ legacyId: r.id_anulacion, dateTime: dTime(r.fecha_hora) || new Date(0), detail: r.detalle,
      transactionId: tid, reason: norm(r.razon_anulacion), voidedBy: norm(r.usuario_anula) });
  }
  sum.anulaciones = { nuevas: data.length, reintentadas: reintentos.length, sinMovimiento: sinMovimiento.length };
  if (DRY) return;
  const escritas = await createMany('voiding', data);
  if (data.length) await prisma.transaction.updateMany({ where: { id: { in: data.map((d) => d.transactionId) } }, data: { status: 'ANULADA' } });

  // Lo que se intentó escribir y no entró (unicidad: ya había una anulación para ese
  // movimiento) no vuelve a la cola: reintentarlo cada 15 minutos para siempre sería
  // ruido. Sólo espera lo que aún no tiene a qué colgarse.
  st.anulaciones = maxId;
  st.anulacionesPendientes = sinMovimiento.slice(-500);
  await saveState(st);
  if (data.length || sinMovimiento.length) {
    log(`anulaciones: +${escritas ?? data.length}`
      + (sinMovimiento.length ? ` · ${sinMovimiento.length} esperando a su movimiento` : ''));
  }
}

/**
 * Facturas BORRADAS en el legacy.
 *
 * El resto de pasos detecta altas y cambios, pero nada miraba las BAJAS: si el
 * legacy borra una factura, en Postgres se queda viva para siempre. Medido el
 * 2026-08-06: 2.865 facturas fantasma, 198.259.196 COP sobre 2.860 clientes, y
 * creciendo (2.861 de ellas de este mismo año).
 *
 * De dónde salen: el legacy emite una factura, la borra y la reemite con `tid`
 * nuevo. Nexus se queda con las dos, así que 2.285 de esos clientes figuran
 * facturados dos veces por el mismo mes.
 *
 * Por qué urge: hoy no duele porque manda el legacy y el paso a Cartera está en
 * solo-informe. El día del corte ese cron se vuelve real y mandaría a Cartera
 * —con corte de servicio— a clientes que están al día.
 *
 * NO se borra la fila: se marca CANCELED y se anota el motivo. Anular es
 * reversible y conserva el rastro; borrar arrastraría renglones y recibos
 * enlazados, y dejaría un agujero imposible de auditar después.
 *
 * EL TOPE DE SEGURIDAD ES LO IMPORTANTE DE ESTA FUNCIÓN. Este paso deduce las
 * bajas por AUSENCIA: lo que no está en la lista del legacy, se anula. Si esa
 * consulta devolviera de más a menos —una conexión que se corta a media lectura,
 * un `WHERE` que alguien toque— la ausencia sería falsa y anularíamos facturas
 * buenas en masa, en silencio y sobre dinero real. Por eso se aborta el paso si
 * los candidatos superan el tope: ante una anomalía, no hacer nada y avisar.
 */
const MAX_BORRADOS_PCT = 5; // % del total; por encima huele a lectura incompleta

async function syncBorradas(my, sum) {
  const [filas] = await my.query('SELECT id FROM invoices');
  const enLegacy = new Set(filas.map((r) => r.id));

  // Cordura previa: si el legacy devuelve muchas menos filas de las que tenemos,
  // la lectura vino incompleta y la comparación no vale.
  const totalPg = await prisma.subInvoice.count({ where: { legacyId: { not: null } } });
  if (enLegacy.size < totalPg * 0.9) {
    sum.borradas = { abortado: `el legacy devolvió ${enLegacy.size} facturas para ${totalPg} en PG: lectura sospechosa` };
    return;
  }

  const vivas = await prisma.subInvoice.findMany({
    where: { legacyId: { not: null }, status: { not: 'CANCELED' } },
    select: { id: true, legacyId: true },
  });
  const aAnular = vivas.filter((r) => !enLegacy.has(r.legacyId));

  const tope = Math.ceil((enLegacy.size * MAX_BORRADOS_PCT) / 100);
  if (aAnular.length > tope) {
    sum.borradas = { abortado: `${aAnular.length} candidatas superan el tope de ${tope} (${MAX_BORRADOS_PCT}%)`, candidatas: aAnular.length };
    return;
  }

  sum.borradas = { anuladas: aAnular.length };
  if (DRY || !aAnular.length) return;

  const sello = new Date().toISOString().slice(0, 10);
  await inChunks(aAnular.map((r) => r.id), 500, async (ids) => {
    await prisma.subInvoice.updateMany({
      where: { id: { in: ids } },
      data: { status: 'CANCELED', notes: `Anulada por sincronización: borrada en el legacy (${sello}).` },
    });
  });
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

// ---------- apertura de caja (legacy → aquí) ----------
/**
 * APERTURA DE CAJA del legacy, traída a SAVES.
 *
 * El writeback ya lleva la apertura en el sentido contrario (`pushCashOpens`), pero
 * este lado faltaba: la cajera que abría en el legacy —que es lo que hacen a diario—
 * no dejaba rastro aquí. El panel la daba por "abierta" sólo cuando cruzaba el primer
 * cobro del día (de ahí lo deducía `actividadDelDia`), así que entre las 7:00 y el
 * primer pago la caja se veía SIN ABRIR con la ventanilla ya trabajando; y si ese día
 * no entraba plata, no constaba la apertura en ningún sitio. El propio writeback lo
 * venía gritando en cada pasada: "1 abiertas SÓLO en el legacy".
 *
 * No son el mismo dato en los dos lados (ver la nota larga de `pushCashOpens`):
 *   · allá → un PERMISO por USUARIO: `aauth_users.finicial`/`hinicial`.
 *   · aquí → una fila `CashOpen` por CAJA y día, con su base.
 * El puente es el USUARIO, y la caja se saca de `asignaciones` (detalle='caja'), que es
 * la misma fuente con la que se pobló `User.cajaLegacyId` (ver `migrar-caja-usuarios`).
 * Un usuario sin caja asignada allá no puede convertirse en una apertura aquí: se
 * reporta, no se inventa.
 *
 * SÓLO EL DÍA DE HOY. `finicial` es un campo que se sobreescribe, no un historial: el
 * legacy sólo sabe cuándo abrió cada quien la ÚLTIMA vez. Traer días pasados fabricaría
 * aperturas retroactivas a partir de un dato que ya no dice lo que parece.
 *
 * Sin eco de vuelta: el writeback ve la fila que este paso crea, resuelve su usuario y
 * encuentra `finicial = hoy` allá, así que la cuenta como "ya abierta" y no reescribe.
 */
async function syncAperturas(my, sum) {
  const hoy = FECHA_CO(new Date());
  const [rows] = await my.query(
    `SELECT u.id, u.username, u.hinicial, e.name AS nombre, a.tipo AS caja
       FROM aauth_users u
       LEFT JOIN employee_profile e ON e.id = u.id
       LEFT JOIN asignaciones a ON a.colaborador = u.id AND a.detalle = 'caja'
      WHERE u.finicial = ?
      ORDER BY u.hinicial`,
    [hoy],
  );
  const res = { dia: hoy, alla: rows.length, nuevas: 0, yaEstaban: 0, sinCaja: [], cajaDesconocida: [] };
  sum.aperturas = res;
  if (!rows.length) return res;

  const dia = DIA_UTC(hoy);
  for (const r of rows) {
    // `asignaciones.tipo` es VARCHAR en el legacy: sin Number() no casa con el legacyId Int.
    const caja = r.caja == null || r.caja === '' ? null : Number(r.caja);
    const quien = r.nombre || r.username || `usuario ${r.id}`;
    if (caja == null || Number.isNaN(caja)) {
      res.sinCaja.push({ id: r.id, usuario: r.username, nombre: r.nombre });
      continue;
    }
    const cuenta = await prisma.cashAccount.findUnique({
      where: { legacyId: caja },
      select: { holder: true, fixedFund: true },
    });
    if (!cuenta) {
      res.cajaDesconocida.push({ id: r.id, usuario: r.username, caja });
      continue;
    }
    const ya = await prisma.cashOpen.findUnique({
      where: { cashAccountId_date: { cashAccountId: caja, date: dia } },
      select: { id: true },
    });
    if (ya) { res.yaEstaban++; continue; }

    // El nombre con el que se firma la apertura es el de `Staff`, no el del legacy: es
    // el que el writeback usa para volver a encontrar al usuario (`usuarioLegacyDe`
    // busca por `Staff.name`). Firmarla con otro la dejaría huérfana en la vuelta.
    const staff = await prisma.staff.findUnique({ where: { legacyId: r.id }, select: { name: true } });
    const base = round2(num(cuenta.fixedFund) + await arrastreDe(caja, dia));

    if (DRY) {
      log(`aperturas: en plan → caja ${caja} (${cuenta.holder}) por ${staff?.name || quien} a las ${r.hinicial}`);
      res.nuevas++;
      continue;
    }
    await prisma.cashOpen.create({
      data: {
        cashAccountId: caja, accountName: cuenta.holder, date: dia, base,
        openedBy: staff?.name || quien,
        openedAt: INSTANTE_CO(hoy, r.hinicial) || new Date(),
        note: 'Abierta en el legacy',
      },
    });
    res.nuevas++;
    log(`aperturas: caja ${caja} (${cuenta.holder}) abierta aquí por ${staff?.name || quien} (${hoy} ${r.hinicial})`);
  }
  if (res.sinCaja.length) {
    log(`aperturas: ${res.sinCaja.length} abiertas allá SIN caja asignada en \`asignaciones\``
      + ` (${res.sinCaja.map((u) => u.usuario).join(', ')}) — no se puede saber qué caja abrieron`);
  }
  return res;
}

/**
 * Arrastre que entró a ese día: la pata INCOME `Saldo <fecha>` que dejó el cierre
 * anterior. Réplica de `CobranzasService.getCarryover` — misma regla, porque la base de
 * una apertura importada tiene que dar lo mismo que si se hubiera pulsado el botón aquí.
 *
 * El pre-filtro no basta: hay gastos reales que empiezan por "Saldo" en el sentido
 * corriente ("Saldo mano de obra..."), y se descartan con la regex exacta.
 */
const RE_NOTA_SALDO = /^Saldo \d{4}-\d{2}-\d{2}$/;

async function arrastreDe(cashAccountId, dia) {
  const filas = await prisma.transaction.findMany({
    where: {
      cashAccountId, status: 'VIGENTE', type: 'INCOME',
      note: { startsWith: 'Saldo ' }, invoiceId: null,
      method: { in: ['Cash', 'cash'] }, category: { in: ['Sales', 'sales'] },
      date: { gte: dia, lt: new Date(dia.getTime() + 86_400_000) },
    },
    select: { credit: true, note: true },
  });
  const entrada = filas.find((t) => RE_NOTA_SALDO.test(t.note || ''));
  return entrada ? round2(num(entrada.credit)) : 0;
}

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// ---------- órdenes de servicio (tickets) ----------
// El legacy llama `tickets` a las órdenes de trabajo. Este paso faltaba desde que
// arrancó el sync en vivo (2026-07-27): la carga histórica las trajo con
// `etl-soporte.js` y ahí quedaron congeladas, así que TODA orden abierta en el
// legacy desde esa fecha era invisible en este sistema (6.424 cuando se detectó,
// 913 de ellas sin cerrar). Correr el sync a mano no las traía: no había paso que
// las mirara.
const TSTATUS = { realizando: 'REALIZANDO', resuelto: 'RESUELTO', anulada: 'ANULADA', pendiente: 'PENDIENTE' };
const tStatus = (s) => TSTATUS[String(s || '').toLowerCase()] || 'PENDIENTE';

function mapTicket(r, sid, staffByUser, nombrePorClave) {
  const asignado = norm(r.asignado) || null;
  const autor = norm(r.col) || null;
  return {
    legacyId: r.idt, code: r.codigo, subject: norm(r.subject) || '', type: norm(r.detalle) || '',
    created: dOnly(r.created) || new Date(0), subscriberId: sid,
    col: norm(r.col) || null, status: tStatus(r.status), problem: norm(r.problema) || null,
    section: norm(r.section) || null,
    finalDate: dOnly(r.fecha_final), invoiceLegacy: r.id_invoice, invoiceBillLegacy: r.id_factura,
    assigned: asignado, par: r.par,
    // `assigned` es texto libre (usernames del legacy). Resolverlo aquí es lo que
    // hace que la orden cuente en el tablero de rendimiento; ver nombre-tecnico.ts.
    assignedStaffId: (asignado && staffByUser.get(asignado.toLowerCase())) || null,
    // Quién la generó ALLÁ. `col` guarda el username del legacy ('SoniaCajera'), así
    // que se traduce a nombre de persona con el mismo censo que `asignado`; lo que no
    // cruza con ninguna ficha se deja crudo, que es mejor que dejarlo sin autor.
    createdByName: (autor && (nombrePorClave.get(autor.toLowerCase()) || autor)) || null,
    createdBySource: autor ? 'LEGACY' : null,
    signatureName: norm(r.nombre_firma) || null, signatureCc: norm(r.cc_firma) || null,
    signatureRel: norm(r.parentesco_firma) || null,
  };
}

async function syncTickets(my, st, sum, subMap) {
  // El texto de `asignado` viene de dos sitios que NO escriben igual: el legacy guarda
  // *usernames* ('OmarTec') y la agenda de este sistema guarda el NOMBRE COMPLETO
  // ('Luis Hurtado'). Indexar sólo por username dejaba sin resolver a las órdenes
  // asignadas aquí y —peor— la ida les borraba `assignedStaffId` en cada pasada,
  // sacándolas del tablero de rendimiento. Ver nombre-tecnico.ts.
  const staff = await prisma.staff.findMany({ select: { id: true, username: true, name: true } });
  const staffByUser = new Map();
  // El mismo censo, pero para LEER: username -> nombre de persona. Es lo que hace
  // legible a `col` (quién generó la orden), que allá también es un username.
  const nombrePorClave = new Map();
  for (const s of staff) {
    for (const clave of [s.username, s.name]) {
      const k = String(clave ?? '').trim().toLowerCase();
      if (k && !staffByUser.has(k)) staffByUser.set(k, s.id);
      if (k && s.name && !nombrePorClave.has(k)) nombrePorClave.set(k, s.name.trim());
    }
  }

  // 1) nuevas por id
  const [nuevasRows] = await my.query('SELECT * FROM tickets WHERE idt > ? ORDER BY idt', [st.tickets]);
  let maxId = st.tickets;
  const inserts = [];
  for (const r of nuevasRows) {
    maxId = Math.max(maxId, r.idt);
    inserts.push(mapTicket(r, subMap.get(r.cid) || null, staffByUser, nombrePorClave));
  }

  // 2) modificadas. No se comparan las 321k: una orden ya RESUELTA/ANULADA y vieja
  //    no se vuelve a mover. La ventana son las que siguen vivas en PG más las
  //    recientes (60 días), que es donde de verdad ocurre el cambio de estado, la
  //    reasignación y el cierre.
  //
  //    La comparación es `diffKeys`, el mismo comparador que usan customers e
  //    invoices, y no una a mano: es el que sabe que '' y null son lo mismo entre
  //    los dos mundos —el legacy guarda '' donde Prisma guarda null— y el que
  //    protege los caracteres reparados (la 'Ñ' que allá es '?'), que si no se
  //    devolverían cada 15 minutos. Ver `soloCaracterPerdido` en lib/vestel-map.js.
  const desde = new Date(Date.now() - 60 * 864e5);
  //    Y las TOCADAS AQUÍ quedan fuera: una orden que este sistema movió en algo que
  //    el legacy también guarda (cierre, técnico, firma) pasa a mandarla nexus, y el
  //    writeback se encarga de empujarla. Si entraran por aquí, la ida les devolvería
  //    el estado viejo del legacy cada 15 minutos y el cierre del técnico duraría lo
  //    que tarde la siguiente pasada. Ver `Ticket.editedAt`.
  const vigiladas = await prisma.ticket.findMany({
    where: {
      legacyId: { not: null }, editedAt: null,
      OR: [{ status: { in: ['PENDIENTE', 'REALIZANDO'] } }, { created: { gte: desde } }],
    },
  });
  const pgByLegacy = new Map(vigiladas.map((r) => [r.legacyId, r]));
  const vigiladasRows = pgByLegacy.size
    ? await mysqlIn(my, 'SELECT * FROM tickets WHERE idt IN (??IDS??)', [...pgByLegacy.keys()]) : [];
  const cambios = [];
  let agendadas = 0;
  for (const r of vigiladasRows) {
    const pg = pgByLegacy.get(r.idt);
    if (!pg) continue;
    const mapped = mapTicket(r, subMap.get(r.cid) || null, staffByUser, nombrePorClave);
    delete mapped.legacyId;
    let keys = diffKeys(mapped, pg);
    // `assignedStaffId` es DERIVADO de `assigned`: si el texto no cambió, el id no se
    // reescribe. El legacy no guarda a quién apunta ese texto, así que dejarlo pasar
    // solo permite que la ida borre un vínculo que aquí ya estaba bien resuelto.
    if (!keys.includes('assigned')) keys = keys.filter((k) => k !== 'assignedStaffId');
    // Orden AGENDADA en este sistema: la cajera ya la repartió y le puso técnico y
    // turno. El legacy no sabe de la agenda, así que traer su `asignado` viejo le
    // borraría el técnico a una visita del día. Del legacy se sigue aceptando todo
    // lo demás —sobre todo el cierre—, pero la asignación es de acá. Mismo criterio
    // que el blindaje `editedAt` de las facturas.
    // El autor de una orden NACIDA AQUÍ ya está sellado y con su origen real
    // (USUARIO / CHATBOT / SISTEMA). El legacy solo tiene `col`, así que dejarlo
    // pasar la re-firmaría como 'LEGACY' cada 15 minutos y se perdería la
    // distinción entre "la abrió una persona" y "la abrió el sistema".
    if (pg.createdBySource) keys = keys.filter((k) => k !== 'createdByName' && k !== 'createdBySource');
    if (pg.scheduledAt && keys.some((k) => k === 'assigned' || k === 'assignedStaffId')) {
      keys = keys.filter((k) => k !== 'assigned' && k !== 'assignedStaffId');
      agendadas++;
    }
    if (keys.length) cambios.push({ legacyId: r.idt, keys, mapped });
  }

  const propiasDeAqui = await prisma.ticket.count({ where: { legacyId: { not: null }, editedAt: { not: null } } });
  sum.tickets = { nuevas: inserts.length, actualizadas: cambios.length, agendadasAqui: agendadas,
    ventana: pgByLegacy.size, tocadasAqui: propiasDeAqui };
  if (!DRY) {
    await createMany('ticket', inserts, 2000);
    await pooled(cambios, 5, async (c) => {
      const data = {};
      for (const k of c.keys) data[k] = c.mapped[k];
      await prisma.ticket.update({ where: { legacyId: c.legacyId }, data }).catch((e) => log(`⚠️ ticket ${c.legacyId}: ${e.message}`));
    });
    if (agendadas) log(`tickets: ${agendadas} agendadas aquí → se respetó el técnico de la agenda`);
    st.tickets = maxId; await saveState(st);
  }

  // 3) hilo de la orden (tickets_th): el historial de mensajes y las fotos.
  const [thRows] = await my.query('SELECT * FROM tickets_th WHERE id > ? ORDER BY id', [st.ticketsTh]);
  let maxTh = st.ticketsTh;
  const thData = thRows.map((r) => {
    maxTh = Math.max(maxTh, r.id);
    return { legacyId: r.id, ticketCode: r.tid, message: norm(r.message), subscriberId: subMap.get(r.cid) || null,
      employeeId: r.eid || 0, date: dTime(r.cdate) || new Date(0), attach: norm(r.attach) };
  });
  sum.ticketsTh = { nuevos: thData.length };
  if (!DRY) {
    await createMany('ticketThread', thData, 3000);
    st.ticketsTh = maxTh; await saveState(st);
  }

  // 4) a dónde se muda el cliente en una orden de TRASLADO. Va también en seco: es
  // el paso que hay que poder mirar antes de soltarlo sobre 4.000 órdenes.
  await syncDestinoTraslados(my, st, sum);
}

// ---------- destino de los traslados (tabla `temporales`) ----------
/**
 * La dirección nueva de un traslado, que el legacy NO guarda en la orden.
 *
 * `tickets` no tiene ninguna columna para el destino: el legacy lo aparca en
 * `temporales`, una fila por orden atada por `corden` = **código** de la orden (no
 * por `idt`), con las casillas partidas igual que en la ficha. Esa tabla es la
 * cesta de "lo que esta orden va a aplicar": en un traslado la dirección, y en un
 * cambio de plan las columnas `tv`/`internet`/`puntos` —eso último sigue sin
 * traerse, ver más abajo.
 *
 * Sin este paso, las 3.757 órdenes de traslado con dirección registrada allá
 * llegaban aquí mudas: la ficha del técnico decía "Traslado" y no a qué casa ir, y
 * parecía un fallo de esta pantalla cuando el dato existía desde el principio.
 *
 * Dos cosas que NO hace:
 *  · **No mueve la ficha del cliente.** Allá el traslado es una SOLICITUD: la
 *    dirección se le escribe al abonado cuando la orden se cierra, y esa escritura
 *    ya baja por `customers`. Aplicarla aquí al verla mudaría al cliente antes de
 *    que el técnico haya ido.
 *  · **No sella `moveAppliedAt`.** Esa marca es "este sistema movió la ficha", y
 *    aquí no la movió nadie: inventarle una fecha diría que sí.
 */
async function syncDestinoTraslados(my, st, sum) {
  if (!direccionDe) {
    sum.trasladosDestino = { omitido: 'sin dist/: compila el backend (npm run build) para traer el destino de los traslados' };
    log('⚠️ traslados: sin dist/, no se pudo armar la dirección — paso omitido');
    return;
  }
  const desde = st.temporales ?? 0;
  const [rows] = await my.query('SELECT * FROM temporales WHERE id > ? ORDER BY id', [desde]);
  let maxId = desde;
  const conDireccion = [];
  for (const r of rows) {
    maxId = Math.max(maxId, r.id);
    // Las filas de cambio de plan no traen dirección: ahí `temporales` guarda el plan
    // nuevo y esta pasada no tiene nada que hacer con ellas.
    if (Number(r.corden) > 0 && norm(r.nomenclatura)) conDireccion.push(r);
  }
  sum.trasladosDestino = { filas: rows.length, conDireccion: conDireccion.length, aplicados: 0 };
  if (!conDireccion.length) {
    if (!DRY) { st.temporales = maxId; await saveState(st); }
    return;
  }

  // Las casillas de `temporales` se llaman distinto que las de `customers` (nuno,
  // auno, ndos, ados, ntres), pero son las mismas doce de la ficha.
  const nomenclaturaDe = (r) => ({
    nomenclatura: norm(r.nomenclatura), numero1: norm(r.nuno), adicionauno: norm(r.auno),
    numero2: norm(r.ndos), adicional2: norm(r.ados), numero3: norm(r.ntres),
    residencia: norm(r.residencia), referencia: norm(r.referencia),
    divicion: '', divnum1: '', divicion2: '', divnum2: '',
  });

  const porCodigo = new Map();
  for (const r of conDireccion) porCodigo.set(Number(r.corden), r);

  // Solo órdenes que vinieron del legacy: una nacida aquí ya trae su destino puesto
  // por quien la abrió, y su código puede repetir el de una de allá.
  const codigos = [...porCodigo.keys()];
  const tickets = [];
  for (let i = 0; i < codigos.length; i += 2000) {
    tickets.push(...await prisma.ticket.findMany({
      where: { code: { in: codigos.slice(i, i + 2000) }, legacyId: { not: null } },
      select: {
        id: true, code: true, moveToText: true, moveInvoiceTid: true,
        subscriber: { select: { nomenclature: true, addressLine: true } },
      },
    }));
  }

  const updates = [];
  for (const t of tickets) {
    const r = porCodigo.get(t.code);
    if (!r) continue;
    const nomenclature = nomenclaturaDe(r);
    const destino = direccionDe(nomenclature, null);
    if (!destino) continue;
    const zona = {};
    if (norm(r.localidad)) zona.localityRef = norm(r.localidad);
    if (norm(r.barrio)) zona.neighborhood = norm(r.barrio);
    // De dónde sale, que es donde está el equipo que hay que recoger. Si la ficha ya
    // está en la dirección nueva, la orden ya se aplicó allá y el origen se perdió:
    // mejor no decir nada que decir que se mudó de su casa a su casa.
    const actual = direccionDe(t.subscriber?.nomenclature, t.subscriber?.addressLine);
    const origen = actual && actual.toLowerCase() !== destino.toLowerCase() ? actual : null;
    const factura = Number(r.tid_traslado) || null;
    // Solo se RELLENA lo que está vacío. Una orden que ya dice a dónde va lo dice
    // porque alguien la registró aquí (el destino se puede corregir desde «Corregir
    // orden»), y esto corre cada 15 minutos: pisarla sería deshacer esa corrección
    // sola, que es exactamente lo que el blindaje `editedAt` evita en el resto del
    // sync. De la factura del traslado sí se acepta el número si aquí falta: el
    // cobro lo hace el legacy y no hay dónde escribirlo desde este lado.
    const data = {};
    if (!t.moveToText) {
      data.moveTo = { nomenclature, ...zona };
      data.moveToText = destino;
      data.moveFromText = origen;
    }
    if (t.moveInvoiceTid == null && factura) data.moveInvoiceTid = factura;
    if (!Object.keys(data).length) continue;
    updates.push({ id: t.id, data });
  }

  sum.trasladosDestino.aplicados = updates.length;
  sum.trasladosDestino.ejemplo = updates[0]
    ? { orden: tickets.find((t) => t.id === updates[0].id)?.code, hasta: updates[0].data.moveToText ?? '(solo factura)' }
    : null;
  if (DRY) return;
  await pooled(updates, 5, async (u) => {
    await prisma.ticket.update({ where: { id: u.id }, data: u.data })
      .catch((e) => log(`⚠️ destino traslado ${u.id}: ${e.message}`));
  });
  if (updates.length) log(`traslados: ${updates.length} órdenes con su dirección nueva`);
  st.temporales = maxId; await saveState(st);
}

// ---------- observaciones y archivos del perfil del cliente ----------
/**
 * OBSERVACIONES del perfil (`historiales` → `SubscriberNote`).
 *
 * Es el bloque que el legacy pinta al pie de la ficha del cliente: fecha, tipo,
 * detalle y quién lo hizo. Altas por marca de agua (`idn`), que es todo lo que hace
 * falta: allá una observación se agrega o se borra, nunca se edita, y el borrado no
 * se propaga (misma regla que el resto del historial). El histórico ya lo trajo
 * `etl-notas-archivos-legacy.js`.
 *
 * Sin eco posible: las notas escritas en nexus no viajan al legacy, así que nada de
 * lo que entra por aquí puede ser algo que escribimos nosotros.
 */
async function syncObservaciones(my, st, sum, subMap) {
  const [rows] = await my.query(
    `SELECT idn,id_user,tipos,nombres,tdocumento,documento2,fecha,observacion,colaborador
       FROM historiales WHERE idn > ? ORDER BY idn`, [st.observaciones]);
  const nombreDe = await traductorDeNombres(prisma);
  let maxId = st.observaciones, sinCliente = 0;
  const data = [];
  for (const r of rows) {
    maxId = Math.max(maxId, r.idn);
    const sid = subMap.get(r.id_user);
    if (!sid) { sinCliente++; continue; }
    const nota = mapObservacion(r, sid, nombreDe);
    if (nota) data.push(nota);
  }
  sum.observaciones = { nuevas: data.length, sinCliente };
  if (DRY) return;
  await createMany('subscriberNote', data, 2000);
  st.observaciones = maxId; await saveState(st);
}

/** Tope de adjuntos por pasada: cada uno puede ser una descarga al legacy vivo. */
const ARCHIVOS_POR_PASADA = Number(process.env.LEGACY_SYNC_ARCHIVOS_MAX || 200);
/** Un adjunto que falla 5 pasadas seguidas ya no está en el legacy: se deja de pedir. */
const ARCHIVOS_REINTENTOS = 5;

/**
 * ARCHIVOS del perfil (`meta_data` type = 6 → `SubscriberFile`).
 *
 * A diferencia del resto de la pasada aquí hay un binario de por medio: una fila sin
 * su fichero es un enlace roto, así que la fila SÓLO se crea si el fichero quedó en
 * `uploads/subscribers/<id>/`. Como `userfiles/attach/` vive en el servidor del
 * legacy, lo nuevo se baja por HTTP — de ahí el tope por pasada.
 *
 * Lo que falla se apunta en la marca (`archivosFallidos`) y se reintenta en las
 * pasadas siguientes: sin eso, adelantar la marca de agua perdería un adjunto para
 * siempre por un timeout de un momento.
 */
async function syncArchivos(my, st, sum, subMap) {
  const [rows] = await my.query(
    'SELECT id,rid,col1 FROM meta_data WHERE type = 6 AND id > ? ORDER BY id LIMIT ?',
    [st.archivos, ARCHIVOS_POR_PASADA]);

  const fallidos = new Map((st.archivosFallidos ?? []).map((f) => [f.id, f]));
  const reintentos = fallidos.size
    ? await mysqlIn(my, 'SELECT id,rid,col1 FROM meta_data WHERE type = 6 AND id IN (??IDS??)', [...fallidos.keys()])
    : [];

  const res = { nuevos: 0, sinCliente: 0, fallidos: 0, reintentados: reintentos.length, descartados: 0 };
  let maxId = st.archivos;
  for (const r of rows) maxId = Math.max(maxId, r.id);
  const pendientes = [];
  for (const r of [...reintentos, ...rows]) {
    const sid = subMap.get(r.rid);
    if (!sid) { res.sinCliente++; continue; }
    pendientes.push({ ...r, sid });
  }
  if (DRY) { sum.archivosCliente = { ...res, porTraer: pendientes.length }; return; }

  const nuevosFallos = [];
  await inChunks(pendientes, 10, async (slice) => {
    const filas = (await Promise.all(slice.map(async (r) => {
      const storedName = nombreEnDisco(r.id, r.col1);
      const t = await traerArchivo(r.col1, path.join(UPLOAD_ROOT, r.sid, storedName));
      if (!t.ok) {
        const intentos = (fallidos.get(r.id)?.intentos ?? 0) + 1;
        if (intentos < ARCHIVOS_REINTENTOS) nuevosFallos.push({ id: r.id, intentos, motivo: t.motivo });
        else res.descartados++;
        return null;
      }
      return { legacyId: r.id, subscriberId: r.sid, originalName: nombreVisible(r.col1),
        storedName, mimeType: mimeDe(r.col1), size: t.size, uploadedByName: null };
    }))).filter(Boolean);
    if (filas.length) res.nuevos += (await prisma.subscriberFile.createMany({ data: filas, skipDuplicates: true })).count;
  });

  res.fallidos = nuevosFallos.length;
  sum.archivosCliente = res;
  st.archivos = maxId;
  st.archivosFallidos = nuevosFallos;
  await saveState(st);
}

// ---------- cargues de pagos por Excel ----------
/** Dónde deja el backend los .xlsx de los cargues (`PAYMENT_IMPORTS_ROOT`). */
const CARGUES_ROOT = path.join(__dirname, '..', 'uploads', 'payment-imports');
/** Descargas por HTTP al legacy por pasada. Copiar de la copia local no cuenta. */
const CARGUES_DESCARGAS_MAX = Number(process.env.LEGACY_SYNC_CARGUES_MAX || 100);
/** Lotes recientes que se releen aunque ya estén cerrados, por si allá los retocaron. */
const CARGUES_RELEER = 10;

/** Estado del archivo en el legacy → estado del lote aquí. */
const estadoCargue = (e) => (norm(e) === 'Transacciones Cargadas' ? 'Procesado' : 'Cargado');

/** Clave de comparación de nombres de cuenta (misma regla que PaymentImportsService). */
const claveCuenta = (s) =>
  norm(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/\s+/g, ' ');

/**
 * CARGUES DE PAGOS POR EXCEL (`files_carga_transaccional` + `datos_archivo_excel_cargue`).
 *
 * Es el archivo del corresponsal que la contadora sube todos los días. La pantalla
 * de aquí (`/tesoreria/importar-pagos`) es el clon de la de allá, pero listaba sólo
 * lo cargado en nexus: como el cargue diario se sigue haciendo en el legacy, salía
 * vacía y el historial —914 archivos desde 2023, 8.544 pagos— no existía de este lado.
 *
 * Lo que entra por aquí es HISTORIA, no trabajo pendiente: la plata de esas filas ya
 * está en Postgres, la trajo `syncTransactions` desde `transactions`. Por eso el lote
 * con `legacyId` llega bloqueado —ni procesar, ni reintentar, ni borrar (ver
 * `PaymentImportsService`)—: volver a aplicarlo duplicaría el recaudo.
 *
 * Se trae:
 *   · lo nuevo por marca de agua (`st.cargues`),
 *   · más la relectura de los lotes que allá aún pueden cambiar (los que no están
 *     cerrados) y de los últimos, porque un archivo se sube y se procesa en dos
 *     momentos distintos: la pasada puede pillarlo a medio camino.
 *
 * El .xlsx original se copia a `uploads/payment-imports/` (copia local primero, el
 * legacy vivo después) para que el enlace del nombre siga bajando el archivo cuando
 * el legacy se apague.
 */
async function syncCargues(my, st, sum, subMap) {
  const res = { nuevos: 0, releidos: 0, filasNuevas: 0, filasCambiadas: 0, archivos: 0, sinArchivo: 0, sinCliente: 0 };
  sum.cargues = res;

  const locales = await prisma.paymentImportBatch.findMany({
    where: { legacyId: { not: null } },
    select: { id: true, legacyId: true, status: true, storedFile: true },
  });
  const porLegacy = new Map(locales.map((b) => [b.legacyId, b]));

  const SEL = `SELECT f.id, f.nombre, f.fecha, f.estado, f.nombre_real_file, u.username, e.name AS nombre_real
                 FROM files_carga_transaccional f
                 LEFT JOIN aauth_users u ON u.id = f.id_usuario
                 LEFT JOIN employee_profile e ON e.id = f.id_usuario`;
  const [nuevos] = await my.query(`${SEL} WHERE f.id > ? ORDER BY f.id`, [st.cargues ?? 0]);

  // Relectura: lo que allá sigue vivo (no cerrado) y los últimos, que es donde
  // cambian los estados de las filas después de procesarlas.
  const aReleer = new Set(locales.filter((b) => b.status !== 'Procesado').map((b) => b.legacyId));
  for (const b of [...porLegacy.keys()].sort((a, c) => c - a).slice(0, CARGUES_RELEER)) aReleer.add(b);
  for (const r of nuevos) aReleer.delete(r.id); // los nuevos ya vienen en esta pasada
  const releidos = aReleer.size
    ? await mysqlIn(my, `${SEL} WHERE f.id IN (??IDS??)`, [...aReleer])
    : [];

  const archivos = [...nuevos, ...releidos];
  if (!archivos.length) return res;

  let maxId = st.cargues ?? 0;
  for (const r of nuevos) maxId = Math.max(maxId, r.id);

  // Filas de todos los archivos de esta pasada, de un tirón.
  const filas = await mysqlIn(
    my,
    `SELECT id,fecha,documento,monto,estado,id_archivo,ref_efecty,id_customer,metodo_pago
       FROM datos_archivo_excel_cargue WHERE id_archivo IN (??IDS??) ORDER BY id`,
    archivos.map((r) => r.id),
  );
  const porArchivo = new Map();
  for (const f of filas) {
    if (!porArchivo.has(f.id_archivo)) porArchivo.set(f.id_archivo, []);
    porArchivo.get(f.id_archivo).push(f);
  }

  // Cuentas de tesorería por nombre: la columna D del Excel es el nombre de la
  // cuenta donde entra la plata, no un método de pago (ver PaymentImportsService).
  const cuentas = new Map();
  for (const c of await prisma.cashAccount.findMany({ where: { legacyId: { not: null } }, select: { legacyId: true, holder: true } })) {
    if (c.holder) cuentas.set(claveCuenta(c.holder), c.legacyId);
  }

  // Nombres de los abonados que aparecen en las filas (los de Postgres, ya limpios
  // de la basura del legacy: espacios de más y las Ñ perdidas).
  const ids = [...new Set(filas.map((f) => subMap.get(f.id_customer)).filter(Boolean))];
  const nombres = new Map();
  await inChunks(ids, 2000, async (slice) => {
    for (const s of await prisma.subscriber.findMany({
      where: { id: { in: slice } },
      select: { id: true, fullName: true, firstName: true, secondName: true, lastName1: true, lastName2: true, companyName: true },
    })) {
      const persona = [s.firstName, s.secondName, s.lastName1, s.lastName2].map((p) => norm(p)).filter(Boolean).join(' ');
      nombres.set(s.id, norm(s.fullName) || persona || norm(s.companyName) || null);
    }
  });

  const nombreDe = await traductorDeNombres(prisma);
  const filaDe = (f, i) => {
    const sid = subMap.get(f.id_customer) || null;
    if (!sid) res.sinCliente++;
    return {
      legacyId: f.id,
      rowNumber: i + 1, // el legacy no guarda la fila del Excel: vale el orden del archivo
      documento: norm(f.documento),
      amount: money(f.monto),
      method: norm(f.metodo_pago),
      reference: norm(f.ref_efecty) || null,
      date: dOnly(f.fecha),
      status: norm(f.estado) || 'Inicial',
      subscriberId: sid,
      subscriberName: sid ? nombres.get(sid) ?? null : null,
      cashAccountId: cuentas.get(claveCuenta(f.metodo_pago)) ?? null,
      message: null,
      transactionId: null,
    };
  };

  if (DRY) {
    res.nuevos = nuevos.length; res.releidos = releidos.length; res.filasNuevas = filas.length;
    return res;
  }

  let descargas = 0;
  for (const a of archivos) {
    const propias = (porArchivo.get(a.id) ?? []).map(filaDe);
    const aplicadas = propias.filter((f) => f.status === 'Cargado');
    const cuenta = {
      totalRows: propias.length,
      appliedRows: aplicadas.length,
      errorRows: propias.filter((f) => f.status === 'Error').length,
      notFoundRows: propias.filter((f) => f.status === 'Usuario No Existe').length,
      duplicateRows: 0, // el legacy no marca duplicados: no los detecta
      totalAmount: propias.reduce((s, f) => s + f.amount, 0),
      appliedAmount: aplicadas.reduce((s, f) => s + f.amount, 0),
    };

    // El .xlsx tal como se subió, para que el enlace del nombre siga sirviendo el día
    // que el legacy se apague. Tope por pasada sólo para lo que hay que descargar.
    const ya = porLegacy.get(a.id);
    let storedFile = ya?.storedFile ?? null;
    const real = norm(a.nombre_real_file);
    if (!storedFile && real) {
      const t = await traerArchivo(real, path.join(CARGUES_ROOT, real), { sinDescarga: descargas >= CARGUES_DESCARGAS_MAX });
      if (t.ok) { storedFile = real; res.archivos++; if (t.origen === 'http') descargas++; }
      else res.sinArchivo++;
    }

    const datos = {
      fileName: norm(a.nombre) || real || `cargue ${a.id}`,
      storedFile,
      uploadedByName: norm(a.nombre_real) || (a.username ? nombreDe(a.username) : null),
      mode: 'pagos',
      status: estadoCargue(a.estado),
      ...cuenta,
    };

    let batchId = ya?.id ?? null;
    if (!batchId) {
      const creado = await prisma.paymentImportBatch.create({
        data: { legacyId: a.id, createdAt: dTime(a.fecha) ?? new Date(), ...datos, rows: { createMany: { data: propias } } },
        select: { id: true },
      });
      batchId = creado.id;
      res.nuevos++;
      res.filasNuevas += propias.length;
      continue;
    }

    res.releidos++;
    await prisma.paymentImportBatch.update({ where: { id: batchId }, data: datos });
    const existentes = new Map(
      (await prisma.paymentImportRow.findMany({
        where: { batchId },
        select: { id: true, legacyId: true, status: true, subscriberId: true, cashAccountId: true, amount: true },
      })).map((f) => [f.legacyId, f]),
    );
    const porCrear = [];
    for (const f of propias) {
      const vieja = existentes.get(f.legacyId);
      if (!vieja) { porCrear.push({ ...f, batchId }); continue; }
      if (vieja.status === f.status && vieja.subscriberId === f.subscriberId
        && vieja.cashAccountId === f.cashAccountId && Number(vieja.amount) === f.amount) continue;
      await prisma.paymentImportRow.update({ where: { id: vieja.id }, data: f });
      res.filasCambiadas++;
    }
    if (porCrear.length) {
      res.filasNuevas += (await prisma.paymentImportRow.createMany({ data: porCrear, skipDuplicates: true })).count;
    }
  }

  st.cargues = maxId;
  await saveState(st);
  return res;
}

// ---------- inventario: equipos y órdenes de compra ----------
/**
 * `equipos` y `purchase` nunca entraron en la pasada. Se cargaron una vez con los ETL
 * (`etl-red.js`, `etl-valores.js`) desde la COPIA `vestel_dev` y ahí se quedaron: las
 * órdenes de compra hechas después en el legacy aquí no existían (24 el día que se
 * escribió esto, desde el 4 de julio) y los equipos que el cliente devolvió allá aquí
 * seguían a su nombre (303).
 *
 * Quién manda sobre cada tabla no es lo mismo, así que las reglas tampoco:
 *
 *  · Dimensiones (bodegas, categorías, proveedores) → SOLO ALTAS. Se traen las filas
 *    NUEVAS para que el material, los equipos y las órdenes que llegan tengan a qué
 *    apuntar, y nada más.
 *
 *  · `products`, `equipos` y `purchase` → altas + comparación fila a fila, SALVO las que llevan
 *    `editedAt`: ésas las movió nexus (una devolución de equipo, una orden aprobada,
 *    recibida o pagada aquí) y mandan las de aquí. Mismo blindaje que
 *    `SubInvoice.editedAt` y `Ticket.editedAt`, y por el mismo motivo: el inventario
 *    NO viaja de vuelta (el writeback no lo toca), así que el legacy nunca se entera
 *    de lo que se hizo aquí y en la siguiente pasada lo desharía.
 *
 *  · Traspasos de equipo y actas de material → sólo altas por marca de agua. Son
 *    historial: una vez emitidos no cambian.
 *
 * Nada de esto borra: si el legacy elimina una orden, aquí se queda. Es deliberado —
 * el borrado sólo se propaga donde se decidió expresamente (ver `syncBorradas`).
 */
async function syncInventario(my, st, sum, subMap, lapidas) {
  const res = {};

  // 1) Dimensiones: sólo altas. -------------------------------------------------
  const soloAltas = async (tabla, model, pk, map) => {
    const [rows] = await my.query(`SELECT * FROM \`${tabla}\``);
    // Sin `where` sobre legacyId: en `EquipmentWarehouse` la columna NO es opcional y
    // Prisma rechaza `{ not: null }` sobre un Int no nulo. Filtrar aquí sale igual de
    // barato y sirve para los dos casos.
    const ya = new Set((await prisma[model].findMany({ select: { legacyId: true } }))
      .map((r) => r.legacyId).filter((v) => v != null));
    const nuevos = rows.filter((r) => !ya.has(r[pk]) && !lapidas.tiene(model, r[pk])).map(map);
    if (!DRY && nuevos.length) await createMany(model, nuevos);
    if (nuevos.length) log(`${tabla}: +${nuevos.length} nuevos`);
    return { rows, nuevos: nuevos.length };
  };

  const cats = await soloAltas('product_cat', 'materialCategory', 'id',
    (c) => ({ legacyId: c.id, title: norm(c.title) || `Cat ${c.id}`, extra: norm(c.extra) }));
  const whMat = await soloAltas('product_warehouse', 'materialWarehouse', 'id',
    (w) => ({ legacyId: w.id, title: norm(w.title) || `Bodega ${w.id}`, extra: norm(w.extra), technicianRef: w.id_tecnico == null ? null : String(w.id_tecnico) }));
  const whEq = await soloAltas('almacen_equipos', 'equipmentWarehouse', 'id',
    (w) => ({ legacyId: w.id, name: norm(w.almacen) || `Bodega ${w.id}`, description: norm(w.descripcion) }));
  const sups = await soloAltas('supplier', 'supplier', 'id', (r) => ({
    legacyId: r.id, category: r.categoria ?? 1, name: norm(r.name) || `Proveedor ${r.id}`,
    nit: norm(r.nit), phone: norm(r.phone), email: norm(r.email), address: norm(r.address),
    city: norm(r.city), region: norm(r.region), payMethod: norm(r.pago), account: norm(r.cuenta),
    accountType: norm(r.typo), bank: norm(r.banco), company: norm(r.company), branchRef: r.gid ?? null,
  }));

  const catMap = await mapaLegacy('materialCategory');
  const whMatMap = await mapaLegacy('materialWarehouse');
  res.dimensiones = { categorias: cats.nuevos, bodegasMaterial: whMat.nuevos, bodegasEquipo: whEq.nuevos, proveedores: sups.nuevos };

  // 1-bis) products → Material: altas + cambios, con blindaje. -------------------
  // Estuvo en SOLO ALTAS para que `products.qty` del legacy no pisara el stock que
  // mueve nexus. El candado no protegía nada: el material se sigue moviendo allá
  // (traspaso a técnico, recepción de compra) y aquí no había ni un consumo
  // registrado, así que el inventario quedó congelado en la foto del ETL — 119
  // filas descuadradas y un técnico con 0 conectores en pantalla y 16 en la mano.
  // Ahora manda el legacy, salvo en las filas que llevan `editedAt`: ésas las movió
  // nexus y el inventario no viaja de vuelta (el writeback no lo toca), así que sin
  // el blindaje la siguiente pasada desharía el movimiento.
  const [matRows] = await my.query('SELECT * FROM products');
  const matPg = await prisma.material.findMany({
    where: { legacyId: { not: null } },
    select: {
      legacyId: true, categoryId: true, categoryLegacy: true, warehouseId: true, warehouseLegacy: true,
      branchRef: true, name: true, code: true, price: true, cost: true, taxRate: true, discRate: true,
      qty: true, description: true, alert: true, serviceType: true, tvOrNet: true, editedAt: true,
    },
  });
  const matByLegacy = new Map(matPg.map((r) => [r.legacyId, r]));
  const mapMaterial = (r) => ({
    categoryId: catMap.get(r.pcat) || null, categoryLegacy: r.pcat,
    warehouseId: whMatMap.get(r.warehouse) || null, warehouseLegacy: r.warehouse, branchRef: r.sede ?? null,
    name: norm(r.product_name) || `Material ${r.pid}`, code: norm(r.product_code),
    price: num(r.product_price), cost: num(r.fproduct_price), taxRate: num(r.taxrate), discRate: num(r.disrate),
    qty: num(r.qty), description: norm(r.product_des), alert: r.alert ?? null,
    serviceType: norm(r.tipo_servicio), tvOrNet: norm(r.pertence_a_tv_o_net),
  });
  const matNuevos = [], matCambios = [];
  let matBlindados = 0;
  for (const r of matRows) {
    const mapped = mapMaterial(r);
    const pg = matByLegacy.get(r.pid);
    if (!pg) {
      if (!lapidas.tiene('material', r.pid)) matNuevos.push({ legacyId: r.pid, ...mapped });
      continue;
    }
    if (pg.editedAt) { matBlindados++; continue; }
    const keys = diffKeys(mapped, pg);
    if (keys.length) matCambios.push({ legacyId: r.pid, keys, mapped });
  }
  res.material = { nuevos: matNuevos.length, actualizados: matCambios.length, tocadosAqui: matBlindados };
  if (!DRY) {
    await createMany('material', matNuevos);
    await pooled(matCambios, 5, async (c) => {
      const data = {};
      for (const k of c.keys) data[k] = c.mapped[k];
      await prisma.material.update({ where: { legacyId: c.legacyId }, data })
        .catch((e) => log(`⚠️ material ${c.legacyId}: ${e.message}`));
    });
    if (matNuevos.length || matCambios.length) log(`products: +${matNuevos.length} nuevos, ~${matCambios.length} actualizados`);
  }

  // 2) equipos → Equipment: altas + cambios, con blindaje. -----------------------
  const whEqMap = await mapaLegacy('equipmentWarehouse');
  const [eqRows] = await my.query('SELECT * FROM equipos');
  const eqPg = await prisma.equipment.findMany({
    where: { legacyId: { not: null } },
    select: {
      legacyId: true, code: true, supplierLegacy: true, warehouseId: true, warehouseLegacy: true,
      mac: true, serial: true, arrival: true, endDate: true, brand: true, installType: true,
      port: true, vlan: true, nat: true, subscriberId: true, assignedRaw: true, status: true,
      observation: true, master: true, image: true, meters: true, accessories: true, genieacsId: true,
      editedAt: true,
    },
  });
  const eqByLegacy = new Map(eqPg.map((r) => [r.legacyId, r]));
  const mapEquipo = (x) => ({
    code: x.codigo, supplierLegacy: x.proveedor ?? 0,
    warehouseId: whEqMap.get(x.almacen) || null, warehouseLegacy: x.almacen ?? 0,
    mac: norm(x.mac), serial: norm(x.serial), arrival: dOnly(x.llegada), endDate: dOnly(x.final),
    brand: norm(x.marca), installType: norm(x.t_instalacion), port: x.puerto ?? null,
    vlan: x.vlan ?? null, nat: x.nat ?? null,
    subscriberId: subMap.get(Number(x.asignado)) || null, assignedRaw: x.asignado ?? null,
    status: norm(x.estado), observation: norm(x.observacion), master: norm(x.master),
    image: norm(x.imagen), meters: x.metros ?? null, accessories: norm(x.accesorios),
    genieacsId: norm(x.id_genieacs),
  });
  const eqNuevos = [], eqCambios = [];
  let eqBlindados = 0;
  for (const x of eqRows) {
    const mapped = mapEquipo(x);
    const pg = eqByLegacy.get(x.id);
    if (!pg) {
      if (!lapidas.tiene('equipment', x.id)) eqNuevos.push({ legacyId: x.id, ...mapped });
      continue;
    }
    // Lo movió nexus: manda lo de aquí. La devolución de equipo es justo esto —
    // el legacy lo sigue viendo instalado en casa del cliente para siempre.
    if (pg.editedAt) { eqBlindados++; continue; }
    const keys = diffKeys(mapped, pg);
    if (keys.length) eqCambios.push({ legacyId: x.id, keys, mapped });
  }
  res.equipos = { nuevos: eqNuevos.length, actualizados: eqCambios.length, tocadosAqui: eqBlindados };
  if (!DRY) {
    await createMany('equipment', eqNuevos);
    await pooled(eqCambios, 5, async (c) => {
      const data = {};
      for (const k of c.keys) data[k] = c.mapped[k];
      await prisma.equipment.update({ where: { legacyId: c.legacyId }, data })
        .catch((e) => log(`⚠️ equipo ${c.legacyId}: ${e.message}`));
    });
    if (eqNuevos.length || eqCambios.length) log(`equipos: +${eqNuevos.length} nuevos, ~${eqCambios.length} actualizados`);
  }

  // 3) purchase → SupplyOrder: altas + cambios, con blindaje. --------------------
  const supMap = await mapaLegacy('supplier');
  const supCat = new Map(sups.rows.map((r) => [r.id, r.categoria ?? 1]));
  const [poRows] = await my.query('SELECT * FROM purchase');
  const poPg = await prisma.supplyOrder.findMany({
    where: { legacyId: { not: null } },
    select: {
      legacyId: true, tid: true, supplierId: true, supplierLegacy: true, orderDate: true, dueDate: true,
      subtotal: true, shipping: true, discount: true, tax: true, total: true, paidAmount: true,
      status: true, categoryRef: true, warehouseRef: true, branchRef: true, notes: true, itemsCount: true,
      receivedBy: true, receivedAt: true, retentionType: true, retention: true, kind: true, editedAt: true,
    },
  });
  const poByLegacy = new Map(poPg.map((r) => [r.legacyId, r]));
  const mapOrden = (r) => ({
    tid: r.tid, supplierId: supMap.get(r.csd) || null, supplierLegacy: r.csd ?? null,
    orderDate: dOnly(r.invoicedate), dueDate: dOnly(r.invoiceduedate),
    subtotal: num(r.subtotal), shipping: num(r.shipping), discount: num(r.discount),
    tax: num(r.tax), total: num(r.total), paidAmount: num(r.pamnt),
    status: norm(r.status) || 'pendiente', categoryRef: norm(r.idcat),
    warehouseRef: r.almacen_seleccionado ?? null, branchRef: norm(r.refer), notes: norm(r.notes),
    itemsCount: num(r.items), receivedBy: r.recibe ?? null,
    receivedAt: r.fcha_recibido ? new Date(r.fcha_recibido) : null,
    retentionType: norm(r.tipo_retencion), retention: num(r.retencion),
    kind: supCat.get(r.csd) === 2 ? 'servicio' : 'compra',
  });
  const poNuevas = [], poCambios = [];
  let poBlindadas = 0;
  for (const r of poRows) {
    const mapped = mapOrden(r);
    const pg = poByLegacy.get(r.id);
    if (!pg) {
      if (!lapidas.tiene('supplyOrder', r.id)) poNuevas.push({ legacyId: r.id, ...mapped });
      continue;
    }
    if (pg.editedAt) { poBlindadas++; continue; }
    const keys = diffKeys(mapped, pg).filter((k) => k !== 'tid'); // el consecutivo no se reescribe
    if (keys.length) poCambios.push({ legacyId: r.id, keys, mapped });
  }
  res.ordenesCompra = { nuevas: poNuevas.length, actualizadas: poCambios.length, tocadasAqui: poBlindadas };
  if (!DRY) {
    await createMany('supplyOrder', poNuevas);
    await pooled(poCambios, 5, async (c) => {
      const data = {};
      for (const k of c.keys) data[k] = c.mapped[k];
      await prisma.supplyOrder.update({ where: { legacyId: c.legacyId }, data })
        .catch((e) => log(`⚠️ orden ${c.legacyId}: ${e.message}`));
    });
    if (poNuevas.length || poCambios.length) log(`purchase: +${poNuevas.length} nuevas, ~${poCambios.length} actualizadas`);
    // El `tid` de las órdenes lo reparten los dos sistemas sobre la MISMA numeración
    // (a diferencia de facturas y órdenes de servicio, que van particionadas). Si el
    // legacy ya gastó números por encima de la secuencia, la próxima orden creada aquí
    // chocaría contra el índice único. Se adelanta la secuencia, nunca se retrocede.
    res.tidSeq = await adelantarSecuencia('SupplyOrder_tid_seq', 'SupplyOrder', 'tid');
  }

  // 4) Ítems de orden. Sólo de órdenes que nexus no ha tocado (allí las notas de
  //    crédito/débito y las retenciones son nuestras y no existen en el legacy).
  const ordEditable = new Map(); // tid legacy → id PG
  for (const r of await prisma.supplyOrder.findMany({
    where: { legacyId: { not: null }, editedAt: null }, select: { id: true, tid: true },
  })) ordEditable.set(r.tid, r.id);
  const [itRows] = await my.query('SELECT * FROM purchase_items');
  const itPg = await prisma.supplyOrderItem.findMany({
    where: { legacyId: { not: null } },
    select: { legacyId: true, orderId: true, materialId: true, materialLegacy: true, product: true,
      qty: true, price: true, taxRate: true, discount: true, subtotal: true, taxTotal: true,
      discountTotal: true, description: true, receivedQty: true },
  });
  const itByLegacy = new Map(itPg.map((r) => [r.legacyId, r]));
  const matMap = await mapaLegacy('material');
  const itNuevos = [], itCambios = [];
  for (const r of itRows) {
    const orderId = ordEditable.get(r.tid);
    if (!orderId) continue; // orden inexistente aquí o blindada
    const mapped = {
      orderId, materialId: matMap.get(r.pid) || null, materialLegacy: r.pid ?? null,
      product: norm(r.product), qty: num(r.qty), price: num(r.price), taxRate: num(r.tax),
      discount: num(r.discount), subtotal: num(r.subtotal), taxTotal: num(r.totaltax),
      discountTotal: num(r.totaldiscount), description: norm(r.product_des), receivedQty: num(r.qty_en_almacen),
    };
    const pg = itByLegacy.get(r.id);
    if (!pg) { itNuevos.push({ legacyId: r.id, ...mapped }); continue; }
    const keys = diffKeys(mapped, pg);
    if (keys.length) itCambios.push({ legacyId: r.id, keys, mapped });
  }
  res.itemsOrden = { nuevos: itNuevos.length, actualizados: itCambios.length };
  if (!DRY) {
    await createMany('supplyOrderItem', itNuevos);
    await pooled(itCambios, 5, async (c) => {
      const data = {};
      for (const k of c.keys) data[k] = c.mapped[k];
      await prisma.supplyOrderItem.update({ where: { legacyId: c.legacyId }, data })
        .catch((e) => log(`⚠️ ítem de orden ${c.legacyId}: ${e.message}`));
    });
  }

  // 5) Historial de movimientos: traspasos de equipo y actas de material. Sólo altas.
  res.traspasos = await syncTraspasos(my, st, whEqMap, matMap);
  return res;
}

/** Mapa legacyId → id de un modelo (los que llevan `legacyId`). */
async function mapaLegacy(model) {
  const rows = await prisma[model].findMany({ select: { id: true, legacyId: true } });
  const m = new Map();
  for (const r of rows) if (r.legacyId != null) m.set(r.legacyId, r.id);
  return m;
}

/**
 * Deja la secuencia por encima del máximo de la columna. Nunca la retrocede: si nexus
 * ya repartió números más altos que el legacy, los suyos siguen valiendo.
 */
async function adelantarSecuencia(seq, tabla, col) {
  const [{ maximo, actual }] = await prisma.$queryRawUnsafe(
    `SELECT (SELECT COALESCE(MAX("${col}"), 0) FROM "${tabla}") AS maximo, last_value AS actual FROM "${seq}"`,
  );
  const max = Number(maximo), act = Number(actual);
  if (max <= act) return { seq, actual: act, adelantada: false };
  await prisma.$queryRawUnsafe(`SELECT setval('"${seq}"', ${max}, true)`);
  log(`${seq}: adelantada de ${act} a ${max} (el legacy ya gastó esos consecutivos)`);
  return { seq, de: act, a: max, adelantada: true };
}

/** Traspasos de equipo y actas de material: historial, sólo altas por marca de agua. */
async function syncTraspasos(my, st, whEqMap, matMap) {
  const out = {};

  const [trRows] = await my.query('SELECT * FROM transfer_equipos WHERE teid > ? ORDER BY teid', [st.transferEq ?? 0]);
  let maxTr = st.transferEq ?? 0;
  const trData = trRows.map((x) => {
    maxTr = Math.max(maxTr, x.teid);
    return { legacyId: x.teid, date: dTime(x.fecha) || new Date(0), fromWarehouse: String(x.almacen_origen ?? ''),
      toWarehouse: String(x.almacen_destino ?? ''), observations: norm(x.observaciones), userId: x.id_usuario_que_transfiere ?? null };
  });
  const [actRows] = await my.query('SELECT * FROM acta_transferencias WHERE id > ? ORDER BY id', [st.actas ?? 0]);
  let maxAct = st.actas ?? 0;
  const actData = actRows.map((r) => {
    maxAct = Math.max(maxAct, r.id);
    return { legacyId: r.id, date: r.fecha ? new Date(r.fecha) : new Date(0),
      fromWarehouseLegacy: r.almacen_origen ?? null, toWarehouseLegacy: r.almacen_destino ?? null,
      observations: norm(r.observaciones), userId: r.id_usuario_que_transfiere ?? null,
      status: norm(r.estado) || 'Emitida', receivedBy: r.id_usuario_recibe ?? null,
      receivedAt: r.fecha_recepcion ? new Date(r.fecha_recepcion) : null };
  });
  if (DRY) return { traspasosEquipo: trData.length, actasMaterial: actData.length };
  // `skipDuplicates` hace el trabajo fino: en la primera pasada se leen las tablas
  // enteras (no hay marca) y sólo entran las filas que faltaban. Se reporta lo que
  // realmente se insertó, no lo que se leyó.
  out.traspasosEquipo = await createMany('equipmentTransfer', trData);
  out.actasMaterial = await createMany('materialActa', actData);

  // Ítems de lo recién insertado (se resuelven contra los mapas ya cargados).
  if (trData.length) {
    const trMap = await mapaLegacy('equipmentTransfer');
    const eqMap = await mapaLegacy('equipment');
    const [items] = await my.query('SELECT * FROM item_transfer_equipos WHERE id_transfer > ? ', [st.transferEq ?? 0]);
    await createMany('equipmentTransferItem', items
      .filter((x) => trMap.has(x.id_transfer))
      .map((x) => ({ legacyId: x.id, transferId: trMap.get(x.id_transfer), equipmentId: eqMap.get(x.id_equipo) || null, equipmentLegacy: x.id_equipo })));
  }
  if (actData.length) {
    const actMap = await mapaLegacy('materialActa');
    const [items] = await my.query(
      `SELECT i.id, i.id_acta_transferencia, i.cantidad, t.producto_a AS pid
         FROM items_acta_transferencias i
         LEFT JOIN transferencias t ON t.id_transferencia = i.id_transferencia
        WHERE i.id_acta_transferencia > ?`, [st.actas ?? 0]);
    await createMany('materialActaItem', items
      .filter((x) => actMap.has(x.id_acta_transferencia))
      .map((x) => ({ legacyId: x.id, actaId: actMap.get(x.id_acta_transferencia),
        materialId: matMap.get(x.pid) || null, materialLegacy: x.pid ?? null, qty: num(x.cantidad) })));
  }

  st.transferEq = maxTr; st.actas = maxAct;
  await saveState(st);
  return out;
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

  // Sólo el repaso de los pagos de compra: sirve para el arreglo de una vez (los 766
  // que colgaban de una factura ajena) y para volver a correrlo sin una pasada entera.
  if (MODE === 'pagos-compra') {
    const sum = { ok: true, mode: MODE, dry: DRY };
    await enlazarPagosDeCompra(my, sum);
    console.log(JSON.stringify(sum));
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
    // La apertura va en la pasada ligera y no sólo en la completa: si esperara a los 15
    // minutos, la cajera que abre a las 7:00 vería su panel "sin abrir" un cuarto de
    // hora. Es una consulta y, salvo el día que alguien abre, no escribe nada.
    await syncAperturas(my, sum);
    // En seco no se toca la marca: una comprobación manual no puede alterar el estado
    // de la sincronización de producción.
    if (!DRY) {
      st.lastCajaRunAt = new Date().toISOString();
      await saveState(st);
    }
    sum.ms = Date.now() - t0;
    sum.watermarks = st;
    console.log(JSON.stringify(sum));
    await my.end(); await prisma.$disconnect();
    return;
  }

  await syncCustomers(my, sum);
  const subs = await prisma.subscriber.findMany({ where: { legacyId: { not: null } }, select: { id: true, legacyId: true } });
  const subMap = new Map(subs.map((r) => [r.legacyId, r.id]));

  const lapidas = await cargarLapidas();
  if (lapidas.total) sum.lapidas = lapidas.total;

  await syncEstados(my, st, sum, subMap);
  await syncInvoices(my, st, sum, subMap, lapidas);
  await syncTransactions(my, st, sum, subMap);
  await refrescarTransacciones(my, sum);
  await syncComprobantes(my, st, sum);
  await syncRecibos(my, st, sum);
  await syncAnulaciones(my, st, sum);
  await syncBorradas(my, sum);
  await syncAperturas(my, sum);
  await syncAddSvc(my, st, sum);
  await syncEInvoice(my, st, sum, subMap);
  await syncTickets(my, st, sum, subMap);
  await syncObservaciones(my, st, sum, subMap);
  await syncArchivos(my, st, sum, subMap);
  await syncCargues(my, st, sum, subMap);
  sum.inventario = await syncInventario(my, st, sum, subMap, lapidas);
  await enlazarPagosDeCompra(my, sum);

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
