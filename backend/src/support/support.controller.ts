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
import { catalogoDeOrdenes } from './order-types';
import { GeofenceService } from './geofence.service';
import {
  SupportWriteService, CreateTicketDto, UpdateStatusDto, AssignDto, PriorityDto, SignatureDto, ThreadDto, AttachDto,
  AssignEquipmentDto, ConsumeMaterialsDto,
} from './support-write.service';
import { OnuProvisionService } from './onu-provision.service';
import { OrderScoreService } from './order-score.service';
import { PUNTAJE_MAX, PUNTAJE_MIN } from './order-score.policy';
import { PerformanceService } from '../reports/performance.service';
import { serviceOrderPdf } from '../common/pdf/pdf-docs';
import { APP_PERMISSIONS } from '../auth/permissions.catalog';
import { AuthUser } from '../auth/current-user.decorator';
import { enviarAdjuntoSeguro, mimeAceptado, nombreEnDisco, MIMES_IMAGEN } from '../common/uploads';

/** ONU que el técnico eligió del autofind para autenticar en esta orden. */
export class AutenticarOnuDto {
  @IsString() @MinLength(4) sn!: string;
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
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) posicion?: number;
}

/**
 * "No se pudo atender": la salida del técnico cuando llega y la visita no se puede
 * hacer. El motivo es obligatorio a propósito — un salto sin explicación devuelve al
 * técnico la decisión de qué orden hacer, que es justo lo que el turno le quita.
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
  /** Lee los filtros del tablero de la query, tal como los manda la pantalla. */
  private static filtrosAgenda(q: Record<string, string>): FiltrosAgenda {
    return {
      q: q.q,
      clase: q.clase,
      tipo: q.tipo,
      prioridad: q.prioridad,
      estado: q.estado,
      noAtendidas: q.noAtendidas === '1' || q.noAtendidas === 'true',
    };
  }
  /**
   * Export a Excel del tablero del día: las visitas de cada técnico en su orden y,
   * al final, la bandeja de sin agendar. Mismo alcance que el tablero — y los mismos
   * filtros: el Excel tiene que traer lo que la cajera está viendo, o el papel que
   * lleva a la reunión no cuadra con la pantalla desde la que lo pidió.
   */
  
  async agendaXlsx(res: Response, user: AuthUser, q: Record<string, string>) {
    const fecha = q.fecha;
    const d = await this.agenda.tablero(user, fecha, SupportController.filtrosAgenda(q));
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Vestel';
    const ws = wb.addWorksheet(`Agenda ${d.fecha}`);
    ws.columns = [
      { header: 'Técnico', key: 'tecnico', width: 24 },
      { header: 'Visita', key: 'seq', width: 8 },
      { header: 'N°', key: 'code', width: 9 },
      { header: 'Estado', key: 'status', width: 13 },
      { header: 'Prioridad', key: 'priority', width: 11 },
      { header: 'Detalle', key: 'type', width: 24 },
      { header: 'Cliente', key: 'cliente', width: 30 },
      { header: 'Abonado', key: 'abonado', width: 10 },
      { header: 'Teléfono', key: 'telefono', width: 15 },
      { header: 'Barrio', key: 'barrio', width: 16 },
      { header: 'Dirección', key: 'direccion', width: 26 },
      { header: 'Sede', key: 'sede', width: 12 },
      { header: 'Observaciones', key: 'problema', width: 40 },
      { header: 'Agendada por', key: 'agendadaPor', width: 18 },
    ];
    ws.getRow(1).font = { bold: true };
    const fila = (tecnico: string, o: any) => ws.addRow({
      tecnico, seq: o.seq ?? '', code: o.code ?? '', status: o.status, priority: o.priority ?? '',
      type: o.type, cliente: o.cliente ?? '', abonado: o.abonado ?? '', telefono: o.telefono ?? '',
      barrio: o.barrio ?? '', direccion: o.direccion ?? '', sede: o.sede ?? '',
      problema: o.problema ?? '', agendadaPor: o.agendadaPor ?? '',
    });
    for (const c of d.columnas) for (const o of c.ordenes) fila(c.nombre, o);
    for (const o of d.sinAgendar) fila('— Sin agendar —', o);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="agenda-${d.fecha}.xlsx"`);
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
   * "Mi turno": UNA visita, la que le toca ahora, más cuántas lleva y cuántas
   * quedan. Es lo que alimenta la pantalla de entrada del técnico desde que el
   * trabajo va en orden obligatorio (2026-08-04).
   */
  miTurno(user: AuthUser, fecha?: string) {
    return this.agenda.miTurno(user, fecha);
  }

  /**
   * "Llegué y no se pudo": aparta la visita en turno con un motivo y destapa la
   * siguiente. No cierra la orden — vuelve a la bandeja de la cajera para que la
   * reagende. Sin `@RequireArea` extra: es una acción sobre su propio trabajo, y
   * el servicio ya comprueba que la orden sea suya y esté en turno.
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
  assign(id: string, dto: AssignDto) { return this.write.assign(id, dto); }
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
  searchMaterials(search?: string) { return this.write.searchMaterials(search); }
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

  tickets(search?: string, status?: string, type?: string, tec?: string, priority?: string, sede?: string, from?: string, to?: string, all?: string, page?: string, pageSize?: string, sortBy?: string, sortDir?: string, user?: AuthUser) {
    return this.support.tickets({ search, status, type, tec, priority, sede, from, to, all, page: Number(page), pageSize: Number(pageSize), sortBy, sortDir }, user);
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
      { header: 'Estado', key: 'status', width: 13 },
      { header: 'Cliente', key: 'client', width: 30 },
      { header: 'Sede', key: 'sede', width: 14 },
      { header: 'Barrio', key: 'barrio', width: 18 },
      { header: 'Técnico', key: 'assigned', width: 22 },
      { header: 'Descripción', key: 'description', width: 40 },
      { header: 'Cerrada', key: 'finalDate', width: 12 },
    ];
    ws.getRow(1).font = { bold: true };
    for (const r of rows) {
      ws.addRow({
        ...r,
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
