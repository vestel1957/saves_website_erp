import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested,
} from 'class-validator';
import { RETENTION_TYPES, type RetentionLabel } from '../retenciones';
import { TrasladoDto } from '../../common/traslado';

export class InvoiceItemDto {
  @IsOptional() @IsString()
  productName?: string;

  /**
   * `Material.legacyId` (pid del legacy) cuando la línea salió del catálogo. Deja el
   * rastro al producto que el legacy guardaba en `invoice_items.pid`; escribir a mano
   * (texto libre) manda 0, como hasta ahora.
   */
  @IsOptional() @IsInt() @Min(0)
  productId?: number;

  @IsString() @MinLength(1)
  description!: string;

  @IsNumber() @Min(0)
  qty!: number;

  @IsNumber() @Min(0)
  price!: number;

  @IsOptional() @IsNumber() @Min(0)
  taxRate?: number;
}

/** Crear una factura (manual o clonada de la última del cliente). */
export class CreateInvoiceDto {
  @IsString()
  subscriberId!: string;

  @IsOptional() @IsDateString()
  invoiceDate?: string;

  @IsOptional() @IsDateString()
  dueDate?: string;

  /**
   * Tipo de factura (el `tipo_factura` del legacy). Solo FIJA y RECURRENTE: las notas
   * crédito/débito son el otro par del enum, pero cuelgan de una factura existente y
   * se crean por `POST /billing/invoices/:id/notes` — emitirlas por aquí las dejaría
   * huérfanas. Por defecto FIJA, que es lo que ofrecía primero el legacy y lo que se
   * venía creando.
   */
  @IsOptional() @IsIn(['FIJA', 'RECURRENTE'])
  kind?: 'FIJA' | 'RECURRENTE';

  @IsOptional() @IsString()
  notes?: string;

  /**
   * POR QUÉ se factura: la clave de un motivo de `billing/motivos-factura.ts`
   * ('mensualidad', 'afiliacion', 'traslado', 'reconexion', 'venta', 'otro').
   *
   * `kind` dice el TIPO y no el motivo: afiliación, traslado, reconexión y venta de
   * equipo son las cuatro «Fija», y desde fuera solo se distinguen adivinando por el
   * renglón. Es opcional para no romper lo que ya factura sin decirlo (la corrida
   * mensual, el cargo de una orden, el chatbot).
   */
  @IsOptional() @IsString() @MaxLength(40)
  purpose?: string;

  /**
   * La dirección NUEVA del cliente, cuando se factura un TRASLADO. Va aquí y no en
   * una orden porque el orden de las cosas es el que pidió el usuario (2026-09-08):
   * primero se cobra el traslado —con el destino escrito en la misma factura— y la
   * ORDEN de traslado nace sola cuando esa factura queda pagada.
   *
   * La ficha del cliente NO se toca al facturar: se muda cuando paga y se abre la
   * orden. Una dirección cambiada por una factura que después se anula dejaría al
   * cliente viviendo en una casa a la que no se mudó.
   */
  @IsOptional() @ValidateNested() @Type(() => TrasladoDto)
  moveTo?: TrasladoDto;

  @IsArray() @ValidateNested({ each: true }) @Type(() => InvoiceItemDto)
  items!: InvoiceItemDto[];
}

/**
 * Editar una factura ya emitida (paridad legacy `Invoices::editaction`, que borra
 * los renglones de la factura y reinserta los que llegan del formulario).
 *
 * `items` es el juego COMPLETO de conceptos: lo que no venga se elimina. Es la
 * misma semántica del legacy y evita tener que mandar altas/bajas por separado.
 * El cliente NO se puede cambiar: mover una factura de abonado descuadra la
 * cartera de los dos; para eso está anular y volver a facturar.
 */
export class UpdateInvoiceDto {
  @IsOptional() @IsDateString()
  invoiceDate?: string;

  @IsOptional() @IsDateString()
  dueDate?: string;

  @IsOptional() @IsIn(['FIJA', 'RECURRENTE'])
  kind?: 'FIJA' | 'RECURRENTE';

  @IsOptional() @IsString()
  notes?: string;

  /**
   * Motivo del cambio: queda en la auditoría (el legacy no lo pedía). OPCIONAL por
   * decisión del usuario (2026-08-27): exigirlo frenaba la corrección de facturas.
   * El resto de la auditoría (antes/después/quién) se guarda igual.
   */
  @IsOptional() @IsString()
  reason?: string;

  @IsArray() @ValidateNested({ each: true }) @Type(() => InvoiceItemDto)
  items!: InvoiceItemDto[];
}

/** Generar facturas recurrentes en lote (una mensualidad por abonado, desde su plan). */
export class GenerateInvoicesDto {
  @IsOptional() @IsString()
  branchId?: string;

  @IsOptional() @IsArray() @IsString({ each: true })
  subscriberIds?: string[];

  @IsOptional() @IsDateString()
  invoiceDate?: string;

  @IsOptional() @IsInt() @Min(1)
  dueDays?: number;

  /**
   * Tope de abonados a procesar. OMITIDO = TODOS los facturables, que es lo que la
   * corrida del mes necesita (el legacy factura al grupo entero, sin tope:
   * Invoices_model.php:1111). No poner un default: un tope silencioso deja el mes
   * a medio facturar y el lote reporta éxito igual.
   */
  @IsOptional() @IsInt() @Min(1)
  limit?: number;

  /**
   * Simulación: calcula el lote completo y NO escribe nada (ni facturas, ni el
   * descuento de los contadores de promo, ni el asiento contable). Devuelve `plan`
   * con la decisión y el motivo por abonado. Sirve para previsualizar la corrida
   * del mes y para compararla contra la del legacy antes del corte.
   */
  @IsOptional() @IsBoolean()
  dryRun?: boolean;

  /**
   * Solo con `dryRun`. Simula el mes como si aún NO se hubiera facturado: ignora las
   * facturas del propio mes objetivo (que si no harían omitir a todo el mundo por
   * `alreadyBilled`) y lee los contadores de promo de la última factura ANTERIOR al
   * mes. Es lo que permite re-simular un mes ya facturado —p.ej. el que emitió el
   * legacy— y comparar factura por factura.
   */
  @IsOptional() @IsBoolean()
  asIfUnbilled?: boolean;
}

// Los tipos de retención se mudaron a `../retenciones` (sin decoradores, para que
// `nota-en-tx.ts` no arrastre `class-validator`). Se re-exportan desde aquí.
export { RETENTION_TYPES, RETENTION_LABEL_TO_ENUM } from '../retenciones';
export type { RetentionLabel } from '../retenciones';

/** Nota crédito / débito sobre una factura. */
export class CreateNoteDto {
  @IsIn(['CREDITO', 'DEBITO'])
  type!: 'CREDITO' | 'DEBITO';

  @IsNumber() @Min(1)
  amount!: number;

  /**
   * Observación: POR QUÉ se aplica la nota. OBLIGATORIA.
   *
   * Era opcional y quien no la escribía dejaba en la factura un renglón "Nota
   * Credito" mudo: tres meses después nadie sabía si fue una depuración de cartera,
   * un descuento autorizado o una retención —y la nota mueve plata—. Contabilidad
   * ya la escribía casi siempre (de 9.915 notas crédito sólo 18 estaban en blanco);
   * ahora el sistema no deja aplicar ninguna sin motivo.
   */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString({ message: 'Escribe la observación de la nota: por qué se aplica.' })
  @MinLength(5, { message: 'La observación debe explicar el motivo de la nota (mínimo 5 caracteres).' })
  @MaxLength(500, { message: 'La observación no puede pasar de 500 caracteres.' })
  description!: string;

  /**
   * Tipo de retención, opcional. Paridad legacy: la retención de VENTA se captura
   * únicamente desde el modal de nota crédito/débito y su valor lo digita el usuario
   * (`amount`); el sistema no lo calcula.
   */
  @IsOptional() @IsIn(RETENTION_TYPES as unknown as string[])
  retentionType?: RetentionLabel;
}

/** Una factura del lote de notas, con lo que le toca a ella. */
export class NotaFacturaDto {
  @IsString() @MinLength(1)
  invoiceId!: string;

  @IsNumber() @Min(1)
  amount!: number;
}

/**
 * Aplicar la MISMA nota a VARIAS facturas de un cliente de una vez.
 *
 * Nace de la depuración de cartera: perdonarle a un abonado los seis meses que
 * arrastra eran seis pasadas por el modal, con su observación reescrita seis veces
 * —y si a la tercera alguien se distraía, el cliente quedaba a medio limpiar—.
 *
 * El monto viaja POR FACTURA (`items`) y no como un total a repartir aquí: el que
 * elige (mismo monto en cada una, el saldo de cada una, o repartir un total
 * cubriendo saldos) lo hace la pantalla, que es donde se ve el reparto antes de
 * aplicarlo. Así lo que se previsualiza es exactamente lo que se escribe; el
 * servidor valida lo que de verdad importa: que las facturas existan, sean TODAS
 * del mismo cliente, ese cliente esté en el alcance de sedes de quien aplica, y
 * los montos sean positivos.
 *
 * Todo el lote va en UNA transacción: o entran las N notas o no entra ninguna.
 */
export class CreateNotesBulkDto {
  @IsIn(['CREDITO', 'DEBITO'])
  type!: 'CREDITO' | 'DEBITO';

  /** Misma exigencia (y mismo porqué) que en `CreateNoteDto`: la observación es el motivo. */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString({ message: 'Escribe la observación de la nota: por qué se aplica.' })
  @MinLength(5, { message: 'La observación debe explicar el motivo de la nota (mínimo 5 caracteres).' })
  @MaxLength(500, { message: 'La observación no puede pasar de 500 caracteres.' })
  description!: string;

  @IsOptional() @IsIn(RETENTION_TYPES as unknown as string[])
  retentionType?: RetentionLabel;

  /**
   * Tope de 50 facturas por lote: son 50 notas escritas dentro de una sola
   * transacción interactiva y no hay caso real que pase de ahí (el cliente más
   * atrasado del legacy arrastra 30 y pico). Sin tope, un lote de cientos tendría
   * la transacción abierta lo bastante como para estorbar al resto — y esta base
   * comparte las 100 conexiones con otras cinco apps.
   */
  @IsArray() @ValidateNested({ each: true }) @Type(() => NotaFacturaDto)
  @ArrayMinSize(1, { message: 'Elige al menos una factura.' })
  @ArrayMaxSize(50, { message: 'No se pueden aplicar más de 50 notas de una vez.' })
  items!: NotaFacturaDto[];
}

/** Anulación de una factura de venta (legacy `Transactions::cancelinvoice`, motivo por GET). */
export class VoidInvoiceDto {
  @IsString() @MinLength(3)
  reason!: string;
}

/**
 * "Asignar servicio" sobre una factura — el `ASIGNAR SERVICIO` del `edit.php` del legacy.
 *
 * No cambia lo que ESTA factura cobró: fija el plan que se le cobrará al abonado de la
 * próxima facturación en adelante.
 *
 * Cada campo ausente se deja como está. El valor `'no'` es el mismo que ofrece el
 * selector del legacy y significa "quitarle ese servicio".
 */
export class AsignarServicioDto {
  /** `Plan.id` de internet, o `'no'` para quitárselo. Ausente = no se toca. */
  @IsOptional() @IsString()
  internet?: string;

  /** `Plan.id` de televisión, o `'no'` para quitársela. Ausente = no se toca. */
  @IsOptional() @IsString()
  tv?: string;

  /** Cuántos televisores adicionales (puntos). 0 los quita. Ausente = no se tocan. */
  @IsOptional() @IsInt() @Min(0) @Max(200)
  puntos?: number;

  /**
   * Empujar el perfil del plan al router. Por defecto sí: si al cliente se le cobra
   * 300 megas, tiene que navegar a 300 megas. Se apaga cuando el cambio de velocidad
   * lo hará el técnico en una visita.
   */
  @IsOptional() @IsBoolean()
  pushRouter?: boolean;

  /** Motivo del cambio, para la auditoría. */
  @IsOptional() @IsString()
  reason?: string;
}
