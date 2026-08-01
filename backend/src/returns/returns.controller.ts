import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ReturnsService, CreateReturnDto, PayReturnDto } from './returns.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AreaGuard } from '../auth/area.guard';
import { RequireArea } from '../auth/require-area.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';

/** Devoluciones de material a proveedor (stockreturn, migrado de saves-vestel). */
@Controller('returns')
@UseGuards(JwtAuthGuard, AreaGuard)
@RequireArea('administracion')
export class ReturnsController {
  constructor(private readonly returns: ReturnsService) {}

  @Get('stats') stats() { return this.returns.stats(); }
  @Get()
  list(@Query('search') search?: string, @Query('status') status?: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string, @Query('sortBy') sortBy?: string, @Query('sortDir') sortDir?: string) {
    return this.returns.list({ search, status, page: Number(page), pageSize: Number(pageSize), sortBy, sortDir });
  }
  @Get(':id') detail(@Param('id') id: string) { return this.returns.detail(id); }
  @Post() create(@Body() dto: CreateReturnDto, @CurrentUser() user: AuthUser) { return this.returns.create(dto, user); }
  @Post(':id/pay') pay(@Param('id') id: string, @Body() dto: PayReturnDto, @CurrentUser() user: AuthUser) { return this.returns.pay(id, dto, user); }
  @Delete(':id') remove(@Param('id') id: string) { return this.returns.remove(id); }
}
