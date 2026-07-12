import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ReportsService } from './reports.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AreaGuard } from '../auth/area.guard';
import { RequireArea } from '../auth/require-area.decorator';

/** Reportes (recaudo, cartera, ventas, órdenes) — migrado de saves-vestel. */
@Controller('reports')
@UseGuards(JwtAuthGuard, AreaGuard)
@RequireArea('gerencia')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('recaudo') recaudo(@Query('from') from?: string, @Query('to') to?: string) { return this.reports.recaudo(from, to); }
  @Get('ventas-sede') ventasSede(@Query('from') from?: string, @Query('to') to?: string) { return this.reports.ventasSede(from, to); }
  @Get('ingresos-egresos') ingresosEgresos() { return this.reports.ingresosEgresos(); }
  @Get('ordenes') ordenes(@Query('from') from?: string, @Query('to') to?: string) { return this.reports.ordenes(from, to); }
  @Get('top-deudores') topDeudores() { return this.reports.topDeudores(); }
  @Get('estadisticas-servicios') estadisticasServicios() { return this.reports.estadisticasServicios(); }
  @Get('cortes-activaciones') cortesActivaciones(@Query('from') from?: string, @Query('to') to?: string) { return this.reports.cortesActivaciones(from, to); }
  @Get('movimientos') movimientos(@Query('from') from?: string, @Query('to') to?: string) { return this.reports.movimientos(from, to); }
}
