import {
  BadRequestException, Controller, Get, Param, Post, Query, Res,
  UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { DataService } from './data.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AreaGuard } from '../auth/area.guard';
import { RequireArea } from '../auth/require-area.decorator';

/** Herramientas de datos: exportar/importar por Excel. Área Sistemas / Administración. */
@Controller('data')
@UseGuards(JwtAuthGuard, AreaGuard)
@RequireArea('sistemas', 'administracion')
export class DataController {
  constructor(private readonly data: DataService) {}

  /** Exporta una entidad a Excel. entity ∈ subscribers|equipment|materials|invoices */
  @Get('export/:entity')
  async export(@Param('entity') entity: string, @Res() res: Response) {
    if (!this.data.isEntity(entity)) throw new BadRequestException('Entidad no soportada.');
    const { buffer, filename } = await this.data.exportEntity(entity);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }

  /** Importa equipos desde Excel. `?commit=1` para escribir; por defecto solo valida (preview). */
  @Post('import/equipment')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 15 * 1024 * 1024 } }))
  async importEquipment(@UploadedFile() file: any, @Query('commit') commit?: string) {
    if (!file?.buffer) throw new BadRequestException('Sube un archivo .xlsx en el campo "file".');
    return this.data.importEquipment(file.buffer, commit === '1' || commit === 'true');
  }
}
