/**
 * El cálculo del prorrateo de reconexión, sin base de datos.
 *
 * QUÉ PROBLEMA RESUELVE. Al abonado cortado no se le factura el servicio cortado:
 * ni el legacy ni la corrida mensual de aquí le ponen ese renglón (`generate()`
 * sólo alcanza a ACTIVO/COMPROMISO, y dentro de cada abonado sólo mete los
 * `SubscriberService` en ACTIVO). Cuando paga y se le devuelve el servicio a
 * mitad de mes, ese pedazo de mes no lo está cobrando nadie. En el legacy ese
 * agujero lo tapan los tipos de orden terminados en "2" —`Reconexion Internet2`,
 * `Reconexion Television2`—, que además de reconectar cobran los días que quedan
 * del mes. Son 185 a 551 órdenes al mes y entre 6,6 y 23,5 millones de pesos:
 * no es un caso de borde.
 *
 * LA FÓRMULA es la del legacy (`Transactions.php:1079`, `Tickets.php:1949`):
 * el precio del mes dividido entre los días que tiene el mes, por los días que
 * quedan. Se redondea al peso porque allá `invoice_items.price` es `int(16)` y
 * los renglones tienen que dar el mismo número: la mitad de estas facturas viven
 * en los dos sistemas a la vez y el writeback las empuja de vuelta.
 *
 * DIVERGENCIA DELIBERADA (una sola). El legacy cuenta los días de dos maneras
 * distintas según el servicio: para internet `$ultimodiames - $fechaActual + 1`
 * (cuenta hoy) y para la TV un `DateTime::diff` contra el fin de mes (no cuenta
 * hoy). Reconectado el 24 de agosto, al mismo cliente le cobra 8 días de internet
 * y 7 de TV — comprobado en la factura 474962 del legacy. Aquí se usa UNA regla,
 * la de internet, para los dos: si el servicio le funciona hoy, hoy se cobra.
 * Son ~700 pesos de diferencia en la TV y el criterio no puede depender de por
 * cuál de los dos ficheros PHP pasó el cliente.
 */

import { hoyEnColombia } from '../common/fecha-colombia';

/** La ventana de días que se va a cobrar. */
export type VentanaProrrateo = {
  /** Días que se cobran, contando hoy. */
  dias: number;
  /** Días que tiene el mes (28..31): el divisor. */
  diasDelMes: number;
  /** Primer día cobrado (hoy). */
  desde: Date;
  /** Último día cobrado (fin de mes) — también el vencimiento de la factura. */
  hasta: Date;
};

/**
 * Los días que quedan del mes contando hoy.
 *
 * `hoy` llega en fecha de Colombia (`hoyEnColombia`), no en UTC: entre las 7 PM y
 * la medianoche el "hoy" de UTC ya es mañana y el cliente pagaría un día menos.
 */
export function ventanaProrrateo(hoy: Date = hoyEnColombia()): VentanaProrrateo {
  const y = hoy.getUTCFullYear();
  const m = hoy.getUTCMonth();
  const diasDelMes = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const dia = hoy.getUTCDate();
  return {
    dias: diasDelMes - dia + 1,
    diasDelMes,
    desde: new Date(Date.UTC(y, m, dia)),
    hasta: new Date(Date.UTC(y, m, diasDelMes)),
  };
}

/**
 * Valor prorrateado de una mensualidad, al peso.
 *
 * Se redondea al peso (no a centavos) por paridad con el legacy: allá la columna
 * es entera y un renglón con decimales haría que el writeback y el sync vieran
 * totales distintos en cada pasada.
 */
export function valorProrrateado(precioMensual: number, v: VentanaProrrateo): number {
  const precio = Number(precioMensual) || 0;
  if (precio <= 0 || v.dias <= 0 || v.diasDelMes <= 0) return 0;
  // Mes completo (reconexión el día 1): se cobra la mensualidad tal cual, sin
  // pasarla por la división — 50.500/31*31 vuelve a dar 50.500, pero no en todos
  // los precios, y una mensualidad que no cuadra al peso con el catálogo es una
  // llamada del cliente.
  if (v.dias >= v.diasDelMes) return Math.round(precio);
  return Math.round((precio / v.diasDelMes) * v.dias);
}

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/**
 * Cómo se le explica el renglón al cliente en la factura: "reconexión 24–31 ago
 * (8 días)". Va en `description`, no en `productName`, para que los reportes de
 * ventas sigan agrupando por el nombre del plan.
 */
export function etiquetaProrrateo(v: VentanaProrrateo): string {
  const mes = MESES[v.hasta.getUTCMonth()];
  return `reconexión ${v.desde.getUTCDate()}–${v.hasta.getUTCDate()} ${mes} (${v.dias} ${v.dias === 1 ? 'día' : 'días'})`;
}
