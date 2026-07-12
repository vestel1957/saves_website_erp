import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { CategoryDto, ConfigDataService, UpdateBranchDto, UpdateCompanyDto } from './config.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AreaGuard } from '../auth/area.guard';
import { RequireArea } from '../auth/require-area.decorator';

/** Configuración: cajas, sedes, geografía, empresa. */
@Controller('config')
@UseGuards(JwtAuthGuard, AreaGuard)
@RequireArea('sistemas')
export class ConfigController {
  constructor(private readonly config: ConfigDataService) {}

  @Get('cash-accounts') cashAccounts() { return this.config.cashAccounts(); }
  @Get('branches') branches() { return this.config.branches(); }
  @Patch('branches/:id') updateBranch(@Param('id') id: string, @Body() dto: UpdateBranchDto) { return this.config.updateBranch(id, dto); }
  @Get('geography') geography() { return this.config.geography(); }
  @Get('geography/:departmentId/cities') cities(@Param('departmentId') id: string) { return this.config.cities(id); }
  @Get('company') company() { return this.config.company(); }
  @Patch('company') updateCompany(@Body() dto: UpdateCompanyDto) { return this.config.updateCompany(dto); }

  // --- Categorías de transacción (tesorería) ---
  @Get('categories') categories() { return this.config.categories(); }
  @Post('categories') createCategory(@Body() dto: CategoryDto) { return this.config.createCategory(dto); }
  @Patch('categories/:id') updateCategory(@Param('id') id: string, @Body() dto: CategoryDto) { return this.config.updateCategory(id, dto); }
  @Delete('categories/:id') deleteCategory(@Param('id') id: string) { return this.config.deleteCategory(id); }
}
