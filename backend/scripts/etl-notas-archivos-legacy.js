/**
 * Volcado histórico de las OBSERVACIONES y los ARCHIVOS del perfil del cliente.
 *
 *   admin_vestel.historiales            → SubscriberNote  (28.087 filas)
 *   admin_vestel.meta_data (type = 6)   → SubscriberFile  (14.565 filas, 4,6 GB)
 *
 * Es el bloque que el legacy pinta al pie de la ficha del cliente ("OBSERVACIONES"
 * y la tabla "Files") y que en nexus salía vacío: los modelos existían desde el
 * primer día, pero nadie había traído el histórico ni enganchado la sincronización.
 * De lo incremental se encarga después `sync-legacy-vivo.js`.
 *
 * Los binarios: se leen de la copia local de `userfiles/attach/` (LEGACY_ATTACH_DIR)
 * y lo que no esté ahí —los subidos después de esa copia— se baja del legacy vivo
 * por HTTP (LEGACY_ATTACH_URL). Cada fichero queda en `uploads/subscribers/<id>/`
 * con un nombre determinista, así que repetir la corrida no duplica nada.
 *
 * Uso:  node scripts/etl-notas-archivos-legacy.js [--dry] [--solo=notas|archivos]
 *                                                 [--limite=N] [--sin-descarga]
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

const { mapObservacion, mimeDe, nombreVisible, nombreEnDisco, traductorDeNombres } = require('./lib/observaciones-legacy');
const { UPLOAD_ROOT, ATTACH_DIR, ATTACH_URL, traerArchivo } = require('./lib/archivos-legacy');

const MYSQL = {
  host: process.env.LEGACY_DB_HOST || '127.0.0.1',
  port: Number(process.env.LEGACY_DB_PORT || 3306),
  user: process.env.LEGACY_DB_USER,
  password: process.env.LEGACY_DB_PASSWORD,
  database: process.env.LEGACY_DB_NAME || 'admin_vestel',
  dateStrings: true,
};

const DRY = process.argv.includes('--dry');
const SIN_DESCARGA = process.argv.includes('--sin-descarga');
const SOLO = (process.argv.find((a) => a.startsWith('--solo=')) || '--solo=todo').split('=')[1];
const LIMITE = Number((process.argv.find((a) => a.startsWith('--limite=')) || '=0').split('=')[1]) || 0;

const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);

async function inChunks(arr, size, fn) {
  for (let i = 0; i < arr.length; i += size) await fn(arr.slice(i, i + size));
}

async function importarNotas(my, subMap) {
  const nombreDe = await traductorDeNombres(prisma);
  const [rows] = await my.query(
    `SELECT idn,id_user,tipos,nombres,tdocumento,documento2,fecha,observacion,colaborador
       FROM historiales ORDER BY idn` + (LIMITE ? ` LIMIT ${LIMITE}` : ''),
  );
  let sinCliente = 0, vacias = 0;
  const data = [];
  for (const r of rows) {
    const sid = subMap.get(r.id_user);
    if (!sid) { sinCliente++; continue; }
    const nota = mapObservacion(r, sid, nombreDe);
    if (!nota) { vacias++; continue; }
    data.push(nota);
  }
  log(`observaciones: ${rows.length} en el legacy · ${data.length} a insertar · ${sinCliente} sin cliente en nexus · ${vacias} sin contenido`);
  if (DRY) return { leidas: rows.length, insertadas: 0, sinCliente, vacias, dry: true };
  let n = 0;
  await inChunks(data, 2000, async (slice) => {
    n += (await prisma.subscriberNote.createMany({ data: slice, skipDuplicates: true })).count;
  });
  log(`observaciones: ${n} nuevas`);
  return { leidas: rows.length, insertadas: n, sinCliente, vacias };
}

async function importarArchivos(my, subMap) {
  const [rows] = await my.query(
    `SELECT id,rid,col1,col2 FROM meta_data WHERE type = 6 ORDER BY id` + (LIMITE ? ` LIMIT ${LIMITE}` : ''),
  );
  const yaImportados = new Set(
    (await prisma.subscriberFile.findMany({ where: { legacyId: { not: null } }, select: { legacyId: true } }))
      .map((f) => f.legacyId),
  );
  const res = { leidos: rows.length, insertados: 0, yaEstaban: 0, sinCliente: 0, copiados: 0, descargados: 0, perdidos: 0, bytes: 0 };
  const perdidos = [];

  const pendientes = [];
  for (const r of rows) {
    if (yaImportados.has(r.id)) { res.yaEstaban++; continue; }
    const sid = subMap.get(r.rid);
    if (!sid) { res.sinCliente++; continue; }
    pendientes.push({ ...r, sid });
  }
  log(`archivos: ${rows.length} en el legacy · ${res.yaEstaban} ya estaban · ${res.sinCliente} sin cliente · ${pendientes.length} por traer`);
  if (DRY) return { ...res, dry: true };

  let hechos = 0;
  await inChunks(pendientes, 25, async (slice) => {
    const filas = (await Promise.all(slice.map(async (r) => {
      const destinoDir = path.join(UPLOAD_ROOT, r.sid);
      const storedName = nombreEnDisco(r.id, r.col1);
      const t = await traerArchivo(r.col1, path.join(destinoDir, storedName), { sinDescarga: SIN_DESCARGA });
      if (!t.ok) { perdidos.push({ id: r.id, name: r.col1, motivo: t.motivo }); return null; }
      if (t.origen === 'disco') res.copiados++; else if (t.origen === 'http') res.descargados++;
      res.bytes += t.size;
      return {
        legacyId: r.id,
        subscriberId: r.sid,
        originalName: nombreVisible(r.col1),
        storedName,
        mimeType: mimeDe(r.col1),
        size: t.size,
        uploadedByName: null,
      };
    }))).filter(Boolean);
    if (filas.length) {
      res.insertados += (await prisma.subscriberFile.createMany({ data: filas, skipDuplicates: true })).count;
    }
    hechos += slice.length;
    if (hechos % 500 < 25) log(`archivos: ${hechos}/${pendientes.length} · ${(res.bytes / 1e9).toFixed(2)} GB`);
  });

  res.perdidos = perdidos.length;
  if (perdidos.length) {
    const salida = path.join(__dirname, 'archivos-legacy-perdidos.json');
    fs.writeFileSync(salida, JSON.stringify(perdidos, null, 2));
    log(`archivos: ${perdidos.length} no se pudieron traer → ${salida}`);
  }
  log(`archivos: ${res.insertados} nuevos (${res.copiados} de disco, ${res.descargados} descargados, ${(res.bytes / 1e9).toFixed(2)} GB)`);
  return res;
}

async function main() {
  if (!MYSQL.user || !MYSQL.password) throw new Error('Faltan LEGACY_DB_USER / LEGACY_DB_PASSWORD en el entorno');
  const t0 = Date.now();
  log(`origen: ${MYSQL.host}/${MYSQL.database} · adjuntos: ${ATTACH_DIR} (respaldo ${ATTACH_URL})`);
  const my = await mysql.createConnection(MYSQL);
  const subs = await prisma.subscriber.findMany({ where: { legacyId: { not: null } }, select: { id: true, legacyId: true } });
  const subMap = new Map(subs.map((s) => [s.legacyId, s.id]));
  log(`clientes con legacyId en nexus: ${subMap.size}`);

  const out = { ok: true, dry: DRY };
  if (SOLO === 'todo' || SOLO === 'notas') out.notas = await importarNotas(my, subMap);
  if (SOLO === 'todo' || SOLO === 'archivos') out.archivos = await importarArchivos(my, subMap);
  out.ms = Date.now() - t0;
  console.log(JSON.stringify(out, null, 2));
  await my.end(); await prisma.$disconnect();
}

main().catch(async (e) => {
  console.log(JSON.stringify({ ok: false, error: e.message }));
  console.error(e);
  process.exit(1);
});
