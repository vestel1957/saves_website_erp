import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { OmniService, CreateQuoteDto, EventDto, QuoteStatusDto, UpdateEventDto } from './omni.service';
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
  @Post('events') createEvent(@Body() dto: EventDto, @CurrentUser() user: AuthUser) { return this.omni.createEvent(dto, user); }
  @Patch('events/:id') updateEvent(@Param('id') id: string, @Body() dto: UpdateEventDto) { return this.omni.updateEvent(id, dto); }
  @Delete('events/:id') deleteEvent(@Param('id') id: string) { return this.omni.deleteEvent(id); }

  @Get('quotes') quotes(@Query('search') search?: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.omni.quotes({ search, page: Number(page), pageSize: Number(pageSize) });
  }
  @Post('quotes') createQuote(@Body() dto: CreateQuoteDto, @CurrentUser() user: AuthUser) { return this.omni.createQuote(dto, user); }
  @Get('quotes/:id') quoteDetail(@Param('id') id: string) { return this.omni.quoteDetail(id); }
  @Patch('quotes/:id/status') quoteStatus(@Param('id') id: string, @Body() dto: QuoteStatusDto) { return this.omni.updateQuoteStatus(id, dto.status); }
  @Post('quotes/:id/convert') convertQuote(@Param('id') id: string, @CurrentUser() user: AuthUser) { return this.omni.convertQuoteToInvoice(id, user); }
}
