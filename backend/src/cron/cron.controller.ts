import { Body, Controller, Get, Post, Put, Query, UseGuards } from '@nestjs/common';
import { IsBoolean, IsInt, IsOptional, IsString, Min, Max } from 'class-validator';
import { CronService } from './cron.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AreaGuard } from '../auth/area.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequireArea } from '../auth/require-area.decorator';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { APP_PERMISSIONS } from '../auth/permissions.catalog';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';

class RunBillingDto {
  @IsOptional() @IsInt() @Min(1) @Max(2000) limit?: number;
  @IsOptional() @IsString() branchId?: string;
}

/** Corrida manual de recordatorios por WhatsApp: permite acotar cuántos y a qué estado. */
class RunWaRemindersDto {
  @IsOptional() @IsInt() @Min(1) @Max(1000) limit?: number;
  /** ACTIVO | CORTADO | CARTERA | COMPROMISO | SUSPENDIDO. Vacío = todos los cobrables. */
  @IsOptional() @IsString() status?: string;
}

class WaRemindersConfigDto {
  /** Interruptor de la corrida programada de las 09:00. */
  @IsOptional() @IsBoolean() enabled?: boolean;
  /** false = simulación: calcula a quién se le escribiría y no envía nada. */
  @IsOptional() @IsBoolean() live?: boolean;
  /** Tope de mensajes por corrida (la línea admite 250 clientes únicos/24 h). */
  @IsOptional() @IsInt() @Min(1) @Max(1000) cap?: number;
}

/** Automatizaciones (cronjobs) — estado, historial y disparo manual. */
@Controller('cron')
@UseGuards(JwtAuthGuard, AreaGuard, PermissionsGuard)
@RequireArea('contabilidad', 'sistemas')
export class CronController {
  constructor(private readonly cron: CronService) {}

  @Get('status') status() {
    return this.cron.status();
  }

  @Get('history') history(@Query('limit') limit?: string) {
    return this.cron.history(limit ? Number(limit) : 50);
  }

  @RequirePermissions(APP_PERMISSIONS.CRON_RUN)

  @Post('run/recurring-billing') runBilling(@Body() dto: RunBillingDto, @CurrentUser() user: AuthUser) {
    return this.cron.runRecurringBilling({ manual: true, user, limit: dto.limit, branchId: dto.branchId });
  }

  @RequirePermissions(APP_PERMISSIONS.CRON_RUN)

  @Post('run/cartera') runCartera(@CurrentUser() user: AuthUser) {
    return this.cron.runCartera({ manual: true, user });
  }

  @RequirePermissions(APP_PERMISSIONS.CRON_RUN)

  @Post('run/reminders') runReminders(@CurrentUser() user: AuthUser) {
    return this.cron.runReminders({ manual: true, user });
  }

  /**
   * Recordatorios de cartera por WhatsApp. Va con el permiso del canal
   * (`system.whatsapp`) y no con el de cron: esto le escribe a clientes reales y
   * gasta cuota de la línea, así que manda quien administra la mensajería —
   * el mismo permiso que exige lanzar una campaña masiva a mano.
   */
  @RequirePermissions(APP_PERMISSIONS.WHATSAPP_MANAGE)

  @Post('run/wa-reminders') runWaReminders(@Body() dto: RunWaRemindersDto, @CurrentUser() user: AuthUser) {
    return this.cron.runWaReminders({ manual: true, user, limit: dto.limit, status: dto.status });
  }

  @RequirePermissions(APP_PERMISSIONS.WHATSAPP_MANAGE)

  @Put('wa-reminders/config') setWaReminders(@Body() dto: WaRemindersConfigDto, @CurrentUser() user: AuthUser) {
    return this.cron.setWaRemindersConfig(dto, user);
  }

  @RequirePermissions(APP_PERMISSIONS.CRON_RUN)

  @Post('run/legacy-sync') runLegacySync(@CurrentUser() user: AuthUser) {
    return this.cron.runLegacySync({ manual: true, user });
  }

  @RequirePermissions(APP_PERMISSIONS.CRON_RUN)

  @Post('run/legacy-writeback') runLegacyWriteback(@CurrentUser() user: AuthUser) {
    return this.cron.runLegacyWriteback({ manual: true, user });
  }

  /** Deriva entre la BD viva del legacy (MySQL) y este sistema: ¿van de la mano? */
  @Get('legacy/drift') legacyDrift() {
    return this.cron.legacyDrift();
  }
}
