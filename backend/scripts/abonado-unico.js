#!/usr/bin/env node
/**
 * Deja el NÚMERO DE ABONADO único para cada cliente, sin importar la sede.
 *
 * El legacy numeró por sede durante años (Yopal, Monterrey y Villanueva arrancaron
 * cada una en 0/1), así que el mismo número lo tienen hasta cinco clientes. Hoy
 * `Customers_model::codigouser()` ya usa el MAX global, pero lo viejo quedó: al
 * 2026-09-14, 4.266 números repetidos entre 11.480 clientes.
 *
 * ─── QUIÉN CONSERVA EL NÚMERO ───────────────────────────────────────────────────
 *
 * De cada grupo lo conserva el cliente VIVO (el que paga o volverá a pagar) y, entre
 * vivos o entre no vivos, el más antiguo (legacyId menor; los nacidos aquí al final).
 * Los demás reciben un número nuevo a partir del máximo de las dos bases + 1. El
 * abonado 0 (dato vacío del legacy) no lo conserva nadie.
 *
 * ─── POR QUÉ SE ESCRIBE EN LOS DOS LADOS ────────────────────────────────────────
 *
 * `abonado` está en el diff de la ida (`vestel-map.js`): cambiarlo sólo en Postgres
 * lo revierte la siguiente pasada de 15 minutos. Se escribe primero en el MySQL del
 * legacy y enseguida aquí; correrlo lejos de los minutos :00/:07/:15/:22/:30/:37/:45/:52.
 *
 * Al final sube `Subscriber_abonado_seq` por encima del último número: estaba por
 * DEBAJO del máximo y el alta de clientes aquí fabricaba repetidos por sí sola.
 *
 *   set -a; . ./.env; set +a
 *   node scripts/abonado-unico.js              # simulacro: escribe el CSV del plan
 *   node scripts/abonado-unico.js --aplicar    # respaldo JSON + MySQL + Postgres
 */
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const { PrismaClient } = require('@prisma/client');

const APLICA = process.argv.includes('--aplicar');
const OUT = (process.argv.find((a) => a.startsWith('--out=')) || '').split('=')[1]
  || path.join(__dirname, '..', 'backups');

const VIVOS = new Set(['ACTIVO', 'CARTERA', 'COMPROMISO', 'CORTADO', 'EXONERADO', 'INSTALAR',
  'POR_RETIRAR', 'REPORTADO', 'SUSPENDIDO', 'EVENTO']);
/** usu_estado del legacy (Title Case) que cuentan como vivo, para las filas que sólo están allá. */
const VIVOS_LEGACY = new Set(['activo', 'cartera', 'compromiso', 'cortado', 'exonerado', 'instalar',
  'por retirar', 'reportado', 'suspendido', 'evento']);

const prisma = new PrismaClient();
const MYSQL = {
  host: process.env.LEGACY_DB_HOST || '127.0.0.1',
  port: Number(process.env.LEGACY_DB_PORT || 3306),
  user: process.env.LEGACY_DB_USER,
  password: process.env.LEGACY_DB_PASSWORD,
  database: process.env.LEGACY_DB_NAME || 'admin_vestel',
  dateStrings: true,
};

const csv = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function main() {
  const my = await mysql.createConnection(MYSQL);
  const [legacy] = await my.query(
    `SELECT id, abonado, usu_estado, TRIM(CONCAT_WS(' ', name, dosnombre, unoapellido, dosapellido)) AS nombre, documento
       FROM customers`);
  const subs = await prisma.subscriber.findMany({
    select: {
      id: true, legacyId: true, abonado: true, status: true, fullName: true, companyName: true,
      firstName: true, lastName1: true, docNumber: true, createdAt: true, branch: { select: { name: true } },
    },
  });

  // Una fila por cliente: los de Postgres, más los del legacy que aquí no están.
  const legacyPorId = new Map(legacy.map((r) => [Number(r.id), r]));
  const enPg = new Set(subs.filter((s) => s.legacyId != null).map((s) => s.legacyId));
  const deriva = [];
  const clientes = subs.map((s) => {
    const l = s.legacyId != null ? legacyPorId.get(s.legacyId) : null;
    if (l && Number(l.abonado) !== s.abonado) deriva.push({ legacyId: s.legacyId, pg: s.abonado, legacy: Number(l.abonado) });
    return {
      pgId: s.id, legacyId: s.legacyId, enLegacy: !!l, abonado: s.abonado,
      vivo: VIVOS.has(s.status), estado: s.status ?? '',
      sede: s.branch?.name ?? '', documento: s.docNumber ?? '', creado: s.createdAt,
      nombre: s.fullName || s.companyName || [s.firstName, s.lastName1].filter(Boolean).join(' '),
    };
  });
  for (const l of legacy) {
    if (enPg.has(Number(l.id))) continue;
    clientes.push({
      pgId: null, legacyId: Number(l.id), enLegacy: true, abonado: Number(l.abonado) || 0,
      vivo: VIVOS_LEGACY.has(String(l.usu_estado || '').trim().toLowerCase()), estado: `${l.usu_estado} (solo legacy)`,
      sede: '', documento: l.documento ?? '', creado: null, nombre: l.nombre,
    });
  }
  if (deriva.length) {
    console.log(`AVISO: ${deriva.length} clientes con abonado distinto entre legacy y Postgres (se usa el de Postgres):`,
      deriva.slice(0, 10));
  }

  const grupos = new Map();
  for (const c of clientes) {
    if (!grupos.has(c.abonado)) grupos.set(c.abonado, []);
    grupos.get(c.abonado).push(c);
  }

  const [[{ maxLegacy }]] = await my.query('SELECT MAX(abonado) AS maxLegacy FROM customers');
  const [{ seq }] = await prisma.$queryRaw`SELECT last_value::int AS seq FROM "Subscriber_abonado_seq"`;
  const maxPg = Math.max(...clientes.map((c) => c.abonado));
  let siguiente = Math.max(maxPg, Number(maxLegacy) || 0, seq) + 1;

  const orden = (a, b) => (b.vivo - a.vivo)
    || ((a.legacyId ?? Infinity) - (b.legacyId ?? Infinity))
    || ((a.creado?.getTime() ?? 0) - (b.creado?.getTime() ?? 0));

  const plan = []; // { ...cliente, nuevo, conserva }
  for (const abonado of [...grupos.keys()].sort((a, b) => a - b)) {
    const g = grupos.get(abonado);
    if (g.length === 1 && abonado !== 0) continue;
    g.sort(orden);
    g.forEach((c, i) => {
      const conserva = i === 0 && abonado !== 0;
      plan.push({ ...c, conserva, nuevo: conserva ? abonado : siguiente++ });
    });
  }
  const cambios = plan.filter((p) => !p.conserva);

  const gruposRepetidos = new Set(plan.map((p) => p.abonado)).size;
  const vivosCambian = cambios.filter((c) => c.vivo).length;
  console.log(`clientes: ${clientes.length} · números repetidos: ${gruposRepetidos} · clientes en ellos: ${plan.length}`);
  console.log(`cambian de número: ${cambios.length} (vivos: ${vivosCambian}, no vivos: ${cambios.length - vivosCambian})`);
  console.log(`números nuevos: ${cambios.length ? `${cambios[0].nuevo}–${siguiente - 1}` : '—'} · secuencia hoy ${seq}, quedará en ${siguiente - 1}`);

  fs.mkdirSync(OUT, { recursive: true });
  const sello = new Date().toISOString().replace(/[:.]/g, '-');
  const archivoCsv = path.join(OUT, `abonado-unico-plan-${sello}.csv`);
  const cab = ['abonado_actual', 'abonado_nuevo', 'accion', 'vivo', 'estado', 'sede', 'nombre', 'documento', 'legacy_id', 'pg_id'];
  fs.writeFileSync(archivoCsv, '﻿' + [cab.join(';'), ...plan.map((p) => [
    p.abonado, p.nuevo, p.conserva ? 'CONSERVA' : 'CAMBIA', p.vivo ? 'SI' : 'NO', p.estado, p.sede,
    p.nombre, p.documento, p.legacyId ?? '', p.pgId ?? '',
  ].map(csv).join(';'))].join('\n'));
  console.log(`plan: ${archivoCsv}`);

  if (!APLICA) {
    console.log('SIMULACRO: no se escribió nada. Repetir con --aplicar.');
    await my.end();
    return;
  }

  // Respaldo: con esto se deshace el cambio fila por fila.
  const archivoRespaldo = path.join(OUT, `abonado-unico-respaldo-${sello}.json`);
  fs.writeFileSync(archivoRespaldo, JSON.stringify(cambios.map((c) => ({
    legacyId: c.legacyId, pgId: c.pgId, antes: c.abonado, despues: c.nuevo,
  }))));
  console.log(`respaldo: ${archivoRespaldo}`);

  const aLegacy = cambios.filter((c) => c.enLegacy);
  await my.beginTransaction();
  try {
    let n = 0;
    for (const c of aLegacy) {
      const [r] = await my.query('UPDATE customers SET abonado = ? WHERE id = ? AND abonado = ?', [c.nuevo, c.legacyId, c.abonado]);
      if (r.affectedRows !== 1) throw new Error(`legacy id ${c.legacyId}: el abonado ya no es ${c.abonado}`);
      n++;
    }
    await my.commit();
    console.log(`legacy: ${n} clientes renumerados`);
  } catch (e) {
    await my.rollback();
    throw e;
  }

  const aPg = cambios.filter((c) => c.pgId);
  await prisma.$transaction(async (tx) => {
    for (const c of aPg) {
      const r = await tx.subscriber.updateMany({ where: { id: c.pgId, abonado: c.abonado }, data: { abonado: c.nuevo } });
      if (r.count !== 1) throw new Error(`pg ${c.pgId}: el abonado ya no es ${c.abonado}`);
    }
    await tx.$queryRaw`SELECT setval('"Subscriber_abonado_seq"', ${siguiente - 1})`;
  }, { timeout: 600_000, maxWait: 30_000 });
  console.log(`postgres: ${aPg.length} clientes renumerados · secuencia en ${siguiente - 1}`);
  await my.end();
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
