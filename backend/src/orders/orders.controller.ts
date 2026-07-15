import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { AddNoteDto, CategoryNameDto, CreateOrderDto, CreateSupplierDto, PayOrderDto, ReceiveOrderDto } from './dto/orders.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AreaGuard } from '../auth/area.guard';
import { RequireArea } from '../auth/require-area.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';

/** Órdenes de compra / servicio + proveedores (migrado de saves-vestel). */
@Controller('orders')
@UseGuards(JwtAuthGuard, AreaGuard)
@RequireArea('administracion', 'caja')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get('stats') stats() { return this.orders.stats(); }

  @Get('suppliers')
  suppliers(@Query('category') category?: string, @Query('search') search?: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.orders.suppliers({ category, search, page: Number(page), pageSize: Number(pageSize) });
  }
  @Post('suppliers') createSupplier(@Body() dto: CreateSupplierDto) { return this.orders.createSupplier(dto); }
  @Get('suppliers/:id/statement') supplierStatement(@Param('id') id: string) { return this.orders.supplierStatement(id); }
  @Patch('suppliers/:id') updateSupplier(@Param('id') id: string, @Body() dto: CreateSupplierDto) { return this.orders.updateSupplier(id, dto); }
  @Delete('suppliers/:id') deleteSupplier(@Param('id') id: string) { return this.orders.deleteSupplier(id); }

  @Get('branches') branches() { return this.orders.branches(); }

  @Get('categories') categories() { return this.orders.categories(); }
  @Post('categories') createCategory(@Body() dto: CategoryNameDto) { return this.orders.createCategory(dto); }
  @Patch('categories/:id') updateCategory(@Param('id') id: string, @Body() dto: CategoryNameDto) { return this.orders.updateCategory(id, dto); }
  @Delete('categories/:id') deleteCategory(@Param('id') id: string) { return this.orders.deleteCategory(id); }

  @Get()
  list(
    @Query('kind') kind?: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('category') category?: string,
    @Query('branch') branch?: string,
    @Query('supplier') supplier?: string,
    @Query('minTotal') minTotal?: string,
    @Query('maxTotal') maxTotal?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.orders.list({ kind, status, search, category, branch, supplier, minTotal, maxTotal, from, to, page: Number(page), pageSize: Number(pageSize) });
  }
  @Get(':id') detail(@Param('id') id: string) { return this.orders.detail(id); }
  @Post() create(@Body() dto: CreateOrderDto, @CurrentUser() user: AuthUser) { return this.orders.create(dto, user); }
  @Post(':id/receive') receive(@Param('id') id: string, @Body() dto: ReceiveOrderDto, @CurrentUser() user: AuthUser) { return this.orders.receive(id, dto, user); }
  @Post(':id/pay') pay(@Param('id') id: string, @Body() dto: PayOrderDto, @CurrentUser() user: AuthUser) { return this.orders.paySupplyOrder(id, dto, user); }
  @Post(':id/notes') addNote(@Param('id') id: string, @Body() dto: AddNoteDto, @CurrentUser() user: AuthUser) { return this.orders.addNote(id, dto, user); }
  @Delete(':id/notes/:noteId') removeNote(@Param('id') id: string, @Param('noteId') noteId: string) { return this.orders.removeNote(id, noteId); }
  @Delete(':id') remove(@Param('id') id: string) { return this.orders.remove(id); }
}
