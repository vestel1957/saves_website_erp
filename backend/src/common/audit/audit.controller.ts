import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuditService } from './audit.service';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { AreaGuard } from '../../auth/area.guard';
import { RequireArea } from '../../auth/require-area.decorator';

/** Visor de la bitácora global (auditoría de acciones). Área Sistemas. */
@Controller('activity')
@UseGuards(JwtAuthGuard, AreaGuard)
@RequireArea('sistemas')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  list(
    @Query('search') search?: string,
    @Query('entity') entity?: string,
    @Query('userId') userId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.audit.list({ search, entity, userId, from, to, page: Number(page), pageSize: Number(pageSize) });
  }
}
