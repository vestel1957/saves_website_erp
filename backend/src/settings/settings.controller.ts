import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { SettingsService } from './settings.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AreaGuard } from '../auth/area.guard';
import { RequireArea } from '../auth/require-area.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { UpdateGoalsDto, UpdateSettingsDto } from './dto/settings.dto';

/** Ajustes globales: metas de negocio, moneda, SMTP y términos de facturación. */
@Controller('settings')
@UseGuards(JwtAuthGuard, AreaGuard)
@RequireArea('sistemas', 'gerencia')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get('goals') goals() { return this.settings.goals(); }
  @Put('goals') updateGoals(@Body() body: UpdateGoalsDto, @CurrentUser() u?: AuthUser) {
    return this.settings.updateGoals(body ?? {}, u?.name ?? u?.email);
  }

  @Get() list() { return this.settings.settings(); }
  @Put() update(@Body() body: UpdateSettingsDto, @CurrentUser() u?: AuthUser) {
    return this.settings.updateSettings(body?.values ?? {}, u?.name ?? u?.email);
  }
}
