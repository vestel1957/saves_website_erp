import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ServiceKind } from '@prisma/client';
import { PlansService } from './plans.service';
import { CreatePlanDto, UpdatePlanDto } from './dto/plan.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AreaGuard } from '../auth/area.guard';
import { RequireArea } from '../auth/require-area.decorator';

/** Catálogo de planes de servicio (internet/TV). */
@Controller('plans')
@UseGuards(JwtAuthGuard, AreaGuard)
@RequireArea('administracion', 'contabilidad', 'tecnicos', 'sistemas', 'caja')
export class PlansController {
  constructor(private readonly plans: PlansService) {}

  @Get()
  list(@Query('activeOnly') activeOnly?: string, @Query('kind') kind?: ServiceKind) {
    return this.plans.list({ activeOnly: activeOnly === 'true', kind });
  }

  @Post()
  create(@Body() dto: CreatePlanDto) {
    return this.plans.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdatePlanDto) {
    return this.plans.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.plans.remove(id);
  }
}
