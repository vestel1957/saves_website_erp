import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { PublicService } from './public.service';
import { ApiKeyGuard, RequireScopes } from './api-key.guard';

/**
 * API REST pública para integraciones de terceros. Autenticada por clave de API
 * (cabecera `X-API-Key`), NO por sesión de usuario. Solo lectura.
 * Base: `/api/public/v1`.
 */
@Controller('public/v1')
@UseGuards(ApiKeyGuard)
export class PublicController {
  constructor(private readonly svc: PublicService) {}

  /** Verifica que la clave funciona; no requiere scope. */
  @Get('ping')
  ping() { return { ok: true, service: 'saves-vestel public API', version: 'v1' }; }

  @Get('clients')
  @RequireScopes('clients:read')
  clients(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('search') search?: string,
  ) {
    return this.svc.clients({ page: Number(page), pageSize: Number(pageSize), search });
  }

  @Get('clients/:id')
  @RequireScopes('clients:read')
  client(@Param('id') id: string) { return this.svc.clientById(id); }

  @Get('clients/:id/invoices')
  @RequireScopes('invoices:read')
  clientInvoices(
    @Param('id') id: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.svc.clientInvoices(id, { page: Number(page), pageSize: Number(pageSize) });
  }
}
