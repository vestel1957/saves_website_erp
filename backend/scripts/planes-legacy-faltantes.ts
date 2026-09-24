/**
 * Los PLANES que el legacy sigue nombrando y que este catálogo no tiene.
 *
 * El catálogo `Plan` de aquí NO se importó de `products` del legacy: se dedujo de los
 * renglones de las facturas de los abonados ACTIVOS (`seed-plans-from-services.js`), así
 * que un plan sólo nació si algún activo lo tenía cobrado en su última factura. Los que
 * para entonces sólo le quedaban a abonados SIN fila en `SubscriberService` —los del plan
 * derivado— se quedaron fuera.
 *
 * Y el hueco cobra: `plan-facturable.ts` cruza los ítems de la factura contra `Plan` POR
 * NOMBRE para saber de qué tipo es cada renglón. Un nombre que no está en el catálogo es
 * un renglón invisible: la corrida del 01-09-2026 le facturó al abonado 56097 sólo la TV
 * ($25.000 de $73.000) porque su internet se llamaba `50MegasF24` y aquí no existía.
 *
 * Qué hace: lee la CABECERA de las facturas recurrentes de aquí (`serviceCombo` = internet,
 * `serviceTv` = TV) y se queda con los nombres que no están en `Plan`. La cabecera es la
 * definición de "plan" del propio legacy —su corrida mensual tarifa lo que diga esa
 * columna, no los renglones—, y de paso dice el TIPO sin tener que adivinarlo.
 *
 * NO sirve mirar los renglones: ahí caen los cobros recurrentes que no son mensualidad
 * (Repetidor Wifi, Ipv4 Publica, Equipo TDT), y en el legacy son `products` pcat 4
 * 'Recurrente' igual que los planes, así que su catálogo tampoco los distingue. Crearlos
 * como `Plan` haría que `plan-facturable` los tomara por el internet del abonado.
 *
 * El precio sale de `products` del legacy. El nombre que no esté ahí se REPORTA y no se
 * crea: inventarle tarifa a un plan es cobrarle de más o de menos a alguien.
 *
 * Los crea OCULTOS (`active=false`): no se ofrecen en venta —son planes viejos— pero el
 * cruce por nombre ya resuelve. No siembra `SubscriberService`: al abonado sin filas su
 * plan le sale derivado de lo que DE VERDAD paga, y sembrarle la tarifa de catálogo le
 * cambiaría la mensualidad (la dry-run del 14-09 iba a crear 919 filas así).
 *
 * `pppProfile` se deja en NULL a propósito. Es el respaldo que usa `buscarPerfilDe` cuando
 * el de la ficha no resuelve, y el nombre del perfil no se puede deducir del nombre del
 * plan: en este mismo catálogo '150 Megas F-26' va por `150Megas` y '300 Megas C-26' por
 * `300Megas26F`. Inventarlo crearía el secret a la velocidad equivocada, que es justo
 * contra lo que avisa ese comentario. Se llenan a mano en /configuracion/planes.
 *
 *   npx ts-node --transpile-only scripts/planes-legacy-faltantes.ts              → simulación
 *   npx ts-node --transpile-only scripts/planes-legacy-faltantes.ts --commit     → crea
 *   ... --desde=2026-01-01   ventana de facturas que se mira (por defecto 6 meses atrás)
 */
import * as fs from 'fs';
import * as path from 'path';

for (const linea of (() => { try { return fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split('\n'); } catch { return []; } })()) {
  const m = linea.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
}

import * as mysql from 'mysql2/promise';
import { PrismaService } from '../src/prisma/prisma.service';

const arg = (n: string, d: string) =>
  (process.argv.find((a) => a.startsWith(`--${n}=`)) || `--${n}=${d}`).split('=')[1];
const COMMIT = process.argv.includes('--commit');
const seisMesesAtras = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 6, 1)).toISOString().slice(0, 10);
};
const DESDE = arg('desde', seisMesesAtras());

type Kind = 'INTERNET' | 'TV';
const clave = (s: unknown) => String(s ?? '').trim().toLowerCase();
const money = (n: number) => '$' + Number(n || 0).toLocaleString('es-CO');

/** Nombre visto en una cabecera: en qué columna salió y a cuántos abonados les toca. */
interface Visto { nombre: string; kind: Kind; abonados: Set<string> }

async function main() {
  const prisma = new PrismaService();
  const my = await mysql.createConnection({
    host: process.env.LEGACY_DB_HOST, port: Number(process.env.LEGACY_DB_PORT || 3306),
    user: process.env.LEGACY_DB_USER, password: process.env.LEGACY_DB_PASSWORD,
    database: process.env.LEGACY_DB_NAME, dateStrings: true,
  });
  console.log(`\n=== Planes del legacy que faltan en el catálogo · cabeceras desde ${DESDE} · ${COMMIT ? 'COMMIT' : 'SIMULACIÓN'} ===\n`);

  const vistos = new Map<string, Visto>();
  const ver = (nombre: string | null, kind: Kind, subId: string) => {
    const k = clave(nombre);
    // Vacío y '-' = "esta factura no lo dice" (las de ventanilla salen así); 'no' = el
    // abonado no tiene ese servicio; 'SoloTelevision…' es como el legacy escribe lo mismo.
    if (!k || k === 'no' || k === '-' || k.startsWith('solotelevision')) return;
    const v = vistos.get(k) ?? { nombre: String(nombre).trim(), kind, abonados: new Set<string>() };
    v.abonados.add(subId);
    vistos.set(k, v);
  };

  // TODAS las recurrentes de la ventana, no sólo la última de cada abonado: la cabecera de
  // septiembre salió VACÍA justo en los abonados a los que la corrida no les cobró el
  // internet, y su plan sólo se ve en la de agosto.
  const cabeceras = await prisma.$queryRaw<{ subscriberId: string; combo: string | null; tv: string | null }[]>`
    SELECT DISTINCT i."subscriberId", i."serviceCombo" AS combo, i."serviceTv" AS tv
      FROM "SubInvoice" i JOIN "Subscriber" s ON s.id = i."subscriberId"
     WHERE i.kind = 'RECURRENTE' AND i.status <> 'CANCELED' AND s.status <> 'RETIRADO'
       AND i."invoiceDate" >= ${new Date(DESDE)}`;
  for (const c of cabeceras) {
    ver(c.combo, 'INTERNET', c.subscriberId);
    ver(c.tv, 'TV', c.subscriberId);
  }

  // Fuera los que el catálogo ya tiene.
  const yaEstan = new Set((await prisma.plan.findMany({ select: { name: true } })).map((p) => clave(p.name)));
  const faltan = Array.from(vistos.entries()).filter(([k]) => !yaEstan.has(k));
  console.log(`Nombres vistos en facturas: ${vistos.size} · ya en el catálogo: ${vistos.size - faltan.length} · sin catálogo: ${faltan.length}\n`);

  // El legacy manda sobre qué es un plan y a qué precio. `pcat=4` recurrente es su catálogo
  // de mensualidades; lo que no esté ahí (Reconexión, Saldo anterior, basura) no se crea.
  const [prods] = await my.query<mysql.RowDataPacket[]>(
    `SELECT product_name, MAX(product_price) AS precio, MAX(taxrate) AS iva,
            MAX(NULLIF(pertence_a_tv_o_net,'')) AS tipo
       FROM products WHERE pcat = 4 AND tipo_servicio = 'Recurrente' GROUP BY product_name`);
  const catalogoLegacy = new Map(prods.map((p) => [clave(p.product_name), p]));

  const aCrear: { name: string; kind: Kind; price: number; taxRate: number; megas: number | null; abonados: number }[] = [];
  const descartados: { nombre: string; motivo: string; abonados: number }[] = [];

  for (const [k, v] of faltan) {
    const prod = catalogoLegacy.get(k);
    if (!prod) { descartados.push({ nombre: v.nombre, motivo: 'el legacy no le pone precio (no está en products) — crear a mano', abonados: v.abonados.size }); continue; }
    const precio = Number(prod.precio || 0);
    if (!(precio > 0)) { descartados.push({ nombre: v.nombre, motivo: 'el legacy lo tiene en $0 — crear a mano', abonados: v.abonados.size }); continue; }

    // El IVA no se inventa: un plan de TV a 0% cobraría de menos y lo reportaría mal a la DIAN.
    const iva = Number(prod.iva || 0);
    if (v.kind === 'TV' && !(iva > 0)) { descartados.push({ nombre: v.nombre, motivo: 'plan de TV sin IVA en el legacy — revisar a mano', abonados: v.abonados.size }); continue; }

    const megas = v.kind === 'INTERNET' ? Number(String(v.nombre).match(/(\d+)\s*megas/i)?.[1] ?? NaN) : NaN;
    aCrear.push({ name: v.nombre, kind: v.kind, price: precio, taxRate: iva, megas: Number.isNaN(megas) ? null : megas, abonados: v.abonados.size });
  }

  aCrear.sort((a, b) => b.abonados - a.abonados || a.name.localeCompare(b.name));
  console.log(`--- A crear (${aCrear.length}) · ocultos, sin pppProfile ---`);
  for (const p of aCrear) {
    console.log(`  ${p.name.padEnd(22)} ${p.kind.padEnd(8)} ${money(p.price).padStart(10)}  IVA ${String(p.taxRate).padStart(2)}%  ${String(p.megas ?? '-').padStart(4)} Mb  ${p.abonados} abonado(s)`);
  }
  if (descartados.length) {
    console.log(`\n--- Descartados (${descartados.length}) ---`);
    for (const d of descartados.sort((a, b) => b.abonados - a.abonados)) {
      console.log(`  ${d.nombre.padEnd(40)} ${String(d.abonados).padStart(4)} abonado(s)  · ${d.motivo}`);
    }
  }

  if (!COMMIT) {
    console.log('\n(simulación: nada escrito — repetir con --commit)\n');
  } else {
    let n = 0;
    for (const p of aCrear) {
      // Idempotente: si alguien ya lo creó a mano entre la simulación y esto, no se duplica
      // (un nombre repetido en `Plan` casa dos veces en el cruce por nombre y cobra doble).
      const existe = await prisma.plan.findFirst({ where: { name: { equals: p.name, mode: 'insensitive' } } });
      if (existe) { console.log(`  = ${p.name} ya existía, se salta`); continue; }
      await prisma.plan.create({
        data: { name: p.name, kind: p.kind, price: p.price, taxRate: p.taxRate, megas: p.megas, pppProfile: null, active: false },
      });
      n++;
    }
    console.log(`\nPlanes creados: ${n}\n`);
  }

  await my.end();
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
