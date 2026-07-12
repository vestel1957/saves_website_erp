import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { InventoryService } from './inventory.service';
import { CreateMaterialDto, SimpleCatalogDto, TransferDto, UpdateMaterialDto } from './dto/inventory.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AreaGuard } from '../auth/area.guard';
import { RequireArea } from '../auth/require-area.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';

/** Inventario / material (migrado de saves-vestel). */
@Controller('inventory')
@UseGuards(JwtAuthGuard, AreaGuard)
@RequireArea('administracion', 'tecnicos')
export class InventoryController {
  constructor(private readonly inv: InventoryService) {}

  @Get('stats') stats() { return this.inv.stats(); }
  @Get('categories') categories() { return this.inv.categories(); }
  @Get('warehouses') warehouses() { return this.inv.warehouses(); }
  @Post('categories') createCategory(@Body() dto: SimpleCatalogDto) { return this.inv.createCategory(dto); }
  @Patch('categories/:id') updateCategory(@Param('id') id: string, @Body() dto: SimpleCatalogDto) { return this.inv.updateCategory(id, dto); }
  @Delete('categories/:id') deleteCategory(@Param('id') id: string) { return this.inv.deleteCategory(id); }
  @Post('warehouses') createWarehouse(@Body() dto: SimpleCatalogDto) { return this.inv.createWarehouse(dto); }

  @Get('materials')
  materials(
    @Query('search') search?: string, @Query('categoryId') categoryId?: string, @Query('warehouseId') warehouseId?: string,
    @Query('lowStock') lowStock?: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string,
  ) {
    return this.inv.materials({ search, categoryId, warehouseId, lowStock, page: Number(page), pageSize: Number(pageSize) });
  }
  @Get('materials/:id') materialDetail(@Param('id') id: string) { return this.inv.materialDetail(id); }
  @Post('materials') createMaterial(@Body() dto: CreateMaterialDto) { return this.inv.createMaterial(dto); }
  @Patch('materials/:id') updateMaterial(@Param('id') id: string, @Body() dto: UpdateMaterialDto) { return this.inv.updateMaterial(id, dto); }
  @Delete('materials/:id') deleteMaterial(@Param('id') id: string) { return this.inv.deleteMaterial(id); }

  @Post('transfer') transfer(@Body() dto: TransferDto, @CurrentUser() user: AuthUser) { return this.inv.transfer(dto, user); }
  @Get('actas') actas(@Query('page') page?: string, @Query('pageSize') pageSize?: string, @Query('search') search?: string, @Query('status') status?: string) { return this.inv.actas({ page: Number(page), pageSize: Number(pageSize), search, status }); }
  @Get('actas/:id') actaDetail(@Param('id') id: string, @CurrentUser() user: AuthUser) { return this.inv.actaDetail(id, user); }
  @Post('actas/:id/items/:itemId/receive') receiveActaItem(@Param('id') id: string, @Param('itemId') itemId: string, @CurrentUser() user: AuthUser) { return this.inv.receiveActaItem(id, itemId, user); }
  @Post('actas/:id/receive') receiveActa(@Param('id') id: string, @CurrentUser() user: AuthUser) { return this.inv.receiveActa(id, user); }
}
