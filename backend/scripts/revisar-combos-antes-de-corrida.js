/**
 * REVISIÓN PREVIA A LA CORRIDA MENSUAL (creado 2026-09-19).
 *
 * La corrida del LEGACY (`Invoices_model::generar_facturas_logica`) no lee el plan de la
 * ficha del cliente: lee la columna `combo` (y `television`) de su ÚLTIMA factura y busca
 * ese nombre en `products`:
 *
 *     $internet = $value2->combo;
 *     SELECT * FROM products WHERE product_name = "$internet"       // línea 1267
 *
 * y sólo emite el renglón de internet si `combo` no es "", "no", "-" ni "solotelevision*"
 * y `estado_combo` está en NULL. Consecuencia: **la factura de octubre se arma leyendo la
 * de septiembre**. Si a alguien se le borró el `combo`, pierde el renglón de internet y lo
 * pierde otra vez todos los meses siguientes — el error se perpetúa solo.
 *
 * Eso fue lo que pasó el 01-09-2026: 68 abonados activos quedaron con `combo` vacío y se
 * les facturó sólo la televisión.
 *
 * Qué hace este script:
 *   1. Para cada abonado Activo/Compromiso simula la MISMA elección de factura que hace la
 *      corrida (la más reciente anterior al mes, saltando Fija, notas crédito/débito y las
 *      que llevan afiliación o traslado).
 *   2. Avisa de los que esa factura dejaría SIN renglón de internet aunque venían con plan.
 *   3. Con --live restaura el `combo` desde la última factura que sí lo tenía, en el legacy
 *      y en nexus a la vez.
 *
 * NO toca totales, renglones ni pagos: `combo` es el dato que lee la corrida del mes que
 * viene, no lo que el cliente debe hoy. Cobrar el internet que septiembre no cobró es una
 * decisión aparte, de Cartera.
 *
 * Sólo restaura cuando el plan pasó a CADENA VACÍA (pérdida de dato). Si pasó a "no" se
 * respeta: eso es alguien quitándole el internet a propósito.
 *
 * Uso: node scripts/revisar-combos-antes-de-corrida.js [--mes=2026-10-01] [--live]
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
const prisma = new PrismaClient();

const LIVE = process.argv.includes('--live');
const MES = (process.argv.find((a) => a.startsWith('--mes=')) || '').slice(6) || proximoMes();
const cop = (n) => '$' + Math.round(n).toLocaleString('es-CO');

function proximoMes() {
  const h = new Date();
  return new Date(Date.UTC(h.getUTCFullYear(), h.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
}
/** Las mismas exclusiones que el foreach de la corrida. */
const vacio = (v) => v == null || String(v).trim() === '' || v === '-';
const sinInternet = (c) => vacio(c) || c === 'no' || String(c).toLowerCase().includes('solotelevision');

async function main() {
  const my = await mysql.createConnection({
    host: process.env.LEGACY_DB_HOST, port: Number(process.env.LEGACY_DB_PORT || 3306),
    user: process.env.LEGACY_DB_USER, password: process.env.LEGACY_DB_PASSWORD,
    database: process.env.LEGACY_DB_NAME, dateStrings: true,
  });

  // La factura que la corrida va a leer, por abonado activo: la más reciente anterior al
  // mes, descartando las que el foreach salta.
  const [filas] = await my.query(
    `SELECT i.csd, i.tid, i.invoicedate, i.combo, i.television, i.estado_combo, i.puntos,
            c.abonado, c.usu_estado, g.title AS sede
       FROM invoices i
       JOIN customers c ON c.id = i.csd
       LEFT JOIN customers_group g ON g.id = c.gid
      WHERE c.usu_estado IN ('Activo','Compromiso')
        AND i.invoicedate < ?
        AND i.tipo_factura NOT IN ('Fija','Nota Credito','Nota Debito')
        AND NOT EXISTS (SELECT 1 FROM invoice_items it
                         WHERE it.tid = i.tid AND (it.product LIKE '%afiliacion%' OR it.product LIKE '%traslado%'))
      ORDER BY i.csd, i.invoicedate DESC, i.tid DESC`, [MES]);

  const elegida = new Map();          // csd → la factura que leerá la corrida
  const historial = new Map();        // csd → [facturas, de nueva a vieja]
  for (const f of filas) {
    if (!elegida.has(f.csd)) elegida.set(f.csd, f);
    if (!historial.has(f.csd)) historial.set(f.csd, []);
    historial.get(f.csd).push(f);
  }

  const aReparar = [];
  const lejanos = [];  // el plan anterior es de hace meses: lo mira una persona
  const viejos = [];   // vacío desde hace meses: son de sólo televisión, no se tocan
  const sinCatalogo = [];
  for (const [csd, f] of elegida) {
    if (sinInternet(f.combo)) {
      // ¿venía con plan y se perdió el dato? (vacío, no un 'no' explícito)
      if (!vacio(f.combo)) continue;
      // Sólo si el dato se perdió EN ESTA corrida: la factura inmediatamente anterior lo
      // tenía. Mirar más atrás sería resucitar un plan viejo y ponerse a cobrar internet
      // a quien hace años es sólo de televisión (223 abonados llevan el combo vacío desde
      // 2021-2024 y se les factura bien así).
      const lista = historial.get(csd);
      const previa = lista[lista.findIndex((p) => p.tid === f.tid) + 1];
      // …y que esa anterior sea realmente del mes pasado. Si entre las dos hay medio año,
      // no es una pérdida de dato de esta corrida y el plan viejo no se resucita solo.
      const dias = previa ? (new Date(f.invoicedate) - new Date(previa.invoicedate)) / 86400000 : Infinity;
      if (previa && !sinInternet(previa.combo) && dias <= 70) {
        aReparar.push({ ...f, comboBueno: previa.combo, desde: previa.tid, desdeFecha: previa.invoicedate });
      } else if (previa && !sinInternet(previa.combo)) {
        lejanos.push({ ...f, comboBueno: previa.combo, desde: previa.tid, desdeFecha: previa.invoicedate });
      } else if (previa) {
        viejos.push(f);
      }
      continue;
    }
    const [[p]] = await my.query('SELECT pid FROM products WHERE product_name = ? LIMIT 1', [f.combo]);
    if (!p) sinCatalogo.push(f);
  }

  console.log(`${LIVE ? 'APLICANDO' : 'EN SECO (no se escribe nada)'} — corrida del ${MES}`);
  console.log(`  abonados activos revisados: ${elegida.size}`);
  console.log(`\n  A) PIERDEN EL INTERNET porque se les borró el combo: ${aReparar.length}`);
  for (const r of aReparar.slice(0, 80)) {
    const freno = r.estado_combo ? `  [estado_combo=${r.estado_combo}: seguirá sin cobrarse]` : '';
    console.log(`     abonado ${String(r.abonado).padStart(6)} · ${String(r.sede ?? '').padEnd(11)} · factura #${r.tid} (${r.invoicedate}) ← "${r.comboBueno}" de #${r.desde} (${r.desdeFecha})${freno}`);
  }
  if (aReparar.length > 80) console.log(`     … y ${aReparar.length - 80} más`);
  for (const r of lejanos) console.log(`\n  ! REVISAR A MANO — abonado ${r.abonado} · #${r.tid} (${r.invoicedate}): el último plan ("${r.comboBueno}") es de ${r.desdeFecha}`);
  console.log(`\n  (sin internet desde hace tiempo, se dejan como están: ${viejos.length})`);
  console.log(`\n  B) combo que el catálogo NO reconoce (renglón invisible): ${sinCatalogo.length}`);
  for (const r of sinCatalogo) console.log(`     abonado ${r.abonado} · factura #${r.tid} · combo "${r.combo}" no está en products`);

  if (!LIVE || !aReparar.length) { await my.end(); await prisma.$disconnect(); return; }

  let ok = 0;
  for (const r of aReparar) {
    await my.execute('UPDATE invoices SET combo=? WHERE tid=?', [r.comboBueno, r.tid]);
    await prisma.subInvoice.updateMany({ where: { tid: r.tid }, data: { serviceCombo: r.comboBueno } });
    ok++;
  }
  // Comprobación: ninguno queda vacío y todos resuelven contra el catálogo.
  let malos = 0;
  for (const r of aReparar) {
    const [[f]] = await my.query('SELECT combo FROM invoices WHERE tid=?', [r.tid]);
    const [[p]] = await my.query('SELECT pid FROM products WHERE product_name=? LIMIT 1', [f.combo]);
    const n = await prisma.subInvoice.findUnique({ where: { tid: r.tid }, select: { serviceCombo: true } });
    if (!p || f.combo !== r.comboBueno || n?.serviceCombo !== r.comboBueno) { malos++; console.error(`     ✘ #${r.tid} quedó mal`); }
  }
  console.log(`\n  ✔ combos restaurados: ${ok}${malos ? ` · con problemas: ${malos}` : ' · todos resuelven contra el catálogo'}`);
  await my.end();
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
