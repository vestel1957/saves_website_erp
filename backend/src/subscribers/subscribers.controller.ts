import { BadRequestException, NotFoundException } from '../core/http/errores';
import * as ExcelJS from 'exceljs';
import { diskStorage } from 'multer';
import type { Response } from 'express';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SubscribersService } from './subscribers.service';
import { SubscriberGeoService } from './subscriber-geo.service';
import { SubscriberFilesService } from './subscriber-files.service';
import { KIND_CARTA_RETIRO, KIND_VIVIENDA, normalizarTipoArchivo } from './subscriber-file-kinds';
import { SubscriberNotesService } from './subscriber-notes.service';
import { AltaClienteService } from './alta.service';
import { APP_PERMISSIONS } from '../auth/permissions.catalog';
import { type AuthUser } from '../auth/current-user.decorator';
import { esTecnicoDeCampo } from '../common/tecnico-scope';
import { ForbiddenException } from '../core/http/errores';
import { UpdateSubscriberDto, AddNoteDto, UpdateInvoiceDto, CreateSubscriberDto, CheckDuplicatesDto, ChangeStatusDto, ChangeServiceStatusDto, ReturnEquipmentDto } from './dto/update-subscriber.dto';
import { AssignPlanDto, AssignPlansDto, SetPuntosDto } from '../plans/dto/plan.dto';
import { ApplyBundleDto } from '../plans/dto/bundle.dto';
import { BulkFilterDto, BulkMessageDto } from './dto/bulk.dto';
import { pazYSalvoPdf, statementPdf } from './subscriber-pdf';
import { ContractsService } from '../contracts/contracts.service';
import { renderContratoLegacy } from '../contracts/contrato-legacy.render';
import { FirmaDto } from '../contracts/dto/clausula.dto';

/** Forma mínima del archivo que entrega multer (evita depender de @types/multer). */
// Lo usa el `fileFilter` de la subida, que vive en el router generado.
import { extensionDeAdjunto } from '../common/uploads';

type MulterFile = { originalname: string; filename: string; mimetype: string; size: number; path: string };

export const UPLOAD_ROOT = join(process.cwd(), 'uploads', 'subscribers');
export const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB
export const ALLOWED_EXT = new Set([
  '.pdf', '.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif',
  '.doc', '.docx', '.xls', '.xlsx', '.csv', '.txt', '.zip',
]);
/** La huella se dibuja dentro del PDF del contrato: sólo formatos que el PDF sabe pintar. */
export const EXT_HUELLA = new Set(['.jpg', '.jpeg', '.png', '.webp']);
/**
 * La foto de la vivienda se pinta como imagen en la ficha, así que sólo entran
 * formatos que el navegador sabe enseñar. `.heic`/`.heif` quedan FUERA aunque los
 * acepte la pestaña Archivos: es lo que dispara un iPhone por defecto y Chrome no
 * lo dibuja — se vería el hueco roto justo donde va la foto.
 */
export const EXT_FOTO_VIVIENDA = new Set(['.jpg', '.jpeg', '.png', '.webp']);
/** La marca de la foto de la casa vive en el catálogo de tipos; se reexporta por comodidad. */
export { KIND_VIVIENDA };
/**
 * La carta de retiro o suspensión llega escaneada o fotografiada desde la
 * ventanilla, así que entran PDF e imágenes. No se admite Office ni ZIP: es un
 * documento que hay que poder ABRIR y leer desde la ficha para dar el paz y salvo.
 */
export const EXT_CARTA_RETIRO = new Set(['.pdf', '.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif']);

/** Clientes / abonados ISP (vertical migrado de saves-vestel). */
export class SubscribersController {
  constructor(
    private readonly subscribers: SubscribersService,
    private readonly geo: SubscriberGeoService,
    private readonly files: SubscriberFilesService,
    private readonly notes: SubscriberNotesService,
    private readonly contracts: ContractsService,
    private readonly alta: AltaClienteService,
  ) {}

  /**
   * El técnico de campo MIRA la ficha del cliente; no vuelve sobre ella.
   *
   * Se abre porque desde 2026-08-31 el técnico entra al perfil del cliente (llega a
   * él desde su orden: necesita el teléfono, la dirección, el plan y el histórico de
   * lo que se le ha hecho). Abrir la pantalla dejaba a un clic lo que el área
   * `tecnicos` ya podía hacer por API desde siempre y nadie quería que hiciera:
   * corregir la ficha, cambiarle el estado, cambiarle el plan o lanzar un corte
   * masivo. Probado antes de cerrarlo: un `PATCH /subscribers/:id` con la cuenta de
   * un técnico puro devolvía 200 y le cambiaba el teléfono al cliente.
   *
   * Lo de CAMPO no entra aquí y sigue siendo suyo: la foto de la vivienda, la firma
   * y la huella del contrato, las notas de la visita, los archivos y el GPS. Ahí el
   * técnico es quien produce el dato, no quien lo revisa.
   *
   * `esTecnicoDeCampo` sólo marca al técnico PURO: quien además es de administración,
   * contabilidad, gerencia o jefe de bodega pasa como siempre.
   */
  private soloMira(user: AuthUser | undefined, que: string) {
    if (esTecnicoDeCampo(user)) {
      throw new ForbiddenException(`No puedes ${que}: desde tu perfil la ficha del cliente es de consulta.`);
    }
  }

  stats() {
    return this.subscribers.stats();
  }

  branches(user: AuthUser) {
    return this.subscribers.branches(user);
  }

  /**
   * Catálogo de afiliaciones para el asistente de alta.
   *
   * Vive aquí y no en `/billing/catalog` porque el alta la hacen también administración
   * y técnicos, que no tienen el área de facturación: colgarlo del catálogo facturable
   * dejaba el selector en 403 justo para media plantilla.
   */
  afiliaciones() {
    return this.alta.afiliaciones();
  }

  branchesStats(user: AuthUser) {
    return this.subscribers.branchesStats(user);
  }

  // ── Operaciones masivas por FILTRO (corta/reconecta TODOS los que cumplen) ──
  bulkCut(dto: BulkFilterDto, user: AuthUser) {
    this.soloMira(user, 'cortar servicio en masa');
    return this.subscribers.cutByFilter(dto, user);
  }


  bulkReconnect(dto: BulkFilterDto, user: AuthUser) {
    this.soloMira(user, 'reconectar en masa');
    return this.subscribers.reconnectByFilter(dto, user);
  }

  bulkTvCut(dto: BulkFilterDto, user: AuthUser) {
    this.soloMira(user, 'cortar la TV en masa');
    return this.subscribers.tvCutByFilter(dto, user);
  }

  bulkTvRestore(dto: BulkFilterDto, user: AuthUser) {
    this.soloMira(user, 'restaurar la TV en masa');
    return this.subscribers.tvRestoreByFilter(dto, user);
  }

  bulkMessage(dto: BulkMessageDto, user: AuthUser) {
    this.soloMira(user, 'mandar mensajes masivos');
    return this.subscribers.messageByFilter(dto, dto.message, user);
  }

  // ── Catálogos de dirección (cascada) ─────────────────────────
  geoDepartments() {
    return this.geo.geoDepartments();
  }

  geoCities(department?: string) {
    return this.geo.geoCities(department ? Number(department) : undefined);
  }

  geoLocalities(city?: string) {
    return this.geo.geoLocalities(city ? Number(city) : undefined);
  }

  geoNeighborhoods(locality?: string) {
    return this.geo.geoNeighborhoods(locality ? Number(locality) : undefined);
  }

  /**
   * Chequeo de duplicados previo al alta (documento/dirección avisan, usuario PPP bloquea).
   * La pantalla lo llama para advertir antes de guardar; `create` revalida igualmente.
   */
  checkDuplicates(dto: CheckDuplicatesDto) {
    return this.subscribers.checkDuplicates(dto);
  }

  /**
   * Alta de cliente. Va por `AltaClienteService` y no por `SubscribersService`
   * a secas porque dar de alta no es escribir la fila: es plan + secret en el
   * Mikrotik + primera factura + orden de instalación. Cada paso viene en la
   * respuesta con su hecho/motivo para que la pantalla diga qué quedó pendiente.
   */
  create(dto: CreateSubscriberDto, user: AuthUser) {
    this.soloMira(user, 'dar de alta clientes');
    return this.alta.alta(dto, user);
  }

  list(
    search?: string,
    status?: string,
    branchId?: string,
    page?: string,
    pageSize?: string,
    withPlan?: string,
    servicio?: string,
    planId?: string,
    tecnologia?: string,
    cuenta?: string,
    deuda?: string,
    sortBy?: string,
    sortDir?: string,
    user?: AuthUser,
  ) {
    return this.subscribers.list({ search, status, branchId, page: Number(page), pageSize: Number(pageSize), withPlan, servicio, planId, tecnologia, cuenta, deuda, sortBy, sortDir }, user);
  }

  /**
   * Export a Excel del listado, con los MISMOS filtros que están puestos en
   * pantalla (no solo la página que se está viendo). Declarado antes de
   * `subscribers/:id` para que 'export.xlsx' no caiga en el parámetro.
   */
  async listXlsx(
    res: Response,
    search?: string,
    status?: string,
    branchId?: string,
    servicio?: string,
    planId?: string,
    tecnologia?: string,
    cuenta?: string,
    deuda?: string,
    sortBy?: string,
    sortDir?: string,
    user?: AuthUser,
  ) {
    const rows = await this.subscribers.exportRows(
      { search, status, branchId, servicio, planId, tecnologia, cuenta, deuda, sortBy, sortDir },
      user,
    );
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Vestel';
    const ws = wb.addWorksheet('Clientes');
    ws.columns = [
      { header: 'Abonado', key: 'abonado', width: 12 },
      { header: 'ID', key: 'legacyId', width: 10 },
      { header: 'Nombre', key: 'name', width: 34 },
      { header: 'Documento', key: 'docNumber', width: 16 },
      { header: 'Celular', key: 'phone', width: 15 },
      { header: 'Correo', key: 'email', width: 28 },
      { header: 'Estado', key: 'status', width: 14 },
      { header: 'Sede', key: 'branch', width: 16 },
      { header: 'Barrio', key: 'neighborhood', width: 20 },
      { header: 'Debe', key: 'debt', width: 14 },
      { header: 'Saldo a favor', key: 'balance', width: 14 },
    ];
    ws.getRow(1).font = { bold: true };
    for (const r of rows) {
      ws.addRow({
        abonado: r.abonado ?? '',
        legacyId: r.legacyId ?? '',
        name: r.name ?? '',
        docNumber: r.docNumber ?? '',
        phone: r.phone ?? '',
        email: r.email ?? '',
        status: r.status ?? '',
        branch: r.branch ?? '',
        neighborhood: r.neighborhood ?? '',
        debt: r.debt ?? 0,
        balance: r.balance ?? 0,
      });
    }
    ws.getColumn('debt').numFmt = '#,##0';
    ws.getColumn('balance').numFmt = '#,##0';
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="clientes-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.send(buffer);
  }

  detail(id: string, user: AuthUser) {
    return this.subscribers.detail(id, user);
  }

  editForm(id: string, user: AuthUser) {
    return this.subscribers.editForm(id, user);
  }

  update(id: string, dto: UpdateSubscriberDto, user: AuthUser) {
    this.soloMira(user, 'editar los datos del cliente');
    return this.subscribers.update(id, dto, user);
  }

  /** Cambio manual de estado (administrativo; no corta ni reconecta en el router). */
  changeStatus(id: string, dto: ChangeStatusDto, user: AuthUser) {
    this.soloMira(user, 'cambiarle el estado al cliente');
    return this.subscribers.changeStatus(id, dto, user);
  }

  /**
   * Cambio manual del estado de UN servicio (internet o televisión).
   * Administrativo, como el del cliente: no toca los equipos.
   */
  cambiarEstadoDeServicio(id: string, dto: ChangeServiceStatusDto, user: AuthUser) {
    this.soloMira(user, 'cambiarle el estado a un servicio del cliente');
    return this.subscribers.cambiarEstadoDeServicio(id, dto, user);
  }

  /** Los planes que tiene contratados hoy, con sus megas (lectura ligera de la ficha). */
  currentPlans(id: string, user: AuthUser) {
    return this.subscribers.currentPlans(id, user);
  }

  /** Cambiar el plan del abonado (catálogo → precio de la próxima factura + perfil al router). */
  changePlan(id: string, dto: AssignPlanDto, user: AuthUser) {
    this.soloMira(user, 'cambiarle el plan al cliente');
    return this.subscribers.changePlan(id, dto.planId, user);
  }

  /** Cambiar varios planes a la vez (ej. Internet + TV) en una sola operación. */
  changePlans(id: string, dto: AssignPlansDto, user: AuthUser) {
    this.soloMira(user, 'cambiarle los planes al cliente');
    return this.subscribers.changePlans(id, dto.planIds, user);
  }

  /** Fijar cuántos puntos de TV adicionales tiene (0 = quitárselos). */
  setPuntos(id: string, dto: SetPuntosDto, user: AuthUser) {
    this.soloMira(user, 'cambiarle los puntos de TV');
    return this.subscribers.setPuntos(id, dto.qty, user);
  }

  /** Venderle un combo: sus planes de golpe, al precio del paquete. */
  applyBundle(id: string, dto: ApplyBundleDto, user: AuthUser) {
    this.soloMira(user, 'venderle un combo');
    return this.subscribers.applyBundle(id, dto.bundleId, user);
  }

  // ── Archivos ────────────────────────────────────────────────────

  listFiles(id: string, user: AuthUser) {
    return this.files.listFiles(id, user);
  }

  /**
   * Sube un adjunto a la ficha. `kind` es PARA QUÉ es el documento (carta de retiro,
   * suspensión, solicitud…): llega como campo de texto del mismo formulario y se
   * valida contra el catálogo — ver `normalizarTipoArchivo`. Sin él, adjunto sin
   * clasificar, como los 14.420 que bajaron del sistema anterior.
   */
  async upload(id: string, file: MulterFile, kind: string | undefined, user: AuthUser) {
    if (!file) throw new BadRequestException('No se recibió ningún archivo');
    // El archivo ya se escribió en disco; si el tipo no vale o el cliente no existe,
    // lo limpiamos (incluida la validación del tipo, que por eso va DENTRO del try).
    try {
      return await this.files.addFile(id, file, user?.name ?? user?.email, user, normalizarTipoArchivo(kind) ?? undefined);
    } catch (e) {
      try { unlinkSync(file.path); } catch { /* noop */ }
      throw e;
    }
  }

  /**
   * Sube la foto de la vivienda. Es un adjunto más (mismo disco, misma pestaña
   * Archivos) marcado con `kind=VIVIENDA`; la PORTADA es siempre la última subida,
   * así que "cambiar foto" es subir otra y las anteriores quedan de historial.
   */
  async uploadHousePhoto(id: string, file: MulterFile, user: AuthUser) {
    if (!file) throw new BadRequestException('No se recibió ninguna foto');
    try {
      return await this.files.addFile(id, file, user?.name ?? user?.email, user, KIND_VIVIENDA);
    } catch (e) {
      try { unlinkSync(file.path); } catch { /* noop */ }
      throw e;
    }
  }

  /**
   * Sube la CARTA DE RETIRO O SUSPENSIÓN: el papel con el que el cliente pide la
   * baja. Es un adjunto más (misma carpeta, misma pestaña Archivos) marcado con
   * `kind=CARTA_RETIRO`, y sin él no se expide el paz y salvo — ver los cuatro
   * requisitos en `SubscribersService.statement`.
   *
   * Vale la ÚLTIMA que se haya subido: si la primera venía movida o ilegible, se
   * sube otra y las anteriores quedan de historial, igual que la foto de la casa.
   */
  async uploadCartaRetiro(id: string, file: MulterFile, user: AuthUser) {
    if (!file) throw new BadRequestException('No se recibió ninguna carta');
    try {
      return await this.files.addFile(id, file, user?.name ?? user?.email, user, KIND_CARTA_RETIRO);
    } catch (e) {
      try { unlinkSync(file.path); } catch { /* noop */ }
      throw e;
    }
  }

  async download(id: string, fileId: string, res: Response, user?: AuthUser) {
    const f = await this.files.fileMeta(id, fileId, user);
    const abs = join(UPLOAD_ROOT, id, f.storedName);
    if (!existsSync(abs)) throw new NotFoundException('El archivo no está en el servidor');
    res.setHeader('Content-Type', f.mimeType || 'application/octet-stream');
    // `res.download` ya manda `attachment`; nosniff impide además que el navegador
    // ignore ese Content-Type y adivine el tipo mirando el contenido.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.download(abs, f.originalName);
  }

  async deleteFile(id: string, fileId: string, user?: AuthUser) {
    const storedName = await this.files.deleteFile(id, fileId, user);
    try { unlinkSync(join(UPLOAD_ROOT, id, storedName)); } catch { /* archivo ya no existe */ }
    return { ok: true };
  }

  // ── Notas ────────────────────────────────────────────────────

  addNote(id: string, dto: AddNoteDto, user: AuthUser) {
    return this.notes.addNote(id, dto.body, user?.name ?? user?.email, user);
  }

  deleteNote(id: string, noteId: string, user: AuthUser) {
    return this.notes.deleteNote(id, noteId, user);
  }

  // ── Equipos ──────────────────────────────────────────────────
  // Devolver el equipo instalado y mandarlo a bodega. Es administrativo (caja y
  // administración): el técnico de campo entrega el equipo, no lo da de baja del
  // cliente. Ver `SubscribersService.returnEquipment`.

  returnEquipment(id: string, equipmentId: string, dto: ReturnEquipmentDto, user: AuthUser) {
    return this.subscribers.returnEquipment(id, equipmentId, dto, user);
  }

  // ── Facturas ─────────────────────────────────────────────────

  invoices(id: string, user: AuthUser) {
    return this.subscribers.invoices(id, user);
  }

  // ── Facturas: editar / eliminar ──────────────────────────────
  // Son documentos de cobro, no datos del cliente: quien los toca es contabilidad
  // (2026-08-03). El @RequireArea de la clase abre esta ficha a caja y a técnicos
  // —que es correcto para el cliente en sí—, y por ahí se colaban dos acciones de
  // dinero: correrle las fechas a una factura y BORRARLA (o sea, borrar una deuda).
  // Es la misma frontera que ya tiene todo lo demás en `billing.controller.ts`.

  updateInvoice(id: string, invoiceId: string, dto: UpdateInvoiceDto, user: AuthUser) {
    return this.subscribers.updateInvoice(id, invoiceId, dto, user);
  }

  deleteInvoice(id: string, invoiceId: string, user: AuthUser) {
    return this.subscribers.deleteInvoice(id, invoiceId, user);
  }

  // ── Estado de cuenta ─────────────────────────────────────────

  statement(id: string, user: AuthUser) {
    return this.subscribers.statement(id, user);
  }

  /**
   * Certificado de paz y salvo. Sólo sale con los CUATRO requisitos cumplidos —sin
   * saldo, sin equipo por devolver, con la carta de retiro o suspensión entregada y
   * con esa orden ya cerrada (ver `SubscribersService.statement`)—. Antes salía
   * siempre y, cuando no estaba al día, el mismo PDF se redactaba en negativo: un
   * documento con membrete que decía que el cliente debe. Eso no es lo que nadie pide
   * cuando pide un paz y salvo, y el que sí estaba al día pero con la ONT en casa se
   * llevaba un certificado "por todo concepto" que dejaba el equipo sin cómo
   * reclamarse. Ahora la ruta se cierra y dice qué falta.
   */
  async pazYSalvo(id: string, res: Response, user?: AuthUser) {
    const data = await this.subscribers.statement(id, user);
    if (!data.puedeEmitirPazYSalvo) {
      throw new BadRequestException(
        `No se puede expedir el paz y salvo: el cliente ${data.motivosPazYSalvoTexto}.`,
      );
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="paz-y-salvo-${data.subscriber.abonado}.pdf"`);
    pazYSalvoPdf(res, data);
  }

  // ── Contrato ────────────────────────────────────────────────────

  /** Estado del contrato: permanencia vigente, firma y huella (para la ficha). */
  contratoEstado(id: string, user?: AuthUser) {
    return this.contracts.estado(id, user);
  }

  /**
   * CONTRATO ÚNICO DE SERVICIOS FIJOS, pintado con la vista y el motor del legacy
   * (ver `contracts/contrato-legacy.render.ts`). La ruta conserva el nombre
   * `contract.pdf` con el que ya la abre la ficha del cliente.
   */
  async contractPdfEndpoint(id: string, res: Response, user?: AuthUser) {
    const data = await this.contracts.datosContratoLegacy(id, user);
    const pdf = await renderContratoLegacy('contrato', data);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="contrato-${data.abonado}.pdf"`);
    res.end(pdf);
  }

  /** ANEXO AL CONTRATO ÚNICO DE SERVICIOS FIJOS (el formato regulatorio CRC). */
  async anexoPdfEndpoint(id: string, res: Response, user?: AuthUser) {
    const data = await this.contracts.datosContratoLegacy(id, user);
    const pdf = await renderContratoLegacy('anexo', data);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="anexo-contrato-${data.abonado}.pdf"`);
    res.end(pdf);
  }

  /** Firma capturada en el navegador (canvas → PNG base64). */
  firma(id: string, dto: FirmaDto, user?: AuthUser) {
    return this.contracts.guardarFirma(id, dto.dataUrl, user);
  }

  borrarFirma(id: string, user?: AuthUser) {
    return this.contracts.borrarFirma(id, user);
  }

  /** Huella: foto o escaneo del documento firmado. */
  async huella(id: string, file: MulterFile, user?: AuthUser) {
    if (!file) throw new BadRequestException('No se recibió ninguna imagen');
    try {
      return await this.contracts.guardarHuella(id, file.filename, user);
    } catch (e) {
      try { unlinkSync(file.path); } catch { /* noop */ }
      throw e;
    }
  }

  borrarHuella(id: string, user?: AuthUser) {
    return this.contracts.borrarHuella(id, user);
  }

  /** Imagen de la firma / huella para mostrarla en la ficha. */
  async verFirma(id: string, res: Response, user?: AuthUser) {
    const abs = await this.contracts.rutaImagen(id, 'firma', user);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(abs);
  }

  async verHuella(id: string, res: Response, user?: AuthUser) {
    const abs = await this.contracts.rutaImagen(id, 'huella', user);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(abs);
  }

  async statementPdfEndpoint(id: string, res: Response, user?: AuthUser) {
    const data = await this.subscribers.statement(id, user);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="estado-cuenta-${data.subscriber.abonado}.pdf"`);
    statementPdf(res, data);
  }
}
