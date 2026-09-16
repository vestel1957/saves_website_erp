/**
 * A DÓNDE SE MUDA el cliente: las casillas del destino de un traslado, y la
 * comprobación de que ese destino sirve para mandar un técnico.
 *
 * Vive aquí, y no dentro de `SupportWriteService`, porque ya son DOS los sitios que
 * capturan a dónde se va el cliente:
 *
 *   · la ORDEN de traslado (`createTicket` / `updateTicket`), que es como se pedía
 *     hasta ahora: se abre la orden y se factura sola;
 *   · la FACTURA de traslado (`FacturasService.createInvoice`, 2026-09-08), que es
 *     al revés: primero se cobra —el cliente paga en ventanilla— y la orden nace
 *     sola cuando la factura queda pagada.
 *
 * Las dos escriben la misma dirección en la misma ficha, así que la validación
 * ("¿está vacía?") y el armado del parche tienen que ser UNO. Dos copias acabarían
 * aceptando en la factura una dirección que la orden rechaza, y la orden no llegaría
 * a abrirse nunca.
 */

import { IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { Prisma } from '@prisma/client';
import { BadRequestException } from '../core/http/errores';
import { direccionDe, nomenclaturaLimpia } from './subscriber-address';

/**
 * A dónde se muda el cliente. Solo lo llevan la orden de 'Traslado' y la factura
 * cuyo motivo es un traslado.
 *
 * Son las mismas casillas de la ficha (`Subscriber.nomenclature` + barrio y zona),
 * y no un renglón de texto libre, por la misma razón por la que la ficha las tiene
 * partidas: de ahí sale la dirección que ve el técnico, la que imprime el contrato
 * y la que el writeback escribe columna a columna en el MySQL del legacy.
 */
export class TrasladoDto {
  /** Las 12 casillas (`nomenclatura`, `numero1`…). Se filtran en el servidor. */
  @IsObject() nomenclature!: Record<string, unknown>;
  /**
   * Zona nueva. Van los ids del legacy en texto, como en la ficha. Son opcionales
   * porque la mudanza suele ser dentro del mismo barrio: lo que no venga se queda
   * como está.
   */
  @IsOptional() @IsString() @MaxLength(50) departmentRef?: string;
  @IsOptional() @IsString() @MaxLength(50) cityRef?: string;
  @IsOptional() @IsString() @MaxLength(50) localityRef?: string;
  @IsOptional() @IsString() @MaxLength(50) neighborhood?: string;
  /** La dirección "comercial" suelta, si en esa ficha se usa (ver `direccionDe`). */
  @IsOptional() @IsString() @MaxLength(255) addressLine?: string;
}

/** La ficha del cliente, en lo que hace falta para saber de dónde sale. */
export type FichaParaTraslado = {
  nomenclature: unknown;
  addressLine: string | null;
  neighborhood?: string | null;
};

export type TrasladoArmado = {
  /** El destino tal cual se guarda en la orden (`Ticket.moveTo`) o en la factura. */
  destino: Record<string, unknown>;
  direccionNueva: string;
  direccionVieja: string | null;
  /**
   * `true` si la ficha ya estaba en esa dirección. No frena nada —el traslado corto
   * dentro del mismo inmueble es válido—: sirve para no reescribirle la ficha a un
   * cliente que no cambia de sitio y para redactar la nota.
   */
  mismaDireccion: boolean;
  /** El parche que hay que escribirle a la ficha cuando el traslado se aplique. */
  fichaData: Record<string, unknown>;
  notaObservacion: string;
};

/**
 * El destino de un traslado, a partir de las casillas de dirección: a dónde va, de
 * dónde sale y qué hay que escribirle a la ficha.
 *
 * Repetir la dirección que el cliente ya tiene NO es un error (decisión del usuario,
 * 2026-09-08). Se rechazaba por parecer un error de dedo —nadie se muda a donde ya
 * vive—, pero el traslado de verdad más común es el corto: el segundo piso de la
 * misma casa, la pieza del fondo, el local de al lado. Eso se puede decir en las
 * casillas del interior (torre/piso, apto/casa) pero no siempre: hay inmuebles sin
 * numerar por dentro, y en ellos lo único que cambia es a dónde tiene que subir el
 * técnico con el cable. La orden vale igual —hay visita, hay obra y hay cobro—, así
 * que se abre y la dirección se queda como está.
 */
export function armarTraslado(moveTo: TrasladoDto, sub: FichaParaTraslado): TrasladoArmado {
  const nomenclature = nomenclaturaLimpia(moveTo.nomenclature);
  const addressLine = moveTo.addressLine?.trim() || null;
  const direccionNueva = direccionDe(nomenclature, addressLine);
  if (!direccionNueva) {
    throw new BadRequestException('La dirección nueva está vacía: escribe al menos la vía y su número.');
  }
  const direccionVieja = direccionDe(sub.nomenclature, sub.addressLine);
  const mismaDireccion = !!direccionVieja && direccionVieja.toLowerCase() === direccionNueva.toLowerCase();

  // La zona (departamento/ciudad/localidad/barrio) solo se toca si viene: mudarse
  // dentro del mismo barrio es lo normal, y escribir un barrio vacío borraría el
  // que tiene puesto.
  const zona: Record<string, string> = {};
  for (const k of ['departmentRef', 'cityRef', 'localityRef', 'neighborhood'] as const) {
    const v = moveTo[k]?.trim();
    if (v) zona[k] = v;
  }

  return {
    destino: { nomenclature, addressLine, ...zona },
    direccionNueva,
    direccionVieja,
    mismaDireccion,
    fichaData: { nomenclature: nomenclature as Prisma.InputJsonValue, ...zona, ...(addressLine ? { addressLine } : {}) },
    // La nota es lo que lee el técnico (y lo único que de esto viaja al legacy, en la
    // observación). "de X a X" no dice nada, así que cuando la dirección no cambia se
    // dice lo que sí pasa: la mudanza es dentro del mismo inmueble.
    notaObservacion: mismaDireccion
      ? `Traslado dentro de la misma dirección (${direccionNueva}): el cliente se muda dentro del mismo inmueble.`
      : `Traslado: de ${direccionVieja ?? 'dirección sin registrar'} a ${direccionNueva}.`,
  };
}
