/** ETL: cajas, geografía, empresa (config) + móviles, eventos, cotizaciones (omni). */
const mysql = require('mysql2/promise');
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const s = (v) => (v == null || v === '' ? null : String(v));
const n = (v) => (v == null ? 0 : Number(v));
const i = (v) => { if (v == null || v === '') return null; const x = parseInt(v, 10); return Number.isFinite(x) ? x : null; };
const dt = (v) => {
  if (!v || String(v).startsWith('0000-00-00')) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
};

async function chunk(model, rows, size = 2000) {
  for (let i = 0; i < rows.length; i += size) await p[model].createMany({ data: rows.slice(i, i + size), skipDuplicates: true });
}

(async () => {
  const my = await mysql.createConnection({ host: 'localhost', user: 'admin_vestel', password: 'Vestel_2025!', database: 'vestel_dev' });
  const q = async (sql) => (await my.query(sql))[0];

  for (const m of ['quoteItem', 'quote', 'calendarEvent', 'movil', 'companyInfo', 'neighborhood', 'locality', 'city', 'department', 'cashAccount']) await p[m].deleteMany({});

  // Cajas
  const accs = await q('SELECT * FROM accounts');
  await chunk('cashAccount', accs.map((a) => ({ legacyId: a.id, accountNumber: s(a.acn), holder: s(a.holder) || `Caja ${a.id}`, branchLegacy: a.sede ?? null, balance: n(a.lastbal), code: s(a.code), address: s(a.direccion), phone: s(a.telefono), departmentRef: s(a.departamento) })));
  console.log('cajas:', accs.length);

  // Geografía
  const deps = await q('SELECT * FROM departamentos');
  await chunk('department', deps.map((d) => ({ legacyId: d.idDepartamento, name: s(d.departamento) || `Dep ${d.idDepartamento}` })));
  const cities = await q('SELECT * FROM ciudad');
  await chunk('city', cities.map((c) => ({ legacyId: c.idCiudad, departmentLegacy: i(c.idDepartamento), name: s(c.ciudad) || `Ciudad ${c.idCiudad}` })));
  const locs = await q('SELECT * FROM localidad');
  await chunk('locality', locs.map((l) => ({ legacyId: l.idLocalidad, departmentLegacy: i(l.idDepartamento), cityLegacy: i(l.idCiudad), name: s(l.localidad) || `Loc ${l.idLocalidad}` })));
  const bars = await q('SELECT * FROM barrio');
  await chunk('neighborhood', bars.map((b) => ({ legacyId: b.idBarrio, departmentLegacy: i(b.idDepartamento), cityLegacy: i(b.idCiudad), localityLegacy: i(b.idLocalidad), name: s(b.barrio) || `Barrio ${b.idBarrio}` })));
  console.log('geografía: dep', deps.length, 'ciudad', cities.length, 'loc', locs.length, 'barrio', bars.length);

  // Empresa
  const app = await q('SELECT * FROM app_system LIMIT 1');
  if (app[0]) { const a = app[0]; await p.companyInfo.create({ data: { legacyId: a.id, name: s(a.cname) || 'Vestel', address: s(a.address), city: s(a.city), region: s(a.region), country: s(a.country), phone: s(a.phone), email: s(a.email), taxId: s(a.taxid), currency: s(a.currency), prefix: s(a.prefix), logo: s(a.logo) } }); }
  console.log('empresa:', app.length);

  // Móviles
  const movs = await q('SELECT * FROM moviles');
  await chunk('movil', movs.map((m) => ({ legacyId: m.id_movil, name: s(m.nombre) || `Móvil ${m.id_movil}`, status: s(m.estado) })));
  console.log('móviles:', movs.length);

  // Eventos (calendario)
  const evs = await q('SELECT * FROM events');
  await chunk('calendarEvent', evs.map((e) => ({ legacyId: e.id, orderNo: e.idorden ?? null, taskId: e.id_tarea ?? null, title: s(e.title), description: s(e.description), color: s(e.color), start: dt(e.start), end: dt(e.end), allDay: e.allDay == 1, rel: e.rel ?? null, rid: e.rid ?? null, assignedBy: s(e.asigno) })));
  console.log('eventos:', evs.length);

  // Cotizaciones (vacío en legacy, pero migramos estructura)
  const qs = await q('SELECT * FROM quotes');
  const subMap = new Map((await p.subscriber.findMany({ select: { id: true, legacyId: true } })).map((r) => [r.legacyId, r.id]));
  await chunk('quote', qs.map((r) => ({ legacyId: r.id, tid: r.tid, subscriberId: subMap.get(r.csd) || null, subscriberLegacy: r.csd ?? null, invoiceDate: dt(r.invoicedate), dueDate: dt(r.invoiceduedate), subtotal: n(r.subtotal), discount: n(r.discount), tax: n(r.tax), total: n(r.total), status: s(r.status) || 'pending', notes: s(r.notes), proposal: s(r.proposal), itemsCount: n(r.items) })));
  console.log('cotizaciones:', qs.length);

  for (const m of ['cashAccount', 'department', 'city', 'locality', 'neighborhood', 'companyInfo', 'movil', 'calendarEvent', 'quote']) console.log('  ✔', m, await p[m].count());
  await my.end(); await p.$disconnect();
  console.log('ETL config+omni OK');
})().catch((e) => { console.error(e); process.exit(1); });
