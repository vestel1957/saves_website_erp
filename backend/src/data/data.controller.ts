import { BadRequestException } from '../core/http/errores';
import type { Response } from 'express';
import { DataService } from './data.service';

/** Herramientas de datos: exportar/importar por Excel. Área Sistemas / Administración. */
export class DataController {
  constructor(private readonly data: DataService) {}

  /** Exporta una entidad a Excel. entity ∈ subscribers|equipment|materials|invoices */
  async export(entity: string, res: Response) {
    if (!this.data.isEntity(entity)) throw new BadRequestException('Entidad no soportada.');
    const { buffer, filename } = await this.data.exportEntity(entity);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }

  /** Importa equipos desde Excel. `?commit=1` para escribir; por defecto solo valida (preview). */
  async importEquipment(file: any, commit?: string) {
    if (!file?.buffer) throw new BadRequestException('Sube un archivo .xlsx en el campo "file".');
    return this.data.importEquipment(file.buffer, commit === '1' || commit === 'true');
  }
}
