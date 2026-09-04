import { BadRequestException, ForbiddenException, NotFoundException } from '../core/http/errores';
import type { EmisorDeEventos } from '../core/eventos';
import { Type } from 'class-transformer';
import { IsArray, IsDateString, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { Prisma, ServiceStatus, TicketStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/current-user.decorator';
import { MikrotikService } from '../network/mikrotik.service';
import type { GenieacsService } from '../network/genieacs.service';

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
import { ResponsibilityNotifierService } from '../responsibilities/responsibility-notifier.service';
import {
  BAJA_APLICADA_EVENT, TICKET_ANULADA_EVENT, TICKET_ASIGNADO_EVENT, TICKET_CREADO_EVENT, TICKET_RESUELTO_EVENT,
  type BajaAplicadaEvent, type TicketAsignadoEvent, type TicketResueltoEvent,
} from './support.events';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CARGO_TECNICO } from '../staff/cargos-legacy';
import { bodegaMaterialDelTecnico, esTecnicoDeCampo, fichaDelUsuario } from '../common/tecnico-scope';
import { hoyEnColombia } from '../common/fecha-colombia';
import { num, round2 } from '../common/money';
import { puedeAbrirOrden } from './turno';
import { nextTid, TID_SEQ } from '../common/tid';
import { AgendaService } from './agenda.service';
import { autorDeOrden, autorDeSeguimiento, SEGUIMIENTO_DEL_SISTEMA, type FirmaDeSeguimiento } from './autor-orden';
import { ETIQUETA_CLASE, esCambioDeMegas, esClaseOrden, esReconexion, esReconexionPorDias, esRetiroVoluntario, esTraslado, MAX_DIAS_GRACIA, motivoDeRetiroCanonico, MOTIVOS_RETIRO, resolverClase, sentidoDeMegas, serviciosDeOrden, serviciosDeReconexion } from './order-types';
import type { SubscribersService } from '../subscribers/subscribers.service';
import type { ProrrateoReconexionService } from '../billing/prorrateo-reconexion.service';
import type { CargoOrdenService, ResultadoCargo } from '../billing/cargo-orden.service';
import { cargoDeTipoDeOrden } from '../billing/cargos-orden';
import { direccionDe, nomenclaturaLimpia } from '../common/subscriber-address';
import { OrderScoreService } from './order-score.service';

/** Carpeta de firmas PNG dibujadas de las órdenes. */
const SIGNATURE_ROOT = join(process.cwd(), 'uploads', 'signatures');

export const TICKET_PRIORITIES = ['Baja', 'Media', 'Alta', 'Urgente'] as const;

/**
 * A dónde se muda el cliente. Solo lo lleva la orden de 'Traslado'.
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
  /** Motivo para cerrar estando fuera del radio. */
  @IsOptional() @IsString() @MaxLength(500) justificacion?: string;
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
  @IsOptional() @IsString() master?: string;
  @IsOptional() @Type(() => Number) @IsInt() meters?: number;
  @IsOptional() @IsString() accessories?: string;
  @IsOptional() @IsString() serial?: string;
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
   */
  async createTicket(
    dto: CreateTicketDto,
    user: AuthUser,
    opts: { destinoOpcional?: boolean; planOpcional?: boolean } = {},
  ) {
    // El técnico de campo ATIENDE órdenes, no las abre (2026-07-31, decisión del
    // usuario): quien las genera es quien recibe al cliente —caja, administración o
    // el chatbot—, y así el trabajo entra por un solo sitio y con quién lo pidió.
    if (esTecnicoDeCampo(user)) {
      throw new ForbiddenException('No puedes crear órdenes de trabajo. Tú atiendes las que te asignan.');
    }
    const sub = await this.prisma.subscriber.findUnique({
      where: { id: dto.subscriberId },
      select: { id: true, nomenclature: true, addressLine: true, neighborhood: true },
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
    const deEsteTipo = cargoDeTipoDeOrden(dto.type);
    const cargo = deEsteTipo && (!esTraslado(dto.type) || traslado) ? deEsteTipo : null;
    let cobro: ResultadoCargo | null = null;
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
            factura: cobro?.invoiceTid ?? null,
            cobrado: cobro?.cobrado ?? false,
            mensaje: cobro?.mensaje ?? 'No se facturó el traslado.',
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
   * Valida el CAMBIO DE MEGAS de una orden nueva: a qué plan se pasa el cliente, de
   * cuál viene y qué hay que escribir en la orden.
   *
   * Devuelve `null` si la orden no es de megas — y ahí el `planToId` que venga se
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
    if (!esCambioDeMegas(dto.type)) return null;
    if (!dto.planToId) {
      if (planOpcional) return null;
      throw new BadRequestException(
        'Di a qué plan se pasa el cliente: una orden de megas sin plan no dice cuántas son.',
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

    const deA = `de ${actual?.megas != null ? `${actual.megas} Megas` : actual?.nombre ?? 'plan sin registrar'}`
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
   * El destino de un traslado, a partir de las casillas de dirección: a dónde va,
   * de dónde sale y qué hay que escribirle en la ficha.
   *
   * Lo comparten abrir la orden y corregirla después. `mismaEsError` es la única
   * diferencia entre las dos: al ABRIRLA, una dirección igual a la que ya tiene el
   * cliente es un error de dedo (nadie se muda a donde ya vive); al REGISTRARLA en
   * una orden que ya existe, es lo más normal del mundo —la orden nació en el
   * legacy y allá ya le cambiaron la dirección a la ficha—, y ahí lo que se quiere
   * es dejar dicho en la orden a dónde se fue, sin volver a tocar la ficha.
   */
  private armarTraslado(
    moveTo: TrasladoDto,
    sub: { nomenclature: unknown; addressLine: string | null; neighborhood: string | null },
    { mismaEsError = true }: { mismaEsError?: boolean } = {},
  ) {
    const nomenclature = nomenclaturaLimpia(moveTo.nomenclature);
    const addressLine = moveTo.addressLine?.trim() || null;
    const direccionNueva = direccionDe(nomenclature, addressLine);
    if (!direccionNueva) {
      throw new BadRequestException('La dirección nueva está vacía: escribe al menos la vía y su número.');
    }
    const direccionVieja = direccionDe(sub.nomenclature, sub.addressLine);
    const mismaDireccion = !!direccionVieja && direccionVieja.toLowerCase() === direccionNueva.toLowerCase();
    if (mismaDireccion && mismaEsError) {
      throw new BadRequestException(`La dirección nueva es la misma que ya tiene el cliente (${direccionVieja}).`);
    }

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
      /** `true` si la ficha ya estaba en esa dirección: no hay nada que moverle. */
      mismaDireccion,
      fichaData: { nomenclature: nomenclature as Prisma.InputJsonValue, ...zona, ...(addressLine ? { addressLine } : {}) },
      notaObservacion: `Traslado: de ${direccionVieja ?? 'dirección sin registrar'} a ${direccionNueva}.`,
    };
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

    // Turno obligatorio: el técnico no cierra una orden que no le toca. La puerta de
    // `ticketDetail` bloquea abrirla, pero cambiar el estado es un endpoint aparte y
    // sin esto quedaba el atajo de llamarlo directamente con el id.
    if (esTecnicoDeCampo(user)) {
      const ficha = await fichaDelUsuario(this.prisma, user!);
      if (ficha) {
        const v = await puedeAbrirOrden(this.prisma, ficha.id, { id, status: t.status });
        if (!v.permitido) throw new ForbiddenException(v.motivo);
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
    return { id, status: dto.status, cascade };
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
    // informe que nadie abre.
    if (veredicto.accion === 'permitir-justificado' || veredicto.accion === 'permitir-marcado') {
      const dist = Math.round(veredicto.distanciaM);
      const quien = user?.name ?? 'Sistema';
      const motivo =
        veredicto.accion === 'permitir-justificado'
          ? ` Motivo: ${datos.closeGeoReason}`
          : ' (registrado en modo observación, sin bloquear).';
      await this.noteOnThread(
        ticketCode,
        subscriberId,
        `⚠ Cierre fuera del rango permitido: ${quien} estaba a ${dist} m del domicilio (máximo ${veredicto.radioM} m).${motivo}`,
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
     */
    const setStatus = async (status: string, nota: string) => {
      if (soloTv) return;
      const ahora = new Date();
      const antes = await this.prisma.subscriber
        .findUnique({ where: { id: sid }, select: { status: true } })
        .catch(() => null);
      await this.prisma.subscriber
        .update({
          where: { id: sid },
          data: { previousStatus: antes?.status ?? undefined, status: status as any, statusChangedAt: ahora },
        })
        .catch(() => undefined);
      cascade.statusSet = status;
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
    };

    if (kind.includes('retiro')) {
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
      await tryReconnect();

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
      // `mismaEsError: false`: si la orden vino del legacy, allá ya le cambiaron la
      // dirección a la ficha, así que lo normal es que la nueva sea la que ya tiene.
      const traslado = this.armarTraslado(dto.moveTo, sub, { mismaEsError: false });
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
    let megas: Awaited<ReturnType<typeof this.prepararCambioDeMegas>> = null;
    if (dto.planToId && esCambioDeMegas(tipoFinal) && dto.planToId !== t.planToId) {
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

  /** Equipos disponibles en stock (sin cliente asignado) para el selector del modal. */
  async availableEquipment(search?: string) {
    const where: Prisma.EquipmentWhereInput = { subscriberId: null };
    const s = search?.trim();
    if (s) where.OR = [{ mac: { contains: s, mode: 'insensitive' } }, { serial: { contains: s, mode: 'insensitive' } }];
    const rows = await this.prisma.equipment.findMany({
      where, orderBy: { code: 'asc' }, take: 30,
      select: { id: true, code: true, mac: true, serial: true, brand: true, installType: true, status: true, warehouse: { select: { name: true } } },
    });
    return rows.map((e) => ({ id: e.id, code: e.code, mac: e.mac, serial: e.serial, brand: e.brand, installType: e.installType, status: e.status, warehouse: e.warehouse?.name ?? null }));
  }

  /** Materiales con stock para el selector del modal de consumo. */
  async searchMaterials(user: AuthUser, search?: string) {
    const where: Prisma.MaterialWhereInput = { qty: { gt: 0 } };
    // El técnico de campo gasta de SU bodega y de ninguna otra (misma regla que
    // /inventario/bodegas, ver `tecnico-scope.ts`). Sin esto el buscador de la orden
    // le ofrecía el material de las 35 bodegas personales y el de los almacenes
    // generales, y `consumeMaterials` se lo descontaba a su dueño sin preguntar.
    // Si no tiene bodega asignada no puede consumir nada: mejor una lista vacía que
    // gastar del almacén de otro.
    if (esTecnicoDeCampo(user)) {
      const suya = await bodegaMaterialDelTecnico(this.prisma, user);
      if (!suya) return [];
      where.warehouseId = suya.id;
    }
    const s = search?.trim();
    if (s) where.OR = [{ name: { contains: s, mode: 'insensitive' } }, { code: { contains: s, mode: 'insensitive' } }];
    const rows = await this.prisma.material.findMany({
      where, orderBy: { name: 'asc' }, take: 30,
      select: { id: true, name: true, code: true, price: true, qty: true, warehouseId: true, warehouse: { select: { title: true } } },
    });
    return rows.map((m) => ({ id: m.id, name: m.name, code: m.code, price: Number(m.price), qty: m.qty, warehouseId: m.warehouseId, warehouse: m.warehouse?.title ?? null }));
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
    const subscriberId = t.subscriberId;

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

    const asignados = await this.prisma.$transaction(async (tx) => {
      const out: { equipmentId: string; mac: string; installType: string }[] = [];
      for (const it of items) {
        const mac = it.mac.trim();
        const data = {
          subscriberId, mac, installType: it.installType,
          port: it.port ?? null, vlan: it.vlan ?? null, nat: it.nat ?? null,
          master: it.master?.trim() || null, meters: it.meters ?? null,
          accessories: it.accessories?.trim() || null, serial: it.serial?.trim() || null,
          status: 'Asignado', endDate: dateOnly(),
          returnedAt: null, // se instala de nuevo: no arrastra la fecha de la devolución anterior
          editedAt: new Date(), // asignación hecha aquí: la sincronización no la pisa
        };
        if (it.equipmentId) {
          const eq = await tx.equipment.findUnique({ where: { id: it.equipmentId }, select: { id: true, subscriberId: true } });
          if (!eq) throw new NotFoundException('Equipo de stock no encontrado');
          if (eq.subscriberId && eq.subscriberId !== subscriberId) throw new BadRequestException(`El equipo ${mac} ya está asignado`);
          await tx.equipment.update({ where: { id: eq.id }, data });
          out.push({ equipmentId: eq.id, mac, installType: it.installType });
        } else {
          const created = await tx.equipment.create({
            data: { ...data, code: siguienteCode++, warehouseLegacy: 0, supplierLegacy: 0, arrival: dateOnly() },
          });
          out.push({ equipmentId: created.id, mac, installType: it.installType });
        }
      }
      return out;
    });

    // Reflejar la MAC principal en el cliente (como el legacy: customers.macequipo).
    // Con varios equipos manda el primero de la lista: el legacy sólo tiene sitio
    // para uno y es el que la pantalla del cliente enseña como equipo del servicio.
    await this.prisma.subscriber.update({ where: { id: subscriberId }, data: { macEquipo: asignados[0].mac } }).catch(() => undefined);

    const detalle = (it: AssignEquipmentItemDto) => [
      it.installType,
      it.port != null ? `PN:${it.port}` : '', it.nat != null ? `N:${it.nat}` : '',
      it.vlan != null ? `V:${it.vlan}` : '', it.meters != null ? `${it.meters}m` : '',
    ].filter(Boolean).join(' ');
    const linea = items.map((it) => `${it.mac.trim()}${detalle(it) ? ` · ${detalle(it)}` : ''}`).join(' | ');
    await this.noteOnThread(t.code, subscriberId,
      `${items.length > 1 ? `${items.length} equipos asignados` : 'Equipo asignado'}: ${linea} (${user.name || user.email})`, user);
    // `equipmentId` y `mac` en singular siguen ahí por los clientes que asignaban
    // de uno en uno y leen la respuesta.
    return { ok: true, equipmentId: asignados[0].equipmentId, mac: asignados[0].mac, equipos: asignados, total: asignados.length };
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
