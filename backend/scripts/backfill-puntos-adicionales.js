// Alta del concepto "Punto Adicional" en el catálogo + una línea de servicio
// PUNTOS por abonado, con la cantidad que traía su última factura del legacy.
// El punto NO es gravado (confirmado por contabilidad 2026-08-11): es el mismo
// servicio de TV repartido a otro televisor, no un servicio nuevo. Va al 0% y el
// precio es el de lista completo, igual que lo viene cobrando el legacy.
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const DRY = process.argv.includes('--dry');

(async () => {
  const plan = await p.plan.upsert({
    where: { id: (await p.plan.findFirst({ where: { name: 'Punto Adicional', kind: 'PUNTOS' } }))?.id ?? '__nuevo__' },
    update: { price: 5000, taxRate: 0, active: true },
    create: { name: 'Punto Adicional', kind: 'PUNTOS', price: 5000, taxRate: 0, active: true },
  });
  console.log(`Plan: ${plan.name} · ${plan.price} · IVA ${plan.taxRate}%`);

  // Precio y cantidad vigentes del abonado, sacados de sus propias facturas:
  //  - qty  = la de la última factura que trajo la línea.
  //  - price = el MÁXIMO de los últimos 12 meses. Las altas a mitad de mes dejan
  //    renglones prorrateados (806, 2.093, 4.032…) que NO son el precio de lista;
  //    el máximo los descarta solo. Si un abonado únicamente tiene prorrateos se
  //    cae al precio estándar del catálogo.
  // Nadie se reprecia: el comercial que paga 10.556 por punto lo conserva, solo
  // se le discrimina el IVA que ya venía adentro.
  const filas = await p.$queryRawUnsafe(`
    WITH linea AS (
      SELECT i."subscriberId", i."invoiceDate", i.tid, it.qty, it.price, it."productName"
        FROM "SubInvoice" i JOIN "SubInvoiceItem" it ON it."invoiceId" = i.id
       WHERE it."productName" ILIKE '%punto%' AND it.qty > 0 AND it.price > 0
         AND i.status <> 'CANCELED' AND i."invoiceDate" >= now() - interval '12 months'
    ),
    ult AS (
      SELECT DISTINCT ON ("subscriberId") "subscriberId", qty, "productName"
        FROM linea ORDER BY "subscriberId", "invoiceDate" DESC, tid DESC
    )
    SELECT ult."subscriberId", ult.qty, ult."productName", max(linea.price) AS price
      FROM ult JOIN linea USING ("subscriberId")
     GROUP BY ult."subscriberId", ult.qty, ult."productName"`);

  const LISTA = 5000;                       // precio de lista del punto

  let creados = 0, actualizados = 0, cobrado = 0;
  const repreciados = [];
  for (const f of filas) {
    // Solo prorrateos en el historial → precio de lista.
    const precio = Number(f.price) < LISTA && /^punto adicional$/i.test(f.productName) ? LISTA : Number(f.price);
    if (precio !== Number(f.price)) repreciados.push(`${f.subscriberId} ${f.price}→${precio}`);
    cobrado += precio * f.qty;

    const data = { qty: f.qty, price: precio, taxRate: 0, status: 'ACTIVO', planName: f.productName,
                   planId: precio === LISTA ? plan.id : null };
    const ya = await p.subscriberService.findFirst({ where: { subscriberId: f.subscriberId, kind: 'PUNTOS' } });
    if (DRY) { ya ? actualizados++ : creados++; continue; }
    if (ya) { await p.subscriberService.update({ where: { id: ya.id }, data }); actualizados++; }
    else { await p.subscriberService.create({ data: { subscriberId: f.subscriberId, kind: 'PUNTOS', ...data } }); creados++; }
  }
  const tot = filas.reduce((s, f) => s + f.qty, 0);
  if (repreciados.length) console.log(`solo ten\u00edan prorrateos, van a precio de lista: ${repreciados.join(', ')}`);
  console.log(`${DRY ? '[SIMULACI\u00d3N] ' : ''}abonados: ${filas.length} \u00b7 puntos: ${tot} \u00b7 creados: ${creados} \u00b7 actualizados: ${actualizados}`);
  console.log(`facturaci\u00f3n mensual que recupera: ${cobrado.toLocaleString('es-CO')} COP (sin IVA: el punto no es gravado)`);
  await p.$disconnect();
})();
