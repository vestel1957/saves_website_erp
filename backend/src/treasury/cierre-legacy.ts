import { Prisma } from '@prisma/client';
import { proximoDiaHabil } from '../common/festivos';

/**
 * Cierre de caja — réplica del legacy saves-vestel (`Reports.php::sacar_pdf()`, ~511-686).
 *
 * EL MODELO DEL LEGACY (verificado contra la BD de producción, no deducido):
 *
 * 1. **No existe una entidad "cierre".** El cierre se materializa como DOS transacciones
 *    con nota `Saldo <fecha>`: un EXPENSE el día que se cierra (saca el efectivo del
 *    cajón) y un INCOME el PRÓXIMO DÍA HÁBIL (lo vuelve a meter). El arrastre es un
 *    movimiento del libro, no un campo de una tabla.
 *
 * 2. **La base es CERO — se barre el efectivo entero.** `$_SESSION['valor_base_caja']`
 *    se LEE en la línea 621 pero no se ASIGNA en ningún sitio del árbol legacy, así que
 *    `(float)null = 0`. Confirmado en los datos: en cada par, el debit de hoy == el
 *    credit del día hábil siguiente == el efectivo íntegro. No queda fondo fijo.
 *
 * 3. Sólo se escribe si el excedente es > 0, y con guarda anti-duplicado.
 *
 * Consecuencia elegante y autoconsistente: como el INCOME del cierre anterior ES efectivo
 * de hoy, el arrastre entra solo en el cálculo — no hay que sumarlo aparte. Y como el
 * EXPENSE de hoy sale del cajón, recalcular el efectivo DESPUÉS de cerrar da 0: el cajón
 * queda vacío, que es justo lo que pasó en la vida real.
 *
 * Por eso NO hay aquí fondo fijo ni `getCarryover`: sumarlos encima del libro contaría el
 * arrastre dos veces.
 */

/** Los dos capitalizados que conviven en los datos para el efectivo. */
const CASH = ['Cash', 'cash'];

/**
 * `Saldo 2026-07-16` y NADA más.
 *
 * OJO, trampa gorda: NO basta con `note LIKE 'Saldo %'`. Hay 559 gastos reales cuya nota
 * empieza por "Saldo" en el sentido corriente del castellano — "Saldo de aire
 * acondicionado", "Saldo mano de obra reparación camioneta", "Saldo compra de 100
 * postes" — y 13 ingresos igual. No son cierres. Colarlos llenaría la pantalla de
 * cierres falsos y, peor, `getCarryover` podría tomar uno como arrastre.
 *
 * El legacy los distingue por `tid = -1`, que en Nexus es `invoiceId = null` — pero esos
 * gastos también van sin factura, así que no discrimina. Lo que sí discrimina es la nota
 * exacta: el cierre la escribe siempre como 'Saldo ' + fecha ISO.
 */
export const RE_NOTA_SALDO = /^Saldo \d{4}-\d{2}-\d{2}$/;
export const esNotaSaldo = (note: string | null | undefined): boolean =>
  !!note && RE_NOTA_SALDO.test(note);

/** El mismo criterio, para SQL crudo (la regex no se puede expresar en un filtro Prisma). */
export const SQL_NOTA_SALDO = Prisma.sql`note ~ '^Saldo [0-9]{4}-[0-9]{2}-[0-9]{2}$'`;

/** Categoría con la que el legacy marca las dos patas del arrastre (`cat = 'Sales'`). */
export const CATEGORIA_SALDO = 'Sales';

export const isoUTC = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Nota del arrastre. Ojo: AMBAS patas llevan la fecha del CIERRE, no la del día en que
 * cae el ingreso. Es lo que hace el legacy y es lo que permite emparejarlas.
 */
export const notaSaldo = (fechaCierre: Date) => `Saldo ${isoUTC(fechaCierre)}`;

/** El día completo [d, d+1). */
export const rangoDia = (d: Date) => ({ gte: d, lt: new Date(d.getTime() + 86_400_000) });

/**
 * Las filas que cuentan como EFECTIVO del cajón. Réplica de `statements()` (~889-907):
 * `method='Cash'` MÁS `type='Transfer'`, sin anuladas y sin `no_mostrar`.
 *
 * Verificado: esta fórmula reproduce EXACTO el excedente que el legacy escribió, en
 * 40/40 cierres reales de las 4 cajas (diferencia 0,00).
 *
 * El legacy suma las dos condiciones en dos `if` independientes (no `else if`), así que
 * una fila que fuera Cash Y Transfer se contaría dos veces. Ese doble conteo NO se
 * replica: los conjuntos son disjuntos en los datos reales (las 11.526 filas TRANSFER
 * tienen `method=''`, y hay 0 filas Cash+TRANSFER), así que el OR da exactamente lo
 * mismo — y replicar el duplicado sería copiar un bug latente que nunca ha disparado.
 */
export function whereEfectivo(cashAccountId: number, d: Date): Prisma.TransactionWhereInput {
  return {
    cashAccountId,
    date: rangoDia(d),
    status: 'VIGENTE',
    noShow: false,
    OR: [{ method: { in: CASH } }, { type: 'TRANSFER' }],
  };
}

/**
 * Lo que una fila aporta al efectivo del cajón.
 *
 * El legacy hace `intval($row['credit'] - $row['debit'])`: trunca POR FILA, no al final.
 * Con importes en pesos enteros da igual, pero hay filas con centavos y ahí la diferencia
 * es real: el cierre de Villanueva del 2026-04-22 sólo cuadra al céntimo truncando por
 * fila (sumando exacto sobraban $0,81).
 */
export const aporteEfectivo = (t: { credit: Prisma.Decimal | number; debit: Prisma.Decimal | number }) =>
  Math.trunc(Number(t.credit) - Number(t.debit));

/**
 * Excluye la pata EXPENSE del cierre de ESE mismo día, para poder ver el efectivo que
 * había ANTES de barrerlo. Sin esto, consultar un día ya cerrado devuelve 0: correcto
 * (el cajón quedó vacío) pero inútil para mostrar el arqueo.
 */
export const sinElBarridoDelDia = (d: Date): Prisma.TransactionWhereInput => ({
  NOT: { note: notaSaldo(d), type: 'EXPENSE' },
});

/**
 * Pre-filtro (en SQL) de las patas del arrastre. Estrecha lo que hay que traer, pero NO
 * es concluyente: hay que pasar cada fila por `esNotaSaldo()` para descartar los
 * impostores. Hoy `category ILIKE 'sales' + method Cash + sin factura` ya deja 0
 * impostores, pero es casualidad, no una garantía: basta un gasto futuro categorizado
 * como Sales que se llame "Saldo de ..." para colarse.
 */
export const whereArrastre: Prisma.TransactionWhereInput = {
  status: 'VIGENTE',
  note: { startsWith: 'Saldo ' },
  invoiceId: null,
  method: { in: CASH },
  category: { in: ['Sales', 'sales'] },
};

export { proximoDiaHabil };
