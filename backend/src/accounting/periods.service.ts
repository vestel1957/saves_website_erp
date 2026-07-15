import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePeriodDto } from './dto/accounting.dto';

@Injectable()
export class PeriodsService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.fiscalPeriod.findMany({ orderBy: [{ year: 'desc' }, { month: 'desc' }] });
  }

  async create(dto: CreatePeriodDto) {
    const isMonth = dto.month != null;
    const month = isMonth ? dto.month! : null;
    const dup = await this.prisma.fiscalPeriod.findUnique({ where: { year_month: { year: dto.year, month: month as any } } });
    if (dup) throw new BadRequestException('El periodo ya existe');

    const start = isMonth ? new Date(Date.UTC(dto.year, month! - 1, 1)) : new Date(Date.UTC(dto.year, 0, 1));
    // último día del rango a las 23:59:59.999 para que las fechas de ese día queden dentro
    const end = isMonth
      ? new Date(Date.UTC(dto.year, month!, 0, 23, 59, 59, 999))
      : new Date(Date.UTC(dto.year, 11, 31, 23, 59, 59, 999));
    const name = isMonth
      ? `${dto.year}-${String(month).padStart(2, '0')}`
      : `Año ${dto.year}`;

    return this.prisma.fiscalPeriod.create({
      data: { name, type: isMonth ? 'MONTH' : 'YEAR', year: dto.year, month, startDate: start, endDate: end },
    });
  }

  private async get(id: string) {
    const p = await this.prisma.fiscalPeriod.findUnique({ where: { id } });
    if (!p) throw new NotFoundException('Periodo no encontrado');
    return p;
  }

  /** Cierra el periodo: bloquea nuevos asientos con fecha dentro del rango. */
  async close(id: string) {
    const p = await this.get(id);
    if (p.status === 'LOCKED') throw new BadRequestException('El periodo está bloqueado');
    return this.prisma.fiscalPeriod.update({ where: { id }, data: { status: 'CLOSED', closedAt: new Date() } });
  }

  async reopen(id: string) {
    const p = await this.get(id);
    if (p.status === 'LOCKED') throw new BadRequestException('El periodo está bloqueado y no puede reabrirse');
    return this.prisma.fiscalPeriod.update({ where: { id }, data: { status: 'OPEN', closedAt: null } });
  }

  /**
   * Devuelve el periodo mensual que contiene la fecha y valida que esté abierto.
   * Si no existe periodo para esa fecha, se permite (no hay cierre definido aún).
   */
  async assertOpenForDate(date: Date) {
    const period = await this.prisma.fiscalPeriod.findFirst({
      where: { type: 'MONTH', startDate: { lte: date }, endDate: { gte: date } },
    });
    if (period && period.status !== 'OPEN') {
      throw new BadRequestException(`El periodo ${period.name} está cerrado; no se pueden registrar asientos en esa fecha`);
    }
    return period;
  }
}
