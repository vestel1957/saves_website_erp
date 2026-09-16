/**
 * Retira del LEGACY el descuento de pronto pago que quedó puesto en facturas sin pagar
 * después de que la promoción venciera.
 *
 *   npx ts-node -T scripts/retirar-pronto-pago-vencido.ts [--si] [--desde=YYYY-MM-DD]
 *
 * POR QUÉ EXISTE (2026-09-08). El portal de pagos del legacy escribe el descuento en la
 * CABECERA de la factura en cuanto el cliente pulsa el botón (`Customers_model::
 * aplicar_discuount_pago_oportuno`: `total = total - descuento`) y **nadie vuelve a
 * mirar la fecha**. La promo "5% Pronto pago" corría del 1 al 5 de septiembre; el día 8
 * seguía habiendo 11 facturas con el 5 % puesto y sin pagar, y 4 ya se habían pagado
 * rebajadas el día 7 (18.425 COP). El parche que lo arregla en el PHP
 * (`revertir_descuentos_vencidos`, en /home/dev/parche-pronto-pago-legacy/) está
 * escrito desde el 2026-08-10 pero no se ha podido desplegar: el vhost de Plesk no es
 * legible por `dev` y no hay sudo. Esto limpia lo que ya quedó puesto.
 *
 * QUÉ HACE: devuelve la factura a su total sin descuento (`total += discount`,
 * `discount = 0`, `notes = ''`). NO toca `promo_sistema_clientes1`: esa marca es la que
 * impide que el portal vuelva a conceder sobre la MISMA factura, y quitarla sería
 * invitar a pedirlo otra vez. La factura de octubre nace sin marca, así que no estorba
 * a la promoción del mes que viene.
 *
 * QUÉ NO TOCA:
 *  - facturas con algún pago (`pamnt > 0` o con fila en `transactions`): ahí el cliente
 *    ya pagó contra el total rebajado y quitarle el descuento le abre una deuda que no
 *    entiende. Lo pagado de más se decide aparte, no en un barrido;
 *  - descuentos que NO son de pronto pago ("Descuento 50% Retención", "20% cartera"…):
 *    son campañas del legacy y las pone una persona;
 *  - nada, si hoy hay una promoción vigente en `promos` con porcentaje > 0. Entonces el
 *    descuento de cabecera puede ser legítimo y el barrido se planta en vez de adivinar.
 *
 * El sync de ida trae solo el total corregido a nexus en la siguiente pasada (copia
 * `subtotal/discount/total/pamnt` en cada vuelta). Sin `--si` sólo enseña lo que haría.
 */
import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';

for (const linea of readFileSync('.env', 'utf8').split('\n')) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(linea.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
}

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1];
const pesos = (n: number) => n.toLocaleString('es-CO');

/** Sólo las notas que escribe el portal al conceder pronto pago: "Descuento N % ". */
const NOTA_PRONTO_PAGO = /^Descuento\s+(\d+)\s*%\s*$/;

async function main() {
  const enSerio = process.argv.includes('--si');
  const my = await mysql.createConnection({
    host: process.env.LEGACY_DB_HOST || '127.0.0.1',
    port: Number(process.env.LEGACY_DB_PORT || 3306),
    user: process.env.LEGACY_DB_USER,
    password: process.env.LEGACY_DB_PASSWORD,
    database: process.env.LEGACY_DB_NAME || 'admin_vestel',
    dateStrings: true,
  });

  // "Hoy" lo dice el MySQL del legacy, no este proceso: el servidor corre en horario
  // europeo y el PHP compara contra su propio date("Y-m-d"). Ver `pushPromosPortal`.
  const [[{ hoy }]] = (await my.query('SELECT CAST(CURDATE() AS CHAR) AS hoy')) as any;
  const desde = arg('desde') ?? `${hoy.slice(0, 7)}-01`;

  // Salvaguarda: si hay una promoción viva con porcentaje, un descuento de cabecera
  // puede ser de ella y no de una vencida. No se adivina.
  const [vivas] = (await my.execute(
    'SELECT idprom, pro_nombre, porcentaje, f_inicio, f_final FROM promos'
    + ' WHERE f_inicio<=? AND f_final>=? AND porcentaje>0 AND id_estado_clientes<>0',
    [hoy, hoy],
  )) as any;
  if (vivas.length) {
    console.log(`⛔ Hay ${vivas.length} promoción(es) vigentes hoy (${hoy}) con porcentaje > 0:`);
    for (const p of vivas) console.log(`   #${p.idprom} «${p.pro_nombre}» ${p.porcentaje}% · ${p.f_inicio}→${p.f_final}`);
    console.log('   Un descuento de cabecera puede venir de ahí. Acota a mano con --desde= o espera a que venza.');
    await my.end();
    process.exit(1);
  }

  const [filas] = (await my.execute(
    'SELECT i.tid, i.id, i.csd, i.invoicedate, i.discount, i.total, i.pamnt, i.status, i.notes,'
    + ' c.name AS cliente'
    + ' FROM invoices i LEFT JOIN customers c ON c.id = i.csd'
    + ' WHERE i.discount > 0 AND i.promo_sistema_clientes1 = 1 AND i.invoicedate >= ?'
    + '   AND i.pamnt = 0'
    + '   AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.tid = i.tid)'
    + ' ORDER BY i.tid',
    [desde],
  )) as any;

  const candidatas = filas.filter((f: any) => NOTA_PRONTO_PAGO.test(String(f.notes ?? '')));
  const descartadas = filas.filter((f: any) => !NOTA_PRONTO_PAGO.test(String(f.notes ?? '')));

  console.log(`Legacy ${process.env.LEGACY_DB_NAME} · hoy ${hoy} · facturas desde ${desde} · ${enSerio ? 'EN VIVO' : 'SECO (plan)'}`);
  if (descartadas.length) {
    console.log(`\nNo son pronto pago, no se tocan (${descartadas.length}):`);
    for (const f of descartadas) console.log(`   #${f.tid} «${String(f.notes ?? '').trim()}» −${pesos(Number(f.discount))}`);
  }
  if (!candidatas.length) {
    console.log('\nNada que retirar.');
    await my.end();
    return;
  }

  let plata = 0;
  console.log(`\nDescuento vencido y sin pagar (${candidatas.length}):`);
  for (const f of candidatas) {
    const desc = Number(f.discount);
    plata += desc;
    console.log(
      `   ${enSerio ? '~' : 'plan ~'} #${f.tid} abonado ${f.csd} ${String(f.cliente ?? '').trim()}`
      + ` · ${f.invoicedate} · total ${pesos(Number(f.total))} → ${pesos(Number(f.total) + desc)} (retira ${pesos(desc)})`,
    );
    if (!enSerio) continue;
    // Condicionada a que siga igual: entre el plan y la escritura el cliente puede
    // haber pagado por el portal, y entonces esta factura ya no es candidata.
    const [r] = (await my.execute(
      'UPDATE invoices SET total = total + discount, discount = 0, notes = ?'
      + ' WHERE id = ? AND discount = ? AND pamnt = 0',
      ['', f.id, f.discount],
    )) as any;
    if (!r.affectedRows) console.log(`      ⚠️ #${f.tid} cambió mientras tanto — no se tocó`);
  }

  console.log(`\n${enSerio ? 'Retirado' : 'Se retiraría'}: ${pesos(plata)} COP en ${candidatas.length} facturas.`);
  if (!enSerio) console.log('Repite con --si para escribirlo.');
  await my.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
