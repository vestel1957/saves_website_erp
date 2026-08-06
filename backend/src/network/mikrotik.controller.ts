import { Allow, IsBoolean, IsOptional, IsString } from 'class-validator';
import { MikrotikAdminService } from './mikrotik-admin.service';
import { APP_PERMISSIONS } from '../auth/permissions.catalog';
import { AuthUser } from '../auth/current-user.decorator';

export class RouterUpsertDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() ip?: string;
  @Allow() port?: string | number;
  @IsOptional() @IsString() tech?: string;
  @IsOptional() @IsString() branchId?: string;
  @IsOptional() @IsString() username?: string;
  @IsOptional() @IsString() password?: string;
}
export class ToggleSecretDto {
  @IsString() name!: string;
  @IsBoolean() disabled!: boolean;
}
export class KickDto {
  @IsString() name!: string;
}

/**
 * Gestión de routers MikroTik — clon de `Mikrotiks.php` (conectar y configurar).
 * Espejo de OltController: CRUD + validación + lecturas/escrituras en vivo (dry-run).
 */
export class MikrotikController {
  constructor(private readonly mk: MikrotikAdminService) {}

  // --- Modo / opciones ---
  mode() { return this.mk.mode(); }
  branches() { return this.mk.branches(); }

  // --- CRUD de routers ---
  routers() { return this.mk.listRouters(); }
  create(dto: RouterUpsertDto, user: AuthUser) { return this.mk.createRouter(dto, user); }
  update(id: string, dto: RouterUpsertDto, user: AuthUser) { return this.mk.updateRouter(id, dto, user); }
  remove(id: string, user: AuthUser) { return this.mk.deleteRouter(id, user); }
  setDefault(id: string, user: AuthUser) { return this.mk.setDefault(id, user); }

  // --- Validación / lecturas en vivo ---
  test(id: string, user: AuthUser) { return this.mk.testRouter(id, user); }
  system(id: string) { return this.mk.systemInfo(id); }
  summary(id: string) { return this.mk.summary(id); }
  secrets(id: string, search?: string, page?: string, pageSize?: string, sortBy?: string, sortDir?: string) {
    return this.mk.secrets(id, { search, page: Number(page), pageSize: Number(pageSize), sortBy, sortDir });
  }
  active(id: string) { return this.mk.active(id); }
  ips(id: string) { return this.mk.ips(id); }
  profiles(id: string) { return this.mk.profiles(id); }
  history(id: string, limit?: string) { return this.mk.history(id, Number(limit) || 100); }

  // --- Escrituras (GATE dry-run) ---
  toggleSecret(id: string, dto: ToggleSecretDto, user: AuthUser) {
    return this.mk.toggleSecret(id, dto.name, dto.disabled, user);
  }
  kick(id: string, dto: KickDto, user: AuthUser) {
    return this.mk.kickActive(id, dto.name, user);
  }
}
