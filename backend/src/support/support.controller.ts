import { BadRequestException } from '../core/http/errores';
import { IsArray, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { diskStorage } from 'multer';
import { existsSync, mkdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import * as ExcelJS from 'exceljs';
import { SupportService } from './support.service';
import { AgendaService, type FiltrosAgenda } from './agenda.service';
import { catalogoDeOrdenes, MOTIVOS_RETIRO } from './order-types';
import { GeofenceService } from './geofence.service';
import {
  SupportWriteService, CreateTicketDto, UpdateTicketDto, UpdateStatusDto, AssignDto, PriorityDto, SignatureDto, ThreadDto, AttachDto,
  AssignEquipmentDto, ConsumeMaterialsDto,
} from './support-write.service';
import { OnuProvisionService } from './onu-provision.service';
import { OrderScoreService } from './order-score.service';
import { CargoOrdenService } from '../billing/cargo-orden.service';
import { CARGOS_POR_ORDEN, cargoDeTipoDeOrden, cargoPorClave } from '../billing/cargos-orden';
import { PUNTAJE_MAX, PUNTAJE_MIN } from './order-score.policy';
import { PerformanceService } from '../reports/performance.service';
import { serviceOrderPdf } from '../common/pdf/pdf-docs';
import { APP_PERMISSIONS } from '../auth/permissions.catalog';
import { AuthUser } from '../auth/current-user.decorator';
import { enviarAdjuntoSeguro, mimeAceptado, nombreEnDisco, MIMES_IMAGEN } from '../common/uploads';

/** ONU que el técnico eligió del autofind para autenticar en esta orden. */
export class AutenticarOnuDto {
  /**
   * SN de la ONU a autenticar. **Opcional**: sin él lo decide el servidor —se
   * autentica el equipo que el cliente ya tenga asignado y, si es un cliente
   * nuevo, se le carga uno de la bodega de su sede— siempre entre las ONUs que
   * la OLT está viendo anunciarse. Ver `OnuProvisionService.decidirAutomatico`.
   */
  @IsOptional() @IsString() @MinLength(4) sn?: string;
  /**
   * Equipo del inventario al que corresponde esta ONU. Solo hace falta cuando el
   * SN no está registrado con ese serial: sirve para dejar el equipo a nombre del
   * abonado y, de paso, corregirle el serial con el que reporta la OLT.
   */
  @IsOptional() @IsString() equipmentId?: string;
}

/**
 * Un movimiento en la agenda. Describe el DESTINO entero (quién, qué día, qué
 * puesto), así que el mismo cuerpo sirve para los cuatro arrastres posibles.
 * `staffId`/`fecha` en null = sacarla del día y devolverla a "sin agendar".
 */
export class MoverAgendaDto {
  @IsString() ticketId!: string;
  @IsOptional() @IsString() staffId?: string | null;
  @IsOptional() @IsString() fecha?: string | null;
  /**
   * Dónde queda dentro de la columna, dicho POR VECINA y no por número: "déjala
   * justo antes (o justo después) de esta otra orden". Sin ninguna de las dos, al
   * final de la columna.
   *
   * Es por vecina porque la columna de hoy mezcla dos escalas: lo agendado para hoy
   * y lo ATRASADO de días anteriores, que conserva su día y por tanto su propia
   * numeración. Un "puesto 2" no dice de cuál de las dos habla; una tarjeta sí. El
   * servidor lo traduce a puesto contra la columna entera, así que también sale bien
   * con un filtro puesto, donde la cajera solo ve parte de las visitas.
   */
  @IsOptional() @IsString() antesDe?: string | null;
  @IsOptional() @IsString() despuesDe?: string | null;
  /** Respaldo por número, en la escala del día destino. Lo que se use si no hay vecina. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) posicion?: number;
}

/**
 * Agendar VARIAS órdenes al mismo técnico de una vez.
 *
 * Es lo que hace utilizable la bandeja cuando hay 120 órdenes esperando: la cajera
 * filtra la tanda ("barrio Centro", "instalaciones"), marca las que van y las manda
 * juntas. Sin esto había que abrir el desplegable de cada tarjeta.
 *
 * `ticketIds` viaja en el orden en que ella las está viendo, y ese es el orden en
 * que entran a la agenda del técnico.
 */
export class MoverLoteAgendaDto {
  @IsArray() @IsString({ each: true }) ticketIds!: string[];
  @IsString() staffId!: string;
  @IsOptional() @IsString() fecha?: string | null;
}

/**
 * Aplicar el recorrido sugerido. `ticketIds` va en el ORDEN propuesto y tiene que
 * ser la jornada COMPLETA de ese técnico ese día: el servicio lo comprueba y
 * rechaza la lista si la agenda cambió mientras se miraba la propuesta.
 */
export class RecorridoAgendaDto {
  @IsArray() @IsString({ each: true }) ticketIds!: string[];
  @IsString() staffId!: string;
  @IsOptional() @IsString() fecha?: string | null;
}

/**
 * "No se pudo atender": la salida del técnico cuando llega y la visita no se puede
 * hacer. El motivo es obligatorio a propósito — es lo único que le llega a quien
 * tiene que reagendarla, y sin él la visita vuelve a la bandeja sin saber por qué.
 */
export class NoAtendidaDto {
  @IsString() ticketId!: string;
  @IsString() @MaxLength(300) motivo!: string;
}

/**
 * Un renglón de la tabla de puntajes. `puntos: null` significa "quítale el valor
 * fijado y que vuelva al sugerido del sistema", que no es lo mismo que ponerle 1.
 */
export class PuntajeTipoDto {
  @IsString() @MinLength(1) tipo!: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(PUNTAJE_MIN) @Max(PUNTAJE_MAX) puntos!: number | null;
}

/** Guarda de una sola vez todo lo que la pantalla cambió. */
export class SaveOrderScoresDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => PuntajeTipoDto) puntajes!: PuntajeTipoDto[];
}

/** Carpeta de evidencias fotográficas de las órdenes de soporte. */
export const SUPPORT_ROOT = join(process.cwd(), 'uploads', 'support');
type MulterFile = { originalname: string; filename: string; mimetype: string; size: number };

/** Soporte: órdenes/tickets, llamadas, encuestas (migrado de saves-vestel). */
export class SupportController {
  constructor(
    private readonly support: SupportService,
    private readonly write: SupportWriteService,
    private readonly geofence: GeofenceService,
    private readonly onuProvision: OnuProvisionService,
    private readonly performance: PerformanceService,
    private readonly agenda: AgendaService,
    private readonly puntajes: OrderScoreService,
    private readonly cargoOrden: CargoOrdenService,
  ) {}

  // ── Agendamiento (2026-07-31) ─────────────────────────────────────────────
  // Quien agenda es la cajera (y administración): reparte el día entre los técnicos
  // y decide el orden de las visitas. Va con `@RequireArea` propio porque el técnico
  // NO entra aquí — él sigue la agenda, no la arma —, y `AgendaService.mover` lo
  // vuelve a comprobar por si alguien reenvía la petición a mano.
  /**
   * Tablero del día: bandeja de "sin agendar" + una columna por técnico.
   *
   * Los filtros (`q`, `clase`, `prioridad`, `estado`, `noAtendidas`) se resuelven en
   * el servicio y filtran ÓRDENES: las columnas siguen estando todas.
   */
  
  agendaTablero(user: AuthUser, q: Record<string, string>) {
    return this.agenda.tablero(user, q.fecha, SupportController.filtrosAgenda(q));
  }
  /** Mover una orden: a la columna de un técnico en una posición, o a "sin agendar". */
  
  agendaMover(dto: MoverAgendaDto, user: AuthUser) {
    return this.agenda.mover(user, dto);
  }
  agendaMoverLote(dto: MoverLoteAgendaDto, user: AuthUser) {
    return this.agenda.moverLote(user, dto);
  }
  /**
   * El recorrido sugerido para la jornada de un técnico: qué visita antes que
   * cuál para no cruzar la ciudad dos veces. Sólo PROPONE — ver `agendaRecorrido`
   * en `AgendaService` y por qué no lo calcula un modelo de lenguaje.
   */
  agendaRecorrido(user: AuthUser, q: Record<string, string>) {
    return this.agenda.recorrido(user, q.staffId, q.fecha);
  }
  /** Escribe el orden propuesto. Lo dispara una persona, nunca el cálculo. */
  agendaAplicarRecorrido(dto: RecorridoAgendaDto, user: AuthUser) {
    return this.agenda.aplicarRecorrido(user, dto);
  }
  /** Quién tiene ya trabajo en cada barrio ese día, para repartir por zonas. */
  agendaZonas(user: AuthUser, q: Record<string, string>) {
    return this.agenda.zonasDelDia(user, q.fecha);
  }
  /**
   * La agenda de una SEMANA: la misma bandeja y una rejilla de técnicos × días
   * (2026-08-26). Acepta los mismos filtros que el tablero del día.
   */
  agendaSemana(user: AuthUser, q: Record<string, string>) {
    return this.agenda.semana(user, q.desde, Number(q.dias) || undefined, SupportController.filtrosAgenda(q));
  }
  /**
   * El calendario del MES: cuántas visitas hay cada día y de quién. Solo cuenta — el
   * detalle se ve entrando a la semana o al día.
   */
  agendaCalendario(user: AuthUser, q: Record<string, string>) {
    return this.agenda.calendario(user, q.desde, q.hasta, SupportController.filtrosAgenda(q));
  }
  /** Lee los filtros del tablero de la query, tal como los manda la pantalla. */
  private static filtrosAgenda(q: Record<string, string>): FiltrosAgenda {
    return {
      q: q.q,
      clase: q.clase,
      tipo: q.tipo,
      prioridad: q.prioridad,
      estado: q.estado,
      noAtendidas: q.noAtendidas === '1' || q.noAtendidas === 'true',
      // La sede NO es un filtro más: estrecha el ALCANCE (ver `AgendaService.alcance`).
      // Estuvo escrita en `FiltrosAgenda` y resuelta en el servicio desde el
      // 2026-08-28, pero NADIE la leía de la query: el desplegable llegó a la
      // pantalla el 2026-09-02 y hasta entonces elegir sede no hacía nada.
      sede: q.sede,
    };
  }
  /**
   * Export a Excel del agendamiento: un DÍA (`fecha`) o un tramo entero
   * (`desde`/`hasta` — la semana que se está repartiendo, el mes).
   *
   * Mismo alcance y MISMOS FILTROS que la pantalla: el Excel tiene que traer lo que
   * la cajera está viendo, o el papel que lleva a la reunión no cuadra con la
   * pantalla desde la que lo pidió.
   *
   * Y lleva la ficha del cliente entera —nombre, abonado, CÉDULA, sus dos teléfonos,
   * dirección (con la referencia detrás), barrio y sede—: este archivo se imprime y
   * se reparte, y una lista de visitas sin a quién ni a dónde no sirve para salir a
   * la calle.
   */
  async agendaXlsx(res: Response, user: AuthUser, q: Record<string, string>) {
    const d = await this.agenda.filasExport(user, q.desde ?? q.fecha, q.hasta, SupportController.filtrosAgenda(q));
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Vestel';
    const unDia = d.desde === d.hasta;
    const ws = wb.addWorksheet(unDia ? `Agenda ${d.desde}` : `Agenda ${d.desde} a ${d.hasta}`);
    ws.columns = [
      { header: 'Día', key: 'dia', width: 12 },
      // "Asignado a" y no "Técnico" (2026-09-02, a pedido del usuario: «pero a quien
      // fue asignado»): la columna siempre llevó al técnico, pero al lado de
      // "Agendada por" —que es quien la REPARTIÓ— un "Técnico" a secas no dice cuál
      // de las dos personas es, y quien imprime el papel necesita las dos.
      { header: 'Asignado a', key: 'tecnico', width: 24 },
      { header: 'Visita', key: 'puesto', width: 8 },
      { header: 'N°', key: 'code', width: 9 },
      { header: 'Estado', key: 'status', width: 13 },
      { header: 'Prioridad', key: 'priority', width: 11 },
      // Los días que lleva abierta. Estaba en la pantalla ("Espera") y era lo único
      // suyo que no bajaba al Excel: sin esto, el papel no distingue la que entró
      // ayer de la que lleva 27 días esperando.
      { header: 'Espera (días)', key: 'espera', width: 12 },
      { header: 'Clase', key: 'subject', width: 12 },
      { header: 'Detalle', key: 'type', width: 24 },
      // A partir de aquí, el cliente: es lo que hace útil el papel en la calle.
      { header: 'Cliente', key: 'cliente', width: 30 },
      { header: 'Abonado', key: 'abonado', width: 10 },
      { header: 'Cédula', key: 'cedula', width: 16 },
      { header: 'Teléfono', key: 'telefono', width: 15 },
      { header: 'Otro teléfono', key: 'telefono2', width: 15 },
      { header: 'Dirección', key: 'direccion', width: 34 },
      { header: 'Barrio', key: 'barrio', width: 18 },
      { header: 'Sede', key: 'sede', width: 14 },
      // Dos columnas y no una: son los dos campos que enseña la ficha de la orden.
      // `problem` es la falla en una línea y casi nunca viene (25 de 212); lo que de
      // verdad describe el trabajo es `section`, la observación — y era justo la que
      // faltaba en el papel que sale a la calle.
      { header: 'Falla reportada', key: 'problema', width: 28 },
      { header: 'Observaciones', key: 'observacion', width: 44 },
      { header: 'Agendada por', key: 'agendadaPor', width: 18 },
      // Lo que viene arrastrado de un día anterior tiene que decirlo también aquí:
      // impreso, una atrasada del jueves es indistinguible del trabajo de hoy.
      { header: 'Atrasada desde', key: 'atrasada', width: 14 },
      { header: 'No se pudo atender', key: 'noAtendida', width: 30 },
    ];
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    // Las fechas llegan como `Date` (esto no pasa por JSON): `String(fecha)` daría
    // 'Wed Aug 26' en la celda, que ni se ordena ni se lee.
    const soloFecha = (v: unknown): string =>
      v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? '').slice(0, 10);
    const fila = (o: any, dia: string) => ws.addRow({
      dia, tecnico: o.tecnico ?? '', puesto: o.puesto ?? o.seq ?? '', code: o.code ?? '',
      status: o.status, priority: o.priority ?? '', espera: o.espera ?? '',
      subject: o.subject ?? '', type: o.type ?? '',
      cliente: o.cliente ?? '', abonado: o.abonado ?? '', cedula: o.cedula ?? '',
      telefono: o.telefono ?? '', telefono2: o.telefono2 ?? '',
      // La referencia se pega DETRÁS de la dirección en vez de en una columna
      // suya: hay abonados cuyas casillas de dirección están vacías y su única
      // seña es ésta ('LOTE 183'), y una celda de dirección en blanco en el papel
      // que sale a la calle es una visita que no se hace.
      direccion: [o.direccion, o.referencia].filter(Boolean).join(' · '),
      barrio: o.barrio ?? '', sede: o.sede ?? '',
      problema: o.problema ?? '', observacion: o.observacion ?? '', agendadaPor: o.agendadaPor ?? '',
      // Atrasada = se lista en un día que NO es aquel para el que se agendó. Se
      // deduce de las dos fechas y no del `atrasada` de la tarjeta, que mira contra
      // HOY: en un Excel del mes pasado eso marcaría como atrasado todo lo ya hecho.
      atrasada: o.dia && soloFecha(o.agendadaPara) && o.dia !== soloFecha(o.agendadaPara) ? soloFecha(o.agendadaPara) : '',
      noAtendida: o.noAtendida ? `${soloFecha(o.noAtendida.fecha)} · ${o.noAtendida.motivo ?? ''}`.trim() : '',
    });
    for (const o of d.filas) fila(o, o.dia ?? '');
    // La bandeja va al final: la pregunta que sigue a "qué hay repartido" es
    // siempre "y qué falta por repartir".
    for (const o of d.sinAgendar) fila(o, '— Sin agendar —');
    const nombre = unDia ? `agenda-${d.desde}` : `agenda-${d.desde}_a_${d.hasta}`;
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${nombre}.xlsx"`);
    res.send(buffer);
  }
  /**
   * "Mi agenda": las órdenes que la cajera le puso al técnico logueado para un día,
   * en su orden. Sin parámetros de alcance — quién es lo dice la sesión.
   */
  miAgenda(user: AuthUser, fecha?: string) {
    return this.agenda.miAgenda(user, fecha);
  }

  /**
   * "Lo que viene": lo que el técnico logueado ya tiene agendado para los próximos
   * días. Es un resumen para que pueda organizarse; su trabajo de hoy va aparte.
   */
  misProximas(user: AuthUser, dias?: string) {
    return this.agenda.misProximas(user, Number(dias) || undefined);
  }

  /**
   * "Llegué y no se pudo": aparta una visita del día con un motivo. No cierra la
   * orden — vuelve a la bandeja de la cajera para que la reagende. Sin `@RequireArea`
   * extra: es una acción sobre su propio trabajo, y el servicio ya comprueba que la
   * orden sea suya, esté agendada y siga abierta.
   */
  noAtendida(
    dto: NoAtendidaDto,
    user: AuthUser,
  ) {
    return this.agenda.noSePudoAtender(user, dto.ticketId, dto.motivo);
  }

  /**
   * Informe de la geo-cerca: cierres fuera de rango. Restringido a quien manda —
   * es un informe sobre el desempeño de personas concretas.
   */
  /** IPs desde las que se ha escrito, para poder marcar cuáles son de oficina. */
  knownIps(dias?: string) {
    const d = Number(dias);
    return this.geofence.ipsVistas(Number.isFinite(d) && d > 0 && d <= 365 ? d : undefined);
  }

  /** Marca qué IPs son de oficina (lista completa, reemplaza la anterior). */
  setOfficeIps(dto: { ips?: string[] }, user: AuthUser) {
    return this.geofence.guardarOficinas(Array.isArray(dto?.ips) ? dto.ips : [], user);
  }

  geofenceReport(dias?: string) {
    const d = Number(dias);
    return this.geofence.informe(Number.isFinite(d) && d > 0 && d <= 365 ? d : undefined);
  }

  stats(user?: AuthUser) { return this.support.stats(user); }
  filterOptions(user: AuthUser) { return this.support.filterOptions(user); }
  /**
   * Las tres clases de orden del legacy con sus detalles, para el formulario de
   * "nueva orden". Vive en el backend y no en el frontend a propósito: es la misma
   * lista con la que se validan y se enderezan las órdenes que entran por el
   * chatbot (ver `order-types.ts`), y una copia en la web se desincronizaría.
   */
  orderCatalog() { return catalogoDeOrdenes(); }

  /**
   * Por qué se va el cliente, para el desplegable de la orden de "Retiro voluntario".
   *
   * Es lista cerrada y del servidor por lo mismo que el catálogo de detalles: el
   * motivo se guarda en `Ticket.problem` —la misma columna por la que agrupan los
   * informes de retiros del legacy—, así que una copia escrita en la web abriría
   * variantes del mismo texto en cuanto alguien tocara una tilde.
   */
  motivosRetiro() { return [...MOTIVOS_RETIRO]; }

  /**
   * Lo que se le va a cobrar al cliente por abrir una orden, para poder decírselo en
   * el formulario ANTES de abrirla.
   *
   * El precio sale del catálogo, no del frontend: escribirlo en la web es garantizar
   * que el día que suba de precio la pantalla siga diciendo 30.000 mientras la
   * factura dice otra cosa.
   *
   * @param tipo  el `Ticket.type` que se está eligiendo ('Traslado',
   *   'AgregarInternet') o la clave corta del cargo. Sin `tipo` devuelve TODOS los
   *   cargos, que es lo que pide el formulario al abrirse para no tener que
   *   preguntar de nuevo cada vez que se cambia el detalle.
   */
  async cargoDeOrden(tipo?: string) {
    const pedido = tipo?.trim()
      ? [cargoDeTipoDeOrden(tipo) ?? cargoPorClave(tipo)].filter((c) => c !== null)
      : CARGOS_POR_ORDEN;
    const cargos = await Promise.all(
      pedido.map(async (cargo) => {
        const [modo, tarifa] = await Promise.all([this.cargoOrden.modo(cargo!), this.cargoOrden.tarifa(cargo!)]);
        return {
          clave: cargo!.clave,
          tipo: cargo!.tipo,
          etiqueta: cargo!.etiqueta,
          activo: modo === 'on',
          modo,
          precio: tarifa.precio,
          ivaPct: tarifa.ivaPct,
          concepto: tarifa.concepto,
          delCatalogo: tarifa.delCatalogo,
        };
      }),
    );
    // Con `tipo` se responde el cargo suelto (o null si ese tipo no cobra nada) y
    // sin él la lista: dos formas, pero la de la lista es la que evita una consulta
    // por cada detalle que se prueba en el desplegable.
    return tipo?.trim() ? (cargos[0] ?? null) : cargos;
  }

  // ── Puntaje de las órdenes (2026-08-04) ───────────────────────────────────
  /**
   * Cuánto vale cada tipo de orden, de 1 a 5.
   *
   * La lista de áreas es MÁS ANCHA que la de la clase, no más estrecha, y por los
   * dos extremos: el técnico entra porque si se le mide con estos puntos tiene
   * derecho a saber cuánto vale cada trabajo antes de hacerlo, no después; y
   * gerencia y sistemas entran porque son quienes lo configuran —sin esto, la
   * pantalla de configuración recibía 403 justo de quien la abre—.
   */
  orderScores() { return this.puntajes.catalogo(); }
  /**
   * Fijar los puntajes. Esto sí es decisión de gestión, no de quien ejecuta: las
   * mismas dos áreas que ven la pantalla (ver SCREENS['/configuracion/puntajes']).
   */
  
  saveOrderScores(dto: SaveOrderScoresDto, user: AuthUser) {
    return this.puntajes.guardar(dto.puntajes, user?.name ?? user?.email);
  }

  // --- Escritura ---
  technicians() { return this.write.technicians(); }
  createTicket(dto: CreateTicketDto, user: AuthUser) { return this.write.createTicket(dto, user); }
  /** La IP se pasa al servicio para poder cotejarla con la ubicación declarada
   *  (un técnico en el wifi de la oficina no puede estar a 3 km). */
  updateStatus(
    id: string,
    dto: UpdateStatusDto,
    user: AuthUser,
    req: { ip?: string; socket?: { remoteAddress?: string } },
  ) {
    return this.write.updateStatus(id, dto, user, req?.ip ?? req?.socket?.remoteAddress ?? null);
  }
  assign(id: string, dto: AssignDto, user: AuthUser) { return this.write.assign(id, dto, user); }
  /** Corregir el trabajo de una orden ya abierta (clase, detalle, falla, fecha…). */
  updateTicket(id: string, dto: UpdateTicketDto, user: AuthUser) { return this.write.updateTicket(id, dto, user); }
  setPriority(id: string, dto: PriorityDto) { return this.write.setPriority(id, dto); }
  sign(id: string, dto: SignatureDto) { return this.write.saveSignature(id, dto); }
  /** Sirve el PNG de la firma dibujada de una orden. */
  async signaturePng(id: string, res: Response) {
    const file = join(process.cwd(), 'uploads', 'signatures', `${id}.png`);
    if (!existsSync(file)) return res.status(404).send('sin firma');
    return enviarAdjuntoSeguro(res, file, `firma-${id}.png`);
  }
  thread(id: string, dto: ThreadDto, user: AuthUser) { return this.write.addThread(id, dto, user); }

  // --- Equipo y material de la orden ---
  availableEquipment(search?: string) { return this.write.availableEquipment(search); }
  searchMaterials(user: AuthUser, search?: string) { return this.write.searchMaterials(user, search); }
  assignEquipment(id: string, dto: AssignEquipmentDto, user: AuthUser) { return this.write.assignEquipment(id, dto, user); }
  consumeMaterials(id: string, dto: ConsumeMaterialsDto, user: AuthUser) { return this.write.consumeMaterials(id, dto, user); }

  // --- ONU de la orden (autenticar contra la OLT desde la instalación) ---
  /**
   * Estado del bloque de ONU: OLT de la sede, plan del abonado, velocidad que se
   * aplicará y ONUs esperando autenticación. Lectura en vivo contra la OLT.
   */
  onuEstado(id: string, user?: AuthUser) {
    return this.onuProvision.estado(id, user);
  }
  /**
   * Autenticar la ONU elegida. Escribe en la OLT, así que exige el mismo permiso
   * que hacerlo desde Red › OLT: que la puerta sea otra no la hace más ancha.
   */
  autenticarOnu(id: string, dto: AutenticarOnuDto, user: AuthUser) {
    return this.onuProvision.autenticar(id, dto, user);
  }
  /** Aplicar al service-port la velocidad del plan vigente (órdenes de subir/bajar megas). */
  aplicarVelocidadOnu(id: string, user: AuthUser) {
    return this.onuProvision.aplicarVelocidad(id, user);
  }

  /** PDF de la orden de servicio (acta técnica). */
  async ticketPdf(id: string, res: Response, user?: AuthUser) {
    const data = await this.support.serviceOrderPdfData(id, user);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="Orden_${data.code}.pdf"`);
    serviceOrderPdf(res, data);
  }

  /** Adjuntar una foto de evidencia al hilo (con geo-etiquetado opcional). Solo imágenes. */
  attach(
    id: string,
    file: MulterFile,
    dto: AttachDto,
    user: AuthUser,
  ) {
    if (!file) throw new BadRequestException('Sube una imagen en el campo "file".');
    return this.write.addAttachment(id, file, dto, user);
  }

  /** Sirve la imagen adjunta de una entrada del hilo (inline, para preview autenticado vía blob). */
  async attachment(threadId: string, res: Response) {
    const a = await this.support.getThreadAttachment(threadId);
    return enviarAdjuntoSeguro(res, join(SUPPORT_ROOT, a.storedName), a.storedName);
  }

  tickets(search?: string, status?: string, type?: string, tec?: string, priority?: string, sede?: string, subscriberId?: string, from?: string, to?: string, all?: string, page?: string, pageSize?: string, sortBy?: string, sortDir?: string, user?: AuthUser) {
    return this.support.tickets({ search, status, type, tec, priority, sede, subscriberId, from, to, all, page: Number(page), pageSize: Number(pageSize), sortBy, sortDir }, user);
  }

  /**
   * Export a Excel del listado, con los MISMOS filtros. Declarado antes de
   * `tickets/:id` para que 'export.xlsx' no caiga en el parámetro.
   */
  async ticketsXlsx(
    res: Response,
    search?: string, status?: string, type?: string,
    tec?: string, priority?: string, sede?: string,
    from?: string, to?: string, all?: string,
    user?: AuthUser,
  ) {
    const rows = await this.support.exportRows({ search, status, type, tec, priority, sede, from, to, all }, user);
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Vestel';
    const ws = wb.addWorksheet('Órdenes de soporte');
    ws.columns = [
      { header: 'N°', key: 'code', width: 9 },
      { header: 'Creada', key: 'created', width: 12 },
      { header: 'Clase', key: 'subject', width: 12 },
      { header: 'Detalle', key: 'type', width: 24 },
      { header: 'Prioridad', key: 'priority', width: 11 },
      // Los días que lleva abierta. Estaba en la pantalla ("Espera") y era lo único
      // suyo que no bajaba al Excel: sin esto, el papel no distingue la que entró
      // ayer de la que lleva 27 días esperando.
      { header: 'Espera (días)', key: 'espera', width: 12 },
      { header: 'Estado', key: 'status', width: 13 },
      { header: 'Cliente', key: 'client', width: 30 },
      // Con quién y a dónde. Faltaban las tres (2026-08-31, a pedido del usuario):
      // el Excel se imprime para salir a la calle y una orden sin cédula, teléfono
      // ni dirección obliga a volver al sistema abonado por abonado.
      { header: 'Abonado', key: 'abonado', width: 10 },
      { header: 'Cédula', key: 'cedula', width: 16 },
      { header: 'Teléfono', key: 'telefono', width: 15 },
      { header: 'Otro teléfono', key: 'telefono2', width: 15 },
      { header: 'Dirección', key: 'direccion', width: 34 },
      { header: 'Sede', key: 'sede', width: 14 },
      { header: 'Barrio', key: 'barrio', width: 18 },
      { header: 'Técnico', key: 'assigned', width: 22 },
      // Quién la mandó, al lado de quién la hizo: es la columna con la que se
      // audita de dónde salió el trabajo (vacía en las heredadas sin autor).
      { header: 'Generada por', key: 'generadaPor', width: 22 },
      { header: 'Descripción', key: 'description', width: 40 },
      { header: 'Cerrada', key: 'finalDate', width: 12 },
    ];
    ws.getRow(1).font = { bold: true };
    for (const r of rows) {
      ws.addRow({
        ...r,
        // La referencia va pegada detrás de la dirección, igual que en el Excel de
        // la agenda: hay abonados sin casillas de dirección cuya única seña es ésa.
        direccion: [r.direccion, r.referencia].filter(Boolean).join(' · '),
        created: r.created ? new Date(r.created).toISOString().slice(0, 10) : '',
        finalDate: r.finalDate ? new Date(r.finalDate).toISOString().slice(0, 10) : '',
      });
    }
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="ordenes-soporte-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.send(buffer);
  }

  /**
   * "Mi jornada": la cola de órdenes del técnico logueado y los contadores de su día.
   * Es lo primero que ve el técnico al entrar (panel de `/dashboard`).
   *
   * No lleva parámetros a propósito: el alcance lo fija la sesión, no la query. Así
   * no hay forma de pedir la jornada de otro cambiando un id en la URL.
   */
  miJornada(user: AuthUser) { return this.support.miJornada(user); }

  /**
   * "Mi rendimiento": las MISMAS métricas del tablero de gerencia
   * (`/reports/tecnicos/:staffId`), pero acotadas a quien pregunta.
   *
   * Se reutiliza `PerformanceService` en vez de recalcular: si la re-visita se mide
   * distinto aquí que en el informe del jefe, la conversación entre ambos es imposible.
   * Lo único que viaja del equipo son las MEDIANAS (`equipo`), sin nombres: el técnico
   * necesita saber si su 12% es bueno o malo, y para eso hace falta la referencia.
   */
  async miRendimiento(user: AuthUser, from?: string, to?: string) {
    const staff = await this.support.staffDelUsuario(user);
    if (!staff) return { resolved: false, resumen: null, equipo: null, porTipo: [], casos: [] };
    const d = await this.performance.tecnico(staff.id, from, to);
    // Los casos concretos de re-visita son de él: sí los ve, son lo único accionable.
    return { resolved: true, tech: { id: staff.id, name: staff.name }, ...d };
  }

  ticketDetail(id: string, user?: AuthUser) { return this.support.ticketDetail(id, user); }

}
