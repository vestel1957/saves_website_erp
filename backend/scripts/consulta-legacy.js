#!/usr/bin/env node
/**
 * Consola de SOLO LECTURA contra el MySQL vivo del legacy (admin_vestel).
 *
 * Sirve para contrastar cifras cuando una pantalla de nexus no cuadra: la fuente
 * de verdad de la operación sigue siendo el legacy, no nuestra copia.
 *
 *   node scripts/consulta-legacy.js "SELECT COUNT(*) n FROM invoices WHERE invoicedate >= '2026-08-01'"
 *   node scripts/consulta-legacy.js -f consulta.sql
 *
 * Rechaza cualquier cosa que no sea SELECT / SHOW / DESCRIBE / EXPLAIN: esta base
 * es la que factura de verdad y un UPDATE suelto aquí se lleva la operación por
 * delante. Para escribir en el legacy está el writeback, con su gate.
 */
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

function cargarEnv() {
  const env = {};
  for (const linea of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split('\n')) {
    const i = linea.indexOf('=');
    if (i > 0 && !linea.trim().startsWith('#')) {
      env[linea.slice(0, i).trim()] = linea.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    }
  }
  return env;
}

const PERMITIDO = /^\s*(select|show|describe|desc|explain|with)\b/i;

async function main() {
  const args = process.argv.slice(2);
  const sql = args[0] === '-f' ? fs.readFileSync(args[1], 'utf8') : args.join(' ');
  if (!sql.trim()) {
    console.error('Uso: node scripts/consulta-legacy.js "SELECT ..."  |  -f archivo.sql');
    process.exit(1);
  }
  if (!PERMITIDO.test(sql)) {
    console.error('Solo lectura: se aceptan SELECT, SHOW, DESCRIBE, EXPLAIN y WITH.');
    process.exit(1);
  }

  const env = cargarEnv();
  const conexion = await mysql.createConnection({
    host: env.LEGACY_DB_HOST || '127.0.0.1',
    port: Number(env.LEGACY_DB_PORT || 3306),
    user: env.LEGACY_DB_USER,
    password: env.LEGACY_DB_PASSWORD,
    database: env.LEGACY_DB_NAME || 'admin_vestel',
  });
  try {
    const [filas] = await conexion.query(sql);
    if (!Array.isArray(filas) || filas.length === 0) return console.log('(sin filas)');
    console.table(filas.slice(0, 200));
    if (filas.length > 200) console.log(`… ${filas.length - 200} filas más (mostradas 200)`);
  } finally {
    await conexion.end();
  }
}

main().catch((e) => { console.error('ERROR', e.code || '', e.message); process.exit(1); });
