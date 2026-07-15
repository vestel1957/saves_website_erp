import { Body, Controller, Delete, Get, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { CollectionsService, AgreementFilter } from './collections.service';
import { CreateCallDto } from './dto/collections.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AreaGuard } from '../auth/area.guard';
import { RequireArea } from '../auth/require-area.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';

const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Cobranza: bitácora de llamadas + acuerdos de pago (migrado de saves-vestel `Llamadas`). */
@Controller('collections')
@UseGuards(JwtAuthGuard, AreaGuard)
@RequireArea('administracion', 'caja')
export class CollectionsController {
  constructor(private readonly collections: CollectionsService) {}

  private filter(q: Record<string, string | undefined>, user: AuthUser): AgreementFilter {
    return {
      responsible: q.responsible, mine: q.mine === 'true', userName: user?.name,
      callType: q.callType, search: q.search, state: q.state,
      from: q.from, to: q.to, dueFrom: q.dueFrom, dueTo: q.dueTo,
      page: Number(q.page), pageSize: Number(q.pageSize),
    };
  }

  @Get('response-types') responseTypes() { return this.collections.responseTypes(); }

  @Get('agreements')
  agreements(@Query() q: Record<string, string | undefined>, @CurrentUser() user: AuthUser) {
    return this.collections.agreements(this.filter(q, user));
  }

  @Get('agreements/export.csv')
  async exportAgreements(@Query() q: Record<string, string | undefined>, @CurrentUser() user: AuthUser, @Res() res: Response) {
    const rows = await this.collections.agreementRows(this.filter(q, user));
    const headers = ['Cliente', 'Documento', 'Abonado', 'Teléfono', 'Estado cliente', 'Responsable', 'Fecha llamada', 'Hora', 'Compromiso', 'Vencido', 'Notas'];
    const lines = [headers.join(';')];
    for (const r of rows) {
      lines.push([r.cliente, r.documento, r.abonado, r.telefono, r.estadoCliente, r.responsible, r.date, r.time, r.dueDate, r.vencido ? 'Sí' : 'No', r.notes].map(csvCell).join(';'));
    }
    const csv = '﻿' + lines.join('\r\n'); // BOM para Excel (acentos)
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="acuerdos-de-pago.csv"');
    res.send(csv);
  }

  @Get('subscriber/:subscriberId') bySubscriber(@Param('subscriberId') subscriberId: string) {
    return this.collections.listBySubscriber(subscriberId);
  }

  @Post() create(@Body() dto: CreateCallDto, @CurrentUser() user: AuthUser) { return this.collections.create(dto, user); }
  @Delete(':id') remove(@Param('id') id: string) { return this.collections.remove(id); }
}
