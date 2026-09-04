/**
 * Rellena la nota de los recaudos que quedaron "pelados".
 *
 * Hasta el 2026-08-25 `CobranzasService.collect` escribía sólo "Pago de la factura
 * #123", mientras el legacy escribe quién pagó, con qué documento y por qué medio
 * (ver `notaDePago`). Esos pagos viajan al legacy en el writeback, así que en la
 * caja de allá se veían al lado de los suyos, más pobres.
 *
 * Sólo toca los recaudos NACIDOS EN NEXUS (createdAt >= DESDE): los históricos de
 * 2020-2023 ya venían cortos del legacy y no son cosa nuestra.
 *
 * Reescribe la nota en PG y, si la fila ya viajó (`legacyId`), también allá — sólo
 * la columna `note`, y sólo si allá sigue teniendo el texto corto (si alguien la
 * editó, se respeta).
 *
 * Uso:
 *   npx ts-node --transpile-only scripts/backfill-notas-pago.ts            # informe
 *   npx ts-node --transpile-only scripts/backfill-notas-pago.ts --escribir
 */
import 'reflect-metadata';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { notaDePago } from '../src/treasury/cobranzas.service';

for (const raw of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split('\n')) {
  const m = raw.match(/^\s*([A-Z0-9_]+)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, '');
}

const ESCRIBIR = process.argv.includes('--escribir');
/** Corte: los recaudos creados en el stack nuevo. Lo anterior es histórico del legacy. */
const DESDE = new Date('2026-08-01T00:00:00Z');
/** Nota corta exactamente como la escribía nexus (con su posible cola de "sin reconexión"). */
const CORTA = /^Pago de la factura #(\d+)( · .*)?$/;

const prisma = new PrismaClient();

(async () => {
  const filas = await prisma.transaction.findMany({
    where: { type: 'INCOME', invoiceId: { not: null }, createdAt: { gte: DESDE } },
    select: {
      id: true, note: true, method: true, accountName: true, legacyId: true, credit: true, date: true,
      invoice: { select: { tid: true } },
      subscriber: { select: { firstName: true, lastName1: true, docNumber: true, branch: { select: { name: true } } } },
    },
    orderBy: { date: 'asc' },
  });

  const cambios: Array<{ id: string; legacyId: number | null; vieja: string; nueva: string }> = [];
  for (const t of filas) {
    const m = CORTA.exec(t.note ?? '');
    if (!m || !t.invoice) continue;
    const cola = m[2] ?? ''; // " · sin reconexión (a petición del cliente)"
    const nueva = notaDePago({
      tid: t.invoice.tid,
      nombre: [t.subscriber?.firstName, t.subscriber?.lastName1].map((x) => (x || '').trim()).filter(Boolean).join(' ') || null,
      documento: t.subscriber?.docNumber ?? null,
      metodo: t.method ?? 'Cash',
      cuenta: t.accountName,
      sede: t.subscriber?.branch?.name ?? null,
    }) + cola;
    if (nueva !== t.note) cambios.push({ id: t.id, legacyId: t.legacyId, vieja: t.note ?? '', nueva });
  }

  console.log(`Recaudos revisados (desde ${DESDE.toISOString().slice(0, 10)}): ${filas.length}`);
  console.log(`Con nota corta: ${cambios.length} · de ellos ya en el legacy: ${cambios.filter((c) => c.legacyId).length}`);
  for (const c of cambios.slice(0, 5)) console.log(`  ${c.vieja}\n   → ${c.nueva}`);
  if (cambios.length > 5) console.log(`  … y ${cambios.length - 5} más`);

  if (!ESCRIBIR) { console.log('\n(informe: nada escrito — repite con --escribir)'); await prisma.$disconnect(); return; }

  for (const c of cambios) await prisma.transaction.update({ where: { id: c.id }, data: { note: c.nueva } });
  console.log(`\nPG: ${cambios.length} notas actualizadas.`);

  const enLegacy = cambios.filter((c) => c.legacyId != null);
  if (enLegacy.length) {
    const mysql = require('mysql2/promise');
    const my = await mysql.createConnection({
      host: process.env.LEGACY_DB_HOST, port: Number(process.env.LEGACY_DB_PORT || 3306),
      user: process.env.LEGACY_DB_USER, password: process.env.LEGACY_DB_PASSWORD, database: process.env.LEGACY_DB_NAME,
    });
    let ok = 0, saltadas = 0;
    for (const c of enLegacy) {
      // Guardia: sólo se pisa si allá sigue el texto corto que escribimos nosotros.
      const [r] = await my.query('UPDATE transactions SET note = ? WHERE id = ? AND note = ?', [c.nueva.slice(0, 255), c.legacyId, c.vieja]);
      if (r.affectedRows) ok++; else saltadas++;
    }
    await my.end();
    console.log(`Legacy: ${ok} notas actualizadas · ${saltadas} saltadas (ya no tenían el texto corto).`);
  }
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
