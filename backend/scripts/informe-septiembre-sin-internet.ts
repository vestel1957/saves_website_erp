/**
 * Las facturas de la corrida de SEPTIEMBRE-2026 a las que les falta el internet.
 *
 * La corrida del 01-09 cobró sólo la TV a los abonados cuyo internet no pudo identificar
 * (ver [[septiembre-sin-internet]]): unos porque su `SubscriberService` sólo tenía la TV,
 * otros porque el nombre de su plan no estaba en el catálogo `Plan` y el cruce por nombre
 * de `plan-facturable` no lo veía (`50MegasF24` y compañía, ya creados por
 * `planes-legacy-faltantes.ts`). Octubre ya les cobra; septiembre quedó sin cobrar.
 *
 * Criterio: factura RECURRENTE de septiembre SIN ningún renglón de internet, cuando la
 * de agosto sí lo traía. El "internet" se reconoce cruzando el nombre del renglón contra
 * `Plan` (kind INTERNET), que es la misma regla con la que factura la corrida.
 *
 * Sólo LEE. La decisión de editar cada factura es de Cartera: varias están PAID y tocarlas
 * cambia lo que el abonado debe.
 *
 *   npx ts-node --transpile-only scripts/informe-septiembre-sin-internet.ts
 *   ... --csv=/ruta/informe.csv
 */
import * as fs from 'fs';
import * as path from 'path';

for (const l of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
}

import { PrismaService } from '../src/prisma/prisma.service';

const arg = (n: string, d: string) =>
  (process.argv.find((a) => a.startsWith(`--${n}=`)) || `--${n}=${d}`).split('=')[1];
const CSV = arg('csv', '');
const $ = (n: number) => '$' + Math.round(Number(n)).toLocaleString('es-CO');

interface Fila {
  abonado: number; nombre: string; estado: string;
  tidSept: number; totalSept: number; estadoSept: string;
  planAgosto: string; precioAgosto: number; tidAgosto: number;
}

async function main() {
  const prisma = new PrismaService();

  const filas = await prisma.$queryRaw<Fila[]>`
    WITH internet AS (SELECT DISTINCT lower(btrim(name)) AS n FROM "Plan" WHERE kind = 'INTERNET'),
    -- Una recurrente por abonado y por mes: la última emitida de ese mes.
    mes AS (
      SELECT DISTINCT ON (i."subscriberId", date_trunc('month', i."invoiceDate"))
             i.id, i.tid, i."subscriberId", i.total, i.status::text AS estado,
             date_trunc('month', i."invoiceDate") AS m
        FROM "SubInvoice" i
       WHERE i.kind = 'RECURRENTE' AND i.status <> 'CANCELED'
         AND i."invoiceDate" >= DATE '2026-08-01' AND i."invoiceDate" < DATE '2026-10-01'
       ORDER BY i."subscriberId", date_trunc('month', i."invoiceDate"), i."invoiceDate" DESC, i.tid DESC
    ),
    -- El renglón de internet de cada una (el más caro, si trae varios).
    conNet AS (
      SELECT m.id, m.tid, m."subscriberId", m.m,
             (SELECT it."productName" FROM "SubInvoiceItem" it JOIN internet p
                     ON p.n = lower(btrim(COALESCE(it."productName", it.description)))
               WHERE it."invoiceId" = m.id AND it.price > 0
               ORDER BY it.price DESC LIMIT 1) AS plan,
             (SELECT max(it.price) FROM "SubInvoiceItem" it JOIN internet p
                     ON p.n = lower(btrim(COALESCE(it."productName", it.description)))
               WHERE it."invoiceId" = m.id AND it.price > 0) AS precio
        FROM mes m
    )
    SELECT s.abonado, COALESCE(s."fullName", '') AS nombre, s.status::text AS estado,
           sep.tid AS "tidSept", sep.total AS "totalSept", sep.estado AS "estadoSept",
           ago.plan AS "planAgosto", ago.precio AS "precioAgosto", ago.tid AS "tidAgosto"
      FROM mes sep
      JOIN conNet sepn ON sepn.id = sep.id
      JOIN conNet ago ON ago."subscriberId" = sep."subscriberId" AND ago.m = DATE '2026-08-01'
      JOIN "Subscriber" s ON s.id = sep."subscriberId"
     WHERE sep.m = DATE '2026-09-01' AND sepn.plan IS NULL AND ago.plan IS NOT NULL
     ORDER BY ago.precio DESC, s.abonado`;

  console.log(`\n=== Facturas de septiembre-2026 sin internet (tenían en agosto): ${filas.length} ===\n`);
  const porEstado = new Map<string, number>();
  let dejadoDeCobrar = 0;
  console.log('abonado  estado     #sept      total sept    estado   internet de agosto');
  console.log('-------  ---------  ---------  ------------  -------  --------------------------------');
  for (const f of filas) {
    porEstado.set(f.estadoSept, (porEstado.get(f.estadoSept) ?? 0) + 1);
    dejadoDeCobrar += Number(f.precioAgosto);
    console.log(`${String(f.abonado).padEnd(8)} ${f.estado.padEnd(10)} #${String(f.tidSept).padEnd(9)} ${$(f.totalSept).padStart(12)}  ${f.estadoSept.padEnd(8)} ${f.planAgosto} ${$(f.precioAgosto)}  (#${f.tidAgosto})`);
  }
  console.log(`\nInternet dejado de cobrar en septiembre: ${$(dejadoDeCobrar)}`);
  console.log('Estado de esas facturas: ' + Array.from(porEstado.entries()).map(([k, v]) => `${k}=${v}`).join(' · '));
  console.log('  (las PAID no se pueden editar sin rehacer el pago — decisión de Cartera)\n');

  if (CSV) {
    const cab = 'abonado,nombre,estado_abonado,tid_septiembre,total_septiembre,estado_factura,plan_agosto,precio_agosto,tid_agosto\n';
    const cuerpo = filas.map((f) => [f.abonado, `"${f.nombre.replace(/"/g, '""')}"`, f.estado, f.tidSept,
      Math.round(Number(f.totalSept)), f.estadoSept, `"${f.planAgosto}"`, Math.round(Number(f.precioAgosto)), f.tidAgosto].join(',')).join('\n');
    fs.writeFileSync(CSV, cab + cuerpo + '\n');
    console.log(`CSV: ${CSV}\n`);
  }
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
