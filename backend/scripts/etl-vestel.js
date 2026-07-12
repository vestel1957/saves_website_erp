/**
 * ETL fiel  vestel_dev (MariaDB)  →  saves_vestel (PostgreSQL / Prisma)
 * Vertical: Clientes + Facturación.  Idempotente (trunca y recarga por legacyId).
 * Uso:  node --max-old-space-size=2560 scripts/etl-vestel.js [--only=step]
 */
const mysql = require('mysql2/promise');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const MYSQL = {
  host: '127.0.0.1', port: 3306, user: 'admin_vestel',
  password: 'Vestel_2025!', database: 'vestel_dev',
  dateStrings: true, supportBigNumbers: true, bigNumberStrings: false,
};

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------- helpers de mapeo ----------
const norm = (s) => (s == null ? '' : String(s).trim());
const bool = (v) => v === 1 || v === '1' || v === true;
const dOnly = (s) => { // 'YYYY-MM-DD ...' -> Date UTC medianoche, o null
  const t = norm(s).slice(0, 10);
  if (!t || t === '0000-00-00') return null;
  const d = new Date(t + 'T00:00:00Z');
  return isNaN(d) ? null : d;
};
const dTime = (s) => {
  const t = norm(s);
  if (!t || t.startsWith('0000-00-00')) return null;
  const d = new Date(t.replace(' ', 'T') + 'Z');
  return isNaN(d) ? null : d;
};
const money = (v) => (v == null || v === '' ? 0 : Number(v));
const cleanEmail = (e) => { const s = norm(e); return !s || s.toUpperCase() === 'NULL' ? null : s; };

const SUB_STATUS = { activo:'ACTIVO', cartera:'CARTERA', compromiso:'COMPROMISO', cortado:'CORTADO',
  depurado:'DEPURADO', evento:'EVENTO', exonerado:'EXONERADO', instalar:'INSTALAR',
  'por retirar':'POR_RETIRAR', reportado:'REPORTADO', retirado:'RETIRADO', suspendido:'SUSPENDIDO', inactivo:'INACTIVO' };
const subStatus = (s) => SUB_STATUS[norm(s).toLowerCase()] || null;

const RON = { ...SUB_STATUS, anulado:'ANULADO', 'dado de baja':'DADO_DE_BAJA' };
const ron = (s) => RON[norm(s).toLowerCase()] || null;

const INV_STATUS = { paid:'PAID', due:'DUE', partial:'PARTIAL', canceled:'CANCELED' };
const invStatus = (s) => INV_STATUS[norm(s).toLowerCase()] || 'DUE';

const KIND = { recurrente:'RECURRENTE', fija:'FIJA', 'nota credito':'NOTA_CREDITO', 'nota debito':'NOTA_DEBITO' };
const invKind = (s) => KIND[norm(s).toLowerCase()] || 'RECURRENTE';

const SVC_STATUS = { cortado:'CORTADO', suspendido:'SUSPENDIDO' };
const svcStatus = (s) => SVC_STATUS[norm(s).toLowerCase()] || null;

const TX_TYPE = { income:'INCOME', expense:'EXPENSE', transfer:'TRANSFER' };
const txType = (s) => TX_TYPE[norm(s).toLowerCase()] || 'INCOME';
const txStatus = (s) => (norm(s).toLowerCase() === 'anulada' ? 'ANULADA' : 'VIGENTE');

const TECH = { GPON:'GPON', EPON:'EPON', EOC:'EOC', RADIO:'RADIO', FIBRA:'FIBRA' };
const tech = (s) => TECH[norm(s).toUpperCase()] || null;

const RET = { 'retefuente servicios':'RETEFUENTE_SERVICIOS', compras:'COMPRAS',
  'personas no declarantes':'PERSONAS_NO_DECLARANTES', reteiva:'RETEIVA' };
const ret = (s) => RET[norm(s).toLowerCase()] || null;

const EI_TYPE = { facturada:'FACTURADA', error:'ERROR', actualizada:'ACTUALIZADA' };
const eiType = (s) => EI_TYPE[norm(s).toLowerCase()] || 'FACTURADA';
const payMethod = (s) => { const t = norm(s).toLowerCase(); return t === 'credito' ? 'CREDITO' : t === 'efectivo' ? 'EFECTIVO' : null; };

// ---------- inserción por lotes ----------
async function insertBatches(modelName, rows, chunk = 2000) {
  const model = prisma[modelName];
  let done = 0;
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk);
    await model.createMany({ data: slice, skipDuplicates: true });
    done += slice.length;
    if (done % 20000 === 0 || done === rows.length) log(`   ${modelName}: ${done}/${rows.length}`);
  }
  return done;
}

// stream de MySQL -> callback por lote acumulado
async function streamRows(conn, sql, onBatch, batchSize = 5000) {
  return new Promise((resolve, reject) => {
    let buf = [], total = 0, chain = Promise.resolve();
    const q = conn.connection.query(sql);
    q.on('error', reject);
    q.on('result', (row) => {
      buf.push(row);
      if (buf.length >= batchSize) {
        const b = buf; buf = [];
        conn.connection.pause();
        chain = chain.then(() => onBatch(b)).then(() => { total += b.length; conn.connection.resume(); }).catch(reject);
      }
    });
    q.on('end', () => { chain.then(() => onBatch(buf)).then(() => resolve(total + buf.length)).catch(reject); });
  });
}

async function main() {
  const only = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1];
  const run = (s) => !only || only === s;
  const my = await mysql.createConnection(MYSQL);
  const myp = my; // promise API for simple queries
  const conn = { connection: (await mysql.createConnection(MYSQL)).connection }; // raw for streaming
  log('Conectado a MariaDB. Iniciando ETL…');

  // --- 0. limpiar (orden inverso de dependencias) ---
  if (run('truncate') && !only) {
    log('Truncando tablas ISP…');
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE
      "ElectronicInvoice","ReceiptTransaction","PaymentReceipt","Voiding","AdditionalService",
      "Transaction","SubInvoiceItem","SubInvoice","SubscriberStatusHistory","SubscriberService",
      "Subscriber","CashClose","PaymentGateway","TransactionCategory","SiigoAccount","Branch"
      RESTART IDENTITY CASCADE`);
  }

  // --- 1. Branch (customers_group) ---
  if (run('branch')) {
    const [g] = await myp.query('SELECT id,title,summary,dir FROM customers_group');
    await insertBatches('branch', g.map((r) => ({ legacyId: r.id, name: norm(r.title) || `Sede ${r.id}`, summary: r.summary, dir: r.dir })));
    log(`Branch: ${g.length}`);
  }
  // --- 2. TransactionCategory ---
  if (run('txcat')) {
    const [c] = await myp.query('SELECT id,name FROM transactions_cat');
    await insertBatches('transactionCategory', c.map((r) => ({ legacyId: r.id, name: norm(r.name) })));
    log(`TransactionCategory: ${c.length}`);
  }
  // --- 3. PaymentGateway ---
  if (run('gateway')) {
    const [p] = await myp.query('SELECT * FROM payment_gateways');
    await insertBatches('paymentGateway', p.map((r) => ({ legacyId: r.id, name: norm(r.name),
      enabled: norm(r.enable) === 'Yes', key1: norm(r.key1), key2: r.key2, currency: norm(r.currency) || 'COP',
      devMode: norm(r.dev_mode) === 'true', ord: r.ord || 0, surcharge: money(r.surcharge) })));
    log(`PaymentGateway: ${p.length}`);
  }
  // --- 4. SiigoAccount (config_facturacion_electronica) ---
  if (run('siigo')) {
    const [s] = await myp.query('SELECT * FROM config_facturacion_electronica');
    await insertBatches('siigoAccount', s.map((r) => ({ legacyId: r.id, role: norm(r.nombre),
      username: norm(r.username), accessKey: norm(r.access_key), token: r.tocken || null })));
    log(`SiigoAccount: ${s.length}`);
  }

  // --- 5. Subscriber (customers) + mapa legacyId->id ---
  const subMap = new Map();
  if (run('subscriber')) {
    log('Migrando customers → Subscriber…');
    let buf = [];
    const flush = async () => { if (buf.length) { await insertBatches('subscriber', buf, 2000); buf = []; } };
    await streamRows(conn, 'SELECT * FROM customers', async (rows) => {
      for (const r of rows) buf.push({
        legacyId: r.id, abonado: Number(r.abonado) || 0, suscripcion: norm(r.suscripcion) || null,
        firstName: r.name, secondName: r.dosnombre, lastName1: r.unoapellido, lastName2: r.dosapellido,
        companyName: r.company, customerType: r.tipo_cliente, docType: r.tipo_documento, docNumber: r.documento,
        birthDate: dOnly(r.nacimiento), phone1: r.celular, phone2: r.celular2, email: cleanEmail(r.email),
        contractDate: dOnly(r.f_contrato), entryDate: dOnly(r.f_ingreso), estrato: r.estrato, clausula: r.clausula || null,
        departmentRef: norm(r.departamento) || null, cityRef: norm(r.ciudad) || null, localityRef: norm(r.localidad) || null,
        neighborhood: norm(r.barrio) || null, addressLine: r.dirsuscriptor,
        nomenclature: { nomenclatura: r.nomenclatura, numero1: r.numero1, adicionauno: r.adicionauno,
          numero2: r.numero2, adicional2: r.adicional2, numero3: r.numero3, residencia: r.residencia,
          referencia: r.referencia, divicion: r.divicion, divnum1: r.divnum1, divicion2: r.divicion2, divnum2: r.divnum2 },
        gpsLat: norm(r.coor1) || null, gpsLng: norm(r.coor2) || null,
        pppUsername: r.name_s, pppPassword: r.contra, pppService: r.servicio, pppProfile: r.perfil,
        ipLocal: r.Iplocal, ipRemote: r.Ipremota, netComment: r.comentario, macEquipo: r.macequipo, macOnt: r.mac_ont,
        installTech: tech(r.tegnologia_instalacion),
        status: subStatus(r.usu_estado), previousStatus: subStatus(r.ultimo_estado),
        statusChangedAt: dTime(r.fecha_cambio), statusGenDate: dOnly(r.fecha_genera_estado_user),
        balance: money(r.balance), debitCache: money(r.debit), creditCache: money(r.credit),
        eInvoice: bool(r.facturar_electronicamente), eInvoiceTv: bool(r.f_elec_tv),
        eInvoiceInternet: bool(r.f_elec_internet), eInvoicePuntos: bool(r.f_elec_puntos),
        digitalSignature: bool(r.firma_digital), picture: r.picture,
      });
      if (buf.length >= 4000) await flush();
    });
    await flush();
    for (const r of await prisma.subscriber.findMany({ select: { id: true, legacyId: true } })) subMap.set(r.legacyId, r.id);
    log(`Subscriber: ${subMap.size}`);
  } else {
    for (const r of await prisma.subscriber.findMany({ select: { id: true, legacyId: true } })) subMap.set(r.legacyId, r.id);
  }

  // --- 6. SubscriberStatusHistory (estados) ---
  if (run('history')) {
    log('Migrando estados → SubscriberStatusHistory…');
    let buf = [];
    const flush = async () => { if (buf.length) { await insertBatches('subscriberStatusHistory', buf, 3000); buf = []; } };
    await streamRows(conn, 'SELECT id,cid,fecha,estado,col FROM estados', async (rows) => {
      for (const r of rows) {
        const sid = subMap.get(r.cid); const st = subStatus(r.estado);
        if (!sid || !st) continue;
        buf.push({ subscriberId: sid, status: st, date: dTime(r.fecha) || new Date(0), originTicketId: r.col || null });
      }
      if (buf.length >= 6000) await flush();
    });
    await flush();
    log('estados → OK');
  }

  // --- 7. SubInvoice (invoices) + mapa tid->id ---
  const invByTid = new Map();
  if (run('invoices')) {
    log('Migrando invoices → SubInvoice…');
    let buf = [], skipped = 0;
    const flush = async () => { if (buf.length) { await insertBatches('subInvoice', buf, 2000); buf = []; } };
    await streamRows(conn, 'SELECT * FROM invoices', async (rows) => {
      for (const r of rows) {
        const sid = subMap.get(r.csd);
        if (!sid) { skipped++; continue; }
        buf.push({
          legacyId: r.id, tid: r.tid, subscriberId: sid, issuerUserId: r.eid || null,
          invoiceDate: dOnly(r.invoicedate) || new Date(0), dueDate: dOnly(r.invoiceduedate) || new Date(0),
          subtotal: money(r.subtotal), shipping: money(r.shipping), discount: money(r.discount),
          tax: money(r.tax), total: money(r.total), paidAmount: money(r.pamnt),
          status: invStatus(r.status), ron: ron(r.ron), paymentMethod: r.pmethod, itemsCount: r.items || 0,
          taxEnabled: norm(r.taxstatus) === 'yes', discEnabled: bool(r.discstatus), discountFormat: r.format_discount,
          branchRef: r.refer, serviceTv: r.television, serviceCombo: r.combo, puntos: r.puntos,
          estadoTv: svcStatus(r.estado_tv), estadoCombo: svcStatus(r.estado_combo),
          streamingStandard: r.streaming_standard || 0, streamingPremium: r.streaming_premium || 0,
          streamingPremiumPlus: r.streaming_premium_plus || 0, streamingDiamante: r.streaming_diamante || 0,
          term: r.term || null, rec: norm(r.rec) || null, reconnectFlag: norm(r.rec) === '1',
          currencyRef: r.multi || null, kind: invKind(r.tipo_factura),
          promo: r.promo, promo2: r.promo2, promoModifiedDate: dOnly(r.fecha_modifica_promo),
          promo2ModifiedDate: dOnly(r.fecha_modifica_promo2), retentionType: ret(r.tipo_retencion),
          eInvoiceFlag: r.facturacion_electronica, eInvoiceGenDate: dOnly(r.fecha_f_electronica_generada),
          eInvoiceServices: r.servicios_facturados_electronicamente, eInvoicePayMethod: payMethod(r.metodo_pago_f_e),
          notes: r.notes,
        });
      }
      if (buf.length >= 4000) await flush();
    });
    await flush();
    log(`invoices sin cliente (omitidas): ${skipped}`);
    for (const r of await prisma.subInvoice.findMany({ select: { id: true, tid: true } })) invByTid.set(r.tid, r.id);
    log(`SubInvoice: ${invByTid.size}`);
  } else {
    for (const r of await prisma.subInvoice.findMany({ select: { id: true, tid: true } })) invByTid.set(r.tid, r.id);
  }

  // --- 8. SubInvoiceItem (invoice_items) ---
  if (run('items')) {
    log('Migrando invoice_items → SubInvoiceItem…');
    let buf = [], skip = 0;
    const flush = async () => { if (buf.length) { await insertBatches('subInvoiceItem', buf, 3000); buf = []; } };
    await streamRows(conn, 'SELECT * FROM invoice_items', async (rows) => {
      for (const r of rows) {
        const iid = invByTid.get(r.tid);
        if (!iid) { skip++; continue; }
        buf.push({ legacyId: r.id, invoiceId: iid, productId: r.pid, productName: r.product, description: r.product_des,
          qty: r.qty || 0, price: money(r.price), taxRate: money(r.tax), discount: money(r.discount),
          subtotal: money(r.subtotal), taxTotal: money(r.totaltax), discountTotal: money(r.totaldiscount),
          taxRemoved: r.tax_removed, retentionType: ret(r.tipo_retencion), createdByUserId: r.id_usuario_crea,
          createdAt: dTime(r.fecha_creacion) || new Date() });
      }
      if (buf.length >= 6000) await flush();
    });
    await flush();
    log(`invoice_items sin factura (omitidos): ${skip}`);
  }

  // --- 9. Transaction (transactions) + mapa legacyId->id ---
  const txMap = new Map();
  if (run('transactions')) {
    log('Migrando transactions → Transaction…');
    let buf = [];
    const flush = async () => { if (buf.length) { await insertBatches('transaction', buf, 3000); buf = []; } };
    await streamRows(conn, 'SELECT * FROM transactions', async (rows) => {
      for (const r of rows) buf.push({
        legacyId: r.id, cashAccountId: r.acid, accountName: r.account, type: txType(r.type), category: norm(r.cat),
        debit: money(r.debit), credit: money(r.credit), payerName: r.payer,
        subscriberId: subMap.get(r.payerid) || null, method: r.method, date: dOnly(r.date) || new Date(0),
        invoiceId: invByTid.get(r.tid) || null, issuerUserId: r.eid || null, note: r.note,
        ext: bool(r.ext), bankName: r.nombre_banco, bankId: r.id_banco, status: txStatus(r.estado),
        noShow: bool(r.no_mostrar), payuOrderId: r.id_orden_payu });
      if (buf.length >= 6000) await flush();
    });
    await flush();
    for (const r of await prisma.transaction.findMany({ select: { id: true, legacyId: true } })) txMap.set(r.legacyId, r.id);
    log(`Transaction: ${txMap.size}`);
  } else {
    for (const r of await prisma.transaction.findMany({ select: { id: true, legacyId: true } })) txMap.set(r.legacyId, r.id);
  }

  // --- 10. PaymentReceipt (recibos_de_pago) + mapa ---
  const rcMap = new Map();
  if (run('receipts')) {
    log('Migrando recibos_de_pago → PaymentReceipt…');
    let buf = [];
    const flush = async () => { if (buf.length) { await insertBatches('paymentReceipt', buf, 3000); buf = []; } };
    await streamRows(conn, 'SELECT * FROM recibos_de_pago', async (rows) => {
      for (const r of rows) buf.push({ legacyId: r.id, date: dTime(r.date) || new Date(0),
        fileName: norm(r.file_name), invoiceId: invByTid.get(r.tid) || null });
      if (buf.length >= 6000) await flush();
    });
    await flush();
    for (const r of await prisma.paymentReceipt.findMany({ select: { id: true, legacyId: true } })) rcMap.set(r.legacyId, r.id);
    log(`PaymentReceipt: ${rcMap.size}`);
  } else {
    for (const r of await prisma.paymentReceipt.findMany({ select: { id: true, legacyId: true } })) rcMap.set(r.legacyId, r.id);
  }

  // --- 11. ReceiptTransaction (puente) ---
  if (run('receipttx')) {
    log('Migrando transactions_ids_recibos_de_pago → ReceiptTransaction…');
    let buf = [], skip = 0;
    const flush = async () => { if (buf.length) { await insertBatches('receiptTransaction', buf, 4000); buf = []; } };
    await streamRows(conn, 'SELECT * FROM transactions_ids_recibos_de_pago', async (rows) => {
      for (const r of rows) {
        const rid = rcMap.get(r.id_recibo_de_pago), tid = txMap.get(r.id_transaccion);
        if (!rid || !tid) { skip++; continue; }
        buf.push({ receiptId: rid, transactionId: tid });
      }
      if (buf.length >= 8000) await flush();
    });
    await flush();
    log(`puente sin refs (omitidos): ${skip}`);
  }

  // --- 12. Voiding (anulaciones) ---
  if (run('voidings')) {
    const [a] = await myp.query('SELECT * FROM anulaciones');
    const rows = [];
    for (const r of a) { const tid = txMap.get(r.transactions_id); if (!tid) continue;
      rows.push({ legacyId: r.id_anulacion, dateTime: dTime(r.fecha_hora) || new Date(0), detail: r.detalle,
        transactionId: tid, reason: norm(r.razon_anulacion), voidedBy: norm(r.usuario_anula) }); }
    await insertBatches('voiding', rows);
    log(`Voiding: ${rows.length}/${a.length}`);
  }

  // --- 13. CashClose (cierres_caja) ---
  if (run('cashclose')) {
    const [c] = await myp.query('SELECT * FROM cierres_caja');
    await insertBatches('cashClose', c.map((r) => ({ legacyId: r.id, cashAccountId: r.account_id, date: dOnly(r.fecha),
      base: money(r.base), sales: money(r.ventas), expenses: money(r.egresos), deposited: money(r.consignado),
      surplus: money(r.excedente), userId: r.usuario_id })));
    log(`CashClose: ${c.length}`);
  }

  // --- 14. AdditionalService (servicios_adicionales) ---
  if (run('addsvc')) {
    log('Migrando servicios_adicionales → AdditionalService…');
    let buf = [];
    const flush = async () => { if (buf.length) { await insertBatches('additionalService', buf, 3000); buf = []; } };
    await streamRows(conn, 'SELECT * FROM servicios_adicionales', async (rows) => {
      for (const r of rows) buf.push({ legacyId: r.id, invoiceId: invByTid.get(r.tid_invoice) || null,
        ticketId: r.idt_ticket, productId: r.pid, valor: norm(r.valor), subtotal: money(r.subtotal), total: money(r.total) });
      if (buf.length >= 6000) await flush();
    });
    await flush();
    log('servicios_adicionales → OK');
  }

  // --- 15. ElectronicInvoice (facturacion_electronica_siigo) ---
  if (run('einvoice')) {
    log('Migrando facturacion_electronica_siigo → ElectronicInvoice…');
    const siigo = await prisma.siigoAccount.findMany({ select: { id: true, role: true } });
    let buf = [];
    const flush = async () => { if (buf.length) { await insertBatches('electronicInvoice', buf, 3000); buf = []; } };
    await streamRows(conn, 'SELECT * FROM facturacion_electronica_siigo', async (rows) => {
      for (const r of rows) buf.push({ legacyId: r.id, subscriberId: subMap.get(r.customer_id) || null,
        invoiceId: (r.tid && invByTid.get(r.tid)) || null, date: dOnly(r.fecha) || new Date(0),
        executedAt: dTime(r.fecha_ejecucion), servicesBilled: r.servicios_facturados,
        createdWithMultiple: bool(r.creado_con_multiple), type: eiType(r.tipo), payMethod: payMethod(r.metodo_pago),
        legacyConsecutive: r.consecutivo_siigo || 0, payloadJson: r.json });
      if (buf.length >= 6000) await flush();
    });
    await flush();
    log('facturacion_electronica_siigo → OK');
  }

  await my.end(); conn.connection.destroy(); await prisma.$disconnect();
  log('ETL COMPLETADO ✅');
}

main().catch((e) => { console.error('ETL FALLÓ:', e); process.exit(1); });
