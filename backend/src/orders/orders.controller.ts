import { BadRequestException } from '../core/http/errores';
import { diskStorage } from 'multer';
import type { Response } from 'express';
import { createReadStream, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as ExcelJS from 'exceljs';
import { OrdersService } from './orders.service';
import { AddNoteDto, ApproveOrderDto, CancelOrderDto, CategoryNameDto, CreateOrderDto, CreateSupplierDto, PayOrderDto, ReceiveOrderDto, UpdateOrderDto } from './dto/orders.dto';
import { APP_PERMISSIONS } from '../auth/permissions.catalog';
import { AuthUser } from '../auth/current-user.decorator';
import { purchaseOrderPdf } from '../common/pdf/pdf-docs';

/** Forma mínima del archivo que entrega multer (evita depender de @types/multer). */
type MulterFile = { originalname: string; filename: string; mimetype: string; size: number; path: string };

export const UPLOAD_ROOT = join(process.cwd(), 'uploads', 'orders');
export const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB
export const ALLOWED_EXT = new Set(['.pdf', '.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.doc', '.docx', '.xls', '.xlsx', '.csv', '.txt', '.zip']);

/** Órdenes de compra / servicio + proveedores (migrado de saves-vestel). */
// Compras salió del perfil de caja (2026-07-29): quien recauda no ordena compras.
// Se quita también aquí y no sólo del menú — si no, la API seguía abierta a `caja`.
// Ninguna pantalla suya llama a `/orders`: el único consumidor fuera de /ordenes es
// OrdersFilterButton, que vive dentro de las propias pantallas de compras.
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  stats() { return this.orders.stats(); }

  suppliers(category?: string, search?: string, page?: string, pageSize?: string, sortBy?: string, sortDir?: string) {
    return this.orders.suppliers({ category, search, page: Number(page), pageSize: Number(pageSize), sortBy, sortDir });
  }
  createSupplier(dto: CreateSupplierDto) { return this.orders.createSupplier(dto); }
  supplierStatement(id: string) { return this.orders.supplierStatement(id); }
  updateSupplier(id: string, dto: CreateSupplierDto) { return this.orders.updateSupplier(id, dto); }
  deleteSupplier(id: string) { return this.orders.deleteSupplier(id); }

  branches() { return this.orders.branches(); }

  categories() { return this.orders.categories(); }
  createCategory(dto: CategoryNameDto) { return this.orders.createCategory(dto); }
  updateCategory(id: string, dto: CategoryNameDto) { return this.orders.updateCategory(id, dto); }
  deleteCategory(id: string) { return this.orders.deleteCategory(id); }

  list(
    kind?: string,
    status?: string,
    search?: string,
    category?: string,
    branch?: string,
    supplier?: string,
    minTotal?: string,
    maxTotal?: string,
    from?: string,
    to?: string,
    page?: string,
    pageSize?: string,
    sortBy?: string, sortDir?: string,
  ) {
    return this.orders.list({ kind, status, search, category, branch, supplier, minTotal, maxTotal, from, to, page: Number(page), pageSize: Number(pageSize), sortBy, sortDir });
  }

  /** Export a Excel del listado (mismos filtros). Va ANTES de :id para no colisionar. */
  async exportXlsx(
    res: Response,
    kind?: string,
    status?: string,
    search?: string,
    category?: string,
    branch?: string,
    supplier?: string,
    from?: string,
    to?: string,
  ) {
    const rows = await this.orders.exportRows({ kind, status, search, category, branch, supplier, from, to });
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Vestel';
    const ws = wb.addWorksheet('Órdenes');
    ws.columns = [
      { header: 'N°', key: 'tid', width: 8 },
      { header: 'Tipo', key: 'kind', width: 10 },
      { header: 'Proveedor', key: 'supplier', width: 32 },
      { header: 'Fecha', key: 'date', width: 12 },
      { header: 'Estado', key: 'status', width: 16 },
      { header: 'Total', key: 'total', width: 14 },
      { header: 'Pagado', key: 'paid', width: 14 },
      { header: 'Saldo', key: 'balance', width: 14 },
      { header: 'Sede', key: 'branchRef', width: 14 },
    ];
    ws.getRow(1).font = { bold: true };
    for (const r of rows) {
      ws.addRow({ ...r, date: r.date ? new Date(r.date).toISOString().slice(0, 10) : '', balance: Math.round(((r.total ?? 0) - (r.paid ?? 0)) * 100) / 100 });
    }
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="ordenes-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.send(buffer);
  }

  detail(id: string) { return this.orders.detail(id); }
  create(dto: CreateOrderDto, user: AuthUser) { return this.orders.create(dto, user); }
  update(id: string, dto: UpdateOrderDto, user: AuthUser) { return this.orders.update(id, dto, user); }

  // --- Flujo de aprobación ---
  // Firmar exige el código que llega al WhatsApp del autorizador: primero se pide
  // (`approve/otp`) y después se aprueba con él. Las dos rutas van tras el mismo
  // permiso — pedir el código ya revela el proveedor y el monto de la orden.
  approveOtp(id: string, user: AuthUser) { return this.orders.requestApprovalOtp(id, user); }
  approve(id: string, dto: ApproveOrderDto, user: AuthUser) { return this.orders.approve(id, user, dto.otp); }
  cancel(id: string, dto: CancelOrderDto, user: AuthUser) { return this.orders.cancel(id, user, dto.reason); }
  finalize(id: string, user: AuthUser) { return this.orders.finalize(id, user); }

  receive(id: string, dto: ReceiveOrderDto, user: AuthUser) { return this.orders.receive(id, dto, user); }
  pay(id: string, dto: PayOrderDto, user: AuthUser) { return this.orders.paySupplyOrder(id, dto, user); }
  addNote(id: string, dto: AddNoteDto, user: AuthUser) { return this.orders.addNote(id, dto, user); }
  removeNote(id: string, noteId: string) { return this.orders.removeNote(id, noteId); }
  remove(id: string) { return this.orders.remove(id); }

  // --- PDF imprimible (con cuadro de firmas) ---
  async pdf(id: string, res: Response) {
    const d = await this.orders.pdfData(id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="orden-${d.tid}.pdf"`);
    purchaseOrderPdf(res, {
      tid: d.tid, kind: d.kind, status: d.status, date: d.date, dueDate: d.dueDate,
      branchRef: d.branchRef, categoryRef: undefined, notes: d.notes,
      supplier: d.supplier ? { name: d.supplier.name, nit: d.supplier.nit, phone: d.supplier.phone } : null,
      items: d.items.map((it) => ({ ...it, product: it.product ?? '—' })),
      noteLines: d.noteLines.map((n) => ({ ...n, type: n.type ?? 'Nota' })),
      subtotal: d.subtotal, tax: d.tax, total: d.total, paid: d.paid, balance: d.balance,
      createdByName: d.approval.createdByName, firstBy: d.approval.firstBy, secondBy: d.approval.secondBy,
    });
  }

  // --- Adjuntos (factura del proveedor, cotizaciones…) ---
  async upload(id: string, file: MulterFile, user: AuthUser) {
    if (!file) throw new BadRequestException('No se recibió ningún archivo');
    try {
      return await this.orders.addFile(id, { originalName: file.originalname, storedName: file.filename, mimeType: file.mimetype, size: file.size }, user);
    } catch (e) {
      // La orden no existe u otro fallo: no dejar el binario huérfano en disco.
      try { unlinkSync(file.path); } catch { /* ya no está */ }
      throw e;
    }
  }

  async download(id: string, fileId: string, res: Response) {
    const f = await this.orders.fileMeta(id, fileId);
    const path = join(UPLOAD_ROOT, id, f.storedName);
    if (!existsSync(path)) throw new BadRequestException('El archivo no está en el disco.');
    res.setHeader('Content-Type', f.mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(f.originalName)}"`);
    createReadStream(path).pipe(res);
  }

  async deleteFile(id: string, fileId: string, user: AuthUser) {
    const f = await this.orders.deleteFile(id, fileId, user);
    const path = join(UPLOAD_ROOT, id, f.storedName);
    try { unlinkSync(path); } catch { /* metadata borrada; binario ya no estaba */ }
    return { ok: true };
  }
}
