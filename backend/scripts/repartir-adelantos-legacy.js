/**
 * Reparte los PAGOS ADELANTADOS que quedaron parqueados en el legacy.
 *
 * El problema (2026-09-07): el cliente paga dos, tres o cinco meses de una vez en la
 * ventanilla del LEGACY. Allá el excedente no se guarda aparte: se queda dentro de la
 * factura sobrepagada (`invoices.pamnt > total`) y lo reparte
 * `Invoices_model::procesar_pagos_adelantados($csd)` CUANDO NACE la factura del mes
 * siguiente. Pero desde agosto la factura del mes la crea NEXUS, no el legacy, así que
 * ese reparto no lo dispara nadie: el abonado que pagó septiembre por adelantado
 * aparece debiendo septiembre —aquí y allá—, expuesto a corte y a que le cobren otra vez.
 *
 * Esto es el port de `procesar_pagos_adelantados`, corriendo sobre LOS DOS SISTEMAS A
 * LA VEZ (mismo criterio que el re-fechado de septiembre): por cada imputación
 *
 *   · legacy   → baja `pamnt` de la factura sobrepagada, sube el de la factura cubierta
 *                (status/pmethod) y PARTE la transacción del cobro: le baja el `credit`
 *                a la original y crea una copia con el resto y el `tid` de la destino.
 *   · nexus    → exactamente lo mismo (`paidAmount`, `status`, `Transaction.credit`) y
 *                la transacción nueva nace ya enlazada por `legacyId`.
 *
 * Los dos lados quedan idénticos, así que la huella de `sync-legacy-vivo` no ve
 * diferencia y no revierte nada. Escribir sólo en el legacy NO vale: `refrescarTransacciones`
 * sólo re-lee los movimientos de los últimos 30 días, y la mayoría de estos cobros son
 * más viejos —el `credit` original se quedaría alto aquí y la plata se contaría dos veces.
 *
 * NO usa `CustomerAdvance`: eso es para el excedente que nace EN NEXUS (ver
 * billing/anticipos.ts). El que nace en el legacy vive en `pamnt` y allí se consume,
 * que es lo que ambos sistemas ya saben leer.
 *
 * Uso:  node scripts/repartir-adelantos-legacy.js [--live] [--desde=YYYY-MM-DD]
 *                                                  [--cliente=<csd>] [--min=50] [--detalle]
 *       (sin `--live` no escribe nada: imprime el reparto que haría)
 *
 * `--desde` acota la ventana A PROPÓSITO, y por defecto es el mes en curso menos dos.
 * El legacy recorre TODAS las facturas del cliente desde la primera, y sin ventana esto
 * se pone a saldar cartera de 2020 con el adelanto de septiembre: son 71 imputaciones a
 * facturas de hace cinco años que nadie ha pedido tocar y que mueven la cartera vieja.
 * El excedente que se reparte y la factura que se cubre tienen que caer los dos dentro
 * de la ventana.
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
// La fila nueva se mapea con el MISMO traductor que usa el sync de ida: así la copia que
// se crea aquí es idéntica, campo a campo, a la que traería la pasada de las 15 minutos.
const { mapTx } = require('./lib/vestel-map');

const arg = (n) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split('=')[1] : undefined;
};
const LIVE = process.argv.includes('--live');
const SOLO_CLIENTE = arg('cliente') ? Number(arg('cliente')) : null;
/** Ventana: sólo se mira el excedente y la deuda de facturas desde esta fecha. */
const DESDE = arg('desde') || (() => {
  const d = new Date(); d.setUTCMonth(d.getUTCMonth() - 2, 1);
  return d.toISOString().slice(0, 10);
})();
/** Por debajo de esto no se reparte: calderilla (mismo mínimo que el legacy y `anticipos.ts`). */
const MINIMO = Number(arg('min') || 50);

/** Las que `procesar_pagos_adelantados` se salta: no entran ni como excedente ni como deuda. */
const TIPOS_SALTADOS = new Set(['Fija', 'Nota Credito', 'Nota Debito']);

/** Tolerancia del legacy: `pamnt`/`total` son int(16), menos de un peso es truncación. */
const mismoDinero = (a, b) => Math.abs(Number(a) - Number(b)) < 1;

const MYSQL = {
  host: process.env.LEGACY_DB_HOST, port: Number(process.env.LEGACY_DB_PORT || 3306),
  user: process.env.LEGACY_DB_USER, password: process.env.LEGACY_DB_PASSWORD,
  database: process.env.LEGACY_DB_NAME, dateStrings: true,
};

const num = (v) => Number(v ?? 0);
const cop = (n) => '$' + Math.round(n).toLocaleString('es-CO');

/**
 * El reparto, sin BD: qué excedente cubre qué factura y por cuánto.
 * Los dos lados van del más viejo al más nuevo, igual que el legacy.
 */
function repartir(facturas) {
  const excedentes = [], faltantes = [];
  for (const f of facturas) {
    if (TIPOS_SALTADOS.has(f.tipo_factura)) continue;
    if (num(f.pamnt) < 0 || num(f.total) < 0) return null; // el legacy corta aquí
    const pamnt = num(f.pamnt), total = num(f.total);
    if (pamnt > total) excedentes.push({ f, queda: pamnt - total });
    else if (pamnt < total) faltantes.push({ f, saldo: total - pamnt });
  }
  const reparto = [];
  for (const e of excedentes) {
    for (const d of faltantes) {
      if (e.queda < MINIMO) break;
      if (d.saldo <= 0) continue;
      if (d.f.tid === e.f.tid) continue;
      const monto = Math.min(e.queda, d.saldo);
      if (monto < MINIMO) continue;
      reparto.push({ origen: e.f, destino: d.f, monto });
      e.queda -= monto; d.saldo -= monto;
    }
  }
  return reparto;
}

/** Los movimientos del legacy que respaldan el cobro de una factura, del mayor al menor. */
async function movimientosDe(my, tid) {
  const [rows] = await my.query(
    `SELECT * FROM transactions
      WHERE tid = ? AND (estado IS NULL OR estado = '') AND cat <> 'Purchase' AND credit > 0
      ORDER BY credit DESC, id ASC`, [tid]);
  return rows;
}

/** Nota de la copia: el nº de factura pasa a ser el de la destino y queda la traza al padre. */
function notaHija(nota, tidOrigen, tidDestino, idPadre) {
  const base = String(nota ?? '').replace(new RegExp(String(tidOrigen), 'g'), String(tidDestino));
  return `${base} #adelantado_de_tr_id=${idPadre}`.slice(0, 255);
}
function notaPadre(nota, creditOriginal) {
  const s = String(nota ?? '');
  if (s.toLowerCase().includes('credito_inicial')) return s;
  return `${s} #credito_inicial=${creditOriginal}`.slice(0, 255);
}

/** Lo que el cliente tiene abonado en el libro del legacy (mismo criterio que `money_details`). */
async function dineroDelCliente(my, csd) {
  const [[t]] = await my.query(
    `SELECT COALESCE(SUM(credit), 0) AS credito FROM transactions
      WHERE payerid = ? AND (estado IS NULL OR estado = '') AND ext = '0'`, [csd]);
  return { legacy: num(t.credito) };
}

async function main() {
  const my = await mysql.createConnection(MYSQL);
  const resumen = { clientes: 0, imputaciones: 0, total: 0, facturasSaldadas: 0, saltados: [] };
  const detalle = [];

  // Clientes con excedente vivo. `status <> 'canceled'`: una anulada no presta plata.
  const [candidatos] = await my.query(
    `SELECT DISTINCT csd FROM invoices
      WHERE pamnt > total + ? AND status <> 'canceled' AND invoicedate >= ?
      ${SOLO_CLIENTE ? 'AND csd = ' + SOLO_CLIENTE : ''}
      ORDER BY csd`, [MINIMO, DESDE]);

  for (const { csd } of candidatos) {
    const [facturas] = await my.query(
      `SELECT * FROM invoices WHERE csd = ? AND status <> 'canceled' AND invoicedate >= ?
        ORDER BY invoicedate ASC, tid ASC`, [csd, DESDE]);
    const reparto = repartir(facturas);
    if (reparto === null) { resumen.saltados.push({ csd, motivo: 'factura en negativo' }); continue; }
    if (!reparto.length) continue;

    // Las dos caras de cada factura tocada. Sin la fila de nexus no se toca nada: dejar
    // los sistemas desalineados es peor que dejar el adelanto sin repartir un día más.
    const idsLegacy = [...new Set(reparto.flatMap((r) => [r.origen.id, r.destino.id]))];
    const enPg = await prisma.subInvoice.findMany({
      where: { legacyId: { in: idsLegacy } },
      select: { id: true, legacyId: true, tid: true, total: true, paidAmount: true, editedAt: true },
    });
    const pgPorLegacy = new Map(enPg.map((r) => [r.legacyId, r]));
    const faltan = idsLegacy.filter((id) => !pgPorLegacy.has(id));
    if (faltan.length) { resumen.saltados.push({ csd, motivo: `sin par en nexus: ${faltan.join(',')}` }); continue; }
    const editadas = enPg.filter((r) => r.editedAt).map((r) => r.tid);
    if (editadas.length) { resumen.saltados.push({ csd, motivo: `factura editada aquí (#${editadas.join(',#')})` }); continue; }

    const lineas = [];
    for (const r of reparto) {
      lineas.push({
        csd, origen: r.origen.tid, destino: r.destino.tid, monto: r.monto,
        fechaOrigen: r.origen.invoicedate, fechaDestino: r.destino.invoicedate,
      });
    }
    detalle.push(...lineas);
    resumen.clientes++;
    resumen.imputaciones += reparto.length;
    resumen.total += reparto.reduce((s, r) => s + r.monto, 0);

    if (!LIVE) continue;

    // ── Escritura: legacy y nexus a la vez ──────────────────────────────────────
    // Foto del dinero ANTES. Esto no crea ni destruye plata: sólo la re-etiqueta de una
    // factura a otra. Si al terminar la suma no es la misma, algo se duplicó y se revierte.
    const platoAntes = await dineroDelCliente(my, csd);
    await my.beginTransaction();
    const nuevasEnPg = []; // filas a crear aquí, con el legacyId que asigne MySQL
    const ajustes = new Map(); // legacyId de transacción → credit nuevo
    const facturasPg = new Map(); // legacyId de factura → { paidAmount, status }
    try {
      for (const r of reparto) {
        const pgOrigen = pgPorLegacy.get(r.origen.id), pgDestino = pgPorLegacy.get(r.destino.id);

        // 1) Las dos facturas del legacy.
        const [[oNow]] = await my.query('SELECT pamnt, total FROM invoices WHERE id = ?', [r.origen.id]);
        const [[dNow]] = await my.query('SELECT pamnt, total FROM invoices WHERE id = ?', [r.destino.id]);
        const oPamnt = num(oNow.pamnt) - r.monto;
        const dPamnt = num(dNow.pamnt) + r.monto;
        const dStatus = dPamnt >= num(dNow.total) ? 'paid' : 'partial';
        await my.execute('UPDATE invoices SET pamnt = ? WHERE id = ?', [oPamnt, r.origen.id]);
        await my.execute('UPDATE invoices SET pamnt = ?, status = ?, pmethod = ? WHERE id = ?',
          [dPamnt, dStatus, 'Cash', r.destino.id]);

        // 2) La transacción del cobro, partida (el legacy hace exactamente esto).
        let porRepartir = r.monto;
        for (const tr of await movimientosDe(my, r.origen.tid)) {
          if (porRepartir <= 0) break;
          const disponible = Math.min(num(tr.credit), porRepartir);
          if (disponible <= 0) continue;
          // El movimiento que se parte tiene que existir en los DOS lados. Si aquí no
          // está, bajarle el crédito allá no resta nada acá y la copia que se crea sí
          // suma: el cliente se quedaría con un abono de más en nexus. Prefiero dejar
          // el adelanto sin repartir a inflarle la plata a alguien.
          const enNexus = await prisma.transaction.findUnique({
            where: { legacyId: tr.id }, select: { id: true, credit: true },
          });
          if (!enNexus) throw new Error(`el movimiento ${tr.id} de la factura #${r.origen.tid} no está en nexus`);
          if (!mismoDinero(enNexus.credit, tr.credit)) {
            throw new Error(`movimiento ${tr.id}: legacy ${cop(tr.credit)} ≠ nexus ${cop(enNexus.credit)}`);
          }
          await my.execute('UPDATE transactions SET credit = ?, note = ? WHERE id = ?',
            [num(tr.credit) - disponible, notaPadre(tr.note, num(tr.credit)), tr.id]);
          const notaDeLaHija = notaHija(tr.note, r.origen.tid, r.destino.tid, tr.id);
          const [ins] = await my.execute(
            `INSERT INTO transactions (acid, account, type, cat, debit, credit, payer, payerid, method, date,
                                       tid, eid, note, ext, nombre_banco, id_banco, estado, no_mostrar, id_orden_payu)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [tr.acid, tr.account, tr.type, tr.cat, tr.debit, disponible, tr.payer, tr.payerid, tr.method, tr.date,
              r.destino.tid, tr.eid, notaDeLaHija, tr.ext,
              tr.nombre_banco, tr.id_banco, tr.estado, tr.no_mostrar, tr.id_orden_payu]);
          ajustes.set(tr.id, { credit: num(tr.credit) - disponible, note: notaPadre(tr.note, num(tr.credit)) });
          nuevasEnPg.push({ legacyId: ins.insertId, padreLegacyId: tr.id, invoicePgId: pgDestino.id });
          porRepartir -= disponible;
        }
        if (porRepartir > 0) throw new Error(`cliente ${csd}: la factura #${r.origen.tid} no tiene movimientos que respalden ${cop(r.monto)}`);

        // 3) Lo mismo en nexus, con la tolerancia de céntimos del legacy.
        const oPg = facturasPg.get(r.origen.id)?.paidAmount ?? num(pgOrigen.paidAmount);
        const dPg = facturasPg.get(r.destino.id)?.paidAmount ?? num(pgDestino.paidAmount);
        const dNuevo = dPg + r.monto;
        facturasPg.set(r.origen.id, { paidAmount: oPg - r.monto, status: 'PAID' });
        facturasPg.set(r.destino.id, {
          paidAmount: dNuevo,
          status: (mismoDinero(dNuevo, num(pgDestino.total)) || dNuevo >= num(pgDestino.total)) ? 'PAID' : 'PARTIAL',
        });
      }

      await prisma.$transaction(async (tx) => {
        for (const [legacyId, data] of facturasPg) {
          const pg = pgPorLegacy.get(legacyId);
          // La origen sigue saldada: se le quita el excedente, no el pago de su propio mes.
          const status = data.status === 'PAID' && data.paidAmount < num(pg.total) && !mismoDinero(data.paidAmount, num(pg.total))
            ? (data.paidAmount > 0 ? 'PARTIAL' : 'DUE') : data.status;
          await tx.subInvoice.update({ where: { legacyId }, data: { paidAmount: data.paidAmount, status } });
        }
        for (const [legacyId, data] of ajustes) {
          await tx.transaction.updateMany({ where: { legacyId }, data });
        }
        for (const n of nuevasEnPg) {
          const [[fila]] = await my.query('SELECT * FROM transactions WHERE id = ?', [n.legacyId]);
          const padre = await tx.transaction.findUnique({
            where: { legacyId: n.padreLegacyId }, select: { subscriberId: true },
          });
          await tx.transaction.create({ data: mapTx(fila, padre?.subscriberId, n.invoicePgId, null) });
        }
        // Invariante: la misma plata, sólo repartida. Y las dos caras de cada factura
        // tienen que quedar diciendo lo mismo, que es lo único que evita el ping-pong
        // con el sync de las 15 minutos.
        const platoDespues = await dineroDelCliente(my, csd);
        if (!mismoDinero(platoAntes.legacy, platoDespues.legacy)) {
          throw new Error(`el legacy pasó de ${cop(platoAntes.legacy)} a ${cop(platoDespues.legacy)}`);
        }
        for (const [legacyId, data] of facturasPg) {
          const [[f]] = await my.query('SELECT tid, pamnt FROM invoices WHERE id = ?', [legacyId]);
          if (!mismoDinero(f.pamnt, data.paidAmount)) {
            throw new Error(`factura #${f.tid}: legacy ${cop(f.pamnt)} ≠ nexus ${cop(data.paidAmount)}`);
          }
        }
        await my.commit();
      });
      resumen.facturasSaldadas += new Set(reparto.map((r) => r.destino.tid)).size;
    } catch (e) {
      await my.rollback().catch(() => {});
      resumen.saltados.push({ csd, motivo: `error: ${e.message}` });
      console.error(`⚠️ cliente ${csd}: ${e.message}`);
    }
  }

  // ── Informe ────────────────────────────────────────────────────────────────
  console.log(`\n${LIVE ? 'APLICADO' : 'EN SECO (no se escribió nada)'} — reparto de pagos adelantados del legacy`);
  console.log(`  ventana: facturas desde ${DESDE} · mínimo ${cop(MINIMO)}\n`);
  const porMes = new Map();
  for (const l of detalle) {
    const k = String(l.fechaDestino).slice(0, 7);
    const v = porMes.get(k) ?? { n: 0, monto: 0 };
    v.n++; v.monto += l.monto; porMes.set(k, v);
  }
  for (const [mes, v] of [...porMes].sort()) console.log(`  factura de ${mes}: ${v.n} imputaciones · ${cop(v.monto)}`);
  console.log(`\n  clientes: ${resumen.clientes} · imputaciones: ${resumen.imputaciones} · total: ${cop(resumen.total)}`);
  if (resumen.saltados.length) {
    console.log(`\n  saltados (${resumen.saltados.length}):`);
    for (const s of resumen.saltados.slice(0, 25)) console.log(`    · cliente ${s.csd}: ${s.motivo}`);
  }
  if (process.argv.includes('--detalle')) {
    console.log('\n  detalle:');
    for (const l of detalle) console.log(`    cliente ${l.csd}: #${l.origen} (${l.fechaOrigen}) → #${l.destino} (${l.fechaDestino})  ${cop(l.monto)}`);
  }

  await my.end();
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
