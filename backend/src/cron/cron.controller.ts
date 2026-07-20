import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { IsInt, IsOptional, IsString, Min, Max } from 'class-validator';
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
}
