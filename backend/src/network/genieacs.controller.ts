import { ArrayNotEmpty, Allow, IsArray, IsOptional, IsString } from 'class-validator';
import { GenieacsService } from './genieacs.service';
import { APP_PERMISSIONS } from '../auth/permissions.catalog';
import { AuthUser } from '../auth/current-user.decorator';

export class ServerUpsertDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() nbiUrl?: string;
  @IsOptional() @IsString() username?: string;
  @IsOptional() @IsString() password?: string;
  @Allow() sedeLegacy?: number | string;
}
export class BatchDto {
  @IsArray() @ArrayNotEmpty() @IsString({ each: true }) ids!: string[];
  @IsOptional() @IsString() serverId?: string;
}
/**
 * Cambio del WiFi de un abonado. La clave llega en claro por HTTPS y NO se guarda
 * en ningún sitio: se le pasa al equipo y se olvida (ni en la auditoría ni en el log).
 */
export class WifiDto {
  @IsString() subscriberId!: string;
  @IsOptional() @IsString() ssid?: string;
  @IsOptional() @IsString() password?: string;
}
export class RefreshDto {
  @IsString() deviceId!: string;
  @IsOptional() @IsString() objectName?: string;
  @IsOptional() @IsString() serverId?: string;
}

/** Integración GenieACS / TR-069 — cortes masivos de TV vía NBI (tag + provision). */
export class GenieacsController {
  constructor(private readonly acs: GenieacsService) {}

  // --- Modo / lecturas ---
  mode() { return this.acs.mode(); }
  dashboard(serverId?: string) { return this.acs.dashboard(serverId); }
  inventory(
    serverId?: string, search?: string,
    model?: string, manufacturer?: string,
    estado?: string,
    sortBy?: string, sortDir?: string,
    page?: string, pageSize?: string,
  ) {
    return this.acs.inventory({
      serverId, search, model, manufacturer, estado, sortBy, sortDir,
      page: Number(page), pageSize: Number(pageSize),
    });
  }
  history(serverId?: string, limit?: string) {
    return this.acs.history(serverId, Number(limit) || 100);
  }

  // --- CRUD de servidores ---
  servers() { return this.acs.listServers(); }
  create(dto: ServerUpsertDto, user: AuthUser) { return this.acs.createServer(dto, user); }
  update(id: string, dto: ServerUpsertDto, user: AuthUser) { return this.acs.updateServer(id, dto, user); }
  remove(id: string, user: AuthUser) { return this.acs.deleteServer(id, user); }
  setDefault(id: string) { return this.acs.setDefault(id); }
  test(id: string, user: AuthUser) { return this.acs.testConnection(id, user); }

  // --- Escrituras (GATE dry-run) ---
  cutTv(dto: BatchDto, user: AuthUser) { return this.acs.cutTv(dto.ids, user, dto.serverId); }
  restoreTv(dto: BatchDto, user: AuthUser) { return this.acs.restoreTv(dto.ids, user, dto.serverId); }
  refresh(dto: RefreshDto, user: AuthUser) { return this.acs.refresh(dto.deviceId, dto.objectName ?? '', dto.serverId, user); }
  setWifi(dto: WifiDto, user: AuthUser) {
    return this.acs.setWifiBySubscriber(dto.subscriberId, { ssid: dto.ssid, clave: dto.password }, user);
  }
  install(serverId?: string, user?: AuthUser) { return this.acs.installProvision(serverId, user); }

  // --- Corte de TV masivo POR ABONADO (resuelve TR-069 u OLT por cada uno) ---
  tvCutSubs(dto: BatchDto, user: AuthUser) {
    return this.acs.tvBatchBySubscribers(dto.ids, false, user);
  }
  tvRestoreSubs(dto: BatchDto, user: AuthUser) {
    return this.acs.tvBatchBySubscribers(dto.ids, true, user);
  }
}
