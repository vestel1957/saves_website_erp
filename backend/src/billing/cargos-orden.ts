/**
 * Los tipos de orden que se COBRAN al abrirlos.
 *
 * Hay trabajos que no son parte de la mensualidad: el cliente pide algo puntual, se
 * le cobra una vez y el técnico sale. El legacy los factura aparte —una factura de
 * un solo renglón, del día y vencida el día— y a mano; aquí se emiten solas al abrir
 * la orden (ver `cargo-orden.service.ts`).
 *
 * Este fichero es la LISTA de esos trabajos, y existe para que añadir uno sea una
 * entrada más y no otro servicio: hasta el 2026-09-01 el único cargo automático era
 * el del traslado y toda la mecánica —precio del catálogo, interruptor, factura,
 * contabilización— estaba escrita con su nombre encima. Los dos cargos son la misma
 * operación con distinto producto.
 *
 * QUÉ NO ES. No es una tabla de precios: el precio sale del catálogo (`Material`),
 * que es lo que contabilidad puede cambiar sin tocar código. `precioPorDefecto` es
 * solo el respaldo para que un producto que todavía no está creado no deje el
 * trabajo sin cobrar.
 */

import { AGREGAR_INTERNET, TRASLADO } from '../support/order-types';

export type CargoDeOrden = {
  /** Clave corta, para el log y para pedirlo desde la web. */
  clave: string;
  /** El `Ticket.type` EXACTO que lo dispara (como está en `order-types.ts`). */
  tipo: string;
  /** Producto del catálogo (`Material.name`) del que sale el precio y el renglón. */
  producto: string;
  /** Lo que se cobra si el catálogo no tiene ese producto. */
  precioPorDefecto: number;
  /** Cómo se nombra en las notas de la factura y en los avisos ("Traslado · orden #…"). */
  etiqueta: string;
  /** Ajuste que lo enciende (`AppSetting.key`): `on` / `informe` / `off`. */
  ajuste: string;
  /** Variable de entorno equivalente, para cuando no hay fila de ajuste. */
  env: string;
};

/**
 * TRASLADO de domicilio. 30.000 sin IVA, producto 'Traslado' del catálogo, como lo
 * lleva facturando el legacy (3.875 renglones). Lo dispara la orden 'Traslado' a
 * secas: el 'Traslado interno De Equipos Red en cliente final' mueve el equipo
 * dentro de la misma casa y no se cobra (ver `esTraslado`).
 */
export const CARGO_TRASLADO: CargoDeOrden = {
  clave: 'traslado',
  tipo: TRASLADO,
  producto: 'Traslado',
  precioPorDefecto: 30_000,
  etiqueta: 'Traslado',
  ajuste: 'billing.cargoTraslado',
  env: 'BILLING_CARGO_TRASLADO',
};

/**
 * AGREGAR INTERNET al cliente que hoy solo tiene televisión (758 órdenes en el
 * histórico). Se cobra una sola vez, al abrir la orden: es el derecho de conexión
 * del servicio nuevo, no una mensualidad — la mensualidad del internet la genera
 * después la corrida del mes, con su plan.
 *
 * 30.000, decisión del usuario (2026-09-01). Sale del catálogo igual que el
 * traslado: el día que contabilidad cree el producto 'Agregar Internet' con otro
 * precio, manda el catálogo y esta constante deja de usarse.
 */
export const CARGO_AGREGAR_INTERNET: CargoDeOrden = {
  clave: 'agregar-internet',
  tipo: AGREGAR_INTERNET,
  producto: 'Agregar Internet',
  precioPorDefecto: 30_000,
  etiqueta: 'Agregar internet',
  ajuste: 'billing.cargoAgregarInternet',
  env: 'BILLING_CARGO_AGREGAR_INTERNET',
};

export const CARGOS_POR_ORDEN: readonly CargoDeOrden[] = [CARGO_TRASLADO, CARGO_AGREGAR_INTERNET];

const normalizar = (s?: string | null) => (s ?? '').trim().toLowerCase();

/**
 * El cargo que lleva un tipo de orden, si lleva alguno. `null` es lo normal: de los
 * 45 detalles del catálogo solo dos se cobran al abrirlos.
 *
 * Se compara el texto ENTERO y no por `includes`, por lo mismo que `esTraslado`:
 * 'Traslado interno De Equipos Red en cliente final' contiene 'Traslado' y no se
 * cobra.
 */
export function cargoDeTipoDeOrden(tipo?: string | null): CargoDeOrden | null {
  const t = normalizar(tipo);
  if (!t) return null;
  return CARGOS_POR_ORDEN.find((c) => normalizar(c.tipo) === t) ?? null;
}

/** El cargo por su clave corta (lo que manda la web al preguntar el precio). */
export function cargoPorClave(clave?: string | null): CargoDeOrden | null {
  const k = normalizar(clave);
  return CARGOS_POR_ORDEN.find((c) => c.clave === k) ?? null;
}
