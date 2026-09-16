/**
 * POR QUÉ se emite una factura: su MOTIVO.
 *
 * Hasta el 2026-09-08 una factura solo decía de qué TIPO era —`FIJA` o
 * `RECURRENTE`, el `tipo_factura` del legacy—, y eso no responde a la pregunta que
 * se hace todo el mundo al abrirla: la afiliación, el traslado, la reconexión y la
 * venta de un equipo son las cuatro «Fija», y desde fuera se distinguen leyendo el
 * renglón y adivinando. El motivo lo dice en una palabra, se elige al facturar y
 * queda escrito en la factura (`SubInvoice.purpose`).
 *
 * Y hay motivos que además HACEN algo: el TRASLADO y AGREGAR INTERNET. Ahí la
 * factura no solo se rotula — lleva el trabajo detrás (y en el traslado, la dirección
 * nueva del cliente) y, cuando se paga, abre sola su orden (`OrdenAlPagarService`).
 * Es el mismo camino que ya seguía la afiliación («primero paga, después va el
 * técnico», ver `AltaClienteService`), pero pedido al revés de como estaba: esos dos
 * trabajos se venían facturando AL ABRIR la orden, y la cajera tenía que abrir una
 * orden para poder cobrar.
 *
 * QUÉ NO ES. No es una tabla de precios ni un catálogo de productos: el renglón de
 * la factura se sigue eligiendo del catálogo (`Material`). `producto` es solo el
 * nombre con el que la web propone la línea al elegir el motivo, para que la cajera
 * no tenga que buscar «Traslado» a mano y no acabe cobrando otra cosa.
 */

import { AGREGAR_INTERNET, TRASLADO } from '../support/order-types';

export type MotivoFactura = {
  /** Clave corta: es lo que se guarda en `SubInvoice.purpose` y lo que manda la web. */
  clave: string;
  etiqueta: string;
  /** Qué significa, en una línea. Se enseña bajo el desplegable. */
  ayuda: string;
  /** Tipo de factura que le corresponde (el legacy solo tiene estos dos). */
  kind: 'FIJA' | 'RECURRENTE';
  /** Producto del catálogo (`Material.name`) con el que se propone el renglón. */
  producto?: string;
  /**
   * La ORDEN que nace sola cuando esta factura queda PAGADA (`Ticket.type`), si es
   * de las que abren trabajo. Sin esto el motivo es solo un rótulo.
   */
  abreOrden?: string;
  /**
   * Exige la dirección NUEVA del cliente (`moveTo`). Hoy solo el traslado: es el
   * único trabajo cuyo destino no se sabe mirando la ficha.
   */
  pideDestino?: boolean;
};

export const MOTIVOS_FACTURA: readonly MotivoFactura[] = [
  {
    clave: 'mensualidad',
    etiqueta: 'Mensualidad',
    ayuda: 'El mes de servicio del cliente. Es lo que emite la corrida del día 1.',
    kind: 'RECURRENTE',
  },
  {
    clave: 'afiliacion',
    etiqueta: 'Afiliación',
    ayuda: 'Lo que se cobra el día que el cliente entra. La orden de instalación nace al pagarla.',
    kind: 'FIJA',
    producto: 'Afiliación',
  },
  {
    clave: 'traslado',
    etiqueta: 'Traslado',
    ayuda: 'El cliente se muda: lleva la dirección nueva y, al pagarse, abre sola la orden de traslado.',
    kind: 'FIJA',
    producto: 'Traslado',
    abreOrden: TRASLADO,
    pideDestino: true,
  },
  {
    clave: 'agregar-internet',
    etiqueta: 'Agregar internet',
    ayuda: 'Al que solo tiene televisión se le monta el internet. Al pagarse, abre sola la orden.',
    kind: 'FIJA',
    producto: 'Agregar Internet',
    abreOrden: AGREGAR_INTERNET,
  },
  {
    clave: 'reconexion',
    etiqueta: 'Reconexión',
    ayuda: 'Volver a conectar a quien estaba cortado.',
    kind: 'FIJA',
    producto: 'Reconexion',
  },
  {
    clave: 'venta',
    etiqueta: 'Venta de equipo o material',
    ayuda: 'Un equipo, un cable, un repetidor: lo que se le vende al cliente en ventanilla.',
    kind: 'FIJA',
  },
  {
    clave: 'otro',
    etiqueta: 'Otro cargo',
    ayuda: 'Cualquier otro cobro puntual. Explícalo en la nota de la factura.',
    kind: 'FIJA',
  },
];

const normalizar = (s?: string | null) => (s ?? '').trim().toLowerCase();

/** El motivo por su clave. `null` = sin motivo (las facturas de antes de 2026-09-08). */
export function motivoPorClave(clave?: string | null): MotivoFactura | null {
  const k = normalizar(clave);
  if (!k) return null;
  return MOTIVOS_FACTURA.find((m) => m.clave === k) ?? null;
}

/** Cómo se lee un motivo guardado. Uno desconocido se enseña tal cual, no se esconde. */
export function etiquetaDeMotivo(clave?: string | null): string | null {
  const k = normalizar(clave);
  if (!k) return null;
  return motivoPorClave(k)?.etiqueta ?? clave!.trim();
}
