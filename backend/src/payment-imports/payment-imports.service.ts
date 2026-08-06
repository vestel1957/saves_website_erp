import { BadRequestException, NotFoundException } from '../core/http/errores';
import * as ExcelJS from 'exceljs';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CobranzasService } from '../treasury/cobranzas.service';
import { ReconexionService } from '../network/reconexion.service';
import { AuthUser } from '../auth/current-user.decorator';
import { num, round2 } from '../common/money';

const dateOnly = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

/** Monto estilo legacy: quita '$' y separadores de miles → entero COP. */
function parseAmount(v: unknown): number {
  if (typeof v === 'number') return round2(v);
  const digits = String(v ?? '').replace(/[^\d-]/g, '');
  const n = parseInt(digits, 10);
  return Number.isFinite(n) ? n : 0;
}

/** Fecha desde una celda de Excel (Date, serial numérico, o texto). */
function parseCellDate(v: unknown): Date | null {
  if (v instanceof Date) return dateOnly(v);
  if (typeof v === 'number' && v > 0) return dateOnly(new Date((v - 25569) * 86400 * 1000));
  if (typeof v === 'string' && v.trim()) { const d = new Date(v); if (!isNaN(d.getTime())) return dateOnly(d); }
  return null;
}

const cellText = (v: unknown): string => {
  if (v == null) return '';
  if (typeof v === 'object' && 'text' in (v as any)) return String((v as any).text).trim();
  if (typeof v === 'object' && 'result' in (v as any)) return String((v as any).result).trim();
  return String(v).trim();
};

export class PaymentImportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cobranzas: CobranzasService,
    private readonly reconexion: ReconexionService,
  ) {}

  /** Fase 1: parsea el archivo y crea el lote + filas en staging (no aplica nada). */
  async upload(buffer: Buffer, fileName: string, dateOverride: string | undefined, user?: AuthUser) {
    const wb = new ExcelJS.Workbook();
    try { await wb.xlsx.load(buffer as any); } catch { throw new BadRequestException('No se pudo leer el archivo. Debe ser un .xlsx válido.'); }
    const ws = wb.worksheets[0];
    if (!ws) throw new BadRequestException('El archivo no tiene hojas.');

    const override = dateOverride ? parseCellDate(dateOverride) : null;
    const rows: Prisma.PaymentImportRowCreateManyBatchInput[] = [];
    let totalAmount = 0;
    // Fila 1 = encabezado. Columnas: A fecha, B documento, C monto, D método, E ref_efecty.
    ws.eachRow((row, rowNumber) => {
      if (rowNumber < 2) return;
      const documento = cellText(row.getCell(2).value);
      const amount = parseAmount(row.getCell(3).value);
      if (!documento || amount <= 0) return; // legacy: solo monto>0 y documento>0
      const method = cellText(row.getCell(4).value) || 'EFECTY';
      const reference = cellText(row.getCell(5).value) || null;
      const date = override ?? parseCellDate(row.getCell(1).value);
      totalAmount = round2(totalAmount + amount);
      rows.push({ rowNumber, documento, amount, method, reference, date, status: 'Inicial' });
    });
    if (!rows.length) throw new BadRequestException('El archivo no tiene filas válidas (revisa que monto y documento sean > 0, y que los datos empiecen en la fila 2).');

    const batch = await this.prisma.paymentImportBatch.create({
      data: {
        fileName, uploadedById: user?.id ?? null, status: 'Cargado',
        totalRows: rows.length, totalAmount,
        rows: { createMany: { data: rows } },
      },
      include: { _count: { select: { rows: true } } },
    });
    return this.detail(batch.id);
  }

  /** Resuelve el cliente por legacyId → abonado → documento (docNumber). */
  private async matchSubscriber(documento: string): Promise<{ id: string } | { error: string }> {
    const asInt = parseInt(documento.replace(/[^\d]/g, ''), 10);
    if (Number.isFinite(asInt)) {
      const byLegacy = await this.prisma.subscriber.findUnique({ where: { legacyId: asInt }, select: { id: true } });
      if (byLegacy) return byLegacy;
      const byAbonado = await this.prisma.subscriber.findMany({ where: { abonado: asInt }, select: { id: true }, take: 2 });
      if (byAbonado.length === 1) return byAbonado[0];
      if (byAbonado.length > 1) return { error: 'Múltiples clientes con ese abonado' };
    }
    const byDoc = await this.prisma.subscriber.findMany({ where: { docNumber: documento }, select: { id: true }, take: 2 });
    if (byDoc.length === 1) return byDoc[0];
    if (byDoc.length > 1) return { error: 'Múltiples clientes con ese documento' };
    return { error: 'Usuario No Existe' };
  }

  /** Fase 2: procesa las filas 'Inicial' del lote y aplica los pagos a cartera. */
  async process(batchId: string, user?: AuthUser) {
    const batch = await this.prisma.paymentImportBatch.findUnique({ where: { id: batchId }, include: { rows: { where: { status: 'Inicial' }, orderBy: { rowNumber: 'asc' } } } });
    if (!batch) throw new NotFoundException('Lote no encontrado');
    if (!batch.rows.length) throw new BadRequestException('El lote no tiene filas pendientes por procesar.');

    // Abonados que efectivamente pagaron en este lote: al final se reconectan de
    // una sola pasada (ver más abajo). Es un Set porque el mismo cliente puede
    // venir en varias filas del archivo.
    const pagaron = new Set<string>();

    for (const row of batch.rows) {
      // Idempotencia: no reaplicar un pago ya cargado con la misma referencia.
      if (row.reference) {
        const dup = await this.prisma.paymentImportRow.findFirst({ where: { reference: row.reference, status: 'Cargado', id: { not: row.id } }, select: { id: true } });
        if (dup) { await this.mark(row.id, 'Duplicado', null, null, `Referencia ${row.reference} ya aplicada`); continue; }
      }
      const match = await this.matchSubscriber(row.documento);
      if ('error' in match) { await this.mark(row.id, match.error === 'Usuario No Existe' ? 'Usuario No Existe' : 'Error', null, null, match.error); continue; }
      try {
        const res = await this.cobranzas.collect({
          subscriberId: match.id, amount: num(row.amount), method: row.method || 'EFECTY',
          date: row.date ? row.date.toISOString().slice(0, 10) : undefined,
          note: `Cargue ${row.method || 'EFECTY'}${row.reference ? ` ref ${row.reference}` : ''}`,
        } as any, (user ?? { name: 'Cargue', email: null }) as any, { reconectar: false });
        await this.mark(row.id, 'Cargado', match.id, res.receiptId, `Aplicado ${res.totalApplied}`);
        pagaron.add(match.id);
      } catch (e: any) {
        await this.mark(row.id, 'Error', match.id, null, e?.message || 'No se pudo aplicar el pago');
      }
    }

    // Reconexión de los que pagaron: internet y/o TV, cada uno por su vía y solo al
    // que le corresponda. Va FUERA del bucle y en lote a propósito — reconectar fila
    // por fila abriría una conexión al router (y una sesión SSH a la OLT) por pago,
    // y un archivo de corresponsal trae cientos. Best-effort: si los equipos fallan,
    // el cargue igual queda aplicado y el fallo queda en el log y en la auditoría.
    const reconexion = await this.reconexion.porPagoLote([...pagaron], user);

    return { ...(await this.detail(batchId, true)), reconexion };
  }

  private async mark(rowId: string, status: string, subscriberId: string | null, transactionId: string | null, message: string) {
    await this.prisma.paymentImportRow.update({ where: { id: rowId }, data: { status, subscriberId, transactionId, message } });
  }

  /** Recalcula contadores del lote desde sus filas. */
  private async recount(batchId: string) {
    const rows = await this.prisma.paymentImportRow.findMany({ where: { batchId }, select: { status: true, amount: true } });
    const applied = rows.filter((r) => r.status === 'Cargado');
    await this.prisma.paymentImportBatch.update({
      where: { id: batchId },
      data: {
        appliedRows: applied.length,
        errorRows: rows.filter((r) => r.status === 'Error').length,
        notFoundRows: rows.filter((r) => r.status === 'Usuario No Existe').length,
        duplicateRows: rows.filter((r) => r.status === 'Duplicado').length,
        appliedAmount: round2(applied.reduce((s, r) => s + num(r.amount), 0)),
        status: rows.some((r) => r.status === 'Inicial') ? 'Cargado' : 'Procesado',
      },
    });
  }

  async list() {
    const rows = await this.prisma.paymentImportBatch.findMany({ orderBy: { createdAt: 'desc' }, take: 100 });
    return rows.map((b) => ({
      id: b.id, fileName: b.fileName, status: b.status, date: b.createdAt,
      totalRows: b.totalRows, appliedRows: b.appliedRows, errorRows: b.errorRows, notFoundRows: b.notFoundRows, duplicateRows: b.duplicateRows,
      totalAmount: num(b.totalAmount), appliedAmount: num(b.appliedAmount),
    }));
  }

  async detail(id: string, recount = false) {
    if (recount) await this.recount(id);
    const b = await this.prisma.paymentImportBatch.findUnique({ where: { id }, include: { rows: { orderBy: { rowNumber: 'asc' } } } });
    if (!b) throw new NotFoundException('Lote no encontrado');
    return {
      id: b.id, fileName: b.fileName, status: b.status, date: b.createdAt,
      totalRows: b.totalRows, appliedRows: b.appliedRows, errorRows: b.errorRows, notFoundRows: b.notFoundRows, duplicateRows: b.duplicateRows,
      totalAmount: num(b.totalAmount), appliedAmount: num(b.appliedAmount),
      rows: b.rows.map((r) => ({
        id: r.id, rowNumber: r.rowNumber, documento: r.documento, amount: num(r.amount), method: r.method,
        reference: r.reference, date: r.date ? r.date.toISOString().slice(0, 10) : null,
        status: r.status, subscriberId: r.subscriberId, message: r.message,
      })),
    };
  }

  async remove(id: string) {
    const b = await this.prisma.paymentImportBatch.findUnique({ where: { id } });
    if (!b) throw new NotFoundException('Lote no encontrado');
    await this.prisma.paymentImportBatch.delete({ where: { id } }); // cascade borra filas (no revierte pagos aplicados)
    return { id, deleted: true };
  }
}
