/** ETL: empleados (employee_profile+aauth_users+areas) y proyectos (projects+milestones). */
const mysql = require('mysql2/promise');
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const dOnly = (d) => (d && String(d) !== '0000-00-00' ? new Date(d) : null);
const dT = (d) => { const x = dOnly(d); return x; };
const s = (v) => (v == null || v === '' ? null : String(v));
const n = (v) => (v == null ? 0 : Number(v));

async function chunk(model, rows, size = 1000) {
  for (let i = 0; i < rows.length; i += size) await p[model].createMany({ data: rows.slice(i, i + size), skipDuplicates: true });
}
async function mapBy(model, key = 'legacyId') {
  const rows = await p[model].findMany({ select: { id: true, [key]: true } });
  const m = new Map(); for (const r of rows) if (r[key] != null) m.set(r[key], r.id); return m;
}

(async () => {
  const my = await mysql.createConnection({ host: 'localhost', user: 'admin_vestel', password: 'Vestel_2025!', database: 'vestel_dev' });
  const q = async (sql) => (await my.query(sql))[0];

  await p.milestone.deleteMany({});
  await p.project.deleteMany({});
  await p.staff.deleteMany({});
  await p.staffArea.deleteMany({});

  // Áreas
  const areas = await q('SELECT * FROM areas');
  await chunk('staffArea', areas.map((a) => ({ legacyId: a.ida, name: s(a.nombre_area) || `Área ${a.ida}`, description: s(a.descripcion) })));
  const areaMap = await mapBy('staffArea');
  console.log('áreas:', areas.length);

  // Empleados: employee_profile LEFT JOIN aauth_users por id
  const emps = await q(`SELECT ep.*, au.email, au.roleid, au.banned, au.last_login, au.sede_accede
                        FROM employee_profile ep LEFT JOIN aauth_users au ON au.id = ep.id`);
  await chunk('staff', emps.map((e) => ({
    legacyId: e.id, name: s(e.name) || s(e.username) || `Empleado ${e.id}`, docNumber: e.dto ? String(e.dto) : null,
    username: s(e.username), email: s(e.email), role: e.roleid ?? null, entryDate: dOnly(e.ingreso),
    rh: s(e.rh), eps: s(e.eps), pension: s(e.pensiones), address: s(e.address), city: s(e.city), region: s(e.region), country: s(e.country),
    areaId: areaMap.get(e.area) || null, areaLegacy: e.area ?? null, phone: s(e.phone), phoneAlt: s(e.phonealt),
    picture: s(e.picture), sign: s(e.sign), banned: e.banned == 1, lastLogin: e.last_login ? new Date(e.last_login) : null, sedeAccede: s(e.sede_accede),
  })));
  console.log('empleados:', emps.length);

  // Proyectos: mapear cid → subscriber por legacyId
  const projs = await q('SELECT * FROM projects');
  const subMap = new Map((await p.subscriber.findMany({ select: { id: true, legacyId: true } })).map((r) => [r.legacyId, r.id]));
  await chunk('project', projs.map((r) => ({
    legacyId: r.id, code: s(r.p_id), name: s(r.name) || `Proyecto ${r.id}`, status: s(r.status) || 'Pending', priority: s(r.priority) || 'Medium',
    progress: n(r.progress), subscriberId: subMap.get(r.cid) || null, subscriberLegacy: r.cid ?? null,
    startDate: dOnly(r.sdate), endDate: dOnly(r.edate), tag: s(r.tag), phase: s(r.phase), note: s(r.note), worth: n(r.worth),
  })));
  const projMap = await mapBy('project');
  console.log('proyectos:', projs.length);

  // Hitos
  const miles = await q('SELECT * FROM milestones');
  await chunk('milestone', miles.map((m) => ({
    legacyId: m.id, projectId: projMap.get(m.pid), name: s(m.name) || `Hito ${m.id}`,
    startDate: dOnly(m.sdate), endDate: dOnly(m.edate), detail: s(m.exp), color: s(m.color),
  })).filter((x) => x.projectId));
  console.log('hitos:', miles.length);

  for (const m of ['staffArea', 'staff', 'project', 'milestone']) console.log('  ✔', m, await p[m].count());
  await my.end(); await p.$disconnect();
  console.log('ETL rrhh+proyectos OK');
})().catch((e) => { console.error(e); process.exit(1); });
