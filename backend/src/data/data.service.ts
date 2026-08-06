import { BadRequestException } from '../core/http/errores';
import * as ExcelJS from 'exceljs';
import { PrismaService } from '../prisma/prisma.service';

type EntityKey = 'subscribers' | 'equipment' | 'materials' | 'invoices';

const ENTITIES: EntityKey[] = ['subscribers', 'equipment', 'materials', 'invoices'];

export class DataService {
  constructor(private prisma: PrismaService) {}

  isEntity(e: string): e is EntityKey {
    return (ENTITIES as string[]).includes(e);
  }

  // ---------------------------------------------------------------------------
  // EXPORT → Excel
  // ---------------------------------------------------------------------------
  async exportEntity(entity: EntityKey): Promise<{ buffer: Buffer; filename: string }> {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Vestel';
    const ws = wb.addWorksheet(entity);

    if (entity === 'subscribers') {
      ws.columns = [
        { header: 'Abonado', key: 'abonado', width: 10 },
        { header: 'Nombre', key: 'name', width: 32 },
        { header: 'Documento', key: 'docNumber', width: 16 },
        { header: 'Teléfono', key: 'phone1', width: 14 },
        { header: 'Email', key: 'email', width: 26 },
        { header: 'Estado', key: 'status', width: 12 },
        { header: 'Usuario PPPoE', key: 'pppUsername', width: 20 },
        { header: 'IP', key: 'ipRemote', width: 15 },
      ];
      const rows = await this.prisma.subscriber.findMany({
        select: { abonado: true, fullName: true, firstName: true, lastName1: true, companyName: true, docNumber: true, phone1: true, email: true, status: true, pppUsername: true, ipRemote: true },
        take: 50000,
      });
      ws.addRows(rows.map((s) => ({
        ...s, name: (s.fullName || [s.firstName, s.lastName1].filter(Boolean).join(' ') || s.companyName || '').trim(),
      })));
    } else if (entity === 'equipment') {
      ws.columns = [
        { header: 'Código', key: 'code', width: 12 },
        { header: 'MAC', key: 'mac', width: 20 },
        { header: 'Serial', key: 'serial', width: 20 },
        { header: 'Marca', key: 'brand', width: 16 },
        { header: 'Estado', key: 'status', width: 14 },
      ];
      const rows = await this.prisma.equipment.findMany({ select: { code: true, mac: true, serial: true, brand: true, status: true }, take: 50000 });
      ws.addRows(rows);
    } else if (entity === 'materials') {
      ws.columns = [
        { header: 'Código', key: 'code', width: 14 },
        { header: 'Nombre', key: 'name', width: 34 },
        { header: 'Precio', key: 'price', width: 14 },
      ];
      const rows = await this.prisma.material.findMany({ select: { code: true, name: true, price: true }, take: 50000 });
      ws.addRows(rows.map((r) => ({ ...r, price: Number(r.price) })));
    } else {
      ws.columns = [
        { header: 'N° Factura', key: 'tid', width: 12 },
        { header: 'Fecha', key: 'invoiceDate', width: 14 },
        { header: 'Total', key: 'total', width: 14 },
        { header: 'Pagado', key: 'paidAmount', width: 14 },
        { header: 'Estado', key: 'status', width: 12 },
      ];
      const rows = await this.prisma.subInvoice.findMany({
        select: { tid: true, invoiceDate: true, total: true, paidAmount: true, status: true },
        orderBy: { invoiceDate: 'desc' }, take: 50000,
      });
      ws.addRows(rows.map((r) => ({ ...r, invoiceDate: r.invoiceDate.toISOString().slice(0, 10), total: Number(r.total), paidAmount: Number(r.paidAmount) })));
    }

    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0E7490' } };
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    const date = new Date().toISOString().slice(0, 10);
    return { buffer, filename: `${entity}-${date}.xlsx` };
  }

  // ---------------------------------------------------------------------------
  // IMPORT ← Excel (preview: valida sin escribir; commit escribe)
  // ---------------------------------------------------------------------------
  async importEquipment(buffer: Buffer, commit: boolean) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as any);
    const ws = wb.worksheets[0];
    if (!ws) throw new BadRequestException('El archivo no tiene hojas.');

    // Cabeceras: Código | MAC | Serial | Marca | Estado (fila 1)
    const header: Record<string, number> = {};
    ws.getRow(1).eachCell((cell, col) => {
      header[String(cell.value ?? '').trim().toLowerCase()] = col;
    });
    const colOf = (...names: string[]) => {
      for (const n of names) if (header[n]) return header[n];
      return 0;
    };
    const cCode = colOf('código', 'codigo', 'code');
    const cMac = colOf('mac');
    const cSerial = colOf('serial');
    const cBrand = colOf('marca', 'brand');
    const cStatus = colOf('estado', 'status');

    const valid: any[] = [];
    const errors: { row: number; reason: string }[] = [];
    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const val = (c: number) => (c ? String(row.getCell(c).value ?? '').trim() : '');
      const mac = val(cMac), serial = val(cSerial);
      if (!mac && !serial) { if (val(cCode) || val(cBrand)) errors.push({ row: r, reason: 'sin MAC ni serial' }); continue; }
      // Se arrastra el número de fila del Excel: si la inserción falla, el usuario
      // tiene que saber QUÉ fila corregir. Antes se reportaba `row: -1`.
      valid.push({ fila: r, code: Number(val(cCode)) || undefined, mac: mac || null, serial: serial || null, brand: val(cBrand) || null, status: val(cStatus) || 'Disponible' });
    }

    let created = 0;
    if (commit && valid.length) {
      for (const e of valid) {
        try {
          await this.prisma.equipment.create({ data: { code: e.code ?? 0, mac: e.mac, serial: e.serial, brand: e.brand, status: e.status } as any });
          created++;
        } catch (err) {
          // Se conserva el motivo real (duplicado, longitud, tipo…). Descartarlo
          // hacía imposible depurar una importación de cientos de filas.
          const motivo = err instanceof Error ? err.message.split('\n').pop()?.trim() : String(err);
          errors.push({ row: e.fila, reason: `no se pudo crear ${e.mac ?? e.serial}: ${motivo}` });
        }
      }
    }

    return {
      committed: commit,
      totalRows: ws.rowCount - 1,
      validCount: valid.length,
      errorCount: errors.length,
      created,
      sample: valid.slice(0, 10),
      errors: errors.slice(0, 20),
    };
  }
}
