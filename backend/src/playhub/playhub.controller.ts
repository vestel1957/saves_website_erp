import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IsString, MinLength } from 'class-validator';
import { PlayhubService } from './playhub.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AreaGuard } from '../auth/area.guard';
import { RequireArea } from '../auth/require-area.decorator';

class ProductDto {
  @IsString() @MinLength(1)
  productId!: string;
}

/** Integración PlayHub (OTT): catálogo, suscripciones, y sincronización. */
@Controller('playhub')
@UseGuards(JwtAuthGuard, AreaGuard)
@RequireArea('administracion', 'tecnicos', 'gerencia', 'sistemas')
export class PlayhubController {
  constructor(private readonly playhub: PlayhubService) {}

  @Get('status')
  status() {
    return this.playhub.status();
  }

  @Get('catalog')
  catalog() {
    return this.playhub.catalog();
  }

  /** Suscripciones en vivo del cliente (consulta a PlayHub). */
  @Get('subscribers/:id/live')
  live(@Param('id') id: string) {
    return this.playhub.liveSubscriptions(id);
  }

  /** Suscripciones locales del cliente (tabla incremental). */
  @Get('subscribers/:id/local')
  local(@Param('id') id: string) {
    return this.playhub.localSubscriptions(id);
  }

  @Post('subscribers/:id/subscribe')
  subscribe(@Param('id') id: string, @Body() dto: ProductDto) {
    return this.playhub.subscribe(id, dto.productId);
  }

  @Post('subscribers/:id/unsubscribe')
  unsubscribe(@Param('id') id: string, @Body() dto: ProductDto) {
    return this.playhub.unsubscribe(id, dto.productId);
  }

  @Post('subscribers/:id/sync-customer')
  syncCustomer(@Param('id') id: string) {
    return this.playhub.syncCustomer(id);
  }

  /** Refresca la tabla local del cliente contra sus suscripciones en vivo. */
  @Post('subscribers/:id/sync-local')
  syncLocal(@Param('id') id: string) {
    return this.playhub.syncSubscriber(id);
  }

  /** Sincronización masiva (todos los clientes con suscripciones locales). */
  @Post('sync-all')
  syncAll(@Query('limit') limit?: string) {
    return this.playhub.syncAll(limit ? Number(limit) : 500);
  }
}
