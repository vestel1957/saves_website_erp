import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import type { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { InventoryService } from './inventory.service';
import { InventoryAlertsService } from './alerts.service';
import { CreateMaterialDto, ReceiveActaDto, SimpleCatalogDto, TransferDto, UpdateMaterialDto, WarehouseDto } from './dto/inventory.dto';
import { actaPdf } from '../common/pdf/pdf-docs';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AreaGuard } from '../auth/area.guard';
import { RequireArea } from '../auth/require-area.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';

/**
 * Inventario / material (migrado de saves-vestel).
 *
 * El área por defecto es administración/técnicos. Caja NO entra al módulo: sólo a
 * los seis endpoints que componen "entregarle material a un técnico" (traspaso +
 * actas), marcados uno a uno con su propio `@RequireArea` — el decorador de método
 * gana sobre el de la clase (`Reflector.getAllAndOverride`). Se hace endpoint por
 * endpoint y no abriendo el controlador entero para que la cajera no pueda crear
 * material, bodegas ni categorías por API aunque la pantalla no se lo ofrezca.
 */
const TRASPASOS = ['administracion', 'tecnicos', 'caja'] as const;

@Controller('inventory')
@UseGuards(JwtAuthGuard, AreaGuard)
@RequireArea('administracion', 'tecnicos')
export class InventoryController {
  constructor(
    private readonly inv: InventoryService,
    private readonly alertsSvc: InventoryAlertsService,
  ) {}

  @Get('stats') stats() { return this.inv.stats(); }

  // ── Alertas de stock (campana del TopNav) ──────────────────────────────────
  // Van antes de `materials/:id` y compañía por claridad; no colisionan porque
  // 'alerts' es un segmento literal.
  @Get('alerts') alerts() { return this.alertsSvc.list(); }
  @Post('alerts/run') runAlerts() { return this.alertsSvc.run(); }
  @Post('alerts/read-all') readAllAlerts() { return this.alertsSvc.readAll(); }

  @Get('categories') categories() { return this.inv.categories(); }
  /** Bodegas: las necesita el selector origen/destino del traspaso. */
  @Get('warehouses') @RequireArea(...TRASPASOS) warehouses(@CurrentUser() user?: AuthUser) { return this.inv.warehouses(user); }
  @Post('categories') createCategory(@Body() dto: SimpleCatalogDto) { return this.inv.createCategory(dto); }
  @Patch('categories/:id') updateCategory(@Param('id') id: string, @Body() dto: SimpleCatalogDto) { return this.inv.updateCategory(id, dto); }
  @Delete('categories/:id') deleteCategory(@Param('id') id: string) { return this.inv.deleteCategory(id); }
  @Post('warehouses') createWarehouse(@Body() dto: WarehouseDto, @CurrentUser() user?: AuthUser) { return this.inv.createWarehouse(dto, user); }
  @Patch('warehouses/:id') updateWarehouse(@Param('id') id: string, @Body() dto: WarehouseDto, @CurrentUser() user?: AuthUser) { return this.inv.updateWarehouse(id, dto, user); }
  @Delete('warehouses/:id') deleteWarehouse(@Param('id') id: string, @CurrentUser() user?: AuthUser) { return this.inv.deleteWarehouse(id, user); }

  /** Existencias de una bodega: es lo que se elige para entregar en el traspaso. */
  @Get('materials')
  @RequireArea(...TRASPASOS)
  materials(
    @Query('search') search?: string, @Query('categoryId') categoryId?: string, @Query('warehouseId') warehouseId?: string,
    @Query('lowStock') lowStock?: string, @Query('onlyConsumable') onlyConsumable?: string,
    @Query('page') page?: string, @Query('pageSize') pageSize?: string,
    @Query('sortBy') sortBy?: string, @Query('sortDir') sortDir?: string,
    @CurrentUser() user?: AuthUser,
  ) {
    return this.inv.materials({ search, categoryId, warehouseId, lowStock, onlyConsumable, page: Number(page), pageSize: Number(pageSize), sortBy, sortDir }, user);
  }
  @Get('materials/:id') materialDetail(@Param('id') id: string, @CurrentUser() user?: AuthUser) { return this.inv.materialDetail(id, user); }
  @Post('materials') createMaterial(@Body() dto: CreateMaterialDto, @CurrentUser() user?: AuthUser) { return this.inv.createMaterial(dto, user); }

  /** Importa materiales desde un Excel (.xlsx). Campo "file". */
  @Post('materials/import')
  @UseInterceptors(FileInterceptor('file', {
    storage: memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => cb(null, /spreadsheet|excel|\.xlsx$/.test(file.mimetype) || file.originalname.toLowerCase().endsWith('.xlsx')),
  }))
  importMaterials(@UploadedFile() file?: { buffer: Buffer }) {
    if (!file) throw new BadRequestException('Sube un archivo .xlsx en el campo "file".');
    return this.inv.importMaterials(file.buffer);
  }
  @Patch('materials/:id') updateMaterial(@Param('id') id: string, @Body() dto: UpdateMaterialDto, @CurrentUser() user?: AuthUser) { return this.inv.updateMaterial(id, dto, user); }
  @Delete('materials/:id') deleteMaterial(@Param('id') id: string, @CurrentUser() user?: AuthUser) { return this.inv.deleteMaterial(id, user); }

  // ── Traspasos y actas ─────────────────────────────────────────────────────
  // Abiertos también a caja: es la entrega de material al técnico. Recibir sigue
  // siendo del designado (`receiveActa` lo comprueba contra `assignedToId`), así
  // que abrir la ruta no deja a nadie firmar un acta ajena.
  /**
   * Lo que la pantalla de nuevo traspaso puede hacer y ofrecer: modos, bodegas,
   * técnicos de su sede y quién recibe en cada destino. La regla se aplica igual
   * en `transfer()`; esto sólo evita pintarle a la cajera lo que no puede mover.
   */
  @Get('transfer/context') @RequireArea(...TRASPASOS) transferContext(@CurrentUser() user: AuthUser) { return this.inv.transferContext(user); }
  @Post('transfer') @RequireArea(...TRASPASOS) transfer(@Body() dto: TransferDto, @CurrentUser() user: AuthUser) { return this.inv.transfer(dto, user); }
  @Get('actas') @RequireArea(...TRASPASOS) actas(@Query('page') page?: string, @Query('pageSize') pageSize?: string, @Query('search') search?: string, @Query('status') status?: string, @Query('sortBy') sortBy?: string, @Query('sortDir') sortDir?: string) { return this.inv.actas({ page: Number(page), pageSize: Number(pageSize), search, status, sortBy, sortDir }); }
  @Get('actas/:id') @RequireArea(...TRASPASOS) actaDetail(@Param('id') id: string, @CurrentUser() user: AuthUser) { return this.inv.actaDetail(id, user); }
  @Post('actas/:id/items/:itemId/receive') @RequireArea(...TRASPASOS) receiveActaItem(@Param('id') id: string, @Param('itemId') itemId: string, @CurrentUser() user: AuthUser) { return this.inv.receiveActaItem(id, itemId, user); }
  // El acta en PDF: la misma que se le manda por WhatsApp a quien debe firmarla.
  @Get('actas/:id/pdf') @RequireArea(...TRASPASOS)
  async actaPdf(@Param('id') id: string, @Res() res: Response) {
    const d = await this.inv.actaPdfData(id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="acta-traspaso-${d.numero}.pdf"`);
    actaPdf(res, d);
  }
  /** Reenvía el acta por WhatsApp (si no le llegó al designado). */
  @Post('actas/:id/send') @RequireArea(...TRASPASOS)
  sendActa(@Param('id') id: string, @CurrentUser() user: AuthUser) { return this.inv.reenviarActa(id, user); }
  /** Código de firma para cerrar el acta (llega al WhatsApp de quien recibe). */
  @Post('actas/:id/otp') @RequireArea(...TRASPASOS)
  actaOtp(@Param('id') id: string, @CurrentUser() user: AuthUser) { return this.inv.pedirCodigoActa(id, user); }
  @Post('actas/:id/receive') @RequireArea(...TRASPASOS)
  receiveActa(@Param('id') id: string, @Body() dto: ReceiveActaDto, @CurrentUser() user: AuthUser) { return this.inv.receiveActa(id, user, dto?.code); }
}
