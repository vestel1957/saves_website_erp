import { Controller, Get, UseGuards } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AreaGuard } from '../auth/area.guard';
import { RequireArea } from '../auth/require-area.decorator';

/** Dashboard ejecutivo (agrega todos los verticales Vestel). */
@Controller('dashboard')
@UseGuards(JwtAuthGuard, AreaGuard)
@RequireArea('gerencia')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get() summary() { return this.dashboard.summary(); }
}
