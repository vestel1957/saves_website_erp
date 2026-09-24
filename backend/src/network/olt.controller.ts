import { Allow, IsBoolean, IsOptional, IsString } from 'class-validator';
import { OltService } from './olt.service';
import { OltPlanProfileService } from './olt-plan-profile.service';
import { VlanEquiposService } from './vlan-equipos.service';
import { APP_PERMISSIONS } from '../auth/permissions.catalog';
import { AuthUser } from '../auth/current-user.decorator';

// Campos numéricos que llegan como número o string desde el front → @Allow()
// para que el ValidationPipe (whitelist) no los descarte; el service los castea.
export class OnusQueryDto {
  @Allow() frame?: number | string;
  @Allow() slot!: number | string;
  @Allow() port!: number | string;
}
export class SlotDto {
  @Allow() frame?: number | string;
  @Allow() slot!: number | string;
  /** Salta la caché del resumen de slot (recorre los 16 puertos de verdad). */
  @Allow() refresh?: boolean;
}
export class ProvisionDto {
  @Allow() frame?: number | string;
  @Allow() slot!: number | string;
  @Allow() port!: number | string;
  @Allow() ont_id?: number | string;
  @IsString() sn!: string;
  @Allow() lineprofile!: number | string;
  @Allow() srvprofile!: number | string;
  @IsOptional() @IsString() desc?: string;
  @Allow() vlan?: number | string;
  @Allow() gemport?: number | string;
  @Allow() user_vlan?: number | string;
  /** Índices de traffic-table: `inbound`/RX = bajada del abonado, `outbound`/TX = subida. */
  @Allow() traffic_in?: number | string;
  @Allow() traffic_out?: number | string;
}
/**
 * Adoptar una ONU que YA está autenticada en la OLT: no se vuelve a dar de alta,
 * solo se le pone comentario/velocidad y se registra en el inventario.
 */
export class AdoptarDto {
  @IsString() sn!: string;
  @IsOptional() @IsString() desc?: string;
  /** Índices de traffic-table: `inbound`/RX = bajada del abonado, `outbound`/TX = subida. */
  @Allow() traffic_in?: number | string;
  @Allow() traffic_out?: number | string;
  /** Solo se usan si la ONU está SIN service-port y hay que crearle uno. */
  @Allow() vlan?: number | string;
  @Allow() gemport?: number | string;
  @Allow() user_vlan?: number | string;
  @IsOptional() @IsString() subscriberId?: string;
}
export class OnuActionDto {
  @Allow() frame?: number | string;
  @Allow() slot!: number | string;
  @Allow() port!: number | string;
  @Allow() ont_id!: number | string;
  @IsOptional() @IsString() sn?: string;
  /** Al eliminar: quita antes los service-ports que bloquean el borrado. */
  @Allow() force?: boolean;
}
export class LinkDto {
  @IsOptional() @IsString() subscriberId?: string | null;
}
export class OnuDescDto {
  @Allow() frame?: number | string;
  @Allow() slot!: number | string;
  @Allow() port!: number | string;
  @Allow() ont_id!: number | string;
  @IsOptional() @IsString() sn?: string;
  @IsOptional() @IsString() desc?: string;
}
export class CatvStateDto {
  @IsString() sn!: string;
}
export class CatvSetDto {
  @IsString() sn!: string;
  @Allow() catvPort?: number | string;
  @Allow() enable!: boolean;
}
/** Velocidad (y overrides) que le corresponde a un plan en una OLT. */
export class PlanOltProfileDto {
  @IsString() planId!: string;
  /** null/vacío = default para TODAS las OLTs; concreto = override de esa OLT. */
  @IsOptional() @IsString() oltId?: string | null;
  @Allow() trafficIn?: number | string | null;
  @Allow() trafficOut?: number | string | null;
  @Allow() lineprofile?: number | string | null;
  @Allow() srvprofile?: number | string | null;
  @Allow() vlan?: number | string | null;
  @Allow() gemport?: number | string | null;
  @Allow() userVlan?: number | string | null;
}
/** Varias velocidades de golpe: lo que se confirma tras deducir de la planta. */
export class PlanOltProfileLoteDto {
  @IsOptional() @IsString() oltId?: string | null;
  @Allow() filas!: { planId: string; trafficIn?: number | null; trafficOut?: number | null }[];
}
export class OltUpsertDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() brand?: string;
  @IsOptional() @IsString() ip?: string;
  @Allow() port?: string | number;
  @IsOptional() @IsString() tech?: string;
  /** "ssh" | "telnet". Los equipos viejos solo escuchan telnet en el 23. */
  @IsOptional() @IsString() transport?: string;
  @Allow() sedeLegacy?: number | string;
  @IsOptional() @IsString() branchId?: string;
  @IsOptional() @IsString() username?: string;
  @IsOptional() @IsString() password?: string;
  @Allow() defaultLineProfile?: number | string;
  @Allow() defaultSrvProfile?: number | string;
  @Allow() defaultVlan?: number | string;
  @Allow() defaultGemport?: number | string;
  @Allow() defaultUserVlan?: number | string;
}

/** Gestión OLT — clon SmartOLT (control total de ONUs por SSH). */
/** Configurar una VLAN del catálogo en la OLT y el Mikrotik (`VlanEquiposService`). */
export class ConfigurarVlanEquiposDto {
  /** Por defecto true: solo devuelve los comandos. false = ejecutarlos. */
  @IsOptional() @IsBoolean() dryRun?: boolean;
  /** F/S/P del uplink, solo cuando la OLT usa varios y hay que elegir. */
  @IsOptional() @IsString() uplink?: string;
}

export class OltController {
  constructor(
    private readonly olt: OltService,
    private readonly planProfiles: OltPlanProfileService,
    private readonly vlanEquipos: VlanEquiposService,
  ) {}

  // --- Velocidad por plan (PlanOltProfile) ---
  // Va ANTES de las rutas `:id/...` por claridad: es configuración del catálogo,
  // no una operación contra un equipo concreto.
  /** Tablero de mapeo plan → traffic-tables, con candidatas sugeridas por las megas del nombre. */
  planProfilesList(oltId?: string) {
    return this.planProfiles.tablero(oltId || null);
  }
  planProfileSave(dto: PlanOltProfileDto) {
    return this.planProfiles.guardar(dto as any);
  }
  planProfileDelete(planId: string, oltId?: string) {
    return this.planProfiles.borrar(planId, oltId || null);
  }
  /**
   * Deduce el mapeo mirando con qué velocidad están funcionando ya los abonados
   * de cada plan. Es una lectura larga (un comando por puerto PON con abonados).
   */
  planProfilesDeducir(oltId: string) {
    return this.planProfiles.deducirDePlanta(oltId);
  }
  /** Guarda de una vez las propuestas que el operador confirmó. */
  planProfilesLote(dto: PlanOltProfileLoteDto) {
    return this.planProfiles.guardarLote(dto.oltId || null, dto.filas ?? []);
  }

  // --- Modo / inventario / dashboard (lectura BD) ---
  mode() { return this.olt.mode(); }
  dashboard() { return this.olt.dashboard(); }
  inventory(
    search?: string, oltId?: string,
    estado?: string, senal?: string, cliente?: string,
    page?: string, pageSize?: string,
    sortBy?: string, sortDir?: string,
  ) {
    return this.olt.inventory({ search, oltId, estado, senal, cliente, page: Number(page), pageSize: Number(pageSize), sortBy, sortDir });
  }
  /** Historial de acciones (autenticaciones, borrados…): solo administración y superadmin. */
  history(oltId?: string, limit?: string) {
    return this.olt.history(oltId, Number(limit) || 100);
  }
  subscribers(q: string) { return this.olt.searchSubscribers(q); }
  /**
   * Señal óptica de la ONU del abonado: el bloque "Señal óptica" de la ficha del
   * cliente. `refresh=1` salta la caché de 60 s (botón Refrescar).
   */
  opticaAbonado(subscriberId: string, refresh?: string) {
    return this.olt.opticaDeAbonado(subscriberId, refresh === '1');
  }
  link(onuId: string, dto: LinkDto, user: AuthUser) {
    return this.olt.linkCustomer(onuId, dto.subscriberId ?? null, user);
  }

  // --- CRUD de OLTs ---
  olts() { return this.olt.listOlts(); }
  create(dto: OltUpsertDto, user: AuthUser) { return this.olt.createOlt(dto, user); }
  update(id: string, dto: OltUpsertDto, user: AuthUser) { return this.olt.updateOlt(id, dto, user); }
  remove(id: string, user: AuthUser) { return this.olt.deleteOlt(id, user); }
  setDefault(id: string) { return this.olt.setDefault(id); }

  // --- Lecturas en vivo (SSH) ---
  // `refresh=1` salta la caché (10 min) de las lecturas que casi no cambian.
  test(id: string, user: AuthUser) { return this.olt.testConnection(id, user); }
  system(id: string, refresh?: string) { return this.olt.systemInfo(id, refresh === '1'); }
  boards(id: string, frame?: string, refresh?: string) { return this.olt.boards(id, Number(frame) || 0, refresh === '1'); }
  /** Tarjetas, puertos y VLAN en uso de la OLT de una sede, para el catálogo de VLANs. */
  mapaVlans(branchId?: string, refresh?: string) { return this.olt.mapaVlansDeSede(String(branchId ?? ''), refresh === '1'); }
  /** Cada VLAN de la sede en catálogo / OLT / uplink / Mikrotik, con veredicto y qué falta. Solo lectura. */
  // `refresh=1` relee todo (también el mapa, ~20 s); `refresh=vlans` solo las VLANs y los Mikrotik.
  saludVlans(branchId?: string, refresh?: string) {
    return this.vlanEquipos.salud(String(branchId ?? ''), refresh === '1' ? true : refresh === 'vlans' ? 'vlans' : false);
  }
  /** Número de VLAN sugerido para un PON sin VLAN, según el patrón de su tarjeta. */
  sugerirVlan(oltId?: string, slot?: string, port?: string) {
    return this.vlanEquipos.sugerir(String(oltId ?? ''), 0, Number(slot), Number(port));
  }
  /** Deja la VLAN en la OLT (creada + uplink) y el Mikrotik (interfaz + PPPoE). dryRun por defecto. */
  configurarVlanEquipos(id: string, dto: ConfigurarVlanEquiposDto, user: AuthUser) {
    return this.vlanEquipos.configurarEquipos(id, { dryRun: dto.dryRun, uplink: dto.uplink ?? null }, user);
  }
  autofind(id: string) { return this.olt.autofind(id); }
  profiles(id: string, refresh?: string) { return this.olt.profiles(id, refresh === '1'); }
  trafficTables(id: string, refresh?: string) { return this.olt.trafficTables(id, refresh === '1'); }
  sugerencia(
    id: string,
    frame?: string,
    slot?: string,
    port?: string,
    model?: string,
  ) {
    return this.olt.sugerencia(id, Number(frame) || 0, Number(slot), Number(port), model);
  }
  onus(id: string, dto: OnusQueryDto) {
    return this.olt.onus(id, Number(dto.frame) || 0, Number(dto.slot), Number(dto.port));
  }
  slotSummary(id: string, dto: SlotDto) {
    return this.olt.slotSummary(id, Number(dto.frame) || 0, Number(dto.slot), dto.refresh === true);
  }
  detail(id: string, dto: OnuActionDto) {
    return this.olt.ontDetail(id, Number(dto.frame) || 0, Number(dto.slot), Number(dto.port), Number(dto.ont_id));
  }
  /** Señal óptica en vivo; el front la pide en segundo plano tras el detalle. */
  optical(id: string, dto: OnuActionDto) {
    return this.olt.ontOptical(id, Number(dto.frame) || 0, Number(dto.slot), Number(dto.port), Number(dto.ont_id));
  }
  find(id: string, sn: string) { return this.olt.findBySn(id, sn); }
  /** Estado del puerto CATV (RF) de una ONT por SN — palanca de TV de las ONTs sin TR-069. */
  catvState(id: string, dto: CatvStateDto) {
    return this.olt.catvState(id, dto.sn);
  }

  // --- Escrituras (GATE dry-run) ---
  provision(id: string, dto: ProvisionDto, user: AuthUser) {
    return this.olt.provision(id, dto, user);
  }
  /** Adopta una ONU ya autenticada (la que rechaza el alta con "SN already exists"). */
  adoptar(id: string, dto: AdoptarDto, user: AuthUser) {
    return this.olt.adoptar(id, dto, user);
  }
  setDesc(id: string, dto: OnuDescDto, user: AuthUser) {
    return this.olt.setDescription(id, dto, user);
  }
  /** Corta/activa la salida CATV de una ONT por OMCI (ONTs combo sin TR-069). */
  setCatv(id: string, dto: CatvSetDto, user: AuthUser) {
    return this.olt.setCatv(id, { sn: dto.sn, catvPort: dto.catvPort, enable: dto.enable === true }, user);
  }
  /** Auto-vincula ONUs↔abonados por la descripción sincronizada de la OLT. */
  autoLink(oltId: string | undefined, user: AuthUser) {
    return this.olt.autoLinkOnus(oltId || undefined, user);
  }
  reboot(id: string, dto: OnuActionDto, user: AuthUser) {
    return this.olt.reboot(id, dto, user);
  }
  deleteOnu(id: string, dto: OnuActionDto, user: AuthUser) {
    return this.olt.remove(id, dto, user);
  }

  // --- Inventario: sincronizar un slot ---
  sync(id: string, dto: SlotDto, user: AuthUser) {
    return this.olt.syncSlot(id, Number(dto.frame) || 0, Number(dto.slot), user);
  }
}
