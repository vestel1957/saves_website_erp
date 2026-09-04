/**
 * ¿Le cobraría nexus lo mismo que el legacy?
 *
 * Toma las reconexiones con arrastre que el LEGACY hizo de verdad (sus tickets
 * `Reconexion …2` de los últimos días, con la factura y los renglones que generó)
 * y le pregunta a `ProrrateoReconexionService` qué habría cobrado él por lo mismo,
 * SIN escribir nada (modo informe forzado).
 *
 * Es la prueba que las unitarias no pueden dar: aquí se ven los datos de verdad —los
 * abonados sin `SubscriberService`, los planes con nombres raros, los que ya tenían
 * el mes facturado— y se ve si el peso cuadra.
 *
 *   npx ts-node --transpile-only scripts/verificar-prorrateo-reconexion.ts [días]
 */

import mysql from 'mysql2/promise';
import { PrismaService } from '../src/prisma/prisma.service';
import { PostingService } from '../src/accounting/posting.service';
import { ProrrateoReconexionService } from '../src/billing/prorrateo-reconexion.service';

const DIAS = Number(process.argv[2] || 7);

async function main() {
  const prisma = new PrismaService();
  // El prorrateo no escribe nada aquí: se fuerza el modo informe.
  process.env.BILLING_PRORRATEO_RECONEXION = 'informe';
  const posting = { postSalesInvoice: async () => null, postSalesInvoiceAdjustment: async () => null } as unknown as PostingService;
  const servicio = new ProrrateoReconexionService(prisma, posting);
  (servicio as any).modo = async () => 'informe';

  const my = await mysql.createConnection({
    host: process.env.LEGACY_DB_HOST, port: Number(process.env.LEGACY_DB_PORT || 3306),
    user: process.env.LEGACY_DB_USER, password: process.env.LEGACY_DB_PASSWORD,
    database: process.env.LEGACY_DB_NAME,
  });

  const [filas] = await my.execute<any[]>(
    `SELECT t.idt, t.cid, t.detalle, t.created, t.id_factura,
            (SELECT ROUND(SUM(ii.price)) FROM invoice_items ii WHERE ii.tid = t.id_factura) AS base_factura
       FROM tickets t
      WHERE t.detalle IN ('Reconexion Internet2','Reconexion Television2','Reconexion Combo2')
        AND t.created >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      ORDER BY t.idt DESC`,
    [DIAS],
  );

  console.log(`\nReconexiones con arrastre en el legacy en los últimos ${DIAS} días: ${filas.length}\n`);
  console.log('abonado  fecha       tipo                    nexus dice');
  console.log('-------  ----------  ----------------------  ------------------------------------------');

  let cobraria = 0, plata = 0, sinFicha = 0, yaFacturado = 0, sinAbonado = 0;
  for (const f of filas) {
    const sub = await prisma.subscriber.findFirst({ where: { legacyId: f.cid }, select: { id: true, abonado: true } });
    if (!sub) { sinAbonado++; continue; }
    const servicios: Array<'INTERNET' | 'TV'> = f.detalle.includes('Combo')
      ? ['INTERNET', 'TV'] : f.detalle.includes('Internet') ? ['INTERNET'] : ['TV'];
    // Se evalúa con la fecha en que lo hizo el legacy, no con hoy: si no, los días
    // no coinciden y la comparación no dice nada.
    const r = await servicio.evaluar(sub.id, servicios, new Date(`${new Date(f.created).toISOString().slice(0, 10)}T00:00:00Z`));
    if (r.aplica) { cobraria++; plata += r.total; }
    else if (/SubscriberService|precio/.test(r.mensaje)) sinFicha++;
    else yaFacturado++;
    console.log(
      `${String(sub.abonado).padEnd(7)}  ${new Date(f.created).toISOString().slice(0, 10)}  ${String(f.detalle).padEnd(22)}  ${r.aplica ? `$${r.total.toLocaleString('es-CO')} (${r.dias}d) — legacy: $${Number(f.base_factura || 0).toLocaleString('es-CO')} base` : r.mensaje.slice(0, 60)}`,
    );
  }

  console.log('\n--- Resumen ---');
  console.log(`Cobraría:            ${cobraria}  ($${Math.round(plata).toLocaleString('es-CO')})`);
  console.log(`Ya facturado (no):   ${yaFacturado}`);
  console.log(`Sin plan en ficha:   ${sinFicha}`);
  console.log(`Sin abonado en nexus:${sinAbonado}`);

  await my.end();
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
