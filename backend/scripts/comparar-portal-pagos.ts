/**
 * ¿Diría este sistema lo MISMO que el legacy si el portal le preguntara a él?
 *
 * Es el arnés del cambio de interlocutor del portal de pagos en línea. El portal le
 * cobra al cliente `due.total - due.pamnt` tal como se lo conteste el web service, así
 * que antes de apuntarlo aquí hay que saber, cliente por cliente, en cuánto difieren
 * las dos respuestas y POR QUÉ. Un céntimo de diferencia es un cliente que paga de más
 * o una factura que queda abierta.
 *
 * Compara tres cifras por abonado:
 *   legacy      SUM(total) - SUM(pamnt) sobre TODAS sus facturas (`due_details`)
 *   nexus bruto  saldo de las facturas DUE/PARTIAL (`subscriberDebt.totalDebt`)
 *   nexus neto   lo anterior menos las promociones vigentes hoy (`totalConDescuento`)
 *
 * La diferencia entre las dos primeras es DERIVA y hay que mirarla. La diferencia entre
 * las dos últimas es el DESCUENTO, y es justo lo que se viene a ganar con el cambio.
 *
 * No escribe nada, ni aquí ni allá: lee las dos bases y compara.
 *
 *   npx ts-node --transpile-only scripts/comparar-portal-pagos.ts            # 300 del portal
 *   npx ts-node --transpile-only scripts/comparar-portal-pagos.ts --n=1000
 *   npx ts-node --transpile-only scripts/comparar-portal-pagos.ts --todos    # todo el que deba
 *   npx ts-node --transpile-only scripts/comparar-portal-pagos.ts --cid=22018
 */
import 'reflect-metadata';
import mysql from 'mysql2/promise';
import { prismaService, portalPagosService } from '../src/core/contenedor';
import { cobranzasService } from '../src/core/contenedor';

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1];
const TIENE = (k: string) => process.argv.includes(`--${k}`);

const N = Number(arg('n') || 300);
const SOLO = arg('cid') ? Number(arg('cid')) : null;

const money = (n: number) => `$${Math.round(n).toLocaleString('es-CO')}`;

async function main() {
  const legacy = await mysql.createConnection({
    host: process.env.LEGACY_DB_HOST || '127.0.0.1',
    port: Number(process.env.LEGACY_DB_PORT || 3306),
    user: process.env.LEGACY_DB_USER,
    password: process.env.LEGACY_DB_PASSWORD,
    database: process.env.LEGACY_DB_NAME || 'admin_vestel',
    dateStrings: true,
  });

  // ── A quién se mira ────────────────────────────────────────────────────────
  let cids: number[];
  if (SOLO) {
    cids = [SOLO];
  } else if (TIENE('todos')) {
    const [filas] = await legacy.query<any[]>(
      'SELECT csd FROM invoices GROUP BY csd HAVING SUM(total) - SUM(pamnt) > 0',
    );
    cids = filas.map((f) => Number(f.csd));
  } else {
    // Los que de verdad usan el portal: quienes abrieron una orden de pago hace poco.
    const portal = await mysql.createConnection({
      host: process.env.PORTAL_DB_HOST || process.env.LEGACY_DB_HOST || '127.0.0.1',
      port: Number(process.env.PORTAL_DB_PORT || process.env.LEGACY_DB_PORT || 3306),
      user: process.env.PORTAL_DB_USER || process.env.LEGACY_DB_USER,
      password: process.env.PORTAL_DB_PASSWORD || process.env.LEGACY_DB_PASSWORD,
      database: process.env.PORTAL_DB_NAME || 'crm_vestel',
      dateStrings: true,
    });
    const [filas] = await portal.query<any[]>(
      'SELECT DISTINCT cid_user FROM wompi_data_orden ORDER BY id DESC LIMIT ?', [N],
    );
    await portal.end();
    cids = filas.map((f) => Number(f.cid_user)).filter(Boolean);
  }

  console.log(`Comparando ${cids.length} abonado(s)…\n`);

  let iguales = 0;
  const soloDescuento: any[] = [];
  const deriva: any[] = [];
  const sinFicha: number[] = [];

  for (const cid of cids) {
    // ── Lo que diría el legacy ───────────────────────────────────────────────
    const [[due]] = await legacy.query<any[]>(
      'SELECT COALESCE(SUM(total),0) AS total, COALESCE(SUM(pamnt),0) AS pamnt FROM invoices WHERE csd = ?',
      [cid],
    );
    const enLegacy = Math.round(Number(due?.total ?? 0) - Number(due?.pamnt ?? 0));

    // ── Lo que diría este sistema ────────────────────────────────────────────
    const sub = await prismaService.subscriber.findFirst({
      where: { legacyId: cid }, select: { id: true, abonado: true },
    });
    if (!sub) { sinFicha.push(cid); continue; }

    const d = await cobranzasService.subscriberDebt(sub.id);
    const bruto = Math.round(d.totalDebt);
    const neto = Math.round(d.totalConDescuento);

    if (bruto === enLegacy && neto === enLegacy) { iguales++; continue; }
    const fila = {
      cid, abonado: sub.abonado, legacy: enLegacy, bruto, neto,
      descuento: Math.round(d.descuentoTotal),
      promo: d.invoices.find((i: any) => i.promocion)?.promocion ?? null,
    };
    // Si el bruto casa con el legacy, la única diferencia es la promoción: eso no es
    // deriva, es el objetivo del cambio.
    if (bruto === enLegacy) soloDescuento.push(fila); else deriva.push(fila);
  }

  await legacy.end();

  // ── Informe ────────────────────────────────────────────────────────────────
  console.log(`IDÉNTICOS ................ ${iguales}`);
  console.log(`SÓLO CAMBIA EL DESCUENTO . ${soloDescuento.length}`);
  console.log(`DERIVA (hay que mirarla) . ${deriva.length}`);
  if (sinFicha.length) console.log(`SIN FICHA AQUÍ ........... ${sinFicha.length} (${sinFicha.slice(0, 10).join(', ')}…)`);

  if (soloDescuento.length) {
    const total = soloDescuento.reduce((s, f) => s + f.descuento, 0);
    console.log(`\n— Descuento que el portal empezaría a aplicar: ${money(total)} —`);
    for (const f of soloDescuento.slice(0, 15)) {
      console.log(`  abonado ${f.abonado} · ${money(f.legacy)} -> ${money(f.neto)} (-${money(f.descuento)}) · ${f.promo ?? ''}`);
    }
    if (soloDescuento.length > 15) console.log(`  … y ${soloDescuento.length - 15} más`);
  }

  if (deriva.length) {
    console.log(`\n— DERIVA: aquí y allá no dicen lo mismo —`);
    for (const f of deriva.slice(0, 40)) {
      const dif = f.bruto - f.legacy;
      console.log(
        `  abonado ${f.abonado} (cid ${f.cid}) · legacy ${money(f.legacy)} · aquí ${money(f.bruto)}`
        + ` · ${dif > 0 ? '+' : ''}${money(dif)}`,
      );
    }
    if (deriva.length > 40) console.log(`  … y ${deriva.length - 40} más`);
    const suma = deriva.reduce((s, f) => s + (f.bruto - f.legacy), 0);
    console.log(`  Suma de la deriva: ${money(suma)}`);
  }

  // Silencia el aviso de variable sin usar cuando el servicio no se llama directamente.
  void portalPagosService;
  await prismaService.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
