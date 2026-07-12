/** ETL Soporte: vestel_dev -> saves_vestel. Idempotente. */
const mysql = require('mysql2/promise');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const MY = { host: '127.0.0.1', user: 'admin_vestel', password: 'Vestel_2025!', database: 'vestel_dev', dateStrings: true };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const dOnly = (s) => { const t = String(s || '').slice(0, 10); if (!t || t === '0000-00-00') return null; const d = new Date(t + 'T00:00:00Z'); return isNaN(d) ? null : d; };
const dTime = (s) => { const t = String(s || ''); if (!t || t.startsWith('0000-00-00')) return null; const d = new Date(t.replace(' ', 'T') + 'Z'); return isNaN(d) ? null : d; };
const str = (v) => (v == null ? null : Buffer.isBuffer(v) ? v.toString('utf8') : String(v));
const intN = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

const TSTATUS = { realizando: 'REALIZANDO', resuelto: 'RESUELTO', anulada: 'ANULADA', pendiente: 'PENDIENTE' };
const tStatus = (s) => TSTATUS[String(s || '').toLowerCase()] || 'PENDIENTE';
const TODO = { due: 'DUE', done: 'DONE', progress: 'PROGRESS' };
const PRIO = { low: 'LOW', medium: 'MEDIUM', high: 'HIGH', urgent: 'URGENT' };

async function insb(model, rows, chunk = 3000) {
  for (let i = 0; i < rows.length; i += chunk) await prisma[model].createMany({ data: rows.slice(i, i + chunk), skipDuplicates: true });
  return rows.length;
}
async function stream(conn, sql, onBatch, size = 5000) {
  return new Promise((res, rej) => {
    let buf = [], total = 0, chain = Promise.resolve();
    const q = conn.query(sql);
    q.on('error', rej);
    q.on('result', (row) => { buf.push(row); if (buf.length >= size) { const b = buf; buf = []; conn.pause(); chain = chain.then(() => onBatch(b)).then(() => { total += b.length; conn.resume(); }).catch(rej); } });
    q.on('end', () => { chain.then(() => onBatch(buf)).then(() => res(total + buf.length)).catch(rej); });
  });
}

(async () => {
  const my = await mysql.createConnection(MY);
  const raw = (await mysql.createConnection(MY)).connection;
  log('Conectado. Limpiando tablas Soporte…');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE "TicketThread","Ticket","Call","Survey","TodoTask","TransferActaItem","TransferActa" RESTART IDENTITY CASCADE`);

  const sub = new Map(); for (const s of await prisma.subscriber.findMany({ select: { id: true, legacyId: true } })) sub.set(s.legacyId, s.id);
  log('subscribers map', sub.size);

  // Tickets (streaming)
  let buf = [], n = 0;
  const flushT = async () => { if (buf.length) { n += await insb('ticket', buf, 3000); buf = []; } };
  await stream(raw, 'SELECT * FROM tickets', async (rows) => {
    for (const r of rows) buf.push({ legacyId: r.idt, code: r.codigo, subject: str(r.subject) || '', type: str(r.detalle) || '', created: dOnly(r.created) || new Date(0), subscriberId: sub.get(r.cid) || null, col: str(r.col), status: tStatus(r.status), problem: str(r.problema), section: str(r.section), finalDate: dOnly(r.fecha_final), invoiceLegacy: r.id_invoice, invoiceBillLegacy: r.id_factura, assigned: str(r.asignado), par: r.par, mobileAssignment: r.asignacion_movil, signatureName: str(r.nombre_firma), signatureCc: str(r.cc_firma), signatureRel: str(r.parentesco_firma) });
    if (buf.length >= 6000) await flushT();
  });
  await flushT(); log('Ticket', n);

  // TicketThread (streaming)
  buf = []; n = 0;
  const flushTh = async () => { if (buf.length) { n += await insb('ticketThread', buf, 4000); buf = []; } };
  await stream(raw, 'SELECT * FROM tickets_th', async (rows) => {
    for (const r of rows) buf.push({ legacyId: r.id, ticketCode: r.tid, message: str(r.message), subscriberId: sub.get(r.cid) || null, employeeId: r.eid || 0, date: dTime(r.cdate) || new Date(0), attach: str(r.attach) });
    if (buf.length >= 8000) await flushTh();
  });
  await flushTh(); log('TicketThread', n);

  // Call (streaming)
  buf = []; n = 0;
  const flushC = async () => { if (buf.length) { n += await insb('call', buf, 4000); buf = []; } };
  await stream(raw, 'SELECT * FROM llamadas', async (rows) => {
    for (const r of rows) buf.push({ legacyId: r.id, subscriberId: sub.get(r.iduser) || null, subscriberLegacy: r.iduser || 0, callType: str(r.tllamada) || '', responseType: str(r.trespuesta), responseDetail: str(r.drespuesta), responsible: str(r.responsable), date: dOnly(r.fcha) || new Date(0), time: str(r.hra), dueDate: dOnly(r.fecha_vence), notes: str(r.notes) });
    if (buf.length >= 8000) await flushC();
  });
  await flushC(); log('Call', n);

  // Survey
  let [r] = await my.query('SELECT * FROM encuestas');
  await insb('survey', r.map((x) => ({ legacyId: x.id, employeeId: x.idemp || 0, techId: str(x.idtec), orderNo: x.norden || 0, date: dOnly(x.fecha), detail: str(x.detalle), presentation: x.presentacion, treatment: x.trato, state: x.estado, time: str(x.tiempo), recommend: str(x.recomendar), observation: str(x.observacion) })));
  log('Survey', r.length);

  // TodoTask
  [r] = await my.query('SELECT * FROM todolist');
  await insb('todoTask', r.map((x) => ({ legacyId: x.id, tdate: dOnly(x.tdate) || new Date(0), name: str(x.name), status: TODO[String(x.status || '').toLowerCase()] || 'DUE', start: dOnly(x.start), dueDate: dOnly(x.duedate), description: str(x.description), orderId: x.idorden || 0, employeeId: x.eid || 0, assigneeId: x.aid || 0, related: x.related, priority: PRIO[String(x.priority || '').toLowerCase()] || 'MEDIUM', rid: x.rid, score: x.puntuacion })));
  log('TodoTask', r.length);

  // TransferActa + items
  [r] = await my.query('SELECT * FROM acta_transferencias');
  await insb('transferActa', r.map((x) => ({ legacyId: x.id, date: dTime(x.fecha) || new Date(0), fromWarehouse: x.almacen_origen, toWarehouse: x.almacen_destino, observations: str(x.observaciones), userTransfers: x.id_usuario_que_transfiere, status: str(x.estado), userReceives: x.id_usuario_recibe, receptionDate: dTime(x.fecha_recepcion) })));
  const acta = new Map(); for (const a of await prisma.transferActa.findMany({ select: { id: true, legacyId: true } })) acta.set(a.legacyId, a.id);
  log('TransferActa', r.length);
  [r] = await my.query('SELECT * FROM items_acta_transferencias');
  await insb('transferActaItem', r.filter((x) => acta.has(x.id_acta_transferencia)).map((x) => ({ legacyId: x.id, productTransferLegacy: x.id_transferencia, quantity: x.cantidad, actaId: acta.get(x.id_acta_transferencia) })));
  log('TransferActaItem', r.length);

  await my.end(); raw.destroy(); await prisma.$disconnect();
  log('ETL SOPORTE COMPLETADO ✅');
})().catch((e) => { console.error('ETL SOPORTE FALLÓ:', e); process.exit(1); });
