/**
 * Devuelve a COMPROMISO a los abonados que una reconexión dejó en ACTIVO.
 *
 * El 2026-08-28 el arrastre del portal de pagos reconectó a 320 abonados y, de paso,
 * pasó a ACTIVO a 39 que estaban en COMPROMISO. Eso no es un detalle cosmético: el
 * estado COMPROMISO es la marca de que hay un ACUERDO DE PAGO en curso, y borrarlo
 * hace desaparecer de la ficha que el cliente quedó debiendo a plazo. El servicio SÍ
 * se le devuelve —pagaron— pero el acuerdo se respeta.
 *
 * Repone el estado en LOS DOS SISTEMAS: aquí y en el legacy, porque el writeback ya
 * había empujado `usu_estado='Activo'` allá y la ida de 15 min lo traería de vuelta.
 * Los valores originales salen del backup de las 03:31, anterior al cambio, no de una
 * suposición: fichero TSV con `id, legacyId, abonado, status, previousStatus,
 * statusChangedAt`.
 *
 * En SECO por defecto.
 *
 *   npx ts-node --transpile-only scripts/reponer-compromisos-reconexion.ts <fichero.tsv> [--aplicar]
 */
import 'reflect-metadata';
import * as fs from 'node:fs';
import * as path from 'node:path';

for (const linea of (() => { try { return fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split('\n'); } catch { return []; } })()) {
  const m = linea.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
}

import { PrismaClient, SubscriberStatus } from '@prisma/client';
import mysql from 'mysql2/promise';

const FICHERO = process.argv[2];
const APLICAR = process.argv.includes('--aplicar');

/** Estado del legacy equivalente al de aquí (allá van en Capitalizado). */
const aLegacy = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();

type Fila = {
  id: string; legacyId: number | null; abonado: number;
  status: SubscriberStatus; previousStatus: SubscriberStatus | null; statusChangedAt: Date | null;
};

function leer(fichero: string): Fila[] {
  return fs.readFileSync(fichero, 'utf8').split('\n').filter((l) => l.trim()).map((l) => {
    const [id, legacyId, abonado, status, previousStatus, statusChangedAt] = l.split('\t');
    return {
      id, legacyId: legacyId ? Number(legacyId) : null, abonado: Number(abonado),
      status: status as SubscriberStatus,
      previousStatus: (previousStatus || null) as SubscriberStatus | null,
      statusChangedAt: statusChangedAt ? new Date(statusChangedAt) : null,
    };
  });
}

async function main() {
  if (!FICHERO) throw new Error('Falta el fichero TSV con los valores originales.');
  const filas = leer(FICHERO);
  const prisma = new PrismaClient();
  console.log(`\n=== Reponer COMPROMISO · ${filas.length} abonado(s) · ${APLICAR ? 'APLICAR' : 'SIMULACIÓN'} ===\n`);

  // Solo se toca a quien HOY está como lo dejó la reconexión. Si alguien volvió a
  // cambiar por su cuenta (un pago, un retiro, el propio legacy), manda lo de ahora.
  const actuales = await prisma.subscriber.findMany({
    where: { id: { in: filas.map((f) => f.id) } },
    select: { id: true, abonado: true, status: true },
  });
  const porId = new Map(actuales.map((a) => [a.id, a]));
  const aponer = filas.filter((f) => porId.get(f.id)?.status === 'ACTIVO');
  const saltados = filas.filter((f) => porId.get(f.id)?.status !== 'ACTIVO');
  for (const s of saltados) {
    console.log(`  SALTA  ${String(s.abonado).padStart(7)}  ya no está en ACTIVO (${porId.get(s.id)?.status ?? 'no existe'})`);
  }
  console.log(`\n${aponer.length} a reponer a COMPROMISO · ${saltados.length} saltado(s)\n`);
  if (!APLICAR) {
    console.log('SIMULACIÓN: no se escribió nada. Repite con --aplicar.\n');
    return;
  }

  // 1. Aquí.
  for (const f of aponer) {
    await prisma.subscriber.update({
      where: { id: f.id },
      data: {
        status: f.status,
        previousStatus: f.previousStatus ?? undefined,
        statusChangedAt: f.statusChangedAt ?? undefined,
      },
    });
  }
  // La fila de historial que escribió `marcarActivo` decía que pasó a ACTIVO, y no
  // pasó: se borra. Un historial con cambios que no ocurrieron es peor que ninguno.
  const borradas = await prisma.subscriberStatusHistory.deleteMany({
    where: {
      subscriberId: { in: aponer.map((f) => f.id) },
      status: 'ACTIVO',
      note: 'Reconexión automática por pago',
      date: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
    },
  });
  console.log(`Aquí: ${aponer.length} abonado(s) repuestos · ${borradas.count} fila(s) de historial borradas`);

  // 2. El legacy, que el writeback ya había puesto en Activo.
  const conLegacy = aponer.filter((f) => f.legacyId);
  if (conLegacy.length) {
    const cn = await mysql.createConnection({
      host: process.env.LEGACY_DB_HOST, port: Number(process.env.LEGACY_DB_PORT || 3306),
      user: process.env.LEGACY_DB_USER, password: process.env.LEGACY_DB_PASSWORD,
      database: process.env.LEGACY_DB_NAME,
    });
    let tocados = 0;
    try {
      for (const f of conLegacy) {
        // Solo si allá sigue como lo dejó el writeback: Activo viniendo de Compromiso.
        const [r] = await cn.execute(
          "UPDATE customers SET usu_estado = ?, ultimo_estado = ?, fecha_cambio = ? " +
            "WHERE id = ? AND usu_estado = 'Activo' AND ultimo_estado = 'Compromiso'",
          [
            aLegacy(f.status), f.previousStatus ? aLegacy(f.previousStatus) : null,
            f.statusChangedAt ? f.statusChangedAt.toISOString().slice(0, 19).replace('T', ' ') : null,
            f.legacyId,
          ],
        );
        tocados += (r as { affectedRows: number }).affectedRows;
      }
    } finally {
      await cn.end();
    }
    console.log(`Legacy: ${tocados} de ${conLegacy.length} fila(s) repuestas a Compromiso`);
  }
  console.log('');
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); }).then(() => process.exit(0));
