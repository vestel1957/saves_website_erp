/**
 * Volcado histórico de la BITÁCORA DE LLAMADAS de cobranza.
 *
 *   admin_vestel.llamadas  → CallLog  (~110.900 filas)
 *
 * Es lo que la pestaña Cobranza de `/clientes/[id]` pinta y que en nexus salía casi
 * vacío: sólo estaban las llamadas registradas aquí. De lo incremental se encarga
 * después `sync-legacy-vivo.js` (paso `syncLlamadas`, marca de agua `llamadas`).
 *
 * Repetible: `CallLog.legacyId` es único y el insert salta lo que ya está. No toca
 * las llamadas creadas en nexus (`legacyId = null`) ni dispara nada: un "Acuerdo de
 * Pago" histórico NO pone al cliente en COMPROMISO (eso sólo lo hace registrarlo aquí).
 *
 * Uso:  node scripts/etl-llamadas-legacy.js [--dry]
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

const { traductorDeNombres } = require('./lib/observaciones-legacy');
const { mapLlamada, COLUMNAS_LLAMADAS } = require('./lib/llamadas-legacy');

const MYSQL = {
  host: process.env.LEGACY_DB_HOST || '127.0.0.1',
  port: Number(process.env.LEGACY_DB_PORT || 3306),
  user: process.env.LEGACY_DB_USER,
  password: process.env.LEGACY_DB_PASSWORD,
  database: process.env.LEGACY_DB_NAME || 'admin_vestel',
  dateStrings: true,
};

const DRY = process.argv.includes('--dry');
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);

(async () => {
  const my = await mysql.createConnection(MYSQL);
  const subs = await prisma.subscriber.findMany({ where: { legacyId: { not: null } }, select: { id: true, legacyId: true } });
  const subMap = new Map(subs.map((s) => [s.legacyId, s.id]));
  const nombreDe = await traductorDeNombres(prisma);

  const [rows] = await my.query(`SELECT ${COLUMNAS_LLAMADAS} FROM llamadas ORDER BY id`);
  let sinCliente = 0, descartadas = 0;
  const data = [];
  for (const r of rows) {
    const sid = subMap.get(r.iduser);
    if (!sid) { sinCliente++; continue; }
    const fila = mapLlamada(r, sid, nombreDe);
    if (fila) data.push(fila); else descartadas++;
  }
  log(`llamadas legacy: ${rows.length} · a importar: ${data.length} · sin cliente: ${sinCliente} · descartadas: ${descartadas}`);

  let creadas = 0;
  if (!DRY) {
    for (let i = 0; i < data.length; i += 2000) {
      creadas += (await prisma.callLog.createMany({ data: data.slice(i, i + 2000), skipDuplicates: true })).count;
    }
  }
  const maxId = rows.reduce((m, r) => Math.max(m, r.id), 0);
  console.log(JSON.stringify({ dry: DRY, legacy: rows.length, creadas, sinCliente, descartadas, maxId }));
  await my.end(); await prisma.$disconnect();
})().catch((e) => { console.error('ETL LLAMADAS FALLÓ:', e); process.exit(1); });
