/**
 * ETL de las cláusulas de permanencia mínima: `clausula` (MySQL vivo) → `Clausula` (PG).
 *
 * Son 5 filas que casi nunca cambian, pero sin ellas el contrato no se puede
 * imprimir: el número que cada abonado trae en `Subscriber.clausula` no significa
 * nada hasta que exista la fila con ese `legacyId`.
 *
 * Idempotente: upsert por legacyId. Los `mesN` que el legacy rellena de cero más
 * allá de `meses` NO se copian — un 0 en el mes 7 de una cláusula de 6 se leería
 * como "no debe nada" cuando lo que pasa es que ya no hay permanencia.
 *
 *   node scripts/etl-clausulas.js
 */
const mysql = require('mysql2/promise');
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

const env = (k, d) => process.env[k] || d;

(async () => {
  const my = await mysql.createConnection({
    host: env('LEGACY_DB_HOST', '127.0.0.1'),
    port: Number(env('LEGACY_DB_PORT', 3306)),
    user: env('LEGACY_DB_USER', 'admin_vestel'),
    password: env('LEGACY_DB_PASSWORD', ''),
    database: env('LEGACY_DB_NAME', 'admin_vestel'),
  });

  const [rows] = await my.query('SELECT * FROM clausula ORDER BY idcla');
  let creadas = 0, actualizadas = 0;

  for (const r of rows) {
    const meses = Number(r.meses) || 0;
    const valores = [];
    for (let i = 1; i <= Math.min(meses, 12); i++) valores.push(Number(r[`mes${i}`]) || 0);

    const data = {
      nombre: String(r.nombre || '').trim(),
      meses,
      vTotal: Number(r.v_total) || 0,
      valores,
      activa: true,
    };
    const existente = await p.clausula.findUnique({ where: { legacyId: r.idcla } });
    await p.clausula.upsert({
      where: { legacyId: r.idcla },
      create: { legacyId: r.idcla, ...data },
      update: data,
    });
    existente ? actualizadas++ : creadas++;
  }

  // Cuántos abonados apuntan a cada cláusula (y cuántos apuntan a una que no existe).
  const uso = await p.$queryRawUnsafe(
    `SELECT s.clausula, count(*)::int AS abonados, c.nombre
       FROM "Subscriber" s LEFT JOIN "Clausula" c ON c."legacyId" = s.clausula
      WHERE s.clausula IS NOT NULL
      GROUP BY s.clausula, c.nombre ORDER BY 2 DESC`,
  );
  console.log(`Cláusulas: +${creadas} nuevas, ~${actualizadas} actualizadas`);
  for (const u of uso) {
    console.log(`  clausula ${u.clausula}: ${u.abonados} abonados → ${u.nombre ?? '⚠ SIN CATÁLOGO'}`);
  }

  await my.end();
  await p.$disconnect();
})().catch(async (e) => {
  console.error(e);
  await p.$disconnect();
  process.exit(1);
});
