import { BadRequestException, ForbiddenException, HttpException, HttpStatus, NotFoundException } from '../core/http/errores';
import type { EmisorDeEventos } from '../core/eventos';
import { Type } from 'class-transformer';
import { IsArray, IsDateString, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { Prisma, ServiceStatus, TicketStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/current-user.decorator';
import { MikrotikService } from '../network/mikrotik.service';
import { conservaEstadoAlReconectar } from '../network/estado-al-reconectar';
import type { GenieacsService } from '../network/genieacs.service';
import type { OltService } from '../network/olt.service';

/**
 * Cuánto espera QUIEN CIERRA la orden a que contesten los equipos de televisión.
 *
 * El CPE se pide por connection-request y la OLT por SSH: los dos pueden tardar. Al
 * técnico no se le deja la pantalla colgada por eso — pasado el tope se cierra igual
 * y el mensaje dice que la red no confirmó.
 */
const ESPERA_EQUIPOS_MS = 20_000;
import { parsePoint } from '../geo/geo.util';
import { GeofenceService, type ResultadoCerca } from './geofence.service';
import { faltaLaFoto, SIN_FOTO } from './foto-cierre.policy';
import { faltaLaIpRemota, SIN_IP_REMOTA } from './ip-remota.policy';
import { esUsuarioPppUtil } from '../subscribers/conexion-alta';
import { ResponsibilityNotifierService } from '../responsibilities/responsibility-notifier.service';
import {
  ACTIVACION_APLICADA_EVENT, BAJA_APLICADA_EVENT, RECONEXION_APLICADA_ORDEN_EVENT, TICKET_ANULADA_EVENT, TICKET_ASIGNADO_EVENT, TICKET_DESASIGNADO_EVENT,
  TICKET_CREADO_EVENT, TICKET_RESUELTO_EVENT,
  type ActivacionAplicadaEvent, type BajaAplicadaEvent, type ReconexionAplicadaOrdenEvent, type TicketAsignadoEvent, type TicketDesasignadoEvent, type TicketResueltoEvent,
} from './support.events';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CARGO_TECNICO } from '../staff/cargos-legacy';
import { bodegaMaterialDelTecnico, esTecnicoDeCampo, fichaDelUsuario } from '../common/tecnico-scope';
import { bodegasConMaterial, buscarMaterialConStock, FiltroMaterial } from '../common/material-stock';
import { hoyEnColombia } from '../common/fecha-colombia';
import { ORDEN_CRONOLOGICO } from './orden-cronologico';
import { EquipoReservaService, tipoConReserva } from './equipo-reserva.service';
import { exigirSedeSuscriptor } from '../common/sede-scope';
import { num, round2 } from '../common/money';
import { puedeEmpezarOrden } from './turno';
import { nextTid, TID_SEQ } from '../common/tid';
import { AgendaService } from './agenda.service';
import { autorDeOrden, autorDeSeguimiento, SEGUIMIENTO_DEL_SISTEMA, type FirmaDeSeguimiento } from './autor-orden';
import { ETIQUETA_CLASE, esAgregarInternet, esCambioDeMegas, esClaseOrden, esReconexion, esReconexionPorDias, esRetiroVoluntario, esTrabajoDeConexion, esTraslado, MAX_DIAS_GRACIA, motivoDeRetiroCanonico, MOTIVOS_RETIRO, ordenLlevaPlanInternet, resolverClase, sentidoDeMegas, serviciosDeOrden, serviciosDeReconexion } from './order-types';
import type { SubscribersService } from '../subscribers/subscribers.service';
import type { ProrrateoReconexionService } from '../billing/prorrateo-reconexion.service';
import type { CargoOrdenService, ResultadoCargo } from '../billing/cargo-orden.service';
import { cargoDeTipoDeOrden } from '../billing/cargos-orden';
import { direccionDe } from '../common/subscriber-address';
import { subName } from '../common/subscriber-name';
import { armarTraslado, TrasladoDto, type FichaParaTraslado } from '../common/traslado';
import { OrderScoreService } from './order-score.service';

/** Carpeta de firmas PNG dibujadas de las órdenes. */
const SIGNATURE_ROOT = join(process.cwd(), 'uploads', 'signatures');

export const TICKET_PRIORITIES = ['Baja', 'Media', 'Alta', 'Urgente'] as const;

/**
 * A dónde se muda el cliente (`TrasladoDto`) y cómo se arma ese destino, ahora en
 * `common/traslado.ts`: lo comparten la ORDEN de traslado y la FACTURA de traslado
 * (ver el encabezado de ese fichero). Se re-exporta para no romper a quien lo
 * importe desde aquí, que es donde vivía.
 */
export { TrasladoDto };

export class CreateTicketDto {
  @IsString() subscriberId!: string;
  /**
   * La CLASE de orden: servicio / reclamo / incidente (`tickets.subject` del
   * legacy). Es opcional porque el chatbot manda aquí una frase descriptiva desde
   * antes de que esto fuera un catálogo; `resolverClase` la endereza y el texto no
   * se pierde (ver `createTicket`).
   */
  @IsOptional() @IsString() subject?: string;
  @IsString() @MinLength(1) type!: string; // detalle
  /**
   * La falla que reporta el cliente. En el 'Retiro voluntario' es otra cosa: es el
   * MOTIVO por el que se va, y ahí no es texto libre sino uno de `MOTIVOS_RETIRO`
   * (ver `motivoDeRetiro`).
   */
  @IsOptional() @IsString() problem?: string;
  @IsOptional() @IsString() section?: string;
  @IsOptional() @IsString() assigned?: string;
  @IsOptional() @IsIn(TICKET_PRIORITIES) priority?: string;
  /**
   * Día para el que se agenda (YYYY-MM-DD). Sin esto la orden nace sin agendar, que
   * es lo normal: la cajera reparte después desde el tablero. Exige técnico, porque
   * la agenda es la cola de UNA persona.
   */
  @IsOptional() @IsDateString() scheduledFor?: string;
  /**
   * Día con el que queda registrada la orden (YYYY-MM-DD). Sin esto nace con la
   * de hoy, que es lo normal; se deja poner una anterior porque el trabajo se pide
   * un día y muchas veces se alcanza a registrar al siguiente, y esa fecha es la
   * que mandan los reportes y el corte del mes. Futura no: una orden no se abre
   * antes de existir.
   */
  @IsOptional() @IsDateString() created?: string;
  /**
   * Días de gracia de una "Reconexión Combo por dias". Solo se guarda si el tipo
   * de orden es ese; en cualquier otro se ignora, para que no queden órdenes con
   * un plazo que nadie va a aplicar.
   */
  @IsOptional() @IsInt() @Min(1) @Max(MAX_DIAS_GRACIA) graceDays?: number;
  /**
   * La dirección nueva de un TRASLADO. Obligatoria en ese tipo de orden y sin uso
   * en los demás: una orden de traslado sin destino es la que mandaba al técnico a
   * preguntar por teléfono a dónde iba.
   */
  @IsOptional() @ValidateNested() @Type(() => TrasladoDto) moveTo?: TrasladoDto;
  /**
   * A CUÁNTAS MEGAS se pasa el cliente: el plan destino (`Plan.id`) de una orden de
   * 'Subir megas' / 'Bajar megas'. Obligatorio en esas dos y sin uso en las demás.
   *
   * Es un plan del catálogo y no un número suelto porque la velocidad no vive sola:
   * de él salen las megas, la tarifa de la próxima factura, el perfil PPP del
   * Mikrotik y el traffic-table de la OLT. Un "400" escrito a mano no cambia ni lo
   * que se le cobra ni lo que la red le entrega.
   */
  @IsOptional() @IsString() planToId?: string;
  /**
   * «Este trabajo YA está facturado»: el número (`SubInvoice.tid`) de la factura con
   * la que se le cobró en ventanilla.
   *
   * Apaga el cargo automático del tipo de orden y ata la orden a esa factura. Es el
   * mismo `yaFacturada` con el que nace la orden que dispara un pago
   * (`OrdenAlPagarService`), pero dicho a mano: la cajera que factura primero y abre
   * la orden después recorría los dos caminos y el cliente acababa con dos facturas
   * de 30.000 del mismo trabajo. Las candidatas las sirve
   * `GET /support/cargo-orden?tipo=…&subscriberId=…`.
   */
  @IsOptional() @IsInt() @Min(1) yaFacturadaTid?: number;
}
/**
 * Corrección de una orden ya registrada: lo que se escribió mal al abrirla.
 *
 * Hasta ahora una orden nacía y se quedaba como naciera: si la cajera elegía
 * "Revision de Internet" donde iba "Corte Internet", o el cliente contaba la falla
 * de verdad por teléfono un rato después, no había forma de arreglarlo — se anulaba
 * y se abría otra, que rompe el hilo, el número y el trabajo ya documentado.
 *
 * Solo lleva el TRABAJO (clase, detalle, falla, observación, fecha, plazo). El
 * técnico y la prioridad tienen su propio mando en la ficha y se guardan solos:
 * duplicarlos aquí dejaría dos sitios diciendo cosas distintas sobre lo mismo.
 *
 * Todos los campos son opcionales: llega lo que se tocó. `problem` y `section`
 * aceptan cadena vacía, que es como se BORRA lo escrito.
 */
export class UpdateTicketDto {
  /**
   * La clase: servicio / reclamo / incidente. No lleva `@IsIn`: pasa por
   * `resolverClase`, que es la misma puerta por la que entran las órdenes del
   * chatbot y la que endereza lo que traen las 320.000 del legacy (donde `subject`
   * llegó a guardar prosa). Un `@IsIn` aquí devolvería un 400 al abrir y guardar
   * una orden vieja sin haberle cambiado nada.
   */
  @IsOptional() @IsString() @MaxLength(255) subject?: string;
  /** El detalle (lo que se va a hacer). */
  @IsOptional() @IsString() @MinLength(1) type?: string;
  /**
   * Los topes son los del legacy (`tickets.problema` es varchar(150) y `section`
   * varchar(1500)): allá el writeback recorta, y recortar sin avisar es perder
   * texto que alguien escribió. Mejor decirlo aquí.
   */
  @IsOptional() @IsString() @MaxLength(150) problem?: string;
  @IsOptional() @IsString() @MaxLength(1500) section?: string;
  /** Día con el que queda registrada la orden (YYYY-MM-DD). */
  @IsOptional() @IsDateString() created?: string;
  /** Días de gracia; solo cuenta si el detalle es la reconexión por días. */
  @IsOptional() @IsInt() @Min(1) @Max(MAX_DIAS_GRACIA) graceDays?: number;
  /**
   * La dirección nueva de un TRASLADO, para las órdenes que no la traen.
   *
   * Las 4.000 órdenes de traslado del legacy —y las que se siguen abriendo allá—
   * no tienen dónde guardar el destino, y las que entran por el chatbot nacen sin
   * él a propósito (`destinoOpcional`). Sin esto, esas órdenes se quedaban para
   * siempre sin decir a dónde se muda el cliente: el técnico salía a preguntarlo
   * por teléfono. Solo cuenta si el detalle final es 'Traslado'.
   */
  @IsOptional() @ValidateNested() @Type(() => TrasladoDto) moveTo?: TrasladoDto;
  /**
   * El PLAN DESTINO de una orden de megas, para las que no lo traen y para las que
   * lo traen mal.
   *
   * Nacen sin él por dos caminos —las 2.741 'Subir megas' del legacy (allá el plan
   * vive en su tabla `temporales`, que todavía no se trae) y las que abre el chatbot
   * con el plan por confirmar—, y hasta ahora no había por dónde ponérselo: la orden
   * salía a la calle sin decir a cuántas megas hay que dejar al cliente. Corregirlo
   * también hace falta cuando se eligió el plan de al lado en el desplegable. Solo
   * cuenta si el detalle final es de megas.
   */
  @IsOptional() @IsString() planToId?: string;
}
export class PriorityDto {
  @IsIn(TICKET_PRIORITIES) priority!: string;
}
export class UpdateStatusDto {
  @IsIn(['PENDIENTE', 'REALIZANDO', 'RESUELTO', 'ANULADA']) status!: TicketStatus;
  @IsOptional() @IsString() finalDate?: string;
  // --- Geo-cerca del cierre (ver geofence.policy.ts) ---
  @IsOptional() @IsNumber() @Min(-90) @Max(90) lat?: number;
  @IsOptional() @IsNumber() @Min(-180) @Max(180) lng?: number;
  @IsOptional() @IsNumber() @Min(0) accuracyM?: number;
  /**
   * Ya NO existe el "cerrar fuera de rango escribiendo un motivo" (2026-09-10): el
   * campo se quitó del DTO a propósito, para que no quede una puerta que el servidor
   * siga aceptando. Un cliente web sin recargar puede seguir mandándolo; `validar`
   * descarta lo que el DTO no declara, así que llega y no hace nada.
   */
}
export class AssignDto {
  @IsOptional() @IsString() assigned?: string; // técnico
}
export class SignatureDto {
  @IsString() @MinLength(1) name!: string;
  @IsOptional() @IsString() cc?: string;
  @IsOptional() @IsString() rel?: string;
  /** Imagen de la firma dibujada (data URL base64 PNG del canvas). */
  @IsOptional() @IsString() image?: string;
}
export class ThreadDto {
  @IsString() @MinLength(1) message!: string;
}
export class AttachDto {
  @IsOptional() @IsString() message?: string;
  @IsOptional() @IsString() lat?: string; // coordenadas del técnico (geo-etiquetado)
  @IsOptional() @IsString() lng?: string;
}

/** Un equipo (CPE) de los que se asignan al cliente desde la orden. */
export class AssignEquipmentItemDto {
  @IsString() @MinLength(1) mac!: string;
  @IsString() @MinLength(1) installType!: string; // t_instalacion (FTTH / EOC / ...)
  @IsOptional() @IsString() equipmentId?: string; // unidad de stock a asignar (si viene de inventario)
  @IsOptional() @Type(() => Number) @IsInt() port?: number;
  @IsOptional() @Type(() => Number) @IsInt() vlan?: number;
  @IsOptional() @Type(() => Number) @IsInt() nat?: number;
  /** Caja NAP elegida en la pantalla (id de aquí). Se traduce a `nat` — ver `resolverPuertos`. */
  @IsOptional() @IsString() napId?: string;
  /** Puerto de esa caja (id de aquí). Se traduce a `puerto` y deja el puerto ocupado. */
  @IsOptional() @IsString() portId?: string;
  @IsOptional() @IsString() master?: string;
  @IsOptional() @Type(() => Number) @IsInt() meters?: number;
  @IsOptional() @IsString() accessories?: string;
  @IsOptional() @IsString() serial?: string;
}

/**
 * Asignación de equipos (CPE) al cliente desde la orden (porta legacy asig_equipo).
 *
 * Admite las dos formas a propósito: `items` para varios equipos de una (una
 * instalación normal deja ONT y decodificador el mismo día, y antes había que
 * abrir el modal una vez por aparato) y el cuerpo plano de un solo equipo, que es
 * como llamaban las pantallas y los toolsets del chatbot antes de esto. Los
 * campos planos son opcionales para que ambas entren por la misma puerta; que
 * venga al menos un equipo lo exige el servicio.
 */
export class AssignEquipmentDto {
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => AssignEquipmentItemDto)
  items?: AssignEquipmentItemDto[];
  @IsOptional() @IsString() mac?: string;
  @IsOptional() @IsString() installType?: string;
  @IsOptional() @IsString() equipmentId?: string;
  @IsOptional() @Type(() => Number) @IsInt() port?: number;
  @IsOptional() @Type(() => Number) @IsInt() vlan?: number;
  @IsOptional() @Type(() => Number) @IsInt() nat?: number;
  @IsOptional() @IsString() napId?: string;
  @IsOptional() @IsString() portId?: string;
  @IsOptional() @IsString() master?: string;
  @IsOptional() @Type(() => Number) @IsInt() meters?: number;
  @IsOptional() @IsString() accessories?: string;
  @IsOptional() @IsString() serial?: string;
}

/**
 * Mover un equipo YA INSTALADO de caja NAP / puerto desde la pestaña Equipos.
 *
 * - `portId` (+ `napId`) → queda colgado de ese puerto.
 * - `quitarCaja` → ya no cuelga de ninguna caja (se sueltan `nat` y `puerto`).
 * - Ninguno de los dos → sólo se vuelve a leer la VLAN de la OLT.
 *
 * La VLAN no viaja: la escribe el servidor con la del service-port de la ONU.
 */
export class UbicarEquipoDto {
  @IsOptional() @IsString() napId?: string;
  @IsOptional() @IsString() portId?: string;
  @IsOptional() @Type(() => Boolean) quitarCaja?: boolean;
  /**
   * Serial rotulado de la ONU. Es con lo que se la encuentra en la OLT: hay equipos
   * importados con "solicitar" o vacío en el serial, y sin él no hay ONU que leer.
   */
  @IsOptional() @IsString() @MaxLength(100) serial?: string;
}

/** Un ítem de consumo de material. */
export class MaterialConsumeItemDto {
  @IsString() @MinLength(1) materialId!: string;
  @Type(() => Number) @IsInt() @Min(1) qty!: number;
}
/** Registro de material consumido en la orden (descuenta stock). */
export class ConsumeMaterialsDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => MaterialConsumeItemDto)
  items!: MaterialConsumeItemDto[];
}

const dateOnly = (s?: string) => { const d = s ? new Date(s) : new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); };

/**
 * Cuánto se puede echar atrás la fecha de una orden nueva. No es una regla del
 * negocio sino un cortafuegos contra el dedo: sin tope, un '2016-08-25' de más
 * entra sin chistar y la orden se va a un mes ya cerrado.
 */
const MAX_DIAS_ATRAS_ORDEN = 90;

/**
 * 'YYYY-MM-DD' → el `Date` que Prisma escribe en la columna `date` de la orden.
 *
 * Se arma en UTC a mano y NO con `new Date(texto)`: la sesión de Postgres corre en
 * Europe/Berlin y atar un `Date` local contra una columna `date` corre el día
 * entero (ver `sql-crudo-fechas-date`). Sin texto, hoy en Colombia.
 */
function diaDeLaOrden(fecha?: string, opciones?: { desde?: Date | null }): Date {
  if (!fecha?.trim()) return hoyEnColombia();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fecha.trim());
  if (!m) throw new BadRequestException('La fecha de la orden debe venir como YYYY-MM-DD.');
  const [y, mes, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dia = new Date(Date.UTC(y, mes - 1, d));
  // `Date.UTC(2026, 1, 31)` no falla: rueda al 3 de marzo. Sin esta comprobación un
  // "31 de febrero" quedaría guardado como otro día distinto del que se escribió.
  if (dia.getUTCFullYear() !== y || dia.getUTCMonth() !== mes - 1 || dia.getUTCDate() !== d) {
    throw new BadRequestException('Esa fecha no existe.');
  }
  const hoy = hoyEnColombia();
  if (dia.getTime() > hoy.getTime()) {
    throw new BadRequestException('La fecha de la orden no puede ser futura. Para un trabajo por venir, agéndala.');
  }
  // El suelo normal son 90 días atrás, pero al CORREGIR una orden vieja ese tope
  // no vale: una orden de hace dos años tiene que poder moverse un día sin que el
  // cortafuegos de las órdenes nuevas se lo impida. Por eso quien edita pasa la
  // fecha que la orden ya tenía y el suelo baja hasta ella.
  const sueloNormal = hoy.getTime() - MAX_DIAS_ATRAS_ORDEN * 86_400_000;
  const suelo = Math.min(sueloNormal, opciones?.desde?.getTime() ?? Infinity);
  if (dia.getTime() < suelo) {
    throw new BadRequestException(
      suelo === sueloNormal
        ? `La fecha de la orden no puede ser de hace más de ${MAX_DIAS_ATRAS_ORDEN} días.`
        : 'La fecha de la orden no puede quedar antes de la que ya tenía.',
    );
  }
  return dia;
}

/**
 * Qué pasó con la factura del mes al cambiarle el plan al cliente (ver
 * `reprecioDelPlanEnFactura`). `ok: false` no impide el cambio de plan: dice que la
 * factura de ESTE mes se quedó como estaba y por qué.
 */
type ReprecioDeFactura = {
  ok: boolean;
  /** Número de la factura mirada, si había alguna. */
  tid?: number;
  /** Cuánto se movió el total (positivo sube, negativo baja). */
  delta?: number;
  /** La frase que se lee en el cierre de la orden. */
  detalle: string;
};

export class SupportWriteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mikrotik: MikrotikService,
    private readonly geofence: GeofenceService,
    private readonly porCargo: ResponsibilityNotifierService,
    private readonly events: EmisorDeEventos,
    private readonly agenda: AgendaService,
    private readonly puntajes: OrderScoreService,
    /**
     * Opcional: sin él, cerrar una reconexión sigue devolviendo el servicio pero no
     * cobra los días que quedan del mes (ver `billing/prorrateo-reconexion.service.ts`).
     * Va al final y opcional para no obligar a las pruebas a montar facturación.
     */
    private readonly prorrateo?: ProrrateoReconexionService,
    /**
     * Opcional: los equipos de televisión (CPE por TR-069 / puerto CATV de la OLT).
     * Sin él, cerrar una orden de TV sigue dejando la ficha al día pero no enciende
     * ni apaga nada, y se dice en el mensaje del cierre en vez de fingir que se hizo.
     */
    private readonly genieacs?: GenieacsService,
    /**
     * Opcional: sin él, una orden que lleva cargo (traslado, agregar internet) se
     * abre igual —y el traslado cambia la dirección igual— pero no se factura nada
     * (ver `billing/cargo-orden.service.ts`). El trabajo entra siempre; lo que
     * puede faltar es la factura.
     */
    private readonly cargoOrden?: CargoOrdenService,
    /**
     * Opcional: sin él, una orden de 'Subir megas' / 'Bajar megas' se abre igual y
     * queda diciendo a qué plan va, pero no se le cambia al cliente — se dice en la
     * respuesta y hay que hacerlo a mano desde su ficha. Es el mismo `changePlan`
     * que usa el botón "Cambiar plan", no una copia.
     */
    private readonly planes?: SubscribersService,
    /**
     * Opcional: la VLAN de un equipo se lee del service-port de su ONU en la OLT
     * (ver `ubicarEquipo`). Sin él, mover la caja NAP funciona igual y la VLAN se
     * queda como estaba.
     */
    private readonly olt?: OltService,
  ) {}

  /**
   * Técnicos disponibles (Staff operativos).
   *
   * El cargo de técnico es el 2, no el 3 — ver `staff/cargos-legacy.ts`. Estaba
   * puesto el 3 (que son las cajeras) por el mapa de etiquetas que estuvo cambiado.
   * No alteraba la lista de puro milagro: `areaLegacy in (2,3,4)` ya cubre a los del
   * área Operativa, así que la condición equivocada no sumaba a nadie. Se corrige
   * igual, porque el día que alguien confíe en ese `role` se lleva la sorpresa.
   */
  async technicians() {
    const rows = await this.prisma.staff.findMany({
      where: { banned: false, OR: [{ role: CARGO_TECNICO }, { areaLegacy: { in: [2, 3, 4] } }] },
      orderBy: { name: 'asc' }, select: { id: true, legacyId: true, name: true },
    });
    return rows.map((r) => ({ id: r.id, legacyId: r.legacyId, name: r.name }));
  }

  /**
   * Traduce el texto de `assigned` al `Staff` real, para poder medir rendimiento
   * por técnico sin agrupar por un string libre.
   *
   * La UI manda el NOMBRE del técnico, pero las órdenes viejas del legacy traen su
   * nombre de usuario ('OmarTec'), así que se busca por ambos. Si no cruza, se
   * devuelve null y la orden queda con el texto pero sin atribuir: preferible a
   * colgársela al técnico equivocado.
   */
  private async resolverStaff(assigned?: string | null): Promise<string | null> {
    const a = assigned?.trim();
    if (!a) return null;
    const s = await this.prisma.staff.findFirst({
      where: { OR: [{ username: { equals: a, mode: 'insensitive' } }, { name: { equals: a, mode: 'insensitive' } }] },
      select: { id: true },
    });
    return s?.id ?? null;
  }

  /**
   * Nº de orden PROVISIONAL. Sale de una secuencia propia y no de `MAX(code)+1`, que es
   * un contador compartido con el legacy y ya repartió códigos duplicados.
   *
   * Provisional porque el número definitivo lo pone el legacy: si al empujar la orden
   * resulta que allá ese código ya es de otro trabajo, el writeback la renumera al
   * consecutivo de allá (y arrastra sus seguimientos). Como el empuje sale en el acto
   * —ver `TICKET_CREADO_EVENT`—, el cambio ocurre en segundos y es la excepción, pero
   * conviene saberlo antes de imprimir un número recién creado. Ver TID_SEQ.ticketCode.
   */
  private async nextCode(tx: Prisma.TransactionClient): Promise<number> {
    return nextTid(tx, TID_SEQ.ticketCode);
  }

  /**
   * Crear orden de servicio.
   *
   * @param opts.destinoOpcional  deja abrir un TRASLADO sin la dirección destino.
   *   Es para los trámites que entran por chat: allí el cliente dicta la dirección
   *   por WhatsApp, en texto libre, y esa no es una dirección que se pueda escribir
   *   en la ficha ni cobrar — el traslado además está sujeto a que haya cobertura,
   *   que lo confirma quien atienda la orden. Esas nacen como siempre: con la
   *   dirección dentro de la observación y sin cargo.
   * @param opts.planOpcional  deja abrir una orden de MEGAS sin el plan destino, por
   *   lo mismo: el cliente pide "más megas" por WhatsApp y a qué plan se pasa lo
   *   confirma quien atienda la orden, con el precio delante.
   * @param opts.yaFacturada  el trabajo YA SE COBRÓ y esta es la factura con la que
   *   se pagó. Es el camino de la factura de traslado (2026-09-08): allí se factura
   *   primero y la orden nace sola al pagarse, así que volver a llamar al cargo
   *   automático le cobraría al cliente los 30.000 dos veces. La orden se abre
   *   apuntando a ESA factura (`chargeInvoiceTid`, y `moveInvoiceTid` si es un
   *   traslado), que es como quedan las que sí se cobran al abrirse.
   */
  async createTicket(
    dto: CreateTicketDto,
    user: AuthUser,
    opts: {
      destinoOpcional?: boolean;
      planOpcional?: boolean;
      yaFacturada?: { tid: number; concepto?: string | null };
    } = {},
  ) {
    // El técnico de campo ATIENDE órdenes, no las abre (2026-07-31, decisión del
    // usuario): quien las genera es quien recibe al cliente —caja, administración o
    // el chatbot—, y así el trabajo entra por un solo sitio y con quién lo pidió.
    if (esTecnicoDeCampo(user)) {
      throw new ForbiddenException('No puedes crear órdenes de trabajo. Tú atiendes las que te asignan.');
    }
    const sub = await this.prisma.subscriber.findUnique({
      where: { id: dto.subscriberId },
      // `branch` sólo para dirigir el aviso de "orden sin técnico" a quien reparte
      // EN esa sede (ver `alcanzanSede`): sin él, la orden de Mocoa le sonaba
      // también a las cajeras de Villavicencio, que no la iban a repartir nunca.
      select: {
        id: true, nomenclature: true, addressLine: true, neighborhood: true,
        branch: { select: { legacyId: true } },
      },
    });
    if (!sub) throw new NotFoundException('Cliente no encontrado');
    // A dónde se muda, si es un traslado. Se resuelve ANTES de tocar nada: una
    // orden de traslado sin dirección destino no se abre.
    const traslado = this.prepararTraslado(dto, sub, opts.destinoOpcional === true);
    // Y a cuántas megas se pasa, si es de ésas. Se valida ANTES por lo mismo: una
    // orden de 'Subir megas' que no dice cuántas es la que manda al técnico a
    // preguntar por teléfono a qué velocidad tiene que dejar al cliente.
    const megas = await this.prepararCambioDeMegas(dto, sub.id, opts.planOpcional === true);
    const asignadoA = dto.assigned?.trim() || null;
    const assignedStaffId = await this.resolverStaff(asignadoA);

    // `subject` es la CLASE de la orden, no un titular libre: el legacy solo escribe
    // ahí servicio/reclamo/incidente y los reportes agrupan por eso.
    const clase = resolverClase(dto.subject, dto.type);
    // Si venía prosa (el chatbot manda "Re-visita: el cliente reporta…"), no se tira:
    // se guarda arriba de la observación, que es donde se lee el contexto.
    const prosa = dto.subject?.trim() && !esClaseOrden(dto.subject) ? dto.subject.trim() : null;
    // La dirección destino va también en la OBSERVACIÓN, que es la que viaja al
    // legacy: allá no hay columna donde meterla y es donde el técnico que sigue
    // trabajando en el sistema viejo la va a leer.
    const observacion = [prosa, traslado?.notaObservacion ?? null, megas?.notaObservacion ?? null, dto.section?.trim() || null]
      .filter(Boolean).join('\n') || null;

    if (dto.scheduledFor && !assignedStaffId) {
      throw new BadRequestException('Para agendar la orden hay que decir qué técnico la atiende.');
    }
    // La fecha y el motivo se validan ANTES de abrir la transacción: si vienen
    // torcidos no tiene sentido haber quemado ya un consecutivo de la secuencia.
    const diaCreacion = diaDeLaOrden(dto.created);
    // En un retiro, `problem` no es la falla sino POR QUÉ se va el cliente.
    const motivo = this.motivoDeRetiro(dto.type, dto.problem);
    const creada = await this.prisma.$transaction(async (tx) => {
      const code = await this.nextCode(tx);
      const t = await tx.ticket.create({
        data: {
          code, subject: clase, type: dto.type, created: diaCreacion, subscriberId: sub.id,
          // Quién la generó. `col` es lo de siempre (viaja al legacy); los tres campos
          // de al lado son los que responden "¿quién mandó esta visita?" sin adivinar.
          ...autorDeOrden(user),
          status: 'PENDIENTE', priority: dto.priority ?? 'Media', problem: motivo,
          section: observacion, assigned: asignadoA,
          // Solo se sella la hora si nace asignada; si no, la sella `assign()`.
          assignedStaffId, assignedAt: asignadoA ? new Date() : null,
          // El plazo solo se guarda en el tipo de orden que lo usa: si viniera en
          // cualquier otra, quedaría un número que nadie va a aplicar al cerrar.
          graceDays: esReconexionPorDias(dto.type) ? (dto.graceDays ?? null) : null,
          // Traslado: a dónde va, de dónde salió y cuándo se aplicó. La copia se
          // guarda aunque la ficha ya quede con la dirección nueva — la ficha solo
          // sabe dónde vive HOY, y dentro de un año esta orden tiene que seguir
          // diciendo de dónde a dónde se mudó.
          moveTo: traslado ? (traslado.destino as Prisma.InputJsonValue) : undefined,
          moveToText: traslado?.direccionNueva ?? undefined,
          moveFromText: traslado?.direccionVieja ?? undefined,
          moveAppliedAt: traslado ? new Date() : undefined,
          // Megas: a qué plan va y de cuál venía. Las copias del nombre y de las
          // megas se guardan aunque el plan siga en el catálogo — el catálogo se
          // renombra y se repreciona, y dentro de un año esta orden tiene que
          // seguir diciendo de cuánto a cuánto se subió. `planAppliedAt` lo sella
          // el cambio de plan, un paso más abajo.
          planToId: megas?.plan.id ?? undefined,
          planToName: megas?.plan.name ?? undefined,
          planToMegas: megas?.plan.megas ?? undefined,
          planFromName: megas?.actual?.nombre ?? undefined,
          planFromMegas: megas?.actual?.megas ?? undefined,
        },
      });
      // La dirección se cambia YA, al abrir la orden (decisión del usuario,
      // 2026-08-27): quien atiende al cliente la escribe una sola vez y la ficha
      // —y con ella el legacy, vía `editedAt`— queda al día desde ese momento.
      if (traslado) {
        await tx.subscriber.update({
          where: { id: sub.id },
          data: {
            ...traslado.fichaData,
            // Sin la marca, el sync de ida compara contra el MySQL vivo y a los 15
            // minutos devuelve la dirección VIEJA. Con ella manda nexus y el
            // writeback la empuja al legacy. Ver `Subscriber.editedAt` (que, a
            // diferencia del de las facturas, no lleva quién: quién la movió queda
            // en la orden, que es donde se puede preguntar por qué).
            editedAt: new Date(),
          },
        });
      }
      return { id: t.id, code: t.code };
    });

    // Una orden que nace SIN técnico es la que se pierde: nadie la siente suya y se
    // queda en la lista hasta que un cliente vuelve a llamar. Se le avisa al encargado
    // de soporte, que es quien reparte. Si nace asignada no se avisa a nadie: ya tiene
    // dueño, y avisar por algo que alguien acaba de hacer a conciencia es sólo ruido.
    if (!asignadoA) {
      await this.porCargo.notifyPost('soporte-tecnico', {
        kind: 'soporte.orden_sin_asignar',
        title: `Orden #${creada.code} sin técnico asignado`,
        body: `${ETIQUETA_CLASE[clase]} · ${dto.type}${dto.priority && dto.priority !== 'Media' ? ` · prioridad ${dto.priority}` : ''}`,
        link: `/soporte/${creada.id}`,
        groupKey: `ticket:${creada.id}`,
        sede: sub.branch?.legacyId ?? null,
      });
    }

    // EL PLAN NO SE APLICA AQUÍ (decisión del usuario, 2026-09-02, que revierte la
    // del mismo día). La orden dice a cuántas megas VA; el cliente sigue en su plan
    // —y pagando su precio— hasta que el técnico cierre la orden, que es cuando el
    // servicio existe de verdad. Cambiarlo al abrirla le subía la factura a alguien
    // que todavía navegaba a la velocidad vieja, y si la orden se anulaba nadie se
    // lo devolvía. El cambio, y con él el reprecio de la factura, vive en la cascada
    // del cierre (ver `applyCloseCascade`).

    // Agendar es un paso aparte y a propósito: lo hace `AgendaService.mover`, que es
    // quien sabe renumerar la cola del técnico. Duplicar esa lógica aquí era la forma
    // segura de que las dos se desincronizaran.
    if (dto.scheduledFor) {
      await this.agenda.mover(user, { ticketId: creada.id, staffId: assignedStaffId, fecha: dto.scheduledFor });
    }

    // EL CARGO DE LA ORDEN. Hay tipos de orden que se cobran al abrirlos —un pago
    // único, factura aparte de un renglón: el traslado (30.000) y agregar internet
    // (30.000)—. La lista está en `billing/cargos-orden.ts`; aquí solo se pregunta
    // si este tipo lleva cargo.
    //
    // Va FUERA de la transacción y no puede tumbar la creación: si la factura
    // falla, la orden ya existe y el técnico puede salir — lo que falta es cobrar,
    // y eso queda dicho en el log y en la respuesta, con la orden sin
    // `chargeInvoiceTid`.
    // El traslado es el único con condición: el que entra por chat nace SIN destino
    // (`destinoOpcional`) y ése no se cobra — la dirección está por confirmar y la
    // cobertura también, así que cobrarlo sería devolver la plata después.
    //
    // Y no se cobra NADA cuando el trabajo llega ya facturado (`yaFacturada`): la
    // orden que nace del pago de una factura de traslado se ata a esa factura y se
    // acabó — cobrar aquí sería el segundo cargo de 30.000 del mismo trabajo.
    //
    // Y tampoco cuando quien abre la orden DICE que ya está facturada
    // (`yaFacturadaTid`): es el mismo caso, pero a mano — la cajera cobra en
    // ventanilla y abre la orden después.
    const yaFacturada = opts.yaFacturada ?? (await this.facturaYaCobrada(dto, sub.id));
    const deEsteTipo = yaFacturada ? null : cargoDeTipoDeOrden(dto.type);
    const cargo = deEsteTipo && (!esTraslado(dto.type) || traslado) ? deEsteTipo : null;
    let cobro: ResultadoCargo | null = null;
    if (yaFacturada) {
      await this.prisma.ticket
        .update({
          where: { id: creada.id },
          data: {
            chargeInvoiceTid: yaFacturada.tid,
            chargeConcept: yaFacturada.concepto ?? null,
            ...(traslado ? { moveInvoiceTid: yaFacturada.tid } : {}),
          },
        })
        .catch(() => undefined);
    }
    if (cargo && this.cargoOrden) {
      cobro = await this.cargoOrden.cobrar(cargo, sub.id, {
        ctx: `orden #${creada.code}`,
        autor: user.name || user.email || 'Sistema',
        detalle: traslado ? `${traslado.direccionVieja ?? 'sin dirección'} → ${traslado.direccionNueva}` : undefined,
      });
      if (cobro.invoiceTid) {
        await this.prisma.ticket
          .update({
            where: { id: creada.id },
            data: {
              chargeInvoiceTid: cobro.invoiceTid,
              chargeConcept: cobro.concepto ?? cargo.etiqueta,
              // El traslado mantiene además su columna de siempre: es la que lee su
              // tarjeta en la ficha de la orden y la que tienen escrita las de agosto.
              ...(traslado ? { moveInvoiceTid: cobro.invoiceTid } : {}),
            },
          })
          .catch(() => undefined);
      }
    }

    // La orden sale hacia el legacy AHORA: es donde el técnico la va a ver.
    this.events.emit(TICKET_CREADO_EVENT, {
      ticketId: creada.id, code: creada.code, subscriberId: sub.id,
    });

    return {
      ...creada,
      // Lo que hay que DECIRLE a quien la abrió: se le movió la dirección al cliente
      // y se le emitió (o no) la factura del traslado. Sin esto la cajera no sabe si
      // tiene que cobrar algo en ventanilla.
      traslado: traslado
        ? {
            desde: traslado.direccionVieja,
            hasta: traslado.direccionNueva,
            // La factura es la que se acaba de emitir... o la que ya se había
            // pagado, si la orden nació justamente del pago de esa factura.
            factura: yaFacturada?.tid ?? cobro?.invoiceTid ?? null,
            cobrado: !!yaFacturada || (cobro?.cobrado ?? false),
            mensaje: yaFacturada
              ? `Ya estaba cobrado en la factura #${yaFacturada.tid}.`
              : cobro?.mensaje ?? 'No se facturó el traslado.',
          }
        : undefined,
      /**
       * LAS MEGAS: a cuánto quedó el cliente y si el plan se le llegó a cambiar. Es
       * lo que hay que decirle a quien abrió la orden — el precio de su próxima
       * factura acaba de cambiar—, y sobre todo cuando NO se aplicó: ahí queda
       * trabajo pendiente en la ficha del cliente.
       */
      megas: megas
        ? {
            de: megas.actual?.megas ?? null,
            a: megas.plan.megas ?? null,
            plan: megas.plan.name,
            resumen: megas.resumen,
            // Todavía no: el plan y el precio se le cambian al CERRAR la orden.
            aplicado: false,
            mensaje: `El cliente sigue en su plan de hoy; pasa a «${megas.plan.name}» cuando se cierre la orden.`,
          }
        : undefined,
      /**
       * Lo que se le facturó por abrir la orden, cuando su tipo lleva cargo. Es lo
       * que la cajera tiene que cobrar en ventanilla ANTES de que el cliente se
       * vaya: si no se le dice aquí, se entera cuando ya no está.
       */
      cargo: cargo && cobro
        ? {
            concepto: cobro.concepto ?? cargo.etiqueta,
            precio: cobro.precio,
            factura: cobro.invoiceTid ?? null,
            cobrado: cobro.cobrado,
            mensaje: cobro.mensaje,
          }
        : undefined,
    };
  }

  /**
   * El MOTIVO de un retiro, listo para guardar en `problem`.
   *
   * En una orden de baja, la casilla que en las demás lleva la falla reportada
   * lleva por qué se va el cliente, y es lista cerrada (`MOTIVOS_RETIRO`, la misma
   * del legacy): de esa columna sale el informe de por qué se pierden clientes, y
   * un texto libre —"se fue", "no quiso"— no se puede sumar con los 1.914 retiros
   * que ya están agrupados por esos veinte motivos.
   *
   * Se exige: una orden de retiro sin motivo es la que deja la pregunta sin
   * responder justo cuando todavía se sabe la respuesta.
   *
   * En cualquier otro tipo de orden devuelve lo que venga, que es la falla de
   * siempre y sí es texto libre.
   */
  private motivoDeRetiro(tipo: string, problem?: string | null): string | null {
    if (!esRetiroVoluntario(tipo)) return problem?.trim() || null;
    const motivo = motivoDeRetiroCanonico(problem);
    if (!motivo) {
      throw new BadRequestException(
        problem?.trim()
          ? `«${problem.trim()}» no es un motivo de retiro válido. Elige uno de la lista: ${MOTIVOS_RETIRO.join(', ')}.`
          : 'Di por qué se retira el cliente: la orden de retiro necesita el motivo.',
      );
    }
    return motivo;
  }

  /**
   * «Esto ya lo pagó»: la factura con la que se cobró el trabajo en ventanilla.
   *
   * Existe porque un mismo trabajo se puede cobrar por dos caminos —la factura
   * primero (motivo de `motivos-factura.ts`; la orden nace al pagarse) o la orden
   * primero (el cargo automático de `cargos-orden.ts`)— y quien factura a mano y
   * abre la orden después recorre los dos: el cliente acaba con dos facturas de
   * 30.000 del mismo trabajo (pasó con la #505077 el 2026-09-08).
   *
   * Se COMPRUEBA en vez de creérselo: el número viaja en el cuerpo de la petición y
   * atar la orden a la factura de otro cliente —o a una anulada, o a una que ya es
   * de otra orden— sería regalar el cargo. Y se lanza en vez de ignorarlo en
   * silencio: quien marcó la casilla cree que no se va a cobrar, y quedarse callado
   * es emitir la segunda factura sin decirlo.
   */
  private async facturaYaCobrada(
    dto: CreateTicketDto,
    subscriberId: string,
  ): Promise<{ tid: number; concepto?: string | null } | undefined> {
    const tid = dto.yaFacturadaTid;
    if (!tid) return undefined;
    const inv = await this.prisma.subInvoice.findUnique({
      where: { tid },
      select: {
        tid: true, subscriberId: true, status: true,
        items: { take: 1, select: { productName: true, description: true } },
      },
    });
    if (!inv || inv.subscriberId !== subscriberId) {
      throw new BadRequestException(`La factura #${tid} no es de este cliente.`);
    }
    if (inv.status === 'CANCELED') {
      throw new BadRequestException(`La factura #${tid} está anulada: no cobra nada.`);
    }
    const otra = await this.prisma.ticket.findFirst({
      where: { OR: [{ chargeInvoiceTid: tid }, { moveInvoiceTid: tid }] },
      select: { code: true },
    });
    if (otra) {
      throw new BadRequestException(`La factura #${tid} ya es de la orden #${otra.code}.`);
    }
    return { tid, concepto: inv.items[0]?.productName ?? inv.items[0]?.description ?? null };
  }

  /**
   * Valida y arma el traslado de una orden nueva: a dónde va el cliente, de dónde
   * sale y qué hay que escribirle en la ficha.
   *
   * Devuelve `null` si la orden no es un traslado — y ahí el `moveTo` que venga se
   * ignora a propósito, igual que los días de gracia fuera de la reconexión por
   * días: un dato que nadie va a aplicar no se guarda.
   */
  private prepararTraslado(
    dto: CreateTicketDto,
    sub: { nomenclature: unknown; addressLine: string | null; neighborhood: string | null },
    destinoOpcional = false,
  ) {
    if (!esTraslado(dto.type)) return null;
    if (!dto.moveTo) {
      if (destinoOpcional) return null;
      throw new BadRequestException('Una orden de traslado necesita la dirección nueva del cliente.');
    }
    return this.armarTraslado(dto.moveTo, sub);
  }

  /**
   * Valida el PLAN DE INTERNET de una orden nueva: a qué plan se pasa el cliente, de
   * cuál viene y qué hay que escribir en la orden.
   *
   * Cubre las dos órdenes que llevan plan destino (`ordenLlevaPlanInternet`):
   *   · 'Subir megas' / 'Bajar megas' — el cliente se MUEVE de un plan a otro; hay
   *     un plan de origen y el sentido tiene que cuadrar con el nombre de la orden.
   *   · 'AgregarInternet' — el cliente NO tiene internet y se le pone el primero:
   *     no hay origen que comparar ni sentido que comprobar, y si ya lo tuviera la
   *     orden está mal abierta (para eso están las de megas).
   *
   * Devuelve `null` si la orden no lleva plan — y ahí el `planToId` que venga se
   * ignora a propósito, igual que los días de gracia fuera de la reconexión por
   * días: un dato que nadie va a aplicar no se guarda.
   *
   * `planOpcional` deja abrirla sin plan. Es para lo que entra por el chatbot: allí
   * el cliente dice "quiero más megas" por WhatsApp y el plan concreto lo confirma
   * quien atienda la orden (con cobertura y precio delante), igual que el destino de
   * un traslado dictado por chat.
   */
  private async prepararCambioDeMegas(
    dto: { type?: string | null; planToId?: string },
    subscriberId: string,
    planOpcional = false,
    origenFijo?: { planId: string | null; nombre: string | null; megas: number | null } | null,
  ) {
    if (!ordenLlevaPlanInternet(dto.type)) return null;
    const alta = esAgregarInternet(dto.type);
    if (!dto.planToId) {
      if (planOpcional) return null;
      throw new BadRequestException(
        alta
          ? 'Di con qué plan de internet queda el cliente: sin plan, cerrar la orden no le monta nada.'
          : 'Di a qué plan se pasa el cliente: una orden de megas sin plan no dice cuántas son.',
      );
    }
    const plan = await this.prisma.plan.findUnique({
      where: { id: dto.planToId },
      select: { id: true, name: true, kind: true, megas: true, active: true },
    });
    if (!plan) throw new NotFoundException('El plan elegido ya no está en el catálogo.');
    if (plan.kind !== 'INTERNET') {
      throw new BadRequestException(`«${plan.name}» no es un plan de internet: las megas se cambian sobre ese servicio.`);
    }
    // Mismo tope que "Cambiar plan" desde la ficha: un plan oculto no se le VENDE a
    // nadie. La diferencia con aquel es que allá se puede forzar (`allowInactive`)
    // para corregir lo que el cliente ya paga; aquí se está vendiendo velocidad nueva.
    if (!plan.active) {
      throw new BadRequestException(`El plan «${plan.name}» está oculto en el catálogo: actívalo o elige otro.`);
    }

    // De cuánto viene. El ACTIVO manda si tiene varios, y las megas se caen al
    // catálogo cuando el servicio no las trae (los abonados heredados del legacy).
    //
    // `origenFijo` lo impone quien CORRIGE una orden que ya movió al cliente: ahí el
    // plan vigente es el que puso la propia orden, y medir contra él haría que
    // arreglar un 'Subir megas' de 5→100 mal tecleado (debía ser 50) se leyera como
    // una bajada. El de cuánto venía es el de cuando se abrió, y ese no cambia.
    let actual = origenFijo ?? null;
    if (origenFijo === undefined) {
      const internetes = await this.prisma.subscriberService.findMany({
        where: { subscriberId, kind: 'INTERNET' },
        select: { planId: true, planName: true, megas: true, status: true, plan: { select: { name: true, megas: true } } },
      });
      const suyo = internetes.find((s) => s.status === 'ACTIVO') ?? internetes[0] ?? null;
      actual = suyo
        ? { planId: suyo.planId, nombre: suyo.planName ?? suyo.plan?.name ?? null, megas: suyo.megas ?? suyo.plan?.megas ?? null }
        : null;
    }

    // En un alta de internet, tener ya el servicio contratado es la señal de que la
    // orden está mal elegida: lo que se quiere ahí es 'Subir megas' / 'Bajar megas'.
    // Se mira que la fila exista con plan, no que esté ACTIVA: un internet cortado
    // sigue siendo internet contratado y no se "agrega" otra vez.
    if (alta && actual?.planId) {
      throw new BadRequestException(
        `El cliente ya tiene internet contratado («${actual.nombre ?? 'plan sin nombre'}»). `
        + 'Para moverlo de plan usa \'Subir megas\' o \'Bajar megas\'.',
      );
    }
    if (actual?.planId && actual.planId === plan.id) {
      throw new BadRequestException(`El cliente ya está en «${plan.name}»: esa orden no le cambia nada.`);
    }
    // El error de dedo de siempre: elegir en el desplegable el plan de al lado y
    // dejar una orden que dice 'Subir megas' y baja la velocidad. Sólo se puede
    // comprobar cuando los dos planes dicen sus megas.
    const sentido = sentidoDeMegas(dto.type);
    if (sentido && plan.megas != null && actual?.megas != null) {
      if (sentido === 'SUBIR' && plan.megas <= actual.megas) {
        throw new BadRequestException(
          `«${plan.name}» (${plan.megas} Megas) no sube nada: el cliente ya tiene ${actual.megas}. Usa 'Bajar megas' o elige un plan mayor.`,
        );
      }
      if (sentido === 'BAJAR' && plan.megas >= actual.megas) {
        throw new BadRequestException(
          `«${plan.name}» (${plan.megas} Megas) no baja nada: el cliente tiene ${actual.megas}. Usa 'Subir megas' o elige un plan menor.`,
        );
      }
    }

    // En el alta no hay "de dónde": la frase dice con qué queda, no de cuánto a
    // cuánto. Escribir "de plan sin registrar a 300 Megas" en una orden de agregar
    // internet sólo confunde a quien la lee (aquí y en el legacy, que recibe esta
    // misma línea dentro de la observación).
    const deA = alta
      ? `con ${plan.megas != null ? `${plan.megas} Megas` : plan.name}`
      : `de ${actual?.megas != null ? `${actual.megas} Megas` : actual?.nombre ?? 'plan sin registrar'}`
        + ` a ${plan.megas != null ? `${plan.megas} Megas` : plan.name}`;
    return {
      plan,
      actual,
      /** La frase que se lee en la orden y que viaja al legacy dentro de la observación. */
      notaObservacion: `${dto.type}: ${deA} (plan «${plan.name}»).`,
      resumen: deA,
    };
  }

  /**
   * Le cambia el plan al abonado por el que dice la orden, AL ABRIRLA.
   *
   * Misma decisión que la dirección del traslado (2026-08-27): quien atiende al
   * cliente lo escribe una sola vez y la ficha queda al día desde ese momento. Aquí
   * además hace falta para que el resto encaje — el botón "aplicar velocidad" de la
   * orden lee el plan VIGENTE del abonado para sacar el traffic-table de la OLT, así
   * que si el plan se aplicara al cerrar, el técnico dejaría la ONU a la velocidad
   * vieja y el cambio de plan llegaría después, sin nadie que lo empujara a la red.
   *
   * No puede tumbar la creación: si el cambio falla, la orden ya existe y lo que
   * falta es el plan, que se dice en la respuesta y queda sin `planAppliedAt`.
   */
  /**
   * EL CAMBIO DE PLAN de una orden de megas, AL CERRARLA.
   *
   * Al abrirla la orden sólo dice a dónde va; el cliente no se mueve hasta que el
   * técnico cierra (decisión del usuario, 2026-09-02). Aquí pasan las dos cosas que
   * hacen falta para que el cambio sea real y no sólo un número en la ficha:
   *
   *   1) El PLAN en la ficha: precio de la próxima factura, perfil PPP que se le
   *      empuja al Mikrotik y —vía `PlanOltProfile`— el traffic-table de la OLT.
   *   2) La FACTURA DEL MES, repreciada al valor del plan nuevo. Sin esto el cliente
   *      navega a 100 Megas y paga las 5 hasta la corrida del mes siguiente.
   *
   * `allowInactive`: al abrir la orden el plan se validó activo; si entre tanto lo
   * ocultaron del catálogo, no se puede dejar al cliente con la velocidad puesta y
   * el plan sin cambiar — la venta ya se hizo.
   *
   * No puede tumbar el cierre: si algo falla, la orden queda cerrada y sin
   * `planAppliedAt`, y el mensaje dice qué quedó por hacer y dónde.
   */
  private async aplicarMegasDeLaOrden(
    ticketId: string | null,
    subscriberId: string,
    planId: string,
    code: number | null,
    user?: AuthUser,
  ): Promise<{ aplicado: boolean; mensaje: string; factura?: ReprecioDeFactura }> {
    const plan = await this.prisma.plan
      .findUnique({ where: { id: planId }, select: { id: true, name: true, megas: true, price: true, taxRate: true } })
      .catch(() => null);
    if (!plan) {
      return { aplicado: false, mensaje: 'El plan que traía la orden ya no está en el catálogo: cámbiaselo al cliente desde su ficha.' };
    }
    if (!this.planes) {
      return { aplicado: false, mensaje: `No se le cambió el plan a «${plan.name}»: hazlo desde su ficha (Cambiar plan).` };
    }
    let router: { ok: boolean; message: string } | null = null;
    try {
      const r = await this.planes.changePlan(subscriberId, plan.id, user, { allowInactive: true });
      router = r.router ? { ok: r.router.ok, message: r.router.message } : null;
    } catch (e) {
      return {
        aplicado: false,
        mensaje: `No se le pudo cambiar el plan a «${plan.name}»: ${(e as Error).message}. Hazlo desde su ficha (Cambiar plan).`,
      };
    }
    if (ticketId) {
      await this.prisma.ticket
        .update({ where: { id: ticketId }, data: { planAppliedAt: new Date() } })
        .catch(() => undefined);
    }

    // Y la factura del mes al valor del plan nuevo.
    const factura = await this.reprecioDelPlanEnFactura(subscriberId, plan, code, user);

    const partes = [`El cliente quedó en «${plan.name}»${plan.megas != null ? ` (${plan.megas} Megas)` : ''}.`];
    partes.push(factura.detalle);
    // En PPPoE la velocidad ES el perfil del plan: si el empuje no salió hay que
    // decirlo, o el cliente paga el plan nuevo navegando con el viejo.
    if (router && !router.ok) partes.push(`El router no tomó el perfil: ${router.message}`);
    return { aplicado: true, mensaje: partes.join(' '), factura };
  }

  /**
   * EL ALTA DE INTERNET de una orden 'AgregarInternet', AL CERRARLA.
   *
   * El cliente que sólo tenía televisión sale de aquí con internet contratado. Son
   * cuatro cosas y ninguna se puede saltar, porque cada una la lee un sitio distinto:
   *
   *   1) El SERVICIO en la ficha (`SubscriberService` de kind INTERNET, vía el mismo
   *      `changePlan` del botón "Cambiar plan"): es lo que factura la corrida mensual
   *      y lo que la ficha enseña como "sus servicios". Sin esto el cliente sigue
   *      "saliendo solo la TV" por más que el técnico haya cerrado la orden.
   *   2) El USUARIO PPPoE, si no lo tenía: los que llegan del legacy con televisión
   *      sola traen `name_s` de relleno y sin usuario no hay secret que crear.
   *   3) El SECRET en el Mikrotik (`provision`, no `applyProfile`): el secret todavía
   *      no existe, así que hay que crearlo —con el perfil que el paso 1 acaba de
   *      dejar en la ficha—, no editarlo. `provision` adopta el que ya esté.
   *   4) LOS DÍAS QUE QUEDAN DEL MES, por el mismo prorrateo que cobra una
   *      reconexión: el internet entra a mitad de mes y se cobra desde hoy, no el mes
   *      entero. Aquí NO se reprecia ningún renglón —a diferencia de un cambio de
   *      megas— porque no hay renglón de internet que repreciar: es un servicio que
   *      no estaba en la factura.
   *
   * El orden importa: 1 antes que 3 (igual que en el alta de cliente, `alta.service.ts`)
   * y 1 antes que 4 (el prorrateo saca el precio del `SubscriberService`).
   *
   * No puede tumbar el cierre. Si algo falla, la orden queda cerrada, sin
   * `planAppliedAt`, y el mensaje dice exactamente qué quedó por hacer y dónde.
   */
  private async aplicarAltaDeInternet(
    ticketId: string | null,
    subscriberId: string,
    planId: string | null,
    code: number | null,
    user?: AuthUser,
  ): Promise<{ aplicado: boolean; mensaje: string; prorrateo?: unknown; router?: { ok: boolean; message: string } }> {
    if (!planId) {
      return {
        aplicado: false,
        mensaje: 'Esta orden no dice con qué plan de internet queda el cliente: asígnaselo desde su ficha (Cambiar plan).',
      };
    }
    const plan = await this.prisma.plan
      .findUnique({ where: { id: planId }, select: { id: true, name: true, megas: true } })
      .catch(() => null);
    if (!plan) {
      return { aplicado: false, mensaje: 'El plan que traía la orden ya no está en el catálogo: asígnaselo al cliente desde su ficha.' };
    }
    if (!this.planes) {
      return { aplicado: false, mensaje: `No se le montó el internet «${plan.name}»: hazlo desde su ficha (Cambiar plan).` };
    }

    // 1) El servicio contratado + el perfil PPP en la ficha. `pushRouter: false`
    // porque el secret aún no existe: empujarle el perfil sólo devolvería un error
    // confuso y el paso 3 lo crea ya con ese perfil.
    try {
      await this.planes.changePlan(subscriberId, plan.id, user, { allowInactive: true, pushRouter: false });
    } catch (e) {
      return {
        aplicado: false,
        mensaje: `No se le pudo montar el internet «${plan.name}»: ${(e as Error).message}. Hazlo desde su ficha (Cambiar plan).`,
      };
    }
    if (ticketId) {
      await this.prisma.ticket
        .update({ where: { id: ticketId }, data: { planAppliedAt: new Date() } })
        .catch(() => undefined);
    }
    const partes = [`El cliente quedó con internet «${plan.name}»${plan.megas != null ? ` (${plan.megas} Megas)` : ''}.`];

    // 2 y 3) Usuario PPPoE y secret en el router. Que el router no responda no
    // deshace el contrato: se dice y se reintenta desde la ficha.
    let router: { ok: boolean; message: string } | undefined;
    try {
      const cred = await this.planes.asegurarCredencialesPpp(subscriberId, user);
      if (!cred.ok) {
        partes.push(`No se creó el secret: ${cred.motivo}`);
      } else {
        if (cred.creado) partes.push(`Usuario PPPoE ${cred.pppUsername} creado.`);
        const r = await this.mikrotik.provision(subscriberId, user);
        router = { ok: r.ok, message: r.message };
        partes.push(r.ok ? r.message : `El router no tomó el alta: ${r.error ?? r.message}`);
      }
    } catch (e) {
      router = { ok: false, message: (e as Error).message };
      partes.push(`No se pudo dar de alta en el router: ${(e as Error).message}. Reinténtalo desde la ficha.`);
    }

    // 4) Los días que quedan del mes. Mismo cobro que una reconexión: el renglón cae
    // en la factura del mes (o en una nueva si esa ya está pagada o timbrada), y si
    // el internet ya estuviera facturado este mes no cobra nada — cerrar dos veces la
    // orden no cobra dos veces.
    let prorrateo: unknown;
    if (this.prorrateo) {
      const p = await this.prorrateo.aplicar(subscriberId, ['INTERNET'], {
        ctx: code ? `orden #${code}` : 'alta de internet al cerrar la orden',
        autor: user?.name || user?.email || 'Sistema',
      });
      prorrateo = p;
      partes.push(p.mensaje);
    } else {
      partes.push('Los días que quedan del mes no se cobraron: revisa su factura.');
    }

    return { aplicado: true, mensaje: partes.join(' '), prorrateo, router };
  }

  /**
   * Deja la factura del MES CORRIENTE al valor del plan nuevo.
   *
   * Se reprecia el RENGLÓN del internet, no se añade uno: el cliente no contrató un
   * servicio más, cambió el que tenía. El encabezado se mueve por la DIFERENCIA y no
   * se recalcula sumando renglones a propósito — los ítems traídos del legacy guardan
   * el IVA DENTRO de `subtotal` y los de aquí fuera (ver `dos convenciones`), así que
   * volver a sumarlos rompería las facturas heredadas. La base siempre es `price`.
   *
   * NO se toca una factura que ya no se puede tocar, y se dice por qué:
   *   · timbrada ante la DIAN → ese documento se ajusta por nota crédito;
   *   · anulada, o sin renglón de internet;
   *   · si el reprecio la dejaría por debajo de lo ya pagado (bajar megas sobre una
   *     factura cobrada): eso es un saldo a favor, no una edición.
   * En todos esos casos el plan SÍ queda cambiado —lo que se cobra desde la próxima
   * corrida es el nuevo— y el mensaje dice qué le falta a la del mes.
   */
  private async reprecioDelPlanEnFactura(
    subscriberId: string,
    plan: { id: string; name: string; price: Prisma.Decimal | number; taxRate: Prisma.Decimal | number },
    code: number | null,
    user?: AuthUser,
  ): Promise<ReprecioDeFactura> {
    try {
      const hoy = hoyEnColombia();
      const desde = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), 1));
      const hasta = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() + 1, 1));
      const inv = await this.prisma.subInvoice.findFirst({
        where: { subscriberId, kind: 'RECURRENTE', invoiceDate: { gte: desde, lt: hasta } },
        orderBy: [{ invoiceDate: 'desc' }, { tid: 'desc' }],
        include: {
          items: { orderBy: { id: 'asc' } },
          electronicInvoices: { select: { type: true, dianNumber: true } },
        },
      });
      if (!inv) {
        return { ok: false, detalle: 'No tiene factura de este mes: el plan nuevo se le cobra en la próxima corrida.' };
      }
      if (inv.status === 'CANCELED') {
        return { ok: false, tid: inv.tid, detalle: `La factura Nº ${inv.tid} está anulada: emítele una nueva con el plan nuevo.` };
      }
      if (inv.electronicInvoices.some((e) => e.type === 'FACTURADA' && e.dianNumber)) {
        return { ok: false, tid: inv.tid, detalle: `La factura Nº ${inv.tid} ya se emitió ante la DIAN y no se toca: ajústala con una nota crédito.` };
      }

      // El renglón del internet: el que lleva por nombre un plan de internet del
      // catálogo (es como lo escribe la corrida y como lo lee `planDeUltimaFactura`).
      const norma = (v: string | null | undefined) => (v ?? '').trim().toLowerCase();
      const internet = await this.prisma.plan.findMany({ where: { kind: 'INTERNET' }, select: { name: true } });
      const nombres = new Set(internet.map((p) => norma(p.name)));
      const linea = inv.items.find((it) => nombres.has(norma(it.productName ?? it.description)));
      if (!linea) {
        return { ok: false, tid: inv.tid, detalle: `La factura Nº ${inv.tid} no trae renglón de internet: revísala a mano.` };
      }

      const qty = linea.qty || 1;
      const baseVieja = round2(num(linea.price) * qty);
      const ivaViejo = num(linea.taxTotal);
      const baseNueva = round2(num(plan.price) * qty);
      const ivaNuevo = round2((baseNueva * num(plan.taxRate)) / 100);
      const deltaBase = round2(baseNueva - baseVieja);
      const deltaIva = round2(ivaNuevo - ivaViejo);
      if (deltaBase === 0 && deltaIva === 0 && norma(linea.productName) === norma(plan.name)) {
        return { ok: true, tid: inv.tid, detalle: `La factura Nº ${inv.tid} ya estaba al valor del plan.`, delta: 0 };
      }

      const totalNuevo = round2(num(inv.total) + deltaBase + deltaIva);
      const pagado = num(inv.paidAmount);
      if (totalNuevo < pagado) {
        return {
          ok: false, tid: inv.tid,
          detalle: `La factura Nº ${inv.tid} ya tiene ${pagado.toLocaleString('es-CO')} pagados y el plan nuevo la dejaría por debajo: hazle una nota crédito.`,
        };
      }

      // El `subtotal` del renglón respeta la convención con la que se escribió: los
      // que vienen del legacy lo traen con el IVA adentro.
      const ivaDentro = ivaViejo > 0 && Math.abs(num(linea.subtotal) - (baseVieja + ivaViejo)) < 0.01;
      const antes = { plan: linea.productName, base: baseVieja, iva: ivaViejo };

      await this.prisma.$transaction(async (tx) => {
        await tx.subInvoiceItem.update({
          where: { id: linea.id },
          data: {
            productName: plan.name,
            description: plan.name,
            price: num(plan.price),
            taxRate: num(plan.taxRate),
            taxTotal: ivaNuevo,
            subtotal: ivaDentro ? round2(baseNueva + ivaNuevo) : baseNueva,
          },
        });
        await tx.subInvoice.update({
          where: { id: inv.id },
          data: {
            subtotal: round2(num(inv.subtotal) + deltaBase),
            tax: round2(num(inv.tax) + deltaIva),
            total: totalNuevo,
            status: totalNuevo <= pagado ? 'PAID' : pagado > 0 ? 'PARTIAL' : 'DUE',
            // `serviceCombo` es la ÚNICA fuente que tiene el legacy para saber en qué
            // plan está el cliente (ver `facturaQueDictaElPlan`): sin esto la corrida
            // de allá le volvería a facturar el plan viejo.
            serviceCombo: plan.name,
            serviceAssignedAt: new Date(),
            serviceAssignedBy: user?.name ?? user?.email ?? null,
            // Sin `editedAt` la ida del sync devuelve el renglón viejo en la próxima
            // pasada de 15 minutos; con él manda nexus y el writeback lo empuja.
            editedAt: new Date(),
            editedBy: user?.name ?? user?.email ?? null,
            editCount: { increment: 1 },
          },
        });
        await tx.auditLog.create({
          data: {
            action: 'UPDATE', entity: 'SubInvoice', entityId: inv.id,
            before: antes,
            after: {
              plan: plan.name, base: baseNueva, iva: ivaNuevo, total: totalNuevo,
              motivo: code ? `cierre de la orden #${code} (cambio de megas)` : 'cambio de megas al cerrar la orden',
              by: user?.name ?? user?.email ?? null,
            },
          },
        }).catch(() => undefined);
      });

      const signo = deltaBase + deltaIva >= 0 ? 'sube' : 'baja';
      return {
        ok: true, tid: inv.tid, delta: round2(deltaBase + deltaIva),
        detalle: `La factura Nº ${inv.tid} ${signo} a ${totalNuevo.toLocaleString('es-CO')} con el plan «${plan.name}».`,
      };
    } catch (e) {
      return { ok: false, detalle: `No se pudo repreciar la factura del mes: ${(e as Error).message}. Edítala a mano.` };
    }
  }

  /**
   * Deja en la observación UNA sola frase de megas: la nueva.
   *
   * La frase (`Subir megas: de 5 Megas a 100 Megas (plan «100 MEGAS»).`) se escribe
   * al abrir la orden porque es lo que viaja al legacy —allá no hay columna para el
   * plan— y lo que el técnico lee en la orden impresa. Al corregir el plan hay que
   * quitar la vieja: dos frases seguidas dejan la orden diciendo dos velocidades
   * distintas, y la que el técnico lea es cuestión de suerte.
   *
   * Se reconoce por el «(plan «…»)» del final, que es lo que la distingue de lo que
   * escribe una persona ("solicita aumento a 100 megas"), que no se toca.
   */
  private conNotaDeMegas(section: string | null, nota: string): string {
    const RASTRO = /\(plan «[^»]*»\)/i;
    const limpio = (section ?? '')
      .split('\n')
      .filter((l) => !(RASTRO.test(l) && /megas/i.test(l)))
      .join('\n')
      .trim();
    return [limpio, nota].filter(Boolean).join('\n').slice(0, 1500);
  }

  /**
   * El destino de un traslado. La mecánica vive en `common/traslado.ts` porque la
   * comparten la orden y la factura de traslado; aquí solo se llama.
   */
  private armarTraslado(moveTo: TrasladoDto, sub: FichaParaTraslado) {
    return armarTraslado(moveTo, sub);
  }

  /**
   * Orden de servicio SIN abonado, para quien todavía no es cliente.
   *
   * La pide el chatbot cuando un número desconocido quiere una afiliación, pregunta
   * por cobertura o pone una PQR (ver TramitesToolset). Antes eso solo podía acabar en
   * la bandeja de WhatsApp como un chat más: si nadie lo leía ese día se perdía, y no
   * quedaba nada estructurado que revisar después.
   *
   * Va aparte de `createTicket` y no como un parámetro opcional suyo a propósito:
   * `createTicket` exige un abonado que existe y ese chequeo es justamente lo que
   * protege al resto del ERP de órdenes colgadas de la nada. `Ticket.subscriberId` es
   * nullable en el esquema, así que la fila es perfectamente válida; lo que no hay es
   * cascada al cerrarla (`applyCloseCascade` necesita un abonado), que es lo correcto:
   * no hay servicio que activar hasta que la venta se concrete y el cliente exista.
   */
  async createLeadTicket(input: {
    subject: string;
    type: string;
    problem?: string;
    section?: string;
    priority?: string;
    /** Cargo al que se avisa. Sin él, a quien reparte lo que llega sin dueño. */
    post?: string;
    actor: AuthUser;
  }) {
    const creada = await this.prisma.$transaction(async (tx) => {
      const code = await this.nextCode(tx);
      const t = await tx.ticket.create({
        data: {
          code,
          subject: input.subject,
          type: input.type,
          created: dateOnly(),
          subscriberId: null,
          ...autorDeOrden(input.actor),
          status: 'PENDIENTE',
          priority: input.priority ?? 'Media',
          problem: input.problem ?? null,
          section: input.section ?? null,
        },
      });
      return { id: t.id, code: t.code };
    });

    await this.porCargo.notifyPost(input.post ?? 'call-center', {
      kind: 'soporte.solicitud_sin_cliente',
      title: `${input.subject} — #${creada.code}`,
      body: `${input.type}${input.problem ? ` · ${input.problem}` : ''}`,
      link: `/soporte/${creada.id}`,
      groupKey: `ticket:${creada.id}`,
    });

    return creada;
  }

  async updateStatus(id: string, dto: UpdateStatusDto, user?: AuthUser, ip?: string | null) {
    const t = await this.prisma.ticket.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('Orden no encontrada');

    // Una orden a la vez, y ésta es la ÚNICA puerta (2026-09-10, réplica del legacy:
    // `Tickets.php` → `update_status`, `if ($status=="Realizando")`). Sólo se mira al
    // EMPEZAR: con una orden ya empezada encima no se empieza una segunda. Cerrarla,
    // anularla, devolverla a pendiente o documentarla no se bloquea nunca — si el
    // cierre también se bloqueara, la orden que ancla no habría forma de quitarla de
    // en medio.
    //
    // Los procesos internos (cron, sync, facturación) no traen usuario y siguen
    // pasando, que es lo que hace que la reconexión automática pueda mover su orden
    // aunque el técnico tenga una empezada.
    if (user?.id && dto.status === 'REALIZANDO') {
      const ficha = await fichaDelUsuario(this.prisma, user);
      if (ficha) {
        const v = await puedeEmpezarOrden(this.prisma, ficha.id, { id }, user);
        if (!v.permitido) throw new ForbiddenException({ message: v.motivo, code: 'ORDEN_EN_CURSO', enCurso: v.enCurso });
      }
    }

    // Bloqueo de cierre sin firma (porta Tickets.php). Desactivable con
    // TICKET_REQUIRE_SIGNATURE=false. Solo aplica al pasar a RESUELTO.
    //
    // Las reconexiones quedan fuera: se resuelven desde el sistema (al pagar
    // vuelve el servicio) y no hay nadie enfrente que firme el acta, así que
    // pedir la firma solo dejaba trabajo hecho sin poder cerrar.
    if (
      dto.status === 'RESUELTO' &&
      process.env.TICKET_REQUIRE_SIGNATURE !== 'false' &&
      !esReconexion(t.type) &&
      !t.signatureName
    ) {
      throw new BadRequestException('No se puede cerrar la orden sin la firma de quien recibe. Registra la firma primero.');
    }

    // Registro fotográfico: una visita a domicilio no se cierra sin evidencia
    // (2026-09-10). Va ANTES de la geo-cerca a propósito — es el requisito más
    // barato de comprobar y el más fácil de arreglar para quien está en la puerta:
    // si le faltan las dos cosas, que la primera que se le pida sea la foto, que ya
    // lleva hecha, y no que discuta con el GPS.
    if (dto.status === 'RESUELTO') await this.exigirRegistroFotografico(t, user);

    // IP remota: la visita no se cierra dejando al cliente sin acceso remoto
    // (2026-09-10). Detrás de la foto y delante de la cerca: ver `exigirIpRemota`.
    if (dto.status === 'RESUELTO') await this.exigirIpRemota(t, user);

    // Geo-cerca: un técnico no cierra una visita a domicilio sin haber estado
    // allí. Lanza si hay que frenar el cierre; sólo aplica al pasar a RESUELTO
    // (ANULADA no: anular una orden es justamente decir que no se hizo).
    const cerca =
      dto.status === 'RESUELTO'
        ? await this.geofence.evaluar(
            { id, code: t.code, type: t.type, subscriberId: t.subscriberId },
            dto,
            user,
            ip,
          )
        : null;

    const data: Prisma.TicketUpdateInput = { status: dto.status };
    if (dto.status === 'RESUELTO') {
      data.finalDate = dto.finalDate ? dateOnly(dto.finalDate) : dateOnly();
      // Con hora, y siempre "ahora": `finalDate` acepta una fecha que escribe el
      // usuario y por eso no sirve para medir. Este sello es del sistema.
      data.resolvedAt = new Date();
      if (cerca) Object.assign(data, cerca.datos);
      // Puntaje del trabajo: se copia el valor que tiene el tipo AHORA, para que
      // un ajuste posterior de la tabla no reescriba lo ya abonado. Ver
      // `Ticket.score` y order-score.policy.ts.
      data.score = await this.puntajes.puntajeDe(t.type);
      data.scoredAt = new Date();
    } else if (t.score != null) {
      // Reabrir o anular una orden le quita los puntos: se abonan por trabajo
      // terminado. Si se vuelve a cerrar, se vuelven a sellar con el valor de
      // ese momento — que es lo correcto, porque es otro cierre.
      data.score = null;
      data.scoredAt = null;
    }
    // El estado y el cierre son cosas que el legacy también guarda: la orden pasa a
    // ser nuestra para que la ida no la revierta y el writeback la empuje. Ver
    // `Ticket.editedAt`.
    data.editedAt = new Date();
    data.editedBy = user?.name ?? user?.email ?? null;
    await this.prisma.ticket.update({ where: { id }, data });

    if (cerca) await this.registrarCierreGeo(id, t.code, t.subscriberId, cerca, user);

    // --- Cascada al resolver: ajusta el estado del cliente + Mikrotik según el tipo
    // de orden (porta Tickets.php). Las operaciones Mikrotik respetan su gate dry-run.
    let cascade: any = {};
    if (dto.status === 'RESUELTO' && t.subscriberId) {
      cascade = await this.applyCloseCascade({ ticketId: id, subscriberId: t.subscriberId, type: t.type, graceDays: t.graceDays, code: t.code, moveToText: t.moveToText, planToId: t.planToId, planToName: t.planToName, planToMegas: t.planToMegas }, user);
    }

    // Aviso para quien quiera reaccionar al cierre. Hoy lo escucha el chatbot, que le
    // pregunta al cliente si de verdad le quedó funcionando (ver
    // TicketConfirmacionService). Va por evento y no por llamada directa porque
    // soporte no conoce —ni debe conocer— el canal de WhatsApp.
    if (dto.status === 'RESUELTO') {
      this.events.emit(TICKET_RESUELTO_EVENT, {
        ticketId: id, code: t.code, type: t.type,
        subscriberId: t.subscriberId, abiertaPor: t.col,
      } satisfies TicketResueltoEvent);
    }
    // Anular deshace lo que se apartó al abrir: el equipo reservado vuelve a bodega.
    if (dto.status === 'ANULADA') {
      this.events.emit(TICKET_ANULADA_EVENT, { ticketId: id, code: t.code, subscriberId: t.subscriberId });
    }

    // La baja sale hacia el legacy EN EL ACTO: si no llega antes de la siguiente ida
    // del sync (15 min), el legacy devuelve su 'Activo' y el retiro se deshace solo.
    // También cuando la baja no le cambió el ESTADO al abonado y sólo bajó un servicio
    // en su factura (una 'Suspension Television'): eso también hay que contárselo al
    // legacy antes de la siguiente ida, o lo deshace igual.
    if (t.subscriberId && (cascade.statusSet === 'RETIRADO' || cascade.statusSet === 'SUSPENDIDO' || cascade.factura?.ok)) {
      this.events.emit(BAJA_APLICADA_EVENT, {
        subscriberId: t.subscriberId, estado: cascade.statusSet ?? 'SUSPENDIDO', code: t.code,
      } satisfies BajaAplicadaEvent);
    }

    // Y la RECONEXIÓN, con la misma prisa y por el mismo motivo que la baja: el corte
    // vive en el estado del abonado Y en el `estado_combo`/`estado_tv` de su factura,
    // los dos de los que manda el legacy en la ida. Lo que no llegue allá antes de la
    // siguiente pasada se deshace solo y el cliente vuelve a salir cortado con el
    // internet funcionando (orden #505799, 09-09-2026). Se emite tanto si volvió el
    // estado como si sólo se levantó el corte de la factura —una reconexión de sólo
    // televisión no le cambia el estado a nadie, igual que la suspensión de sólo TV—.
    if (t.subscriberId
        && (cascade.facturaReconexion?.ok === true && !cascade.facturaReconexion?.sinCambio
          || cascade.statusSet === 'ACTIVO' || cascade.statusSet === 'COMPROMISO')
        && (esReconexion(t.type) || (t.type || '').toLowerCase().includes('activ'))) {
      this.events.emit(RECONEXION_APLICADA_ORDEN_EVENT, {
        subscriberId: t.subscriberId, code: t.code,
      } satisfies ReconexionAplicadaOrdenEvent);
    }

    // Y la ACTIVACIÓN por instalación, con la misma prisa y por el mismo motivo: el
    // legacy tiene al recién instalado en 'Instalar' y su ida devuelve ese estado cada
    // 15 minutos, así que la activación que no llegue antes se deshace sola y el técnico
    // ve al cliente "por instalar" al día siguiente de haberlo instalado.
    // `cascade.activacion` = venía en 'INSTALAR' y quedó ACTIVO, sea cual sea la
    // orden que lo consiguió (un 'AgregarInternet' o una 'Migracion' también
    // instalan). El nombre de la orden se sigue mirando porque una instalación que
    // reactiva a un CORTADO también hay que empujarla con prisa.
    if (t.subscriberId && cascade.statusSet === 'ACTIVO'
        && (cascade.activacion || (t.type || '').toLowerCase().includes('instalac'))) {
      this.events.emit(ACTIVACION_APLICADA_EVENT, {
        subscriberId: t.subscriberId, code: t.code,
      } satisfies ActivacionAplicadaEvent);
    }
    return { id, status: dto.status, cascade };
  }

  /**
   * Frena el cierre de una visita a domicilio que no tiene ni una foto
   * (2026-09-10, del requerimiento: «exigir registro fotográfico como requisito
   * obligatorio para cerrar la orden»). La regla —a quién y a qué órdenes— vive en
   * `foto-cierre.policy.ts`; aquí sólo se cuentan las fotos y se lanza.
   *
   * **Las fotos cuelgan del NÚMERO de orden** (`TicketThread.ticketCode`), no del
   * id: así las guarda el legacy y así las escribe `addAttachment`. Una orden sin
   * número no puede tener fotos —el propio endpoint de subida la rechaza— y por eso
   * queda fuera del requisito: exigírsela sería dejarla abierta para siempre.
   *
   * Es 422 y no 400, igual que la geo-cerca: la petición está bien formada y lo que
   * falla es una regla de negocio que el técnico puede cumplir y reintentar. El
   * `code` viaja para que la pantalla sepa ofrecerle la cámara en vez de un error.
   *
   * Se apaga con `TICKET_REQUIRE_PHOTO=false`, como la firma con
   * `TICKET_REQUIRE_SIGNATURE`: el día que una cuadrilla se quede sin cobertura para
   * subir imágenes, la empresa tiene que poder seguir cerrando órdenes.
   */
  private async exigirRegistroFotografico(
    t: { code: number | null; type: string | null },
    user?: AuthUser,
  ) {
    const activo = process.env.TICKET_REQUIRE_PHOTO !== 'false';
    if (!activo || t.code == null) return;
    const tiposCampo = await this.geofence.tiposCampo();
    // Sólo se cuentan las fotos si la orden es de las que las exigen: es una
    // consulta que no hay por qué hacer en el 85% de los cierres (los remotos).
    const entrada = {
      activo,
      tipoOrden: t.type,
      tiposCampo,
      permisosUsuario: user?.permissions,
      hayUsuario: Boolean(user?.id),
      fotos: 0,
    };
    if (!faltaLaFoto(entrada)) return;
    const fotos = await this.prisma.ticketThread.count({
      where: { ticketCode: t.code, attach: { not: null } },
    });
    if (!faltaLaFoto({ ...entrada, fotos })) return;
    throw new HttpException({ code: 'FOTO_REQUERIDA', message: SIN_FOTO }, HttpStatus.UNPROCESSABLE_ENTITY);
  }

  /**
   * IP remota obligatoria para cerrar una visita (2026-09-10, a petición del
   * usuario: «no dejarle cerrar órdenes si el cliente no tiene IP Remota activa,
   * para que sistemas pueda acceder remotamente»).
   *
   * Las reglas —a quién sí y a quién no— están en `ip-remota.policy.ts`, sin base de
   * datos. Aquí sólo se traen los dos datos del abonado que hacen falta: si tiene
   * internet (usuario PPPoE de verdad) y qué dirección trae la ficha.
   *
   * Va DESPUÉS de la foto y ANTES de la geo-cerca, por lo mismo que ella: es lo que
   * se puede arreglar sin moverse —el botón «Asignar IP remota» de la propia orden la
   * reparte y la escribe en el router—, y discutir con el GPS es siempre lo último.
   *
   * `code` viaja para que la pantalla ofrezca ese botón en vez de un error seco.
   * Se apaga con `TICKET_REQUIRE_REMOTE_IP=false`, como la foto y la firma.
   */
  private async exigirIpRemota(
    t: { type: string | null; subscriberId: string | null },
    user?: AuthUser,
  ) {
    const activo = process.env.TICKET_REQUIRE_REMOTE_IP !== 'false';
    if (!activo) return;
    const tiposCampo = await this.geofence.tiposCampo();
    const entrada = {
      activo,
      tipoOrden: t.type,
      tiposCampo,
      permisosUsuario: user?.permissions,
      hayUsuario: Boolean(user?.id),
      hayCliente: Boolean(t.subscriberId),
      // Optimistas a propósito: con estos dos valores la política ya descarta el 85%
      // de los cierres (los que no son de campo) sin ir a buscar al abonado.
      tieneInternet: true,
      ipRemota: null as string | null,
    };
    if (!faltaLaIpRemota(entrada)) return;

    const sub = await this.prisma.subscriber.findUnique({
      where: { id: t.subscriberId! },
      select: { pppUsername: true, ipRemote: true },
    });
    const real = {
      ...entrada,
      tieneInternet: esUsuarioPppUtil(sub?.pppUsername),
      ipRemota: sub?.ipRemote ?? null,
    };
    if (!faltaLaIpRemota(real)) return;
    throw new HttpException({ code: 'IP_REMOTA_REQUERIDA', message: SIN_IP_REMOTA }, HttpStatus.UNPROCESSABLE_ENTITY);
  }

  /**
   * Le activa la IP remota al cliente de esta orden: la reparte el sistema y la
   * escribe en el `/ppp/secret` (ver `MikrotikService.garantizarIpRemota`).
   *
   * Es la salida del bloqueo de arriba, y por eso vive en soporte y no en Red: el
   * técnico que está en la puerta del cliente no entra al módulo Red — ni tiene por
   * qué—, y un candado sin forma de abrirlo desde donde se choca con él es una
   * cadena. El alcance por sede es el mismo que el de la orden.
   */
  async activarIpRemota(ticketId: string, user?: AuthUser) {
    const t = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      select: { id: true, code: true, subscriberId: true, assignedStaffId: true },
    });
    if (!t) throw new NotFoundException('Orden no encontrada');
    if (!t.subscriberId) throw new BadRequestException('Esta orden no tiene cliente: no hay IP remota que activar.');
    // Que la orden sea SUYA basta para el alcance, igual que al abrir su detalle: el
    // técnico llega aquí desde la orden que está atendiendo, y exigirle además que el
    // cliente sea de su sede lo dejaría con el candado del cierre y sin la llave.
    const ficha = esTecnicoDeCampo(user) ? await fichaDelUsuario(this.prisma, user!) : null;
    if (!ficha || t.assignedStaffId !== ficha.id) {
      await exigirSedeSuscriptor(this.prisma, user, t.subscriberId);
    }

    const r = await this.mikrotik.garantizarIpRemota(t.subscriberId, user);
    // Queda en el hilo de la orden: al día siguiente, "por qué a este cliente le
    // cambió la IP" se responde mirando la orden en la que se hizo.
    if (r.ok && t.code != null) {
      await this.prisma.ticketThread
        .create({
          data: {
            ticketCode: t.code,
            message: r.dryRun
              ? `IP remota (simulación): ${r.message}`
              : `IP remota activada: ${r.ip} en ${r.mikrotik?.name ?? 'el router'}.`,
            subscriberId: t.subscriberId,
            date: new Date(),
            ...(await this.firmaDeSeguimiento(user)),
          },
        })
        .catch(() => undefined);
    }
    return { ok: r.ok, ip: r.ip, dryRun: r.dryRun, message: r.message, steps: r.steps, error: r.error };
  }

  /**
   * Efectos del cierre georreferenciado: deja el rastro del técnico, georreferencia
   * al abonado si no lo estaba, y anota en el hilo cuando se cerró fuera de rango.
   *
   * Nada de esto puede tumbar el cierre: la orden YA se guardó. Si falla anotar
   * el punto, se pierde el apunte, no el trabajo del técnico.
   */
  private async registrarCierreGeo(
    ticketId: string,
    ticketCode: number | null,
    subscriberId: string | null,
    cerca: ResultadoCerca,
    user?: AuthUser,
  ) {
    const { datos, georreferenciar, veredicto } = cerca;

    if (datos.closeLat != null && datos.closeLng != null && user) {
      await this.prisma.geoPing
        .create({
          data: {
            userId: user.id, userName: user.name,
            lat: datos.closeLat, lng: datos.closeLng,
            accuracy: datos.closeAccuracyM,
            reason: 'ticket.close',
            refType: 'ticket', refId: ticketId,
            flags: cerca.senales,
          },
        })
        .catch(() => undefined);
    }

    // El cliente no tenía coordenada y ahora sí: cada cierre en campo va
    // llenando el mapa, que es lo que hará que la cerca sirva de verdad.
    if (georreferenciar && subscriberId) {
      await this.prisma.subscriber
        .update({
          where: { id: subscriberId },
          data: {
            gpsLat: georreferenciar.lat.toFixed(6),
            gpsLng: georreferenciar.lng.toFixed(6),
            // `editedAt` NO es decoración (2026-09-03). Sin el sello, la ida del
            // sync pisa `gpsLat` con el `coor1` vacío del legacy en la siguiente
            // pasada —15 minutos— y el writeback tampoco se lo lleva allá, que
            // sólo empuja fichas con `editedAt`. O sea: la coordenada que el
            // técnico dejó parado en la puerta del cliente se perdía entera, y en
            // silencio. Es el mismo sello que ya ponía `setSubscriberLocation`
            // para el botón "Capturar GPS aquí"; aquí faltaba.
            editedAt: new Date(),
          },
        })
        .catch(() => undefined);
    }

    // Un cierre fuera de rango tiene que verse en la propia orden, no sólo en un
    // informe que nadie abre. Desde el 2026-09-10 esto sólo puede pasar en modo
    // observación o con un usuario EXENTO (el técnico ya no puede cerrar fuera de
    // rango de ninguna manera), y en los dos casos interesa que quede dicho.
    if (veredicto.accion === 'permitir-marcado') {
      const dist = Math.round(veredicto.distanciaM);
      const quien = user?.name ?? 'Sistema';
      await this.noteOnThread(
        ticketCode,
        subscriberId,
        `⚠ Cierre fuera del rango permitido: ${quien} estaba a ${dist} m del domicilio `
        + `(máximo ${veredicto.radioM} m) (registrado en modo observación, sin bloquear).`,
        user,
      ).catch(() => undefined);
    }
  }

  /** ¿Auto-cobrar en la cascada de cierre? Ajuste `tickets.cascadeBilling` (o env TICKET_CASCADE_BILLING). */
  private async cascadeBillingEnabled(): Promise<boolean> {
    if (process.env.TICKET_CASCADE_BILLING === 'true') return true;
    const row = await this.prisma.appSetting.findUnique({ where: { key: 'tickets.cascadeBilling' } });
    return row?.value === 'true';
  }

  /**
   * ¿A este abonado hay televisión que tocarle?
   *
   * Se pregunta antes de encender o apagar el puerto CATV en una orden GENÉRICA
   * ('Instalacion', 'Activacion', 'Reconexion' a secas): esas no dicen de qué
   * servicio hablan, y encenderle la TV a un cliente que solo tiene internet es
   * regalarle un servicio que nadie le factura.
   *
   * Se mira por dos vías porque `SubscriberService` no está completo: solo se pobló
   * para los abonados en ACTIVO, así que a los 2.350 que no lo están hay que
   * preguntarles por su última factura (ver `servicios-contratados-incompletos`).
   */
  private async tieneTv(sid: string): Promise<boolean> {
    const servicio = await this.prisma.subscriberService
      .count({ where: { subscriberId: sid, kind: { in: ['TV', 'PUNTOS'] } } })
      .catch(() => 0);
    if (servicio > 0) return true;
    const factura = await this.prisma.subInvoice
      .findFirst({
        where: { subscriberId: sid, OR: [{ serviceTv: { not: null } }, { serviceCombo: { not: null } }] },
        orderBy: { invoiceDate: 'desc' },
        select: { serviceTv: true, serviceCombo: true },
      })
      .catch(() => null);
    return !!(factura?.serviceTv?.trim() || factura?.serviceCombo?.trim());
  }

  /**
   * Devuelve —o quita— la SEÑAL DE TELEVISIÓN al cerrar la orden.
   *
   * Esto faltaba, y es el agujero que dejaba a la gente sin televisión después de
   * que se le cerrara la reconexión: la cascada solo hablaba con el Mikrotik, que es
   * el internet. La TV vive en otro equipo (el CPE por TR-069, o el puerto CATV de
   * la OLT si la ONT no habla TR-069), así que cerrar 'Reconexion Television'
   * reconectaba el internet, marcaba al cliente ACTIVO y no encendía nada: el
   * técnico daba el trabajo por hecho y el cliente seguía con la pantalla en negro.
   *
   * El estado del servicio en la ficha se marca SIEMPRE, aunque el equipo no
   * conteste y aunque el gate esté en dry-run —a diferencia del camino automático
   * del pago, que no escribe lo que no tocó—. La diferencia es quién lo dice: aquí
   * hay una persona cerrando la orden, y cerrar una orden ES afirmar que el trabajo
   * quedó hecho (lo normal es que lo haya hecho en sitio, que es justo para lo que
   * se abrió la visita). Si no se marcara, ese cliente volvería a salir "por
   * reconectar" en el siguiente pago y se le abriría otra orden.
   */
  private async aplicarTv(sid: string, enable: boolean, user?: AuthUser) {
    const marcarFicha = () =>
      this.prisma.subscriberService
        .updateMany({
          where: { subscriberId: sid, kind: { in: ['TV', 'PUNTOS'] } },
          data: { status: enable ? 'ACTIVO' : 'CORTADO' },
        })
        .catch(() => undefined);

    if (!this.genieacs) {
      await marcarFicha();
      return { ok: false, via: null, detalle: 'La TV no se intentó por red: el módulo de equipos no está cableado.' };
    }
    try {
      // Con tope: cerrar una orden no puede quedarse colgado esperando al ACS o a una
      // sesión SSH contra la OLT. Si se pasa, se dice y el trabajo se da por hecho en
      // sitio (mismo criterio que el tope de la caja en `ReconexionService`).
      const r: any = await Promise.race([
        this.genieacs.tvBatchBySubscribers([sid], enable, user),
        new Promise((_, rechazar) =>
          setTimeout(() => rechazar(new Error('los equipos no contestaron a tiempo.')), ESPERA_EQUIPOS_MS).unref?.(),
        ),
      ]);
      const fila = (r?.results ?? []).find((x: any) => x.subscriberId === sid);
      await marcarFicha();
      return {
        ok: !!fila?.ok,
        via: fila?.via ?? null,
        dryRun: !!fila?.dryRun,
        detalle: fila?.detail ?? (fila?.ok ? 'Hecho.' : 'El equipo no aplicó el cambio.'),
      };
    } catch (e) {
      await marcarFicha();
      return { ok: false, via: null, detalle: (e as Error).message };
    }
  }

  /**
   * Cascada al cerrar una orden ("Resuelto"), según el tipo (porta Tickets.php):
   *   corte → CORTADO+cut · suspensión → SUSPENDIDO+cut · retiro → RETIRADO+cut ·
   *   reconexión/activación → ACTIVO+reconnect · instalación → ACTIVO+reconnect ·
   *   plan/megas y traslado → nota (la orden no porta el destino; se hace aparte).
   * Los cargos (reconexión/instalación) solo se aplican si `cascadeBilling` está activo.
   *
   * Y CADA COSA EN SU EQUIPO: el nombre de la orden dice si el trabajo es del
   * internet, de la televisión o de los dos (`serviciosDeOrden`), y eso decide a
   * quién se le habla. Antes todo iba al Mikrotik, con dos consecuencias que se
   * veían en la calle: 'Reconexion Television' no devolvía la señal (y de paso
   * reconectaba el internet de quien seguía debiendo) y 'Corte Television' dejaba
   * sin internet a alguien que solo debía perder la TV.
   */
  private async applyCloseCascade(t: { ticketId?: string; subscriberId: string; type: string | null; graceDays?: number | null; code?: number | null; moveToText?: string | null; planToId?: string | null; planToName?: string | null; planToMegas?: number | null }, user?: AuthUser) {
    const cascade: any = {};
    const kind = (t.type || '').toLowerCase();
    const sid = t.subscriberId;

    const servicios = serviciosDeOrden(t.type);
    const tocaInternet = servicios.includes('INTERNET');
    // Explícita = el nombre nombra la televisión ('… Television', '… Combo'). En esas
    // se actúa sin preguntar; en las genéricas, solo si el abonado tiene TV.
    const tvExplicita = /televi|combo/.test(kind);
    const tocaTv = servicios.includes('TV') && (tvExplicita || (await this.tieneTv(sid)));
    /**
     * Una orden que SOLO es de televisión no cambia el estado del abonado: cortarle
     * la TV no lo deja CORTADO ni devolvérsela lo pone ACTIVO —el estado habla del
     * servicio principal—. Escribirlo era además una trampa con dientes: cerrar una
     * 'Suspension Television' lo dejaba SUSPENDIDO, y SUSPENDIDO está fuera de los
     * estados que reconecta un pago, así que ese cliente pagaba y no volvía nunca.
     */
    const soloTv = tocaTv && !tocaInternet;

    /**
     * Cambia el estado del abonado y DEJA CONSTANCIA.
     *
     * Las dos cosas que faltaban aquí y que el legacy sí hace en el mismo acto
     * (`Tickets.php`): guardar el estado anterior en `previousStatus` —que es su
     * `customers.ultimo_estado`— y escribir la fila de historial (su tabla
     * `estados`). La fila no es papeleo: `pushEstados` es quien la lleva al legacy,
     * y un cambio de estado del que el legacy no se entera lo DESHACE la ida del
     * sync en la siguiente pasada, porque el estado es de los `CAMPOS_DE_ALLA`.
     * Así se cerró un 'Retiro voluntario' el 31-08-2026 y el cliente volvió a
     * ACTIVO diecisiete minutos después.
     *
     * `previo` es el estado de ANTES de tocar los equipos, para cuando quien llama ya
     * lo movió sin dejar rastro: `MikrotikService.reconnect` pone ACTIVO al abonado por
     * su cuenta, así que preguntarlo aquí devolvería el estado nuevo, la comparación de
     * abajo diría "no hay cambio que historiar" y la reconexión se quedaría otra vez
     * sin constancia —justo lo que se quiere arreglar—.
     */
    const setStatus = async (status: string, nota: string, opts: { aunqueSoloTv?: boolean; previo?: string | null } = {}) => {
      if (soloTv && !opts.aunqueSoloTv) return;
      const ahora = new Date();
      const antes = opts.previo !== undefined
        ? { status: opts.previo }
        : await this.prisma.subscriber
          .findUnique({ where: { id: sid }, select: { status: true } })
          .catch(() => null);
      await this.prisma.subscriber
        .update({
          where: { id: sid },
          data: { previousStatus: (antes?.status as any) ?? undefined, status: status as any, statusChangedAt: ahora },
        })
        .catch(() => undefined);
      cascade.statusSet = status;
      // El que estaba POR INSTALAR y queda activo es un caso aparte: hay que
      // contárselo al legacy en el acto o su ida lo devuelve a 'Instalar' en la
      // siguiente pasada (ver `ACTIVACION_APLICADA_EVENT`).
      if (antes?.status === 'INSTALAR' && status === 'ACTIVO') cascade.activacion = true;
      // Ya estaba en ese estado: no hay cambio que historiar (cerrar dos veces la
      // misma orden no puede dejar dos filas).
      if (antes?.status === status) return;
      await this.prisma.subscriberStatusHistory
        .create({
          data: {
            subscriberId: sid,
            status: status as any,
            date: ahora,
            originTicketId: t.code ?? null,
            note: t.code ? `${nota} (orden #${t.code})` : nota,
          },
        })
        .catch(() => undefined);
    };
    const tryCut = async () => {
      if (tocaInternet) {
        try { cascade.mikrotik = await this.mikrotik.cut(sid, user); }
        catch (e) { cascade.note = `Corte Mikrotik: ${(e as Error).message}`; }
      }
      if (tocaTv) cascade.tv = await this.aplicarTv(sid, false, user);
    };
    const tryReconnect = async () => {
      if (tocaInternet) {
        try { cascade.mikrotik = await this.mikrotik.reconnect(sid, user); cascade.statusSet = 'ACTIVO'; }
        catch (e) { cascade.note = `Reconexión Mikrotik: ${(e as Error).message}`; }
      }
      if (tocaTv) cascade.tv = await this.aplicarTv(sid, true, user);
      // Y SE LEVANTA EL CORTE EN LA FACTURA, que es de donde la ficha lee qué servicio
      // está caído. Faltaba —y es la contraparte exacta de `marcarBajaEnFactura`, que
      // el corte sí tiene—: se cerraba la 'Reconexion Internet', el router devolvía al
      // cliente a ACTIVOS y su ficha seguía pintando el internet en rojo porque nadie
      // tocaba `estadoCombo` (orden #505799, 09-09-2026, abonado 2131).
      // Clave propia (no `cascade.factura`, que es la de la baja): la baja y la
      // reconexión se empujan al legacy por puertas distintas y con gates distintos.
      cascade.facturaReconexion = await this.levantarCorteEnFactura(sid, servicios, soloTv);
      // Y EN LA LÍNEA DE SERVICIO, que es la OTRA mitad de donde se lee el corte. La
      // televisión ya lo hace dentro de `aplicarTv` (`marcarFicha`, en los dos
      // sentidos); el internet no tenía contraparte ninguna.
      cascade.servicioReconexion = await this.levantarCorteEnServicio(sid, servicios);
    };

    // AGREGAR INTERNET va lo primero y por el predicado, no por `includes`: el
    // nombre 'AgregarInternet' no cae en ninguna de las palabras de abajo (ni
    // 'megas' ni 'plan' ni 'instalac'), y por eso cerrar una de estas órdenes no
    // hacía absolutamente nada — se cobraba el cargo al abrirla y el cliente se
    // quedaba con la televisión sola.
    if (esAgregarInternet(t.type)) {
      cascade.internet = await this.aplicarAltaDeInternet(t.ticketId ?? null, sid, t.planToId ?? null, t.code ?? null, user);
      cascade.note = cascade.internet.mensaje;
    } else if (kind.includes('retiro')) {
      await tryCut();
      await setStatus('RETIRADO', 'Retiro');
      cascade.factura = await this.marcarBajaEnFactura(sid, servicios, 'RETIRADO', soloTv);
    } else if (kind.includes('suspens')) {
      await tryCut();
      await setStatus('SUSPENDIDO', 'Suspensión');
      cascade.factura = await this.marcarBajaEnFactura(sid, servicios, 'SUSPENDIDO', soloTv);
    } else if (kind.includes('corte')) {
      await tryCut(); // cut() ya deja el cliente CORTADO
      // Salvo que el corte sea SOLO de televisión: ese no lo deja cortado a él.
      if (!soloTv) cascade.statusSet = cascade.statusSet ?? 'CORTADO';
      // Y se anota EN LA FACTURA qué servicio cayó, que es de donde la ficha lo lee.
      // Faltaba: cerrar un 'Corte Television' apagaba el CATV y dejaba la ficha
      // diciendo que la televisión seguía al aire (#504965, 31-08-2026). Al cortado
      // por mora se lo escribe el legacy; al que se corta desde aquí, nadie.
      cascade.factura = await this.marcarBajaEnFactura(sid, servicios, 'CORTADO', soloTv);
    } else if (kind.includes('instalac')) {
      await tryReconnect();
      await setStatus('ACTIVO', 'Instalación');
      if (await this.cascadeBillingEnabled()) cascade.charge = await this.applyReconnectionCharge(sid, kind);
      cascade.note = (cascade.note ? cascade.note + ' · ' : '') + 'Instalación resuelta: cliente activado.';
    } else if (kind.includes('reconex') || kind.includes('activ')) {
      // El estado de ANTES de tocar el router: `mikrotik.reconnect` lo pone ACTIVO por
      // dentro, así que después ya no hay forma de saber de dónde venía.
      const antesDeReconectar = soloTv ? null : await this.prisma.subscriber
        .findUnique({ where: { id: sid }, select: { status: true } })
        .catch(() => null);
      await tryReconnect();

      /**
       * Y SE DEJA CONSTANCIA del ACTIVO, igual que hacen el retiro, la suspensión y la
       * instalación en sus ramas. Aquí no había ninguna: el estado lo movía por dentro
       * `MikrotikService.markStatus`, en silencio y sin fila de historial. Sin esa fila
       * la reconexión no existe para nadie más:
       *  · `pushEstados` y `pushReconexiones` (el writeback) sacan de ahí a quién
       *    empujar al legacy, así que la reconexión no llegaba allá y la ida devolvía
       *    su 'Cortado' quince minutos después, y
       *  · la ficha se queda sin el renglón que explica por qué el cliente volvió.
       *
       * `setStatus` ya respeta que una orden sólo de televisión no cambia el estado del
       * abonado. Lo que se respeta aparte es el ACUERDO DE PAGO: a un COMPROMISO se le
       * devuelve el servicio pero no se le borra el acuerdo poniéndolo ACTIVO (ver
       * `estado-al-reconectar.ts`). Y la reconexión POR DÍAS de aquí abajo escribe su
       * propio COMPROMISO, así que tampoco se le pone ACTIVO antes.
       */
      const porDias = esReconexionPorDias(t.type) && (t.graceDays ?? 0) > 0;
      if (!porDias && !soloTv && !conservaEstadoAlReconectar(antesDeReconectar?.status)) {
        await setStatus('ACTIVO', 'Reconexión', { previo: antesDeReconectar?.status ?? null });
      }

      // Reconexión POR DÍAS: no basta con devolver el servicio, hay que dejar
      // dicho hasta cuándo. Se traduce a COMPROMISO + `promiseExpiry`, que es la
      // pareja que el corte masivo ya respeta (`filterCuttable`): protegido
      // mientras la fecha no pase, y cortable de nuevo en cuanto pase. Así no
      // hace falta un cron nuevo que ande recortando a nadie.
      if (esReconexionPorDias(t.type) && (t.graceDays ?? 0) > 0) {
        const dias = t.graceDays!;
        const vence = new Date(hoyEnColombia());
        vence.setUTCDate(vence.getUTCDate() + dias);
        await this.prisma.subscriber
          .update({
            where: { id: sid },
            data: { status: 'COMPROMISO', statusChangedAt: new Date(), promiseExpiry: vence },
          })
          .catch(() => undefined);
        cascade.statusSet = 'COMPROMISO';
        cascade.graceDays = dias;
        cascade.graceUntil = vence.toISOString().slice(0, 10);
        cascade.note = (cascade.note ? cascade.note + ' · ' : '')
          + `Reconectado por ${dias} día(s): vence el ${cascade.graceUntil} y vuelve a ser cortable.`;
      }

      if (await this.cascadeBillingEnabled()) cascade.charge = await this.applyReconnectionCharge(sid, kind);

      // Los días que quedan del mes, cuando el servicio venía cortado desde antes de
      // la corrida de facturación (las órdenes "…2" del legacy). Ésta es la OTRA
      // puerta por la que vuelve un servicio: no el pago en caja —que ya cobra por su
      // cuenta en `ReconexionService`— sino el técnico que lo restablece en sitio.
      //
      // No se mira el nombre de la orden sino la factura del mes: si el renglón del
      // servicio ya está, no se cobra nada. Eso es lo que hace que las dos puertas no
      // se pisen y que cerrar dos veces la misma orden no cobre dos veces.
      if (this.prorrateo) {
        cascade.prorrateo = await this.prorrateo.aplicar(sid, serviciosDeReconexion(t.type), {
          ctx: t.code ? `orden #${t.code}` : 'cierre de orden',
          autor: user?.name || user?.email || 'Sistema',
        });
      }
    } else if (kind.includes('megas') || kind.includes('plan') || kind.includes('perfil')) {
      // AQUÍ es donde el cliente cambia de plan (decisión del usuario, 2026-09-02):
      // no al abrir la orden sino al cerrarla, que es cuando la velocidad nueva ya
      // está puesta. Se le cambia el plan en la ficha (precio y perfil PPP) y se le
      // reprecia la factura del mes al valor del plan nuevo — sin eso, el cliente
      // navega a 100 Megas y paga las 5 hasta la corrida del mes siguiente.
      if (t.planToId) {
        cascade.megas = await this.aplicarMegasDeLaOrden(t.ticketId ?? null, sid, t.planToId, t.code ?? null, user);
        cascade.note = cascade.megas.mensaje;
      } else {
        cascade.note = 'Cambio de plan/megas: aplica el nuevo plan al cliente desde su ficha (Cambiar plan); la orden no porta el plan destino.';
      }
    } else if (kind.includes('traslado')) {
      // Desde 2026-08-27 la orden de 'Traslado' SÍ porta el destino y la dirección
      // ya se le cambió al cliente al abrirla, así que aquí no hay nada que mover:
      // solo se recuerda a dónde quedó. Las que se abrieron antes —y el 'Traslado
      // interno de equipos', que no cambia de casa— siguen con el aviso de siempre.
      cascade.note = t.moveToText
        ? `Traslado resuelto: el cliente quedó en ${t.moveToText}.`
        : 'Traslado resuelto: actualiza la dirección del cliente en su ficha (esta orden no porta la nueva dirección).';
    }

    /**
     * RED DE SEGURIDAD: ninguno de los cinco trabajos que dejan al cliente
     * conectado puede cerrarse dejándolo en 'INSTALAR' (`esTrabajoDeConexion`).
     *
     * La instalación ya lo activa en su rama, pero las otras cuatro no tenían
     * ninguna: cerrar un 'AgregarInternet', una 'Migracion', un 'Traslado' o un
     * 'Cambio de equipo' no tocaba el estado, y el abonado que venía en 'INSTALAR'
     * —el legacy los pone ahí al abrir la visita— se quedaba ahí para siempre.
     * En 'INSTALAR' NO SE FACTURA: es un cliente conectado, con la ONU autenticada,
     * al que se dejó de cobrar (el abonado 3653 llevaba así desde el 19-08-2025).
     *
     * Solo LEVANTA ese estado: cualquier otro (CORTADO, RETIRADO, CARTERA…) se
     * respeta, porque ahí el estado lo puso otra cosa y no es esta orden quien
     * tiene que decidirlo. Y se hace aunque la orden sea sólo de televisión: al
     * que se le acaba de instalar la TV también se le terminó el trabajo.
     */
    if (esTrabajoDeConexion(t.type) && cascade.statusSet !== 'ACTIVO') {
      const actual = await this.prisma.subscriber
        .findUnique({ where: { id: sid }, select: { status: true } })
        .catch(() => null);
      if (actual?.status === 'INSTALAR') {
        await setStatus('ACTIVO', 'Trabajo terminado en sitio', { aunqueSoloTv: true });
        cascade.note = (cascade.note ? cascade.note + ' · ' : '')
          + 'El cliente seguía en «Por instalar» y quedó ACTIVO al cerrar esta orden.';
      }
    }

    cascade.mensaje = this.mensajeDeCascada(cascade);
    return cascade;
  }

  /**
   * Baja del servicio EN LA FACTURA, que es donde la ficha lee qué está caído.
   *
   * Es la contraparte de `ReconexionService.levantarCorteDeFactura` y hace lo mismo
   * que el legacy al cerrar un 'Retiro voluntario' o una suspensión (`Tickets.php`):
   * `estado_tv` / `estado_combo` a 'Suspendido' y el `ron` de la factura al estado
   * nuevo del abonado. Sin esto la ficha seguía pintando el servicio al aire —lee
   * `estadoTv`/`estadoCombo`, no el estado del cliente— después de un retiro.
   *
   * SÓLO la factura vigente y sólo del servicio que la orden nombra: al que suspende
   * la televisión no se le tumba el internet en la factura.
   */
  private async marcarBajaEnFactura(
    sid: string,
    servicios: Array<'INTERNET' | 'TV'>,
    estado: 'RETIRADO' | 'SUSPENDIDO' | 'CORTADO',
    soloTv: boolean,
  ) {
    try {
      const vigente = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT i.id
          FROM "SubInvoice" i
         WHERE i."subscriberId" = ${sid}
           AND i.kind = 'RECURRENTE'
         ORDER BY i."invoiceDate" DESC NULLS LAST, i.tid DESC
         LIMIT 1`;
      const id = vigente[0]?.id;
      if (!id) return { ok: false, detalle: 'el abonado no tiene factura recurrente' };
      // El servicio queda como lo deja el legacy en el mismo caso: 'Suspendido' cuando
      // se suspende o se retira, 'Cortado' cuando se corta. Son estados distintos y se
      // leen distinto en la ficha: al cortado se le devuelve el servicio pagando, al
      // suspendido no.
      const delServicio: ServiceStatus = estado === 'CORTADO' ? 'CORTADO' : 'SUSPENDIDO';
      const data: Prisma.SubInvoiceUpdateInput = {};
      if (servicios.includes('INTERNET')) data.estadoCombo = delServicio;
      if (servicios.includes('TV')) data.estadoTv = delServicio;
      // El `ron` es del abonado, no de un servicio: sólo se mueve cuando la baja es
      // suya de verdad (una orden que sólo toca la TV no lo cambia, igual que no
      // cambia su estado). En el corte no se toca: de eso ya se encarga el estado del
      // abonado, que `cut()` deja en CORTADO.
      if (!soloTv && estado !== 'CORTADO') data.ron = estado;
      // Sin sellar con `editedAt` a propósito, igual que la reconexión: ese sello lo
      // lee `pushEditedInvoices`, que reescribe los RENGLONES de la factura, y aquí
      // no se ha tocado ningún renglón.
      //
      // Lo que sí se sella es `serviceStatusAt`, y sin él esto no serviría de nada
      // cuando la orden es SÓLO de televisión: `pushBajas` saca a quién empujar de la
      // fila de historial de estados, y una baja de sólo TV no escribe ninguna (no le
      // cambia el estado al abonado, y con razón). Nadie se lo contaba al legacy y la
      // ida devolvía el 'al aire' quince minutos después: la orden #502150 se cerró el
      // 31-08-2026 y el cliente se quedó con la TV suspendida en la calle y activa en
      // las dos pantallas. La marca la empuja `pushEstadoServicio` y la borra en
      // cuanto los dos lados coinciden.
      data.serviceStatusAt = new Date();
      await this.prisma.subInvoice.update({ where: { id }, data });
      return { ok: true, facturaId: id };
    } catch (e) {
      return { ok: false, detalle: (e as Error).message };
    }
  }

  /**
   * LEVANTA el corte del servicio en la factura vigente. Es el espejo de
   * `marcarBajaEnFactura` y faltaba: el cierre sabía escribir el corte pero no
   * borrarlo.
   *
   * Sin esto, cerrar una 'Reconexion Internet' devolvía el servicio de verdad —el
   * router saca la IP de MOROSOS y el abonado navega— y la ficha seguía diciendo
   * "internet cortado", porque lo que pinta ese chip no es el estado del abonado sino
   * `SubInvoice.estadoTv`/`estadoCombo` de su última factura recurrente (convención del
   * legacy: NULL = al aire, con valor = caído). Caso: orden #505799 del 09-09-2026,
   * abonado 2131 — cerrada, reconectada en el router y roja en las dos pantallas.
   *
   * Sólo se levanta lo CORTADO: un 'Suspendido' es una suspensión pedida por el
   * cliente y no la deshace una reconexión (la deshace su propio trámite). Y sólo del
   * servicio que la orden NOMBRA: al que se le devuelve el internet no se le regala la
   * televisión.
   *
   * `ron` es del abonado, no de un servicio: se pone en ACTIVO sólo cuando en esa
   * factura ya no queda ningún corte en pie (mismo criterio que
   * `ReconexionService.levantarCorteDeFactura`).
   *
   * Y se sella `serviceStatusAt` por la misma razón que en la baja: sin esa marca la
   * ida del sync devuelve el 'Cortado' del legacy a los quince minutos, y además es de
   * donde `pushEstadoServicio` saca a quién empujar allá (levantar un corte va por el
   * gate de RECONEXIÓN, no por el de bajas).
   */
  private async levantarCorteEnFactura(
    sid: string,
    servicios: Array<'INTERNET' | 'TV'>,
    soloTv: boolean,
  ) {
    try {
      const vigente = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT i.id
          FROM "SubInvoice" i
         WHERE i."subscriberId" = ${sid}
           AND i.kind = 'RECURRENTE'
         ORDER BY i."invoiceDate" DESC NULLS LAST, i.tid DESC
         LIMIT 1`;
      const id = vigente[0]?.id;
      if (!id) return { ok: false, detalle: 'el abonado no tiene factura recurrente' };
      const actual = await this.prisma.subInvoice.findUnique({
        where: { id },
        select: { estadoCombo: true, estadoTv: true, ron: true },
      });
      if (!actual) return { ok: false, detalle: 'la factura vigente desapareció' };

      const data: Prisma.SubInvoiceUpdateInput = {};
      if (servicios.includes('INTERNET') && actual.estadoCombo === 'CORTADO') data.estadoCombo = null;
      if (servicios.includes('TV') && actual.estadoTv === 'CORTADO') data.estadoTv = null;
      if (!Object.keys(data).length) return { ok: true, sinCambio: true, facturaId: id };

      // ¿Queda algún corte en pie después de esto? Si no, el eje de la factura sube.
      const quedaCorte = (actual.estadoCombo === 'CORTADO' && data.estadoCombo === undefined)
        || (actual.estadoTv === 'CORTADO' && data.estadoTv === undefined);
      if (!soloTv && !quedaCorte && actual.ron === 'CORTADO') data.ron = 'ACTIVO';
      data.serviceStatusAt = new Date();
      await this.prisma.subInvoice.update({ where: { id }, data });
      return { ok: true, facturaId: id, levantado: Object.keys(data).filter((k) => k !== 'serviceStatusAt') };
    } catch (e) {
      return { ok: false, detalle: (e as Error).message };
    }
  }

  /**
   * LEVANTA el corte en la LÍNEA DE SERVICIO del abonado (`SubscriberService`), que es
   * la otra mitad de donde la ficha lee "este servicio está caído".
   *
   * `SubscribersService.conEstadoDeServicio` le da prioridad ABSOLUTA al corte de esta
   * tabla —esconder un corte es el error caro: es justo lo que el cliente está llamando
   * a reclamar—, así que mientras la fila diga CORTADO el chip sigue rojo aunque la
   * factura esté limpia y el router navegando.
   *
   * Faltaba sólo para el INTERNET, y por eso se colaba: la televisión se marca en las
   * dos direcciones dentro de `aplicarTv` (`marcarFicha`), pero el corte de internet lo
   * escribe aquí `MikrotikService.registrarCorteDeInternet` (el lote de corte) y NADIE
   * lo borraba. Caso que lo destapó: abonado 17842, cortado en el lote del 09-09-2026;
   * al día siguiente se cerraron sus dos reconexiones (#505970 internet y #505971 TV),
   * el router lo sacó de MOROSOS, `estadoCombo` quedó limpio, la TV volvió… y el chip de
   * internet siguió en rojo hasta que se arregló a mano desde el botón de la ficha.
   *
   * Sólo lo CORTADO y sólo del servicio que la orden NOMBRA, mismo criterio que en la
   * factura: una SUSPENSIÓN la pidió el cliente y no la deshace una reconexión, y al que
   * se le devuelve el internet no se le regala la televisión. Los PUNTOS son decos de
   * televisión y corren su suerte.
   *
   * No hay nada que empujar al legacy desde aquí: allá el corte por servicio vive en
   * `invoices.estado_combo`/`estado_tv`, y de eso se encarga `levantarCorteEnFactura`
   * con su `serviceStatusAt`.
   */
  private async levantarCorteEnServicio(sid: string, servicios: Array<'INTERNET' | 'TV'>) {
    // Sólo el INTERNET: la televisión (y sus PUNTOS, que son decos suyos) ya la marca
    // `aplicarTv` en los dos sentidos y sin condiciones, porque ahí hay una PERSONA
    // cerrando. Repetirlo aquí sería una escritura de más y más floja que aquélla.
    if (!servicios.includes('INTERNET')) return { ok: true, sinCambio: true };
    try {
      const r = await this.prisma.subscriberService.updateMany({
        where: { subscriberId: sid, kind: 'INTERNET', status: 'CORTADO' },
        data: { status: 'ACTIVO' },
      });
      return { ok: true, sinCambio: r.count === 0, lineas: r.count };
    } catch (e) {
      return { ok: false, detalle: (e as Error).message };
    }
  }

  /**
   * Lo que hay que DECIRLE a quien acaba de cerrar la orden.
   *
   * Sin esto el cierre contestaba siempre lo mismo —"Estado: Resuelto"— hubiera
   * pasado lo que hubiera pasado con los equipos, y por ahí se coló el problema:
   * la cajera cerraba la reconexión de televisión, veía el visto verde y el cliente
   * se quedaba sin señal sin que nadie se enterara. Si la red no pudo hacerlo, tiene
   * que decirlo en la cara del que cierra, que es el único que todavía puede
   * mandar a alguien.
   */
  private mensajeDeCascada(cascade: any): string | undefined {
    const partes: string[] = [];
    if (cascade.tv) {
      if (cascade.tv.ok) {
        partes.push(cascade.tv.dryRun ? 'TV: simulación (los equipos están en dry-run).' : `TV aplicada${cascade.tv.via ? ` por ${cascade.tv.via}` : ''}.`);
      } else {
        partes.push(`⚠ La TV no se pudo aplicar desde el sistema: ${cascade.tv.detalle} Compruébalo en sitio.`);
      }
    }
    if (cascade.mikrotik && cascade.mikrotik.ok === false && !cascade.note) {
      partes.push('⚠ El router no confirmó el cambio de internet.');
    }
    if (cascade.note) partes.push(cascade.note);
    return partes.length ? partes.join(' ') : undefined;
  }

  /**
   * Inyecta el cargo de reconexión (producto del catálogo) en la factura del MES
   * CORRIENTE del cliente, y recalcula los totales. Guarda: solo mes actual (fiel
   * a Tickets.php, que evita ensuciar facturas de periodos viejos ya pagados).
   */
  private async applyReconnectionCharge(subscriberId: string, ticketKind: string) {
    // Producto según el tipo de orden.
    let name = 'Reconexion';
    if (ticketKind.includes('televi')) name = 'Reconexión Television';
    else if (ticketKind.includes('combo')) name = 'Reconexion Combo';
    else if (ticketKind.includes('internet') || ticketKind.includes('reconex')) name = 'Reconexión Internet';
    const material = await this.prisma.material.findFirst({
      where: { name: { contains: name.split(' ')[0], mode: 'insensitive' } },
      orderBy: { name: 'asc' },
    });
    const price = material ? Number(material.price) : 0;
    if (price <= 0) return { applied: false, note: 'sin producto de reconexión con precio' };

    // Factura del mes corriente.
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const invoice = await this.prisma.subInvoice.findFirst({
      where: { subscriberId, invoiceDate: { gte: monthStart, lt: monthEnd } },
      orderBy: { invoiceDate: 'desc' },
    });
    if (!invoice) return { applied: false, note: 'sin factura del mes corriente' };

    await this.prisma.$transaction(async (tx) => {
      await tx.subInvoiceItem.create({
        data: {
          invoiceId: invoice.id, productId: 0, productName: material?.name ?? name,
          description: material?.name ?? name, qty: 1, price, taxRate: 0,
          subtotal: price, taxTotal: 0, discountTotal: 0,
        },
      });
      const newTotal = Number(invoice.total) + price;
      const paid = Number(invoice.paidAmount);
      await tx.subInvoice.update({
        where: { id: invoice.id },
        data: {
          subtotal: { increment: price }, total: { increment: price },
          itemsCount: { increment: 1 },
          status: paid <= 0 ? 'DUE' : paid < newTotal ? 'PARTIAL' : 'PAID',
        },
      });
    });
    return { applied: true, invoiceTid: invoice.tid, product: material?.name ?? name, amount: price };
  }

  /**
   * Asignar técnico desde la ficha de la orden — y METERLA EN SU DÍA (2026-08-11).
   *
   * Esto era un agujero silencioso: `assign()` escribía `assignedStaffId` y nada más,
   * pero el técnico solo ve lo que está AGENDADO (`/mi-agenda` lista por
   * `scheduledFor`). Asignar desde aquí le colgaba la orden sin que le apareciera por
   * ningún lado — 205 órdenes abiertas estaban así el día que se detectó—, y encima
   * la cajera la seguía viendo en su bandeja de "sin agendar", con lo que parecía sin
   * repartir. Asignar es dar trabajo: si no entra en un día, no llega.
   *
   *  · Sin día → HOY, al final de la cola de ese técnico. La cajera puede moverla
   *    después en el tablero; lo que no puede pasar es que no la vea nadie.
   *  · Con día ya puesto → se respeta ESE día y solo cambia de columna. Reasignar
   *    una visita de mañana no es adelantarla a hoy.
   *  · Al desasignar → sale del día. Una orden agendada sin técnico no se pinta en
   *    ninguna columna del tablero (que agrupa por técnico) ni vuelve a la bandeja
   *    (que pide `scheduledFor` nulo): es el mismo agujero por el otro lado.
   *
   * Solo para órdenes ABIERTAS: asignar una cerrada es corregir el histórico, no
   * repartir trabajo, y no tiene por qué reaparecer en la agenda de nadie.
   */
  async assign(id: string, dto: AssignDto, user: AuthUser) {
    const t = await this.prisma.ticket.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('Orden no encontrada');
    const assignedStaffId = await this.resolverStaff(dto.assigned);
    // `assignedAt` es el arranque del reloj del técnico. Se vuelve a sellar en
    // cada reasignación: el tiempo que la orden estuvo en manos de otro no es
    // deuda de quien la recibe ahora. Al desasignar se limpia, para no dejar un
    // reloj corriendo contra nadie.
    await this.prisma.ticket.update({
      where: { id },
      data: {
        assigned: dto.assigned ?? null,
        assignedStaffId,
        assignedAt: dto.assigned?.trim() ? new Date() : null,
        // `asignado` existe allá: la orden pasa a mandarla este sistema.
        editedAt: new Date(),
        editedBy: user?.name ?? user?.email ?? null,
      },
    });

    // El reparto del día lo hace la agenda, no este método: se delega en `mover`
    // para no acabar con dos sitios que renumeran `scheduledSeq`. Se llama DESPUÉS
    // del update, así que `mover` ya ve la orden como suya y no vuelve a emitir el
    // evento de asignación (lo emite este método abajo, una sola vez).
    //
    // Al técnico de campo se le deja el `assign` de siempre sin tocar la agenda:
    // `mover` se lo negaría —él no reparte trabajo— y la excepción tumbaría una
    // asignación que sí es legítima.
    const abierta = t.status === 'PENDIENTE' || t.status === 'REALIZANDO';
    if (abierta && !esTecnicoDeCampo(user)) {
      // `mover` rechaza a un ex-empleado, y esa excepción llegaría DESPUÉS de haber
      // guardado la asignación: media operación hecha y un error en pantalla. Se
      // comprueba antes y, si está inhabilitado, se guarda la asignación sin
      // agendarla — corregir el histórico de alguien que ya no trabaja aquí no tiene
      // que meterle trabajo en la agenda a nadie.
      const activo = assignedStaffId
        ? await this.prisma.staff.findFirst({ where: { id: assignedStaffId, banned: false }, select: { id: true } })
        : null;
      if (activo) {
        const dia = (t.scheduledFor ?? hoyEnColombia()).toISOString().slice(0, 10);
        await this.agenda.mover(user, { ticketId: id, staffId: assignedStaffId, fecha: dia });
      } else if (!assignedStaffId && t.scheduledFor) {
        await this.agenda.mover(user, { ticketId: id, staffId: null, fecha: null });
      }
    }

    // Solo cuando se ASIGNA (no al desasignar): es lo que se le puede contar al
    // cliente, que su caso ya tiene un técnico con nombre.
    if (dto.assigned?.trim()) {
      this.events.emit(TICKET_ASIGNADO_EVENT, {
        ticketId: id, code: t.code, type: t.type, subscriberId: t.subscriberId,
        tecnico: dto.assigned.trim(), abiertaPor: t.col,
      } satisfies TicketAsignadoEvent);
    } else if (t.assigned?.trim()) {
      // Se la quitaron a alguien y no se la dieron a nadie: que deje de verla en su
      // campanita. La reasignación no pasa por aquí —el aviso del nuevo dueño ya
      // barre el del anterior— pero desasignar no avisaba a nada.
      this.events.emit(TICKET_DESASIGNADO_EVENT, { ticketId: id, code: t.code } satisfies TicketDesasignadoEvent);
    }
    return { id, assigned: dto.assigned ?? null };
  }

  /**
   * Corregir el trabajo de una orden ya abierta.
   *
   * Existe porque hasta ahora una orden mal registrada solo tenía una salida:
   * anularla y abrir otra. Eso cuesta el número, el hilo de seguimiento, el equipo
   * y el material ya cargados — y deja dos filas donde hubo un solo trabajo, que es
   * justo lo que ensucia los reportes por tipo.
   *
   * Tres cosas que NO hace, a propósito:
   *
   *  · **No re-ejecuta nada.** Cambiarle el detalle a una orden ya RESUELTA corrige
   *    el dato, no vuelve a correr la cascada del cierre: el servicio no se corta ni
   *    se reconecta otra vez. Lo que ya pasó, pasó.
   *  · **No reescribe el puntaje sellado.** `score` es una copia de lo que valía el
   *    trabajo cuando se cerró (ver `order-score.service.ts`); si se corrige el tipo
   *    después, lo que ya se le abonó al técnico se queda como se le abonó. En una
   *    orden abierta no hay nada que hacer: el puntaje se calcula al cerrarla.
   *  · **No toca técnico ni prioridad.** Tienen su propio mando, que guarda solo.
   *
   * Deja rastro en el hilo de seguimiento con lo que cambió y quién lo cambió: una
   * corrección silenciosa sobre una orden que otro está atendiendo es peor que no
   * poder corregir.
   */
  async updateTicket(id: string, dto: UpdateTicketDto, user: AuthUser) {
    // Mismo criterio que abrir una orden (2026-07-31): el técnico de campo ATIENDE
    // el trabajo, no lo redefine. Si llega y la orden está mal, lo documenta en el
    // hilo y quien la abrió la corrige.
    if (esTecnicoDeCampo(user)) {
      throw new ForbiddenException('No puedes editar órdenes de trabajo. Si esta no corresponde, documéntalo en el seguimiento.');
    }
    const t = await this.prisma.ticket.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('Orden no encontrada');

    const data: Prisma.TicketUncheckedUpdateInput = {};
    const cambios: string[] = [];

    const tipoNuevo = dto.type?.trim();
    if (tipoNuevo && tipoNuevo !== t.type) {
      data.type = tipoNuevo;
      cambios.push(`detalle: «${t.type}» → «${tipoNuevo}»`);
    }
    const tipoFinal = tipoNuevo || t.type;

    if (dto.subject) {
      // Se pasa por `resolverClase` y no se guarda crudo: es la misma puerta por la
      // que entran las órdenes del chatbot, y garantiza que en `subject` viva una de
      // las tres palabras que el legacy escribe ahí y por las que agrupan los reportes.
      const clase = resolverClase(dto.subject, tipoFinal);
      if (clase !== t.subject) {
        data.subject = clase;
        // La de antes puede no ser ninguna de las tres (en el legacy `subject` guardó
        // prosa): si lo es se pinta con su etiqueta, y si no, tal como está guardada.
        const antes = esClaseOrden(t.subject) ? ETIQUETA_CLASE[t.subject] : (t.subject || '—');
        cambios.push(`clase: «${antes}» → «${ETIQUETA_CLASE[clase]}»`);
      }
    }

    if (dto.problem !== undefined) {
      // En un retiro esta casilla es el MOTIVO por el que se va el cliente, y es
      // lista cerrada: corregir la orden no puede ser la rendija por la que entre
      // texto libre a la columna por la que agrupa el informe de retiros. Borrarlo
      // sí se deja: las órdenes viejas del legacy vienen sin motivo y no se les
      // puede exigir uno para poder tocarles la observación.
      const esRetiro = esRetiroVoluntario(tipoFinal);
      const problem = esRetiro && dto.problem.trim()
        ? this.motivoDeRetiro(tipoFinal, dto.problem)
        : dto.problem.trim() || null;
      if (problem !== (t.problem ?? null)) {
        data.problem = problem;
        const que = esRetiro ? 'el motivo del retiro' : 'la falla reportada';
        cambios.push(problem ? `se corrigió ${que}` : `se borró ${que}`);
      }
    }

    if (dto.section !== undefined) {
      const section = dto.section.trim() || null;
      if (section !== (t.section ?? null)) {
        data.section = section;
        cambios.push(section ? 'se corrigió la observación' : 'se borró la observación');
      }
    }

    if (dto.created) {
      const dia = diaDeLaOrden(dto.created, { desde: t.created });
      if (dia.getTime() !== t.created.getTime()) {
        data.created = dia;
        cambios.push(`fecha: ${t.created.toISOString().slice(0, 10)} → ${dia.toISOString().slice(0, 10)}`);
      }
    }

    // El plazo sigue al detalle: solo la reconexión por días lo usa, así que si la
    // orden deja de serlo el número se va con ella. Al revés —una orden que PASA a
    // ser por días— hay que decir cuántos: sin plazo, al cerrarla no protegería al
    // cliente del corte y nadie se enteraría hasta que se lo cortaran.
    const porDias = esReconexionPorDias(tipoFinal);
    if (!porDias) {
      if (t.graceDays != null) {
        data.graceDays = null;
        cambios.push('se quitó el plazo en días (este tipo de orden no lo usa)');
      }
    } else {
      const dias = dto.graceDays ?? t.graceDays;
      if (dias == null) {
        throw new BadRequestException('Esta orden devuelve el servicio por un plazo: di cuántos días.');
      }
      if (dias !== t.graceDays) {
        data.graceDays = dias;
        cambios.push(`días de reconexión: ${t.graceDays ?? '—'} → ${dias}`);
      }
    }

    // El DESTINO de un traslado. Se registra aquí porque hay dos caminos por los
    // que una orden de traslado nace sin él: las que se abren en el legacy (allá no
    // hay columna donde guardarlo) y las que entran por el chatbot (el cliente
    // dicta la dirección en texto libre y hay que confirmar cobertura). Sin esto se
    // quedaban sin decir a dónde se muda el cliente para siempre. Igual que el
    // plazo en días, solo cuenta en el tipo de orden que lo usa.
    let ficha: { data: Prisma.SubscriberUpdateInput; direccion: string } | null = null;
    if (dto.moveTo && esTraslado(tipoFinal)) {
      if (!t.subscriberId) throw new BadRequestException('Esta orden no tiene cliente: no hay ficha a la que mover la dirección.');
      const sub = await this.prisma.subscriber.findUnique({
        where: { id: t.subscriberId },
        select: { id: true, nomenclature: true, addressLine: true, neighborhood: true },
      });
      if (!sub) throw new NotFoundException('Cliente no encontrado');
      // Que la dirección nueva sea la que la ficha ya tiene es lo normal por aquí: si
      // la orden vino del legacy, allá ya se la cambiaron. Se registra en la orden a
      // dónde se fue y la ficha no se vuelve a tocar (ver `mismaDireccion` abajo).
      const traslado = this.armarTraslado(dto.moveTo, sub);
      if (traslado.direccionNueva !== t.moveToText) {
        data.moveTo = traslado.destino as Prisma.InputJsonValue;
        data.moveToText = traslado.direccionNueva;
        // La de "antes" se toma de la ficha, no de la orden: es de donde sale el
        // equipo que hay que recoger. Si la orden ya traía una registrada, manda esa.
        data.moveFromText = t.moveFromText ?? traslado.direccionVieja;
        data.moveAppliedAt = new Date();
        cambios.push(
          t.moveToText
            ? `destino del traslado: «${t.moveToText}» → «${traslado.direccionNueva}»`
            : `se registró el destino del traslado: ${traslado.direccionNueva}`,
        );
        // La ficha solo se toca si de verdad cambia de dirección. Y la nota va
        // también en la OBSERVACIÓN, que es lo que viaja al legacy: allá no hay
        // columna donde meterla y es donde la lee quien siga en el sistema viejo.
        if (!traslado.mismaDireccion) {
          ficha = { data: { ...traslado.fichaData, editedAt: new Date() }, direccion: traslado.direccionNueva };
          const observacion = data.section !== undefined ? (data.section as string | null) : t.section;
          if (!(observacion ?? '').includes(traslado.direccionNueva)) {
            data.section = [observacion, traslado.notaObservacion].filter(Boolean).join('\n').slice(0, 1500);
          }
        }
      }
    }

    // El PLAN DESTINO de una orden de megas: a cuántas se pasa el cliente. Se
    // registra aquí por lo mismo que el destino del traslado — hay órdenes que
    // nacen sin él (las del legacy, donde el plan vive en su tabla `temporales`, y
    // las que abre el chatbot con el plan por confirmar) y hasta ahora no había por
    // dónde ponérselo: la orden salía a la calle sin decir a qué velocidad hay que
    // dejar al cliente. Y también corrige el error de dedo: el plan de al lado en
    // el desplegable. Igual que el plazo en días, solo cuenta en su tipo de orden.
    //
    // Vale también para 'AgregarInternet' (`ordenLlevaPlanInternet`), y ahí es lo
    // que permite rescatar las que ya se cerraron sin plan: se les pone el suyo y
    // se aplica desde la ficha, sin tener que anular y repetir la orden.
    let megas: Awaited<ReturnType<typeof this.prepararCambioDeMegas>> = null;
    if (dto.planToId && ordenLlevaPlanInternet(tipoFinal) && dto.planToId !== t.planToId) {
      if (!t.subscriberId) throw new BadRequestException('Esta orden no tiene cliente: no hay a quién cambiarle el plan.');
      megas = await this.prepararCambioDeMegas(
        { type: tipoFinal, planToId: dto.planToId },
        t.subscriberId,
        false,
        // Si la orden YA se cerró y le cambió el plan al cliente, el "de cuánto
        // viene" es el que ella misma dejó anotado, no el que la ficha tiene hoy
        // (que es justo el que puso esta orden). Mientras siga abierta, el cliente
        // no se ha movido: manda su plan vigente.
        t.planAppliedAt ? { planId: null, nombre: t.planFromName, megas: t.planFromMegas } : undefined,
      );
      data.planToId = megas!.plan.id;
      data.planToName = megas!.plan.name;
      data.planToMegas = megas!.plan.megas;
      data.planFromName = megas!.actual?.nombre ?? null;
      data.planFromMegas = megas!.actual?.megas ?? null;
      // Si ya se había aplicado (orden cerrada que se corrige), el sello se cae: la
      // ficha tiene el plan viejo de esta orden, no el que acaba de elegirse. Se
      // vuelve a poner cuando se aplique — al cerrarla, o desde la ficha.
      data.planAppliedAt = null;
      cambios.push(
        t.planToName
          ? `plan destino: «${t.planToName}» → «${megas!.plan.name}» (${megas!.resumen})`
          : `se registró el plan destino: «${megas!.plan.name}» (${megas!.resumen})`,
      );
      // La frase también en la OBSERVACIÓN, que es lo que viaja al legacy y lo que
      // lee el técnico en la orden impresa. Se REEMPLAZA la que hubiera: dejar las
      // dos es dejar la orden diciendo dos velocidades distintas.
      const observacion = data.section !== undefined ? (data.section as string | null) : t.section;
      data.section = this.conNotaDeMegas(observacion, megas!.notaObservacion);
    }

    if (!cambios.length) return { id, cambios: [] as string[] };

    // `graceDays` y el destino del traslado son de este sistema (el legacy no tiene
    // columnas para ellos); el resto de lo editable son columnas que allá también
    // existen (`subject`, `detalle`, `problema`, `section`, `created`). Solo esas
    // sellan la orden como nuestra para que el writeback la empuje y la ida de las
    // 15 min no la devuelva a como estaba allá. Ojo: la dirección nueva SÍ llega al
    // legacy, pero por la observación —que es una de esas columnas.
    const SOLO_NUESTRO = ['graceDays', 'moveTo', 'moveToText', 'moveFromText', 'moveAppliedAt',
      'planToId', 'planToName', 'planToMegas', 'planFromName', 'planFromMegas', 'planAppliedAt'];
    const tocaAlLegacy = Object.keys(data).some((k) => !SOLO_NUESTRO.includes(k));
    if (tocaAlLegacy) {
      data.editedAt = new Date();
      data.editedBy = user?.name ?? user?.email ?? null;
    }
    await this.prisma.ticket.update({ where: { id }, data });

    // La dirección del cliente, si el traslado la movió. Va después de la orden y
    // no en una transacción con ella a propósito: lo que no puede pasar es que la
    // ficha quede mudada sin que la orden diga a dónde. `editedAt` es lo que impide
    // que el sync de ida devuelva la vieja a los 15 minutos (ver `createTicket`).
    if (ficha) {
      await this.prisma.subscriber.update({ where: { id: t.subscriberId! }, data: ficha.data });
      cambios.push(`la ficha del cliente quedó en ${ficha.direccion}`);
    }

    // Corregir el plan NO se lo cambia al cliente: eso pasa al cerrar la orden. En
    // una orden ya cerrada tampoco se rehace el trabajo —corregirla arregla el dato
    // para los reportes—, así que se dice quién tiene que aplicarlo y dónde.
    if (megas) {
      cambios.push(
        t.planAppliedAt
          ? `OJO: esta orden ya había dejado al cliente en «${t.planToName}». Aplícale «${megas.plan.name}» desde su ficha (Cambiar plan) si el cambio de verdad se hizo.`
          : `El cliente pasa a «${megas.plan.name}» cuando se cierre la orden.`,
      );
    }

    // Rastro en el propio hilo de la orden, firmado por quien la corrigió. El nombre
    // sigue yendo también dentro del texto: el acta en PDF imprime el mensaje, y ahí
    // "Orden corregida" a secas no dice por quién.
    if (t.code != null) {
      const quien = user?.name ?? user?.email ?? 'un funcionario';
      await this.prisma.ticketThread.create({
        data: {
          ticketCode: t.code,
          message: `Orden corregida por ${quien}: ${cambios.join('; ')}.`,
          subscriberId: t.subscriberId,
          date: new Date(),
          ...(await this.firmaDeSeguimiento(user)),
        },
      });
    }

    return { id, cambios };
  }

  async setPriority(id: string, dto: PriorityDto) {
    const t = await this.prisma.ticket.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('Orden no encontrada');
    await this.prisma.ticket.update({ where: { id }, data: { priority: dto.priority } });
    return { id, priority: dto.priority };
  }

  async saveSignature(id: string, dto: SignatureDto) {
    const t = await this.prisma.ticket.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('Orden no encontrada');
    let signatureImage: string | undefined;
    // Guarda el PNG dibujado (data URL) en uploads/signatures/<id>.png.
    if (dto.image && dto.image.startsWith('data:image')) {
      const b64 = dto.image.replace(/^data:image\/\w+;base64,/, '');
      if (b64.length > 100) {
        try {
          if (!existsSync(SIGNATURE_ROOT)) mkdirSync(SIGNATURE_ROOT, { recursive: true });
          const fname = `${id}.png`;
          writeFileSync(join(SIGNATURE_ROOT, fname), Buffer.from(b64, 'base64'));
          signatureImage = fname;
        } catch (e) { throw new BadRequestException(`No se pudo guardar la firma: ${(e as Error).message}`); }
      }
    }
    await this.prisma.ticket.update({
      where: { id },
      data: {
        signatureName: dto.name, signatureCc: dto.cc ?? null, signatureRel: dto.rel ?? null,
        ...(signatureImage ? { signatureImage } : {}),
        // nombre_firma/cc_firma/parentesco_firma también viven en el legacy.
        // Sin `editedBy`: esta ruta no recibe el usuario (el router es generado) y
        // la propiedad del dato, que es lo que importa aquí, no depende de quién.
        editedAt: new Date(),
      },
    });

    // Firmar de nuevo REESCRIBE el acta —y el PNG, que se guarda en `<id>.png`—, así
    // que la de la visita anterior se perdía en silencio (2026-09-12: una orden
    // cerrada por teléfono y reabierta el mismo día, #506045). Aquí no se guarda un
    // histórico de actas; lo que queda es el renglón en el seguimiento, que es donde
    // el acta en PDF y la ficha ya cuentan lo que pasó con la orden.
    if (t.signatureName && t.code != null && t.signatureName.trim() !== dto.name.trim()) {
      await this.prisma.ticketThread.create({
        data: {
          ticketCode: t.code,
          message: `Acta firmada de nuevo por ${dto.name.trim()}. La anterior era de ${t.signatureName.trim()}${t.signatureCc ? ` (CC ${t.signatureCc})` : ''} y queda reemplazada.`,
          subscriberId: t.subscriberId,
          date: new Date(),
          ...SEGUIMIENTO_DEL_SISTEMA,
        },
      });
    }

    return { id, signed: true, hasImage: !!signatureImage };
  }

  async addThread(id: string, dto: ThreadDto, user: AuthUser) {
    const t = await this.prisma.ticket.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('Orden no encontrada');
    if (t.code == null) throw new BadRequestException('La orden no tiene número');
    await this.prisma.ticketThread.create({
      data: {
        ticketCode: t.code, message: dto.message, subscriberId: t.subscriberId, date: new Date(),
        ...(await this.firmaDeSeguimiento(user)),
      },
    });
    return { ok: true };
  }

  /**
   * Borra un renglón del seguimiento de una orden. Sólo superusuario (el gate va en la
   * ruta). Lo borrado queda copiado en `AuditLog` —texto, autor y fecha—, porque la
   * fila ya no está para preguntarle qué decía.
   *
   * No resucita con el sync: la ida trae `tickets_th` por marca de agua (sólo ids
   * nuevos). Pero tampoco viaja: si el renglón vino del legacy, allá sigue.
   */
  async deleteThread(threadId: string, user: AuthUser) {
    const th = await this.prisma.ticketThread.findUnique({ where: { id: threadId } });
    if (!th) throw new NotFoundException('Seguimiento no encontrado');
    await this.prisma.$transaction(async (tx) => {
      await tx.ticketThread.delete({ where: { id: threadId } });
      await tx.auditLog.create({
        data: {
          userId: user?.id ?? null, action: 'DELETE', entity: 'TicketThread', entityId: th.id,
          before: {
            orden: th.ticketCode, mensaje: th.message, autor: th.authorName, eid: th.employeeId,
            fecha: th.date.toISOString(), adjunto: th.attachName ?? th.attach, legacyId: th.legacyId,
          },
          after: { by: user?.name ?? user?.email ?? null },
        },
      });
    });
    // La foto se va con su renglón, salvo que otro renglón apunte al mismo archivo.
    if (th.attach && !(await this.prisma.ticketThread.count({ where: { attach: th.attach } }))) {
      const file = join(process.cwd(), 'uploads', 'support', th.attach);
      try { if (existsSync(file)) unlinkSync(file); } catch { /* el archivo huérfano no estorba */ }
    }
    return { ok: true };
  }

  /**
   * Con qué se firma lo que se escribe en el hilo de una orden.
   *
   * La ficha de empleado se busca para sacar el `eid` del legacy, pero que no
   * aparezca NO deja el renglón sin autor: el nombre se guarda igual. Y si la
   * consulta falla se firma con lo que hay en la sesión — perder la documentación
   * del técnico porque no se pudo leer su ficha sería mucho peor que un `eid` en 0.
   */
  private async firmaDeSeguimiento(user?: AuthUser | null): Promise<FirmaDeSeguimiento> {
    if (!user?.id) return SEGUIMIENTO_DEL_SISTEMA;
    let ficha = null;
    try {
      ficha = await fichaDelUsuario(this.prisma, user);
    } catch {
      ficha = null;
    }
    return autorDeSeguimiento(user, ficha);
  }

  /** Agrega una entrada al hilo con una foto adjunta (evidencia) y, si el dispositivo la dio, su geolocalización. */
  async addAttachment(
    id: string,
    file: { filename: string; originalname: string },
    dto: AttachDto,
    user?: AuthUser,
  ) {
    const t = await this.prisma.ticket.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('Orden no encontrada');
    if (t.code == null) throw new BadRequestException('La orden no tiene número');
    const th = await this.prisma.ticketThread.create({
      data: {
        ticketCode: t.code, message: dto.message?.trim() || null, subscriberId: t.subscriberId,
        date: new Date(), ...(await this.firmaDeSeguimiento(user)),
        attach: file.filename, attachName: file.originalname,
        geoLat: dto.lat?.trim() || null, geoLng: dto.lng?.trim() || null,
      },
    });

    // La foto ya venía geo-etiquetada; lo que faltaba era que ese punto contara
    // como "dónde está este técnico". Se graba aquí, en el servidor, y no con una
    // llamada extra desde el móvil: el técnico está en la calle, muchas veces con
    // una barra de señal, y una segunda petición se pierde justo cuando más
    // importa. Si la coordenada no es utilizable, no se inventa un punto.
    if (user) {
      const p = parsePoint(dto.lat, dto.lng);
      if (p) {
        await this.prisma.geoPing
          .create({
            data: {
              userId: user.id, userName: user.name,
              lat: p.lat, lng: p.lng,
              reason: 'ticket.attach',
              refType: 'ticket', refId: id,
            },
          })
          // Nunca hacer que se pierda la evidencia por no poder anotar el punto.
          .catch(() => undefined);
      }
    }

    return { ok: true, id: th.id };
  }

  /**
   * Registra una nota en el hilo de la orden (para dejar traza de acciones).
   *
   * `user` es quien la provocó, cuando la provocó alguien: asignar un equipo o
   * consumir material es un acto de una persona y en la ficha tiene que aparecer con
   * su nombre. Sin `user` la nota queda como del sistema, que es lo que de verdad es
   * (un proceso automático).
   */
  private async noteOnThread(ticketCode: number | null, subscriberId: string | null, message: string, user?: AuthUser | null) {
    if (ticketCode == null) return;
    const firma = await this.firmaDeSeguimiento(user);
    await this.prisma.ticketThread
      .create({ data: { ticketCode, message, subscriberId, date: new Date(), ...firma } })
      .catch(() => undefined);
  }

  /**
   * Equipos que se le pueden entregar a un cliente: los libres de stock y —si se dice
   * de quién se habla— los que YA están apartados a su nombre.
   *
   * Ese segundo caso no es un adorno: desde que la orden aparta una unidad al abrirse
   * (`EquipoReservaService`), esa unidad deja de estar "libre" —lleva `subscriberId`—
   * y desaparecía de este selector. La ficha decía "llévese el equipo 311793" y el
   * modal para entregarlo no lo ofrecía: la única caja que había que dar era la única
   * que no se podía elegir.
   *
   * Las apartadas para él salen PRIMERO y marcadas (`reservado`), para que quien
   * entrega no elija otra por descuido.
   */
  async availableEquipment(search?: string, subscriberId?: string) {
    const dueño = subscriberId?.trim() || null;
    const s = search?.trim();
    // El CÓDIGO es lo que la cajera tiene delante: viene rotulado en la caja y es lo
    // que se teclea (2026-09-05). Buscar sólo por MAC/serial obligaba a leer una MAC
    // de 12 dígitos de una etiqueta diminuta para encontrar una unidad del estante.
    const codigo = s && /^\d{1,9}$/.test(s) ? Number(s) : null;
    const texto: Prisma.EquipmentWhereInput = s
      ? {
          OR: [
            ...(codigo == null ? [] : [{ code: codigo }]),
            { mac: { contains: s, mode: 'insensitive' as const } },
            { serial: { contains: s, mode: 'insensitive' as const } },
          ],
        }
      : {};
    const SEL = {
      id: true, code: true, mac: true, serial: true, brand: true, installType: true, status: true,
      warehouse: { select: { name: true } },
    } as const;

    // Las suyas van en su PROPIA consulta y no mezcladas en un `OR` con el stock: la
    // lista se corta a 30 por código ascendente, y las unidades apartadas llevan los
    // códigos más altos del inventario (son las que entraron ayer). En un solo `OR` el
    // recorte se las comía SIEMPRE — la caja que la ficha manda entregar era justo la
    // única que el selector no ofrecía.
    const suyos = dueño
      ? await this.prisma.equipment.findMany({
          where: { subscriberId: dueño, AND: [texto] }, orderBy: { code: 'asc' }, select: SEL,
        })
      : [];
    // La SEDE del cliente, para no ofrecerle a la cajera de Villanueva unidades que
    // están en el estante de Yopal. Si su sede no tiene nada que dar, se cae a todo el
    // inventario antes que devolver una lista vacía.
    const sede = dueño
      ? (await this.prisma.subscriber.findUnique({ where: { id: dueño }, select: { branch: { select: { legacyId: true } } } }))?.branch?.legacyId ?? null
      : null;
    // Ordenadas por código DESCENDENTE, igual que elige la reserva y por lo mismo: el
    // inventario arrastra unidades de hace años que figuran "disponibles" y ya no están
    // en ningún estante (el código 1004 de Villanueva, sin ir más lejos). Con el orden
    // ascendente el selector ofrecía justo ésas en las primeras 30 filas, y la caja que
    // de verdad se puede entregar no aparecía nunca.
    const libresDe = (donde: Prisma.EquipmentWhereInput, cuantos: number) =>
      this.prisma.equipment.findMany({
        where: { subscriberId: null, AND: [texto, donde] }, orderBy: { code: 'desc' }, take: cuantos, select: SEL,
      });
    const deSuSede = sede == null ? [] : await libresDe({ warehouse: { branchLegacy: sede } }, 30);
    const encontradas = deSuSede.length
      ? deSuSede
      : await libresDe({}, 30);
    // El código EXACTO va primero y sin pasar por el recorte: "1004" también aparece
    // dentro de mil seriales, y la unidad 1004 —que es la que se está tecleando— caía
    // fuera de las 30 filas. Tampoco se limita a la sede: si la caja rotulada está en
    // otro estante, mejor verla y saberlo que no encontrarla.
    const exacta = codigo == null
      ? null
      : await this.prisma.equipment.findFirst({ where: { code: codigo, subscriberId: null }, select: SEL });
    const libres = exacta
      ? [exacta, ...encontradas.filter((e) => e.id !== exacta.id)]
      : encontradas;
    const fila = (e: (typeof libres)[number], reservado: boolean) => ({
      id: e.id, code: e.code, mac: e.mac, serial: e.serial, brand: e.brand,
      installType: e.installType, status: e.status, warehouse: e.warehouse?.name ?? null,
      /** Ya está a nombre del cliente por el que se pregunta: es el que hay que entregar. */
      reservado,
    });
    return [...suyos.map((e) => fila(e, true)), ...libres.map((e) => fila(e, false))];
  }

  /**
   * Cajas NAP para el selector de la entrega de equipos (2026-09-09).
   *
   * No reusa `/network/naps` a propósito: aquélla pide área `tecnicos` o
   * `administracion` y el módulo Red, y quien entrega la caja en la ventanilla es la
   * CAJERA. Esta responde lo justo para elegir —rótulo, dirección, sede y cuántos
   * puertos quedan libres— con la misma puerta que el resto del modal.
   *
   * Las de la sede del cliente van primero: una NAP es un poste, y ofrecerle a
   * Villanueva las cajas de Yopal es cómo se acaba con un equipo colgado de una caja
   * que está a 80 km. No se FILTRA por sede porque 4 de cada 10 clientes no la
   * tienen puesta (ver `cliente-sin-sede-invisible`) y ahí la lista saldría vacía.
   *
   * SIN TOPE (2026-09-14): antes se cortaba en 40 y Yopal tiene 508 cajas, así que
   * "no salen todas". Son 1.406 filas en total: se traen enteras y se filtran aquí,
   * comparando sin espacios/guiones/rayas bajas porque los rótulos del legacy vienen
   * como "VLLC _03" y quien busca teclea "vllc 03".
   */
  async napsParaEquipo(search?: string, subscriberId?: string) {
    const plano = (s: string | null | undefined) =>
      (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[\s_\-.]+/g, '');
    const texto = plano(search);
    const sede = subscriberId
      ? (await this.prisma.subscriber.findUnique({ where: { id: subscriberId }, select: { branchId: true } }))?.branchId ?? null
      : null;
    const todas = await this.prisma.nap.findMany({
      where: !texto && sede ? { branchId: sede } : {},
      select: { id: true, name: true, address: true, portCount: true, branchId: true, branch: { select: { name: true } } },
    });
    const naps = texto ? todas.filter((n) => plano(n.name).includes(texto) || plano(n.address).includes(texto)) : todas;
    if (!naps.length) return [];
    const ids = naps.map((n) => n.id);
    const [total, ocupados] = await Promise.all([
      this.prisma.port.groupBy({ by: ['napId'], where: { napId: { in: ids } }, _count: { _all: true } }),
      // Ocupado = TIENE CLIENTE, no `status: 'Ocupado'`: son la misma cosa salvo en 5
      // filas sucias del legacy, y es la regla con la que se pintan los puertos al
      // abrir la caja (`libre`). Contar de dos maneras distintas es cómo la lista
      // dice "3 libres" y dentro se ven 4.
      this.prisma.port.groupBy({ by: ['napId'], where: { napId: { in: ids }, subscriberId: { not: null } }, _count: { _all: true } }),
    ]);
    const mapa = (g: { napId: string | null; _count: { _all: number } }[]) =>
      new Map(g.map((x) => [x.napId, x._count._all] as const));
    const [totalPor, ocupadosPor] = [mapa(total), mapa(ocupados)];
    const cuenta = (m: Map<string | null, number>, id: string) => m.get(id) ?? 0;
    return naps
      .map((n) => {
        const puertos = cuenta(totalPor, n.id) || n.portCount;
        return {
          id: n.id, name: n.name, address: n.address || null,
          branch: n.branch?.name ?? null,
          /** De la sede del cliente: la lista las sube arriba y la pantalla lo dice. */
          deSuSede: !!sede && n.branchId === sede,
          puertos, libres: Math.max(0, puertos - cuenta(ocupadosPor, n.id)),
        };
      })
      // `numeric`: "_2" antes que "_10", como están rotuladas en el poste.
      .sort((a, b) => Number(b.deSuSede) - Number(a.deSuSede) || a.name.localeCompare(b.name, 'es', { numeric: true }));
  }

  /**
   * Los puertos de una caja, como se ven al abrirla: por número, con quién ocupa
   * cada uno. `subscriberId` marca los que ya son de ese cliente (`mio`), que son los
   * únicos ocupados que se pueden volver a elegir —es su propio equipo cambiándose—.
   */
  async puertosDeNap(napId: string, subscriberId?: string) {
    const nap = await this.prisma.nap.findUnique({
      where: { id: napId },
      select: { id: true, name: true, address: true, portCount: true, vlanLegacy: true, branch: { select: { name: true } } },
    });
    if (!nap) throw new NotFoundException('Caja NAP no encontrada');
    const ports = await this.prisma.port.findMany({
      where: { napId },
      orderBy: { port: 'asc' },
      select: {
        id: true, port: true, status: true, detail: true, subscriberId: true,
        subscriber: { select: { firstName: true, secondName: true, lastName1: true, lastName2: true, companyName: true, fullName: true } },
      },
    });
    return {
      nap: { id: nap.id, name: nap.name, address: nap.address || null, branch: nap.branch?.name ?? null, portCount: nap.portCount, vlan: nap.vlanLegacy || null },
      ports: ports.map((p) => ({
        id: p.id, port: p.port, status: p.status,
        detail: p.detail?.trim() || null,
        client: subName(p.subscriber),
        subscriberId: p.subscriberId,
        mio: !!subscriberId && p.subscriberId === subscriberId,
        libre: !p.subscriberId,
      })),
    };
  }

  /** Bodegas con material, para entrar por el estante (ver `material-stock.ts`). */
  materialWarehouses(user: AuthUser, search?: string) {
    return bodegasConMaterial(this.prisma, user, search);
  }

  /** Materiales con stock para el selector del modal de consumo (ver `material-stock.ts`). */
  searchMaterials(user: AuthUser, filtro: FiltroMaterial) {
    return buscarMaterialConStock(this.prisma, user, filtro);
  }

  /**
   * Asigna uno o varios equipos (CPE) al cliente de la orden. Los que traen
   * `equipmentId` salen del inventario (subscriberId + status "Asignado"); los
   * demás se crean como unidad nueva. Fiel al legacy asig_equipo: valida que la
   * MAC no esté ya en uso por otro cliente.
   *
   * Va en una sola transacción: una instalación que deja ONT y decodificador es
   * un acto, y si el segundo aparato choca (MAC de otro cliente, unidad ya
   * entregada) no puede quedar el primero asignado y el otro no —el técnico
   * tendría media instalación registrada y ninguna pantalla que lo delate.
   */
  async assignEquipment(id: string, dto: AssignEquipmentDto, user: AuthUser) {
    const t = await this.prisma.ticket.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('Orden no encontrada');
    if (!t.subscriberId) throw new BadRequestException('La orden no tiene cliente asociado');
    return this.asignarEquipos(t.subscriberId, t.code, dto, user);
  }

  /**
   * Los mismos equipos, entregados DESDE LA FICHA del cliente (2026-09-04).
   *
   * La pestaña "Equipos" no tenía por dónde entregar nada: se asignaba sólo desde la
   * orden, y quien entrega la caja en la ventanilla está mirando al cliente, no una
   * orden. Es la misma escritura —misma transacción, mismas validaciones— y por eso
   * comparte cuerpo con la de arriba: dos caminos que asignan equipos con reglas
   * distintas es cómo se llega a un inventario que no cuadra.
   *
   * La nota se cuelga de su orden ABIERTA cuando la tiene —primero la que pide equipo
   * (una instalación, un cambio de equipo…), que es la razón por la que se entrega—,
   * y si no tiene ninguna abierta se asigna igual, sin nota. No se exige orden: un
   * cliente al que se le repone un equipo un martes cualquiera no siempre trae una.
   */
  async assignEquipmentToSubscriber(subscriberId: string, dto: AssignEquipmentDto, user: AuthUser) {
    // La cajera solo entrega a los clientes de SU sede: aquí y no en la pantalla,
    // porque el desplegable es una comodidad y esto es la puerta (ver `sede-scope`).
    // La vía por orden no lo comprueba porque el técnico llega a ella desde su propia
    // agenda, ya acotada; a la ficha se llega escribiendo un id.
    await exigirSedeSuscriptor(this.prisma, user, subscriberId);
    const sub = await this.prisma.subscriber.findUnique({ where: { id: subscriberId }, select: { id: true } });
    if (!sub) throw new NotFoundException('Cliente no encontrado');
    const abiertas = await this.prisma.ticket.findMany({
      where: { subscriberId, status: { in: ['PENDIENTE', 'REALIZANDO'] }, code: { not: null } },
      select: { code: true, type: true },
      orderBy: ORDEN_CRONOLOGICO,
    });
    const ancla = abiertas.find((o) => tipoConReserva(o.type)) ?? abiertas[0] ?? null;
    return this.asignarEquipos(subscriberId, ancla?.code ?? null, dto, user);
  }

  /**
   * Traduce la caja NAP y el puerto elegidos en la pantalla a lo que guarda `equipos`.
   *
   * OJO CON LA CONVENCIÓN DEL LEGACY, que es la que hay que respetar para que el
   * dato signifique lo mismo a los dos lados: `equipos.nat` es el id de la caja
   * (`Nap.legacyId`, la columna `idn`) y `equipos.puerto` NO es el número del puerto
   * —el 1 al 16 que está rotulado en la caja— sino el id de SU FILA en `puertos`
   * (`Port.legacyId`, la columna `idp`). Comprobado sobre los 4.477 equipos
   * importados que traen caja: 4.124 casan por `idp` y sólo 302 por número.
   *
   * Por eso la pantalla manda ids de aquí (`portId`) y la traducción vive en el
   * servidor: un `idp` no se teclea de memoria, y las dos casillas numéricas que
   * había antes ("Puerto NAT" y "Caja NAT") pedían justo eso.
   *
   * Devuelve el mapa `portId → datos`, ya validado: puerto existente, coherente con
   * la caja que dice la pantalla, no elegido dos veces en el mismo envío y libre (o
   * ya de este mismo cliente).
   */
  private async resolverPuertos(items: AssignEquipmentItemDto[], subscriberId: string) {
    const pedidos = items.map((it) => it.portId).filter((v): v is string => !!v);
    const mapa = new Map<string, { id: string; numero: number; napLegacy: number; napNombre: string; portLegacy: number; vlanLegacy: number | null }>();
    if (!pedidos.length) return mapa;
    if (new Set(pedidos).size !== pedidos.length) {
      throw new BadRequestException('Hay dos equipos colgados del mismo puerto de la caja NAP');
    }
    const filas = await this.prisma.port.findMany({
      where: { id: { in: [...new Set(pedidos)] } },
      select: {
        id: true, port: true, legacyId: true, napId: true, subscriberId: true,
        nap: { select: { legacyId: true, name: true, vlanLegacy: true } },
        subscriber: { select: { firstName: true, secondName: true, lastName1: true, lastName2: true, companyName: true, fullName: true } },
      },
    });
    for (const it of items) {
      if (!it.portId) continue;
      const p = filas.find((f) => f.id === it.portId);
      if (!p) throw new NotFoundException('El puerto de la caja NAP no existe');
      if (!p.nap) throw new BadRequestException('Ese puerto no cuelga de ninguna caja NAP');
      if (it.napId && p.napId !== it.napId) {
        throw new BadRequestException(`El puerto ${p.port} no es de la caja NAP elegida`);
      }
      // Ocupado por OTRO: dos clientes en el mismo puerto es una avería, no un dato.
      if (p.subscriberId && p.subscriberId !== subscriberId) {
        throw new BadRequestException(
          `El puerto ${p.port} de la caja ${p.nap.name} ya lo ocupa ${subName(p.subscriber) ?? 'otro cliente'}`,
        );
      }
      mapa.set(p.id, {
        id: p.id, numero: p.port, napLegacy: p.nap.legacyId, napNombre: p.nap.name,
        portLegacy: p.legacyId, vlanLegacy: p.nap.vlanLegacy || null,
      });
    }
    return mapa;
  }

  /** El cuerpo compartido: asigna la lista de equipos al cliente y deja la traza. */
  private async asignarEquipos(subscriberId: string, ticketCode: number | null, dto: AssignEquipmentDto, user: AuthUser) {
    // El id del cliente EN EL LEGACY: es lo que va en `equipos.asignado` allá, y sin
    // él la asignación no sobrevive al viaje de ida y vuelta — ver `assignedRaw` abajo.
    const dueño = await this.prisma.subscriber.findUnique({ where: { id: subscriberId }, select: { legacyId: true } });

    // Lote o cuerpo plano: a partir de aquí todo es una lista.
    const items: AssignEquipmentItemDto[] = dto.items?.length ? dto.items : (dto.mac ? [dto as AssignEquipmentItemDto] : []);
    if (!items.length) throw new BadRequestException('Agrega al menos un equipo');
    for (const it of items) {
      if (!it.mac?.trim()) throw new BadRequestException('Cada equipo necesita su MAC');
      if (!it.installType?.trim()) throw new BadRequestException(`Indica el tipo de instalación de ${it.mac.trim()}`);
    }

    // Repetidos dentro del mismo envío: sin esto, dos líneas con la misma MAC
    // pasarían las validaciones de una en una y dejarían dos unidades gemelas.
    const vistas = new Set<string>();
    for (const it of items) {
      const k = it.mac.trim().toLowerCase();
      if (vistas.has(k)) throw new BadRequestException(`La MAC ${it.mac.trim()} está repetida en la lista`);
      vistas.add(k);
    }
    const stockPedido = items.map((it) => it.equipmentId).filter((v): v is string => !!v);
    if (new Set(stockPedido).size !== stockPedido.length) {
      throw new BadRequestException('Hay una misma unidad de inventario elegida dos veces');
    }

    // Ninguna MAC puede estar asignada a OTRO cliente.
    const clash = await this.prisma.equipment.findFirst({
      where: {
        OR: items.map((it) => ({ mac: { equals: it.mac.trim(), mode: 'insensitive' as const } })),
        subscriberId: { not: null, notIn: [subscriberId] },
      },
      select: { mac: true },
    });
    if (clash) throw new BadRequestException(`La MAC ${clash.mac} ya está asignada a otro cliente`);

    // Un solo golpe al máximo: creando varias unidades a la vez, recalcularlo por
    // equipo daría el mismo `code` a todas.
    const max = await this.prisma.equipment.aggregate({ _max: { code: true } });
    let siguienteCode = (max._max.code ?? 0) + 1;

    // La caja NAP y el puerto donde queda colgado cada equipo (2026-09-09). Se
    // resuelve ANTES de la transacción para que un puerto ocupado por otro cliente
    // se conteste con un mensaje y no reviente a medio escribir el lote.
    const puertos = await this.resolverPuertos(items, subscriberId);

    const asignados = await this.prisma.$transaction(async (tx) => {
      const out: { equipmentId: string; mac: string; installType: string }[] = [];
      for (const it of items) {
        const mac = it.mac.trim();
        const caja = it.portId ? puertos.get(it.portId) ?? null : null;
        const data = {
          subscriberId, mac, installType: it.installType,
          // Con caja elegida mandan sus ids legacy; los números sueltos siguen
          // valiendo para quien llame a la API sin pasar por la pantalla.
          port: caja ? caja.portLegacy : it.port ?? null,
          vlan: it.vlan ?? caja?.vlanLegacy ?? null,
          nat: caja ? caja.napLegacy : it.nat ?? null,
          master: it.master?.trim() || null, meters: it.meters ?? null,
          accessories: it.accessories?.trim() || null, serial: it.serial?.trim() || null,
          status: 'Asignado', endDate: dateOnly(),
          returnedAt: null, // se instala de nuevo: no arrastra la fecha de la devolución anterior
          editedAt: new Date(), // asignación hecha aquí: la sincronización no la pisa
          // El mismo dueño escrito como lo escribe el legacy (`equipos.asignado` = su
          // id de cliente allá). `subscriberId` solo existe de este lado: el writeback
          // manda `assignedRaw` y después suelta el blindaje `editedAt`, así que sin
          // esto se empujaba un `asignado = 0` y la siguiente pasada de la ida dejaba
          // el equipo sin dueño otra vez. Los 5.832 equipos asignados que bajaron del
          // legacy llevan exactamente esta convención.
          ...(dueño?.legacyId == null ? {} : { assignedRaw: String(dueño.legacyId) }),
          // La reserva era una apuesta sobre qué caja se llevaría el técnico; esto ya
          // es la entrega. Se suelta la marca para que al cerrar la orden no se
          // "libere" a la bodega un equipo que está en casa del cliente.
          reservedTicketId: null,
        };
        let equipmentId: string;
        /** Dónde colgaba este mismo equipo antes, para soltar ese puerto si se mueve. */
        let anterior: { port: number | null; nat: number | null } | null = null;
        if (it.equipmentId) {
          const eq = await tx.equipment.findUnique({ where: { id: it.equipmentId }, select: { id: true, subscriberId: true, port: true, nat: true } });
          if (!eq) throw new NotFoundException('Equipo de stock no encontrado');
          if (eq.subscriberId && eq.subscriberId !== subscriberId) throw new BadRequestException(`El equipo ${mac} ya está asignado`);
          await tx.equipment.update({ where: { id: eq.id }, data });
          equipmentId = eq.id;
          anterior = { port: eq.port, nat: eq.nat };
        } else {
          const created = await tx.equipment.create({
            data: { ...data, code: siguienteCode++, warehouseLegacy: 0, supplierLegacy: 0, arrival: dateOnly() },
          });
          equipmentId = created.id;
        }
        out.push({ equipmentId, mac, installType: it.installType });

        if (caja) {
          // El censo de la caja: sin esto la NAP seguiría diciendo "puerto libre" con
          // un cliente colgado, que es justo lo que se mira antes de mandar a alguien
          // a instalar (ver /red/naps y /red/conexiones).
          await tx.port.update({
            where: { id: caja.id },
            data: { subscriberId, assignedLegacy: dueño?.legacyId ?? 0, status: 'Ocupado' },
          });
          // Y el puerto de donde venía este mismo equipo se suelta, salvo que otro
          // aparato del cliente siga colgado ahí (un cambio de equipo que reusa el
          // mismo puerto ya está cubierto por la comparación de arriba).
          if (anterior?.port && anterior.port !== caja.portLegacy) {
            const quedan = await tx.equipment.count({
              where: { subscriberId, port: anterior.port, id: { not: equipmentId } },
            });
            if (!quedan) {
              await tx.port.updateMany({
                where: { legacyId: anterior.port, subscriberId },
                data: { subscriberId: null, assignedLegacy: 0, status: 'Disponible' },
              });
            }
          }
        }
      }
      return out;
    });

    // La caja ya está entregada: lo que otra orden abierta le tuviera apartado vuelve
    // al estante. Si no, el cliente queda con dos unidades a su nombre y el aviso de
    // "esta visita sale con equipo" nombra una distinta de la que se acaba de dar.
    await new EquipoReservaService(this.prisma).liberarSobrantesDeCliente(subscriberId, asignados.map((a) => a.equipmentId));

    // Reflejar la MAC principal en el cliente (como el legacy: customers.macequipo).
    // Con varios equipos manda el primero de la lista: el legacy sólo tiene sitio
    // para uno y es el que la pantalla del cliente enseña como equipo del servicio.
    await this.prisma.subscriber.update({ where: { id: subscriberId }, data: { macEquipo: asignados[0].mac } }).catch(() => undefined);

    const detalle = (it: AssignEquipmentItemDto) => {
      // La caja se nombra por su rótulo y el puerto por su número: "N:241 PN:2393"
      // era el par de ids del legacy, que no le dice nada a quien lee el hilo.
      const caja = it.portId ? puertos.get(it.portId) : null;
      return [
        it.installType,
        caja ? `NAP ${caja.napNombre} pto ${caja.numero}` : '',
        !caja && it.port != null ? `PN:${it.port}` : '', !caja && it.nat != null ? `N:${it.nat}` : '',
        it.vlan != null ? `V:${it.vlan}` : '', it.meters != null ? `${it.meters}m` : '',
      ].filter(Boolean).join(' ');
    };
    const linea = items.map((it) => `${it.mac.trim()}${detalle(it) ? ` · ${detalle(it)}` : ''}`).join(' | ');
    await this.noteOnThread(ticketCode, subscriberId,
      `${items.length > 1 ? `${items.length} equipos asignados` : 'Equipo asignado'}: ${linea} (${user.name || user.email})`, user);
    // `equipmentId` y `mac` en singular siguen ahí por los clientes que asignaban
    // de uno en uno y leen la respuesta.
    return { ok: true, equipmentId: asignados[0].equipmentId, mac: asignados[0].mac, equipos: asignados, total: asignados.length };
  }

  /**
   * La VLAN que la OLT tiene para la ONU del cliente, para enseñarla en el editor
   * antes de guardar. Vive en soporte (y no en Red) por lo mismo que las NAP: quien
   * corrige la caja de un equipo puede ser la cajera, que no entra al módulo Red.
   */
  async vlanOltDeAbonado(subscriberId: string, user: AuthUser, refresh = false) {
    await exigirSedeSuscriptor(this.prisma, user, subscriberId);
    if (!this.olt) {
      return { ok: false, motivo: 'SIN_OLT', vlan: null, vlans: [], error: 'La consulta a la OLT no está disponible.' };
    }
    return this.olt.vlanDeAbonado(subscriberId, refresh);
  }

  /**
   * Corrige DÓNDE está colgado un equipo que el cliente ya tiene (2026-09-14): la
   * caja NAP y el puerto sólo se podían poner al entregarlo, y los 5.800 equipos
   * que bajaron del legacy —o uno al que se le cambió la acometida— no tenían por
   * dónde arreglarse.
   *
   * Misma traducción y mismo censo que la entrega (`resolverPuertos`: `nat` = id
   * legacy de la caja, `puerto` = id legacy de la FILA del puerto; el puerto nuevo
   * queda ocupado y el viejo se suelta si nadie más del cliente cuelga de él).
   *
   * La VLAN no se pide: se lee del service-port de la ONU en la OLT, que es la que
   * de verdad lleva el tráfico. Si la OLT no contesta, se guarda la caja igual y la
   * VLAN se queda como estaba —se dice en `vlanOlt`—, porque una OLT caída no es
   * razón para no poder corregir una caja.
   */
  async ubicarEquipo(subscriberId: string, equipmentId: string, dto: UbicarEquipoDto, user: AuthUser) {
    await exigirSedeSuscriptor(this.prisma, user, subscriberId);
    const eq = await this.prisma.equipment.findUnique({
      where: { id: equipmentId },
      select: { id: true, subscriberId: true, mac: true, code: true, port: true, nat: true, vlan: true, serial: true },
    });
    if (!eq || eq.subscriberId !== subscriberId) throw new NotFoundException('Ese equipo no está asignado a este cliente');

    // El serial va ANTES de preguntarle a la OLT: es con lo que se localiza la ONU
    // (`ubicarOnuDeAbonado` lo lee de la base), y con el viejo la lectura seguiría
    // diciendo "sin ONU". Por lo mismo, si cambia se salta la caché.
    const serial = dto.serial?.trim() || null;
    const cambiaSerial = !!serial && serial !== (eq.serial ?? '').trim();
    if (cambiaSerial) {
      await this.prisma.equipment.update({ where: { id: eq.id }, data: { serial, editedAt: new Date() } });
    }
    const dueño = await this.prisma.subscriber.findUnique({ where: { id: subscriberId }, select: { legacyId: true } });

    const quitar = !dto.portId && !!dto.quitarCaja;
    const puertos = dto.portId
      ? await this.resolverPuertos([{ napId: dto.napId, portId: dto.portId } as AssignEquipmentItemDto], subscriberId)
      : null;
    const caja = dto.portId ? puertos!.get(dto.portId) ?? null : null;

    // Fuera de la transacción: son segundos de SSH. Con caché (la misma lectura que
    // acaba de pintar el editor), así guardar no abre otra sesión contra la OLT.
    let vlanOlt: { ok: boolean; vlan: number | null; vlans?: number[]; error?: string; olt?: { name: string } } | null = null;
    if (this.olt) {
      vlanOlt = await this.olt.vlanDeAbonado(subscriberId, cambiaSerial).catch((e) => ({ ok: false, vlan: null, error: e?.message ?? 'No se pudo consultar la OLT.' }));
    }
    const vlan = vlanOlt?.ok && vlanOlt.vlan != null ? vlanOlt.vlan : eq.vlan;

    await this.prisma.$transaction(async (tx) => {
      await tx.equipment.update({
        where: { id: eq.id },
        data: {
          ...(caja ? { port: caja.portLegacy, nat: caja.napLegacy } : quitar ? { port: null, nat: null } : {}),
          vlan,
          editedAt: new Date(), // editado aquí: la sincronización no lo pisa
          // Ver `asignarEquipos`: sin el dueño en crudo, el writeback empuja
          // `asignado = 0` y la ida deja el equipo sin cliente.
          ...(dueño?.legacyId == null ? {} : { assignedRaw: String(dueño.legacyId) }),
        },
      });
      if (caja) {
        await tx.port.update({
          where: { id: caja.id },
          data: { subscriberId, assignedLegacy: dueño?.legacyId ?? 0, status: 'Ocupado' },
        });
      }
      if (eq.port && (quitar || (caja && eq.port !== caja.portLegacy))) {
        const quedan = await tx.equipment.count({ where: { subscriberId, port: eq.port, id: { not: eq.id } } });
        if (!quedan) {
          await tx.port.updateMany({
            where: { legacyId: eq.port, subscriberId },
            data: { subscriberId: null, assignedLegacy: 0, status: 'Disponible' },
          });
        }
      }
    });

    // La traza, en la orden abierta del cliente si la tiene (como la entrega).
    if (caja || quitar || cambiaSerial || vlan !== eq.vlan) {
      const abierta = await this.prisma.ticket.findFirst({
        where: { subscriberId, status: { in: ['PENDIENTE', 'REALIZANDO'] }, code: { not: null } },
        select: { code: true },
        orderBy: ORDEN_CRONOLOGICO,
      });
      const cambios = [
        caja ? `NAP ${caja.napNombre} pto ${caja.numero}` : quitar ? 'sin caja NAP' : '',
        cambiaSerial ? `serial ${eq.serial || '—'} → ${serial}` : '',
        vlan !== eq.vlan ? `VLAN ${vlan ?? '—'} (de la OLT)` : '',
      ].filter(Boolean).join(' · ');
      await this.noteOnThread(abierta?.code ?? null, subscriberId,
        `Equipo ${eq.mac ?? eq.code} reubicado: ${cambios} (${user.name || user.email})`, user);
    }

    return {
      ok: true,
      equipmentId: eq.id,
      napName: caja?.napNombre ?? null,
      portNumber: caja?.numero ?? null,
      serial: cambiaSerial ? serial : eq.serial,
      vlan,
      vlanOlt,
    };
  }

  /**
   * Registra material consumido en la orden y descuenta stock (Material.qty).
   * Transaccional: valida stock suficiente de cada ítem antes de descontar.
   */
  async consumeMaterials(id: string, dto: ConsumeMaterialsDto, user: AuthUser) {
    const t = await this.prisma.ticket.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('Orden no encontrada');
    if (!dto.items?.length) throw new BadRequestException('Agrega al menos un material');

    // La misma acotación que el buscador, aquí en la puerta de la escritura: el
    // buscador es una comodidad de la pantalla, esto es lo que de verdad impide que
    // un técnico descuente material de la bodega de un compañero mandando un id a
    // mano. `null` = no tiene bodega, y entonces no consume nada.
    const bodegaPropia = esTecnicoDeCampo(user) ? await bodegaMaterialDelTecnico(this.prisma, user) : null;
    if (esTecnicoDeCampo(user) && !bodegaPropia) {
      throw new ForbiddenException('No tienes una bodega de material asignada.');
    }

    const created = await this.prisma.$transaction(async (tx) => {
      const out: { name: string; qty: number }[] = [];
      for (const it of dto.items) {
        const m = await tx.material.findUnique({
          where: { id: it.materialId },
          select: { id: true, name: true, price: true, qty: true, warehouseId: true, warehouse: { select: { title: true } } },
        });
        if (!m) throw new NotFoundException('Material no encontrado');
        if (bodegaPropia && m.warehouseId !== bodegaPropia.id) {
          throw new ForbiddenException(`"${m.name}" no está en tu bodega (${bodegaPropia.title}).`);
        }
        if (m.qty < it.qty) throw new BadRequestException(`Stock insuficiente de "${m.name}" (disponible ${m.qty})`);
        await tx.material.update({ where: { id: m.id }, data: { qty: { decrement: it.qty }, editedAt: new Date() } });
        await tx.ticketMaterial.create({
          data: {
            ticketId: t.id, materialId: m.id, materialName: m.name, qty: it.qty, price: m.price,
            warehouseId: m.warehouseId, warehouseName: m.warehouse?.title ?? null, employeeName: user.name || user.email,
          },
        });
        out.push({ name: m.name, qty: it.qty });
      }
      return out;
    });

    await this.noteOnThread(t.code, t.subscriberId, `Material consumido: ${created.map((c) => `${c.qty}× ${c.name}`).join(', ')} (${user.name || user.email})`, user);
    return { ok: true, items: created };
  }
}
