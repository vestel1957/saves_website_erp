import { IsBoolean, IsInt, IsOptional, IsString, Min, Max } from 'class-validator';
import { CronService } from './cron.service';
import { APP_PERMISSIONS } from '../auth/permissions.catalog';
import { AuthUser } from '../auth/current-user.decorator';

export class RunBillingDto {
  @IsOptional() @IsInt() @Min(1) @Max(2000) limit?: number;
  @IsOptional() @IsString() branchId?: string;
}

/** Corrida manual de recordatorios por WhatsApp: permite acotar cuántos y a qué estado. */
export class RunWaRemindersDto {
  @IsOptional() @IsInt() @Min(1) @Max(1000) limit?: number;
  /** ACTIVO | CORTADO | CARTERA | COMPROMISO | SUSPENDIDO. Vacío = todos los cobrables. */
  @IsOptional() @IsString() status?: string;
}

export class WaRemindersConfigDto {
  /** Interruptor de la corrida programada de las 09:00. */
  @IsOptional() @IsBoolean() enabled?: boolean;
  /** false = simulación: calcula a quién se le escribiría y no envía nada. */
  @IsOptional() @IsBoolean() live?: boolean;
  /** Tope de mensajes por corrida (la línea admite 250 clientes únicos/24 h). */
  @IsOptional() @IsInt() @Min(1) @Max(1000) cap?: number;
}

/** Automatizaciones (cronjobs) — estado, historial y disparo manual. */
export class CronController {
  constructor(private readonly cron: CronService) {}

  status() {
    return this.cron.status();
  }

  history(limit?: string) {
    return this.cron.history(limit ? Number(limit) : 50);
  }


  runBilling(dto: RunBillingDto, user: AuthUser) {
    return this.cron.runRecurringBilling({ manual: true, user, limit: dto.limit, branchId: dto.branchId });
  }


  runCartera(user: AuthUser) {
    return this.cron.runCartera({ manual: true, user });
  }


  runReminders(user: AuthUser) {
    return this.cron.runReminders({ manual: true, user });
  }

  /**
   * Recordatorios de cartera por WhatsApp. Va con el permiso del canal
   * (`system.whatsapp`) y no con el de cron: esto le escribe a clientes reales y
   * gasta cuota de la línea, así que manda quien administra la mensajería —
   * el mismo permiso que exige lanzar una campaña masiva a mano.
   */

  runWaReminders(dto: RunWaRemindersDto, user: AuthUser) {
    return this.cron.runWaReminders({ manual: true, user, limit: dto.limit, status: dto.status });
  }


  setWaReminders(dto: WaRemindersConfigDto, user: AuthUser) {
    return this.cron.setWaRemindersConfig(dto, user);
  }


  runLegacySync(user: AuthUser) {
    return this.cron.runLegacySync({ manual: true, user });
  }


  runLegacyWriteback(user: AuthUser) {
    return this.cron.runLegacyWriteback({ manual: true, user });
  }

  /**
   * Cuadra la caja de este sistema contra la del legacy y reporta los pagos que allá
   * se borraron. Disparo manual del mismo trabajo que corre a diario a las 21:00.
   */
  runConciliacionCaja(user: AuthUser) {
    return this.cron.runConciliacionCaja({ manual: true, user });
  }

  /** Deriva entre la BD viva del legacy (MySQL) y este sistema: ¿van de la mano? */
  legacyDrift() {
    return this.cron.legacyDrift();
  }
}
