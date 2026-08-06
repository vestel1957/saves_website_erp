import { BadRequestException, NotFoundException } from '../core/http/errores';
import { diskStorage } from 'multer';
import type { Response } from 'express';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SubscribersService } from './subscribers.service';
import { SubscriberGeoService } from './subscriber-geo.service';
import { SubscriberFilesService } from './subscriber-files.service';
import { SubscriberNotesService } from './subscriber-notes.service';
import { APP_PERMISSIONS } from '../auth/permissions.catalog';
import { type AuthUser } from '../auth/current-user.decorator';
import { UpdateSubscriberDto, AddNoteDto, UpdateInvoiceDto, CreateSubscriberDto, CheckDuplicatesDto, ChangeStatusDto } from './dto/update-subscriber.dto';
import { AssignPlanDto, AssignPlansDto } from '../plans/dto/plan.dto';
import { BulkFilterDto, BulkMessageDto } from './dto/bulk.dto';
import { pazYSalvoPdf, statementPdf } from './subscriber-pdf';
import { ContractsService } from '../contracts/contracts.service';
import { renderContratoLegacy } from '../contracts/contrato-legacy.render';
import { FirmaDto } from '../contracts/dto/clausula.dto';

/** Forma mínima del archivo que entrega multer (evita depender de @types/multer). */
type MulterFile = { originalname: string; filename: string; mimetype: string; size: number; path: string };

export const UPLOAD_ROOT = join(process.cwd(), 'uploads', 'subscribers');
export const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB
export const ALLOWED_EXT = new Set([
  '.pdf', '.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic',
  '.doc', '.docx', '.xls', '.xlsx', '.csv', '.txt', '.zip',
]);

/** Clientes / abonados ISP (vertical migrado de saves-vestel). */
export class SubscribersController {
  constructor(
    private readonly subscribers: SubscribersService,
    private readonly geo: SubscriberGeoService,
    private readonly files: SubscriberFilesService,
    private readonly notes: SubscriberNotesService,
    private readonly contracts: ContractsService,
  ) {}

  stats() {
    return this.subscribers.stats();
  }

  branches(user: AuthUser) {
    return this.subscribers.branches(user);
  }

  branchesStats(user: AuthUser) {
    return this.subscribers.branchesStats(user);
  }

  // ── Operaciones masivas por FILTRO (corta/reconecta TODOS los que cumplen) ──
  bulkCut(dto: BulkFilterDto, user: AuthUser) {
    return this.subscribers.cutByFilter(dto, user);
  }


  bulkReconnect(dto: BulkFilterDto, user: AuthUser) {
    return this.subscribers.reconnectByFilter(dto, user);
  }

  bulkTvCut(dto: BulkFilterDto, user: AuthUser) {
    return this.subscribers.tvCutByFilter(dto, user);
  }

  bulkTvRestore(dto: BulkFilterDto, user: AuthUser) {
    return this.subscribers.tvRestoreByFilter(dto, user);
  }

  bulkMessage(dto: BulkMessageDto, user: AuthUser) {
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

  create(dto: CreateSubscriberDto, user: AuthUser) {
    return this.subscribers.create(dto, user);
  }

  list(
    search?: string,
    status?: string,
    branchId?: string,
    page?: string,
    pageSize?: string,
    withPlan?: string,
    servicio?: string,
    tecnologia?: string,
    cuenta?: string,
    deuda?: string,
    sortBy?: string,
    sortDir?: string,
    user?: AuthUser,
  ) {
    return this.subscribers.list({ search, status, branchId, page: Number(page), pageSize: Number(pageSize), withPlan, servicio, tecnologia, cuenta, deuda, sortBy, sortDir }, user);
  }

  detail(id: string, user: AuthUser) {
    return this.subscribers.detail(id, user);
  }

  editForm(id: string, user: AuthUser) {
    return this.subscribers.editForm(id, user);
  }

  update(id: string, dto: UpdateSubscriberDto, user: AuthUser) {
    return this.subscribers.update(id, dto, user);
  }

  /** Cambio manual de estado (administrativo; no corta ni reconecta en el router). */
  changeStatus(id: string, dto: ChangeStatusDto, user: AuthUser) {
    return this.subscribers.changeStatus(id, dto, user);
  }

  /** Cambiar el plan del abonado (catálogo → precio de la próxima factura + perfil al router). */
  changePlan(id: string, dto: AssignPlanDto, user: AuthUser) {
    return this.subscribers.changePlan(id, dto.planId, user);
  }

  /** Cambiar varios planes a la vez (ej. Internet + TV) en una sola operación. */
  changePlans(id: string, dto: AssignPlansDto, user: AuthUser) {
    return this.subscribers.changePlans(id, dto.planIds, user);
  }

  // ── Archivos ────────────────────────────────────────────────────

  listFiles(id: string, user: AuthUser) {
    return this.files.listFiles(id, user);
  }

  async upload(id: string, file: MulterFile, user: AuthUser) {
    if (!file) throw new BadRequestException('No se recibió ningún archivo');
    // El archivo ya se escribió en disco; si el cliente no existe, lo limpiamos.
    try {
      return await this.files.addFile(id, file, user?.name ?? user?.email, user);
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

  async pazYSalvo(id: string, res: Response, user?: AuthUser) {
    const data = await this.subscribers.statement(id, user);
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
