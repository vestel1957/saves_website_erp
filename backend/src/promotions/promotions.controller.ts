import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { PromotionsService } from './promotions.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { APP_PERMISSIONS } from '../auth/permissions.catalog';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import {
  ApplyPromotionDto,
  CreatePromotionDto,
  UpdatePromotionDto,
} from './dto/promotions.dto';

/**
 * Administración de promociones: crear campañas y asignarlas a funcionarios.
 * Exclusivo del superusuario (system.admin), tal como lo pidió el negocio.
 */
@Controller('promotions')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(APP_PERMISSIONS.SYSTEM_ADMIN)
export class PromotionsController {
  constructor(private readonly promos: PromotionsService) {}

  @Get() list() {
    return this.promos.list();
  }

  /** Historial de asignaciones (qué promo, a quién, por quién y cuándo). */
  @Get('history') history(@Query('promotionId') promotionId?: string) {
    return this.promos.assignmentHistory(promotionId);
  }

  @Post() create(@Body() dto: CreatePromotionDto, @CurrentUser() u?: AuthUser) {
    return this.promos.create(dto, u?.name ?? u?.email);
  }

  @Put(':id') update(
    @Param('id') id: string,
    @Body() dto: UpdatePromotionDto,
    @CurrentUser() u?: AuthUser,
  ) {
    return this.promos.update(id, dto, u?.name ?? u?.email);
  }

  @Delete(':id') remove(@Param('id') id: string) {
    return this.promos.remove(id);
  }
}

/**
 * Uso por parte del funcionario: consulta las promociones que tiene vigentes y
 * las aplica a las facturas de los clientes. La autorización real la da la
 * asignación de la promo (o que sea global), no un permiso de área.
 */
@Controller('my-promotions')
@UseGuards(JwtAuthGuard)
export class MyPromotionsController {
  constructor(private readonly promos: PromotionsService) {}

  /** Promociones vigentes que el usuario puede aplicar hoy (opcional: para una factura). */
  @Get() available(@CurrentUser() u: AuthUser, @Query('invoiceId') invoiceId?: string) {
    return this.promos.available(u, invoiceId);
  }

  /** Aplica la promoción a una factura (genera nota crédito). */
  @Post(':id/apply')
  apply(
    @Param('id') id: string,
    @Body() dto: ApplyPromotionDto,
    @CurrentUser() u: AuthUser,
  ) {
    return this.promos.apply(id, dto, u);
  }
}
