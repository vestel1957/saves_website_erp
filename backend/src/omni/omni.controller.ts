import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { OmniService, CreateQuoteDto } from './omni.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AreaGuard } from '../auth/area.guard';
import { RequireArea } from '../auth/require-area.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';

/** Omnicanalidad: agenda (eventos), cotizaciones. */
@Controller('omni')
@UseGuards(JwtAuthGuard, AreaGuard)
@RequireArea('contabilidad', 'administracion', 'caja')
export class OmniController {
  constructor(private readonly omni: OmniService) {}

  @Get('events') events(@Query('from') from?: string, @Query('to') to?: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.omni.events({ from, to, page: Number(page), pageSize: Number(pageSize) });
  }
  @Get('events/stats') eventsStats() { return this.omni.eventsStats(); }

  @Get('quotes') quotes(@Query('search') search?: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.omni.quotes({ search, page: Number(page), pageSize: Number(pageSize) });
  }
  @Post('quotes') createQuote(@Body() dto: CreateQuoteDto, @CurrentUser() user: AuthUser) { return this.omni.createQuote(dto, user); }
}
