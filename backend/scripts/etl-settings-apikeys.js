// ETL: metas de negocio (goals) + claves de API legacy (api_keys).
// Idempotente. Uso: node scripts/etl-settings-apikeys.js
//
// - goals (fila única id=1) → BusinessGoal (upsert por legacyId).
// - api_keys → ApiKey importadas como REVOCADAS por seguridad: la clave legacy
//   se guarda hasheada (así el tercero podría reactivarse), pero queda inactiva
//   hasta que Sistemas la habilite explícitamente. Superficie sensible.
const mysql = require('mysql2/promise');
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

const GOAL_FIELDS = [
  'income', 'expense', 'sales', 'netincome', 'users', 'vesagro', 'servicios',
  'compras', 'creditos', 'nomina', 'socios', 'oficial', 'internet',
  'programadora', 'impuestos', 'publicos', 'comisiones', 'celulares', 'purchase',
];

function pepper() {
  const s = process.env.AUTH_SECRET;
  return s && s.length >= 16 ? s : 'nexus-dev-secret-change-me';
}
const hashKey = (k) => crypto.createHmac('sha256', pepper()).update(String(k).trim()).digest('hex');
const big = (v) => { try { return BigInt(Math.max(0, Math.trunc(Number(v) || 0))); } catch { return 0n; } };

async function main() {
  const my = await mysql.createConnection({ host: 'localhost', user: 'admin_vestel', password: 'Vestel_2025!', database: 'vestel_dev' });

  // --- Metas / goals ---
  const [goals] = await my.query('SELECT * FROM goals ORDER BY id ASC LIMIT 1');
  if (goals.length) {
    const g = goals[0];
    const data = { legacyId: Number(g.id) || 1 };
    for (const f of GOAL_FIELDS) data[f] = big(g[f]);
    await p.businessGoal.upsert({ where: { legacyId: data.legacyId }, update: data, create: data });
    console.log(`✓ Metas (goals) importadas: income=${data.income} internet=${data.internet}`);
  } else {
    console.log('– goals vacío, nada que importar');
  }

  // --- Claves de API legacy ---
  const [keys] = await my.query('SELECT * FROM api_keys');
  let n = 0, skip = 0;
  for (const r of keys) {
    if (!r.key) { skip++; continue; }
    const keyHash = hashKey(r.key);
    const exists = await p.apiKey.findFirst({ where: { OR: [{ legacyId: Number(r.id) }, { keyHash }] } });
    if (exists) { skip++; continue; }
    const ips = (r.ip_addresses || '').split(/[\s,]+/).filter(Boolean);
    await p.apiKey.create({
      data: {
        legacyId: Number(r.id),
        name: `Clave legacy #${r.id}` + (r.user_id ? ` (user ${r.user_id})` : ''),
        keyHash,
        keyPrefix: `${String(r.key).slice(0, 6)}…(legacy)`,
        scopes: ['clients:read'],
        active: false,          // importada revocada: requiere habilitación explícita
        revokedAt: new Date(),
        ignoreLimits: !!r.ignore_limits,
        ipAllowlist: ips,
        createdByName: 'ETL (import legacy)',
      },
    });
    n++;
  }
  console.log(`✓ Claves API legacy: ${n} importadas (revocadas), ${skip} omitidas`);

  await my.end();
  await p.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
