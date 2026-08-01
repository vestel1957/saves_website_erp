/**
 * ETL: aauth_users (legacy vestel_dev) -> User (Postgres saves_vestel).
 *
 * Crea el login de TODOS los empleados del legacy conservando su misma clave:
 * el hash Aauth (sha256(md5(id)+clave)) se guarda como `aauth:<md5(id)>:<hash>`,
 * formato que `verifyPassword` (crypto.util.ts) acepta y re-hashea a scrypt en el
 * primer login exitoso.
 *
 * Mapeos:
 *   - roleid 5 -> super-admin · 4 -> area-administracion · 3 -> area-caja · 2 -> area-tecnicos
 *   - banned=1 -> isActive=false (ex-empleados quedan importados pero sin acceso)
 *   - sede_accede '-2-,-3-' -> sedesAccede [2,3]; '0'/'-0-' solo -> [] (= TODAS);
 *     sedes inexistentes (p.ej. 0 dentro de una lista) se descartan como en el legacy
 *   - asignaciones (detalle='caja', colaborador=id) -> cajaLegacyId
 *   - nombre: Staff.name (employee_profile) por legacyId, fallback username
 *
 * Idempotente y no destructivo: si ya existe un User con ese email (cuentas demo,
 * admin o una corrida previa) se SALTA y se reporta — nunca pisa claves ni roles.
 */
const mysql = require('mysql2/promise');
const { createHash } = require('crypto');
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

const ROLE_BY_LEGACY = { 5: 'super-admin', 4: 'area-administracion', 3: 'area-caja', 2: 'area-tecnicos' };

// '-2-,-3-' -> [2,3] · '0' y '-0-' (solos) -> [] = TODAS (Search.php:84-88 quita
// guiones antes de comparar con '0'). Ids que no existen como Branch se descartan.
function parseSedes(raw, sedesValidas) {
  const limpio = (raw ?? '').replace(/-/g, '').trim();
  if (!limpio || limpio === '0') return [];
  const ids = [...new Set(limpio.split(',').map((x) => parseInt(x.trim(), 10)).filter((n) => !Number.isNaN(n)))];
  return ids.filter((id) => sedesValidas.has(id)).sort((a, b) => a - b);
}

(async () => {
  const my = await mysql.createConnection({ host: 'localhost', user: 'admin_vestel', password: 'Vestel_2025!', database: 'vestel_dev' });
  const q = async (sql) => (await my.query(sql))[0];

  const roles = await p.role.findMany({ where: { key: { in: Object.values(ROLE_BY_LEGACY) } }, select: { id: true, key: true } });
  const roleId = new Map(roles.map((r) => [r.key, r.id]));
  for (const key of Object.values(ROLE_BY_LEGACY)) if (!roleId.has(key)) throw new Error(`Falta el rol ${key} en la BD`);

  const sedesValidas = new Set((await p.branch.findMany({ select: { legacyId: true } })).map((b) => b.legacyId));
  const staffPorLegacy = new Map(
    (await p.staff.findMany({ select: { legacyId: true, name: true } })).filter((s) => s.legacyId != null).map((s) => [s.legacyId, s.name]),
  );

  const legacy = await q(`
    SELECT u.id, u.email, u.username, u.pass, u.banned, u.roleid, u.sede_accede, a.tipo AS caja
    FROM aauth_users u
    LEFT JOIN asignaciones a ON a.colaborador = u.id AND a.detalle = 'caja'
    ORDER BY u.id
  `);
  const existentes = new Set((await p.user.findMany({ select: { email: true } })).map((u) => u.email.toLowerCase()));

  let creados = 0, activos = 0, saltados = 0;
  for (const u of legacy) {
    const email = String(u.email ?? '').trim().toLowerCase();
    if (!email) { console.log(`  ~ id ${u.id} (${u.username}) sin email — saltado`); saltados++; continue; }
    if (existentes.has(email)) { console.log(`  ~ ${email} ya existe — saltado (no se toca)`); saltados++; continue; }

    const salt = createHash('md5').update(String(u.id)).digest('hex');
    const rolKey = ROLE_BY_LEGACY[u.roleid];
    await p.user.create({
      data: {
        email,
        name: staffPorLegacy.get(u.id) || u.username || email.split('@')[0],
        passwordHash: `aauth:${salt}:${u.pass}`,
        isActive: !u.banned,
        sedesAccede: parseSedes(u.sede_accede, sedesValidas),
        cajaLegacyId: u.caja != null ? parseInt(u.caja, 10) || null : null,
        ...(rolKey ? { roles: { create: [{ roleId: roleId.get(rolKey) }] } } : {}),
      },
    });
    existentes.add(email);
    creados++;
    if (!u.banned) activos++;
  }

  console.log(`\nLegacy: ${legacy.length} usuarios · creados: ${creados} (${activos} activos, ${creados - activos} inactivos/banned) · saltados: ${saltados}`);
  await my.end();
  await p.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
