import {
  BadRequestException, Body, Controller, Get, Param, Post, Query, Req, Res, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { IsInt, IsOptional, IsString, Min, MinLength } from 'class-validator';
import { Type } from 'class-transformer';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { existsSync, mkdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import * as ExcelJS from 'exceljs';
import { SupportService } from './support.service';
import { AgendaService } from './agenda.service';
import { catalogoDeOrdenes } from './order-types';
import { GeofenceService } from './geofence.service';
import {
  SupportWriteService, CreateTicketDto, UpdateStatusDto, AssignDto, PriorityDto, SignatureDto, ThreadDto, AttachDto,
  AssignEquipmentDto, ConsumeMaterialsDto,
} from './support-write.service';
import { OnuProvisionService } from './onu-provision.service';
import { PerformanceService } from '../reports/performance.service';
import { serviceOrderPdf } from '../common/pdf/pdf-docs';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AreaGuard } from '../auth/area.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequireArea } from '../auth/require-area.decorator';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { APP_PERMISSIONS } from '../auth/permissions.catalog';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { enviarAdjuntoSeguro, mimeAceptado, nombreEnDisco, MIMES_IMAGEN } from '../common/uploads';

/** ONU que el técnico eligió del autofind para autenticar en esta orden. */
class AutenticarOnuDto {
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
class MoverAgendaDto {
  @IsString() ticketId!: string;
  @IsOptional() @IsString() staffId?: string | null;
  @IsOptional() @IsString() fecha?: string | null;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) posicion?: number;
}

/** Carpeta de evidencias fotográficas de las órdenes de soporte. */
const SUPPORT_ROOT = join(process.cwd(), 'uploads', 'support');
type MulterFile = { originalname: string; filename: string; mimetype: string; size: number };

/** Soporte: órdenes/tickets, llamadas, encuestas (migrado de saves-vestel). */
@Controller('support')
@UseGuards(JwtAuthGuard, AreaGuard)
@RequireArea('tecnicos', 'administracion', 'caja')
export class SupportController {
  constructor(
    private readonly support: SupportService,
    private readonly write: SupportWriteService,
    private readonly geofence: GeofenceService,
    private readonly onuProvision: OnuProvisionService,
    private readonly performance: PerformanceService,
    private readonly agenda: AgendaService,
  ) {}

  // ── Agendamiento (2026-07-31) ─────────────────────────────────────────────
  // Quien agenda es la cajera (y administración): reparte el día entre los técnicos
  // y decide el orden de las visitas. Va con `@RequireArea` propio porque el técnico
  // NO entra aquí — él sigue la agenda, no la arma —, y `AgendaService.mover` lo
  // vuelve a comprobar por si alguien reenvía la petición a mano.
  /** Tablero del día: bandeja de "sin agendar" + una columna por técnico. */
  @Get('agenda') @RequireArea('caja', 'administracion')
  agendaTablero(@CurrentUser() user: AuthUser, @Query('fecha') fecha?: string) {
    return this.agenda.tablero(user, fecha);
  }
  /** Mover una orden: a la columna de un técnico en una posición, o a "sin agendar". */
  @Post('agenda/mover') @RequireArea('caja', 'administracion')
  agendaMover(@Body() dto: MoverAgendaDto, @CurrentUser() user: AuthUser) {
    return this.agenda.mover(user, dto);
  }
  /**
   * Export a Excel del tablero completo del día: las visitas de cada técnico en su
   * orden y, al final, la bandeja de sin agendar. Mismo alcance que el tablero.
   */
  @Get('agenda/export.xlsx') @RequireArea('caja', 'administracion')
  async agendaXlsx(@Res() res: Response, @CurrentUser() user: AuthUser, @Query('fecha') fecha?: string) {
    const d = await this.agenda.tablero(user, fecha);
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
  @Get('mi-agenda') miAgenda(@CurrentUser() user: AuthUser, @Query('fecha') fecha?: string) {
    return this.agenda.miAgenda(user, fecha);
  }

  /**
   * Informe de la geo-cerca: cierres fuera de rango. Restringido a quien manda —
   * es un informe sobre el desempeño de personas concretas.
   */
  /** IPs desde las que se ha escrito, para poder marcar cuáles son de oficina. */
  @Get('known-ips')
  @RequireArea('gerencia', 'administracion', 'sistemas')
  knownIps(@Query('dias') dias?: string) {
    const d = Number(dias);
    return this.geofence.ipsVistas(Number.isFinite(d) && d > 0 && d <= 365 ? d : undefined);
  }

  /** Marca qué IPs son de oficina (lista completa, reemplaza la anterior). */
  @Post('office-ips')
  @RequireArea('gerencia', 'administracion', 'sistemas')
  setOfficeIps(@Body() dto: { ips?: string[] }, @CurrentUser() user: AuthUser) {
    return this.geofence.guardarOficinas(Array.isArray(dto?.ips) ? dto.ips : [], user);
  }

  @Get('geofence-report')
  @RequireArea('gerencia', 'administracion', 'sistemas')
  geofenceReport(@Query('dias') dias?: string) {
    const d = Number(dias);
    return this.geofence.informe(Number.isFinite(d) && d > 0 && d <= 365 ? d : undefined);
  }

  @Get('stats') stats(@CurrentUser() user?: AuthUser) { return this.support.stats(user); }
  @Get('filter-options') filterOptions() { return this.support.filterOptions(); }
  /**
   * Las tres clases de orden del legacy con sus detalles, para el formulario de
   * "nueva orden". Vive en el backend y no en el frontend a propósito: es la misma
   * lista con la que se validan y se enderezan las órdenes que entran por el
   * chatbot (ver `order-types.ts`), y una copia en la web se desincronizaría.
   */
  @Get('order-catalog') orderCatalog() { return catalogoDeOrdenes(); }

  // --- Escritura ---
  @Get('technicians') technicians() { return this.write.technicians(); }
  @Post('tickets') createTicket(@Body() dto: CreateTicketDto, @CurrentUser() user: AuthUser) { return this.write.createTicket(dto, user); }
  /** La IP se pasa al servicio para poder cotejarla con la ubicación declarada
   *  (un técnico en el wifi de la oficina no puede estar a 3 km). */
  @Post('tickets/:id/status')
  updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateStatusDto,
    @CurrentUser() user: AuthUser,
    @Req() req: { ip?: string; socket?: { remoteAddress?: string } },
  ) {
    return this.write.updateStatus(id, dto, user, req?.ip ?? req?.socket?.remoteAddress ?? null);
  }
  @Post('tickets/:id/assign') assign(@Param('id') id: string, @Body() dto: AssignDto) { return this.write.assign(id, dto); }
  @Post('tickets/:id/priority') setPriority(@Param('id') id: string, @Body() dto: PriorityDto) { return this.write.setPriority(id, dto); }
  @Post('tickets/:id/signature') sign(@Param('id') id: string, @Body() dto: SignatureDto) { return this.write.saveSignature(id, dto); }
  /** Sirve el PNG de la firma dibujada de una orden. */
  @Get('tickets/:id/signature.png')
  async signaturePng(@Param('id') id: string, @Res() res: Response) {
    const file = join(process.cwd(), 'uploads', 'signatures', `${id}.png`);
    if (!existsSync(file)) return res.status(404).send('sin firma');
    return enviarAdjuntoSeguro(res, file, `firma-${id}.png`);
  }
  @Post('tickets/:id/thread') thread(@Param('id') id: string, @Body() dto: ThreadDto, @CurrentUser() user: AuthUser) { return this.write.addThread(id, dto, user); }

  // --- Equipo y material de la orden ---
  @Get('equipment/available') availableEquipment(@Query('search') search?: string) { return this.write.availableEquipment(search); }
  @Get('materials/search') searchMaterials(@Query('search') search?: string) { return this.write.searchMaterials(search); }
  @Post('tickets/:id/equipment') assignEquipment(@Param('id') id: string, @Body() dto: AssignEquipmentDto, @CurrentUser() user: AuthUser) { return this.write.assignEquipment(id, dto, user); }
  @Post('tickets/:id/materials') consumeMaterials(@Param('id') id: string, @Body() dto: ConsumeMaterialsDto, @CurrentUser() user: AuthUser) { return this.write.consumeMaterials(id, dto, user); }

  // --- ONU de la orden (autenticar contra la OLT desde la instalación) ---
  /**
   * Estado del bloque de ONU: OLT de la sede, plan del abonado, velocidad que se
   * aplicará y ONUs esperando autenticación. Lectura en vivo contra la OLT.
   */
  @Get('tickets/:id/onu') onuEstado(@Param('id') id: string, @CurrentUser() user?: AuthUser) {
    return this.onuProvision.estado(id, user);
  }
  /**
   * Autenticar la ONU elegida. Escribe en la OLT, así que exige el mismo permiso
   * que hacerlo desde Red › OLT: que la puerta sea otra no la hace más ancha.
   */
  @UseGuards(PermissionsGuard)
  @RequirePermissions(APP_PERMISSIONS.NETWORK_OLT_MANAGE)
  @Post('tickets/:id/onu/autenticar')
  autenticarOnu(@Param('id') id: string, @Body() dto: AutenticarOnuDto, @CurrentUser() user: AuthUser) {
    return this.onuProvision.autenticar(id, dto, user);
  }
  /** Aplicar al service-port la velocidad del plan vigente (órdenes de subir/bajar megas). */
  @UseGuards(PermissionsGuard)
  @RequirePermissions(APP_PERMISSIONS.NETWORK_OLT_MANAGE)
  @Post('tickets/:id/onu/velocidad')
  aplicarVelocidadOnu(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.onuProvision.aplicarVelocidad(id, user);
  }

  /** PDF de la orden de servicio (acta técnica). */
  @Get('tickets/:id/pdf')
  async ticketPdf(@Param('id') id: string, @Res() res: Response, @CurrentUser() user?: AuthUser) {
    const data = await this.support.serviceOrderPdfData(id, user);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="Orden_${data.code}.pdf"`);
    serviceOrderPdf(res, data);
  }

  /** Adjuntar una foto de evidencia al hilo (con geo-etiquetado opcional). Solo imágenes. */
  @Post('tickets/:id/attach')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: (_req, _file, cb) => { if (!existsSync(SUPPORT_ROOT)) mkdirSync(SUPPORT_ROOT, { recursive: true }); cb(null, SUPPORT_ROOT); },
        filename: (_req, file, cb) => cb(null, nombreEnDisco(randomUUID(), file.mimetype)),
      }),
      limits: { fileSize: 15 * 1024 * 1024 },
      // Lista blanca de MIME concretos, no `startsWith('image/')`: aquél aceptaba
      // cualquier `image/loquesea` y la extensión salía del nombre del cliente.
      fileFilter: (_req, file, cb) => cb(null, mimeAceptado(file.mimetype, MIMES_IMAGEN)),
    }),
  )
  attach(
    @Param('id') id: string,
    @UploadedFile() file: MulterFile,
    @Body() dto: AttachDto,
    @CurrentUser() user: AuthUser,
  ) {
    if (!file) throw new BadRequestException('Sube una imagen en el campo "file".');
    return this.write.addAttachment(id, file, dto, user);
  }

  /** Sirve la imagen adjunta de una entrada del hilo (inline, para preview autenticado vía blob). */
  @Get('threads/:threadId/attachment')
  async attachment(@Param('threadId') threadId: string, @Res() res: Response) {
    const a = await this.support.getThreadAttachment(threadId);
    return enviarAdjuntoSeguro(res, join(SUPPORT_ROOT, a.storedName), a.storedName);
  }

  @Get('tickets')
  tickets(@Query('search') search?: string, @Query('status') status?: string, @Query('type') type?: string, @Query('tec') tec?: string, @Query('priority') priority?: string, @Query('sede') sede?: string, @Query('from') from?: string, @Query('to') to?: string, @Query('all') all?: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string, @Query('sortBy') sortBy?: string, @Query('sortDir') sortDir?: string, @CurrentUser() user?: AuthUser) {
    return this.support.tickets({ search, status, type, tec, priority, sede, from, to, all, page: Number(page), pageSize: Number(pageSize), sortBy, sortDir }, user);
  }

  /**
   * Export a Excel del listado, con los MISMOS filtros. Declarado antes de
   * `tickets/:id` para que 'export.xlsx' no caiga en el parámetro.
   */
  @Get('tickets/export.xlsx')
  async ticketsXlsx(
    @Res() res: Response,
    @Query('search') search?: string, @Query('status') status?: string, @Query('type') type?: string,
    @Query('tec') tec?: string, @Query('priority') priority?: string, @Query('sede') sede?: string,
    @Query('from') from?: string, @Query('to') to?: string, @Query('all') all?: string,
    @CurrentUser() user?: AuthUser,
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
  @Get('mi-jornada') miJornada(@CurrentUser() user: AuthUser) { return this.support.miJornada(user); }

  /**
   * "Mi rendimiento": las MISMAS métricas del tablero de gerencia
   * (`/reports/tecnicos/:staffId`), pero acotadas a quien pregunta.
   *
   * Se reutiliza `PerformanceService` en vez de recalcular: si la re-visita se mide
   * distinto aquí que en el informe del jefe, la conversación entre ambos es imposible.
   * Lo único que viaja del equipo son las MEDIANAS (`equipo`), sin nombres: el técnico
   * necesita saber si su 12% es bueno o malo, y para eso hace falta la referencia.
   */
  @Get('mi-rendimiento')
  async miRendimiento(@CurrentUser() user: AuthUser, @Query('from') from?: string, @Query('to') to?: string) {
    const staff = await this.support.staffDelUsuario(user);
    if (!staff) return { resolved: false, resumen: null, equipo: null, porTipo: [], casos: [] };
    const d = await this.performance.tecnico(staff.id, from, to);
    // Los casos concretos de re-visita son de él: sí los ve, son lo único accionable.
    return { resolved: true, tech: { id: staff.id, name: staff.name }, ...d };
  }

  @Get('tickets/:id') ticketDetail(@Param('id') id: string, @CurrentUser() user?: AuthUser) { return this.support.ticketDetail(id, user); }

}
