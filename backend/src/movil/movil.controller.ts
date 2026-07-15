import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { MovilService, AddMemberDto, CreateMovilDto, UpdateMovilDto } from './movil.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AreaGuard } from '../auth/area.guard';
import { RequireArea } from '../auth/require-area.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';

/** Móviles / cuadrillas de técnicos (migrado de saves-vestel). */
@Controller('moviles')
@UseGuards(JwtAuthGuard, AreaGuard)
@RequireArea('administracion', 'tecnicos', 'gerencia')
export class MovilController {
  constructor(private readonly moviles: MovilService) {}

  @Get() list(@Query('search') search?: string, @Query('status') status?: string) { return this.moviles.list({ search, status }); }
  @Get('employees') employees(@Query('movilId') movilId?: string) { return this.moviles.availableEmployees(movilId); }
  @Get(':id') detail(@Param('id') id: string) { return this.moviles.detail(id); }
  @Post() create(@Body() dto: CreateMovilDto, @CurrentUser() user: AuthUser) { return this.moviles.create(dto, user); }
  @Patch(':id') update(@Param('id') id: string, @Body() dto: UpdateMovilDto) { return this.moviles.update(id, dto); }
  @Delete(':id') remove(@Param('id') id: string) { return this.moviles.remove(id); }
  @Post(':id/members') addMember(@Param('id') id: string, @Body() dto: AddMemberDto) { return this.moviles.addMember(id, dto); }
  @Delete(':id/members/:employeeId') removeMember(@Param('id') id: string, @Param('employeeId') employeeId: string) { return this.moviles.removeMember(id, employeeId); }
}
