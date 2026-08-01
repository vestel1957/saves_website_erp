/**
 * Cuadra el DETALLE de facturas del legacy contra su TOTAL.
 *
 * El legacy tiene facturas cuya cabecera no coincide con la suma de sus renglones:
 * al imprimirlas el cliente ve un detalle que no da el total que se le cobra, y
 * nadie puede explicar la diferencia. Este script las deja explicándose solas.
 *
 * REGLA DE ORO: nunca cambia lo que el cliente debe. El `total` se respeta y se
 * ajusta el RENGLÓN. El único caso donde el total estaba mal (arrastre de un mes
 * no facturado, abonado 56888) se corrigió aparte y a mano, porque ahí sí cambiaba
 * la deuda y eso lo decide la empresa, no un script.
 *
 * Por qué el total es el bueno en el grupo grande: en la corrida del 2026-02-01 el
 * catálogo cambió a los productos "…26" con el precio viejo (26.500) pero el total
 * quedó con el precio real. 511 clientes PAGARON 30.000 y 160 pagaron 35.000 con
 * ese mismo renglón de 26.500 → el que está mal es el renglón.
 *
 * Reparto de la diferencia: va al renglón de TELEVISIÓN, que es el que quedó con el
 * precio equivocado en el cambio de catálogo. Se comprobó una por una: en las 84
 * facturas el descuadre está ahí (26.500 contra los 30.000/35.000 reales cuando falta
 * plata, y contra 26.250/25.000 cuando sobra). Tocar el renglón de internet cuadraría
 * la cuenta pero dejaría un precio de internet que no existe — justo lo que hay que
 * evitar. Si una factura no tiene exactamente un renglón de TV, se omite y sale
 * listada para mirarla a mano.
 *
 * Se conserva la tasa de IVA del renglón y después se recalculan `invoices.subtotal`
 * (= ítems − IVA) y `invoices.tax` (= Σ IVA), que es la convención del legacy.
 *
 * Uso:  node scripts/cuadrar-facturas-legacy.js [--aplicar] [--desde=2026-01-01]
 *       Sin --aplicar no escribe nada (modo seco, imprime el plan).
 */
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

for (const l of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
}

const APLICAR = process.argv.includes('--aplicar');
const DESDE = (process.argv.find((a) => a.startsWith('--desde=')) || '--desde=2026-01-01').split('=')[1];

const cop = (n) => new Intl.NumberFormat('es-CO').format(n);

(async () => {
  const my = await mysql.createConnection({
    host: process.env.LEGACY_DB_HOST, port: Number(process.env.LEGACY_DB_PORT || 3306),
    user: process.env.LEGACY_DB_USER, password: process.env.LEGACY_DB_PASSWORD,
    database: process.env.LEGACY_DB_NAME, dateStrings: true,
  });

  // Candidatas: pendientes cuyo total no cuadra ni contra los ítems ni aplicando
  // el descuento (el legacy usa las dos convenciones según la factura).
  const [rows] = await my.query(`
    SELECT i.id, i.tid, i.invoicedate, i.total, i.discount, i.shipping, i.status,
           i.facturacion_electronica AS fe, c.abonado,
           s.suma, s.n
    FROM invoices i
    JOIN (SELECT tid, SUM(subtotal) suma, COUNT(*) n, MIN(subtotal) minsub
          FROM invoice_items GROUP BY tid) s ON s.tid = i.tid
    JOIN customers c ON c.id = i.csd
    WHERE i.status IN ('due','partial')
      AND i.total <> s.suma
      AND i.total <> s.suma - i.discount + i.shipping
      AND i.invoicedate >= ?
      AND s.minsub >= 0            -- deja fuera la basura histórica con ítems negativos
    ORDER BY i.invoicedate, i.id`, [DESDE]);

  const plan = [], saltadas = [];
  for (const inv of rows) {
    const diff = Number(inv.total) - Number(inv.suma);
    if (!diff) continue;
    // Una factura ya emitida a la DIAN no se toca: el detalle tiene que seguir
    // siendo el que se reportó. Si aparece alguna, va a revisión manual.
    if (inv.fe) { saltadas.push({ ...inv, motivo: 'factura electrónica emitida' }); continue; }

    const [items] = await my.query(
      'SELECT id, product, qty, price, subtotal, totaltax FROM invoice_items WHERE tid=? ORDER BY subtotal DESC', [inv.tid]);
    if (!items.length) { saltadas.push({ ...inv, motivo: 'sin renglones' }); continue; }

    // La diferencia va al renglón de televisión, que es el que trae el precio malo.
    const tv = items.filter((x) => /tele?vision/i.test(x.product || ''));
    if (tv.length !== 1) { saltadas.push({ ...inv, motivo: `${tv.length} renglones de TV (se esperaba 1)` }); continue; }
    const it = tv[0];
    const nuevoSub = Number(it.subtotal) + diff;
    if (nuevoSub <= 0) { saltadas.push({ ...inv, motivo: `el ajuste dejaría el renglón en ${nuevoSub}` }); continue; }

    const tasa = Number(it.price) > 0 ? Number(it.totaltax) / Number(it.price) : 0;
    const nuevoPrecio = Math.round(nuevoSub / (1 + tasa));
    const nuevoIva = nuevoSub - nuevoPrecio;

    const totIva = items.reduce((a, x) => a + Number(x.totaltax), 0) - Number(it.totaltax) + nuevoIva;
    const totItems = Number(inv.suma) + diff;

    plan.push({
      id: inv.id, tid: inv.tid, abonado: inv.abonado, fecha: inv.invoicedate, total: Number(inv.total),
      itemId: it.id, producto: it.product, deSub: Number(it.subtotal), aSub: nuevoSub, diff,
      nuevoPrecio, nuevoIva, invSubtotal: totItems - totIva, invTax: totIva,
    });
  }

  console.log(`\nFacturas por cuadrar: ${plan.length}   (omitidas: ${saltadas.length})`);
  const sube = plan.filter((p) => p.diff > 0), baja = plan.filter((p) => p.diff < 0);
  console.log(`  · sube el renglón (el detalle cobraba de menos): ${sube.length}  → ${cop(sube.reduce((a, p) => a + p.diff, 0))}`);
  console.log(`  · baja el renglón (el detalle cobraba de más):   ${baja.length}  → ${cop(baja.reduce((a, p) => a + p.diff, 0))}`);
  for (const s of saltadas) console.log(`  OMITIDA  factura ${s.id} (abonado ${s.abonado}): ${s.motivo}`);
  console.log('\nMuestra:');
  for (const p of plan.slice(0, 6)) {
    console.log(`  #${p.id} ab.${p.abonado} ${p.fecha}  total ${cop(p.total)}  ·  ${p.producto}: ${cop(p.deSub)} → ${cop(p.aSub)}`);
  }

  if (!APLICAR) { console.log('\n(seco: no se escribió nada — use --aplicar)\n'); await my.end(); return; }

  const nota = 'Detalle cuadrado 2026-07-31: el renglon no sumaba el total cobrado. No cambia lo que debe el cliente.';
  let ok = 0;
  for (const p of plan) {
    await my.execute('UPDATE invoice_items SET price=?, subtotal=?, totaltax=? WHERE id=?',
      [p.nuevoPrecio, p.aSub, p.nuevoIva, p.itemId]);
    await my.execute(
      'UPDATE invoices SET subtotal=?, tax=?, notes=CONCAT(IFNULL(NULLIF(notes,\'.\'),\'\'),?) WHERE id=? AND total=?',
      [p.invSubtotal, p.invTax, ' ' + nota, p.id, p.total]);
    ok++;
  }
  console.log(`\nAplicado a ${ok} facturas. El total de cada una quedó intacto.\n`);
  await my.end();
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
