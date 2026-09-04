import { BadRequestException, NotFoundException } from '../core/http/errores';
import { Logger } from '../core/logger';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/current-user.decorator';
import { GenieacsNbi, NbiDevice, NbiError, nbiHttpMessage } from './genieacs/genieacs-nbi.client';
import { elegirRedes, planWifi, validarClave, validarSsid } from './genieacs/wifi-targets';
import { OltService } from './olt.service';
import { encryptSecret, decryptSecret, isEncrypted } from '../common/secret-box';

/**
 * GenieacsService — integración con GenieACS (ACS TR-069) vía su NBI (API REST).
 *
 * Uso: cortes/altas MASIVAS de servicio de TV sobre los CPEs de fibra, por el
 * mecanismo tag + provision (se etiqueta el CPE como "tv-suspendida" y un provision
 * del ACS aplica el parámetro; el connection_request lo hace inmediato).
 *
 * ⚠️ SEGURIDAD: por defecto DRY-RUN. Las escrituras (corte/alta de TV, instalar el
 * provision) devuelven el PLAN sin tocar el ACS. Para operar de verdad: GENIEACS_LIVE=true
 * (o el interruptor `network.genieacsLive` en Configuración). Cada acción queda auditada.
 *
 * PENDIENTE DE SEGURIDAD DEL SERVIDOR: hoy el NBI está expuesto SIN autenticación; cerrar
 * eso (bind localhost + túnel, o basic-auth) antes de activar LIVE.
 *
 * Palanca de TV confirmada en vivo (Huawei EG8143A5): X_CATVConfiguration.Enable (escribible).
 * Otras marcas se calibran igual (refreshObject del subárbol y se ajusta TV_PARAM_BY_MODEL).
 */

export type GenieacsAction =
  | 'TEST' | 'LIST' | 'TAG_CUT' | 'TAG_RESTORE' | 'REFRESH'
  | 'SET_PARAM' | 'INSTALL_PROVISION' | 'LINK' | 'DELETE';

/** Subárbol TR-069 donde viven las redes WiFi (nombre y clave) en todo el parque. */
export const WLAN_PATH = 'InternetGatewayDevice.LANDevice.1.WLANConfiguration';

/**
 * En qué puede terminar un cambio de WiFi. Se devuelve el motivo y no un booleano
 * porque de eso depende lo que se le dice al cliente y si hay que abrir orden:
 * «su equipo está apagado» y «su equipo no se puede configurar a distancia» son
 * cosas distintas para quien está esperando en el chat.
 */
export type WifiResultado =
  | 'APLICADO'          // el CPE ejecutó el cambio
  | 'SIN_EQUIPO'        // no está en el ACS (o no se pudo identificar sin ambigüedad)
  | 'EQUIPO_OFFLINE'    // está en el ACS pero no contestó
  | 'RECHAZADO'         // contestó, pero no deja tocar el WiFi
  | 'DRY_RUN'           // el gate de red está en simulación
  | 'DATOS_INVALIDOS';  // la clave o el nombre no cumplen lo que exige WPA

export interface WifiCambioResultado {
  ok: boolean;
  resultado: WifiResultado;
  detalle: string;
  deviceId?: string;
  /** Qué se le hizo a cada red, sin la clave. */
  redes?: string[];
}

/** Tag que marca "TV suspendida" y parámetro TR-069 que corta la salida de TV (RF/CATV). */
export const TV_TAG = 'tv-suspendida';
export const TV_PARAM = 'InternetGatewayDevice.X_CATVConfiguration.Enable';

/** Provision del ACS: aplica/retira el corte de TV según el tag, en cada inform. */
export const TV_PROVISION_NAME = 'tv-suspension';
export const TV_PROVISION_SCRIPT = `// tv-suspension — gestionado por saves. Aplica/retira el corte de TV (RF/CATV)
// segun el tag "${TV_TAG}". Corre en cada inform de los CPEs que exponen ${TV_PARAM}.
const now = Date.now();
const tag = declare("Tags.${TV_TAG}", {value: now});
const suspended = !!(tag.value && tag.value[0]);
declare("${TV_PARAM}", {value: now}, {value: !suspended});
`;
export const TV_PRESET_NAME = 'tv-suspension';
/**
 * Precondición POR TAG, no por parámetro. ⚠️ NUNCA usar `$exists` aquí: esta
 * versión de GenieACS no lo soporta y la excepción tumba el worker CWMP en cada
 * inform → crash-loop → ACS caído para TODO el parque (pasó el 2026-07-23,
 * ~17 min sin informs). Con el tag, el provision corre sólo en los CPEs
 * suspendidos y jamás toca (ni enciende) la TV de los demás.
 */
export const TV_PRESET = {
  weight: 0,
  precondition: JSON.stringify({ _tags: TV_TAG }),
  configurations: [{ type: 'provision', name: TV_PROVISION_NAME, args: [] as any[] }],
};

interface AuditMeta {
  deviceId?: string | null;
  subscriberId?: string | null;
  count?: number | null;
  user?: AuthUser;
}

const ACTIVE_DAYS = 1;    // "vivo" = informó en el último día
const STALE_DAYS = 180;   // "muerto" = >180 días sin informar

/** Fila del inventario tal como la consume el front (`/network/genieacs/inventory`). */
export interface CpeRow {
  id: string;
  manufacturer: string | null;
  model: string | null;
  serial: string | null;
  pppUser: string | null;
  wanIp: string | null;
  lastInform: string | null;
  daysSince: number | null;
  alive: boolean;
  tvSuspended: boolean;
  tags: string[];
  /** ONUs que NO hablan TR-069 (no existen en el ACS): vienen del inventario de
   *  la OLT y su corte de TV va por OMCI. El front las enruta al modal de OLT. */
  source?: 'olt';
  oltId?: string;
  oltName?: string;
  fsp?: string;
  runState?: string | null;
}

export class GenieacsService {
  private readonly logger = new Logger(GenieacsService.name);
  private live = process.env.GENIEACS_LIVE === 'true';
  private liveCheckedAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly olt: OltService,
  ) {}

  get isLive(): boolean {
    return this.live;
  }

  /** Sincroniza el modo real desde el ajuste `network.genieacsLive` (cache 15s). GENIEACS_LIVE=true lo fuerza. */
  private async syncLive(): Promise<void> {
    const now = Date.now();
    if (now - this.liveCheckedAt < 15000) return;
    this.liveCheckedAt = now;
    const row = await this.prisma.appSetting.findUnique({ where: { key: 'network.genieacsLive' } });
    this.live = row?.value === 'true' || row?.value === 'false'
      ? row.value === 'true'
      : process.env.GENIEACS_LIVE === 'true';
  }

  async mode() {
    await this.syncLive();
    return { live: this.live, mode: this.live ? 'LIVE' : 'DRY_RUN', tvTag: TV_TAG, tvParam: TV_PARAM };
  }

  // ------------------------------------------------------------------ //
  //  Resolución + auditoría                                            //
  // ------------------------------------------------------------------ //

  private async resolveServer(id?: string) {
    if (id) {
      const s = await this.prisma.genieacsServer.findUnique({ where: { id } });
      if (!s) throw new NotFoundException('Servidor GenieACS no encontrado.');
      return s;
    }
    const s = (await this.prisma.genieacsServer.findFirst({ where: { isDefault: true } }))
      ?? (await this.prisma.genieacsServer.findFirst({ orderBy: { createdAt: 'asc' } }));
    if (!s) throw new BadRequestException('No hay ningún servidor GenieACS configurado.');
    return s;
  }

  private nbi(s: { nbiUrl: string; username: string; password: string }) {
    // La clave se guarda cifrada (secret-box); las filas legacy en texto plano
    // pasan intactas por decryptSecret. Se descifra sólo aquí, al construir el cliente.
    return new GenieacsNbi(s.nbiUrl, s.username, decryptSecret(s.password));
  }

  /** Lista dispositivos traduciendo un rechazo de auth del NBI en un error accionable. */
  private async devicesOf(s: { nbiUrl: string; username: string; password: string }): Promise<NbiDevice[]> {
    try {
      return await this.nbi(s).listDevices(null);
    } catch (e) {
      if (e instanceof NbiError) throw new BadRequestException(nbiHttpMessage(e.status));
      throw e;
    }
  }

  private async audit(action: GenieacsAction, server: { id: string; name: string } | null, ok: boolean, dryRun: boolean, detail: string, meta: AuditMeta = {}) {
    try {
      await this.prisma.genieacsActionLog.create({
        data: {
          serverId: server?.id ?? null,
          serverName: server?.name ?? null,
          action, ok, dryRun,
          detail: detail.slice(0, 1900),
          deviceId: meta.deviceId ?? null,
          subscriberId: meta.subscriberId ?? null,
          count: meta.count ?? null,
          userId: meta.user?.id ?? null,
          userName: meta.user?.name ?? null,
        },
      });
    } catch (e) {
      this.logger.warn(`No se pudo auditar acción GenieACS: ${(e as Error).message}`);
    }
  }

  // ------------------------------------------------------------------ //
  //  CRUD de servidores                                                //
  // ------------------------------------------------------------------ //

  async listServers() {
    const rows = await this.prisma.genieacsServer.findMany({ orderBy: [{ sedeLegacy: 'asc' }, { name: 'asc' }] });
    return rows.map((s) => ({
      id: s.id, name: s.name, nbiUrl: s.nbiUrl, username: s.username,
      sedeLegacy: s.sedeLegacy, isDefault: s.isDefault, online: s.online,
      // ¿tiene basic-auth configurado? (usuario + clave). No exponemos la clave.
      hasAuth: !!(s.username && s.password),
      // ¿la clave ya quedó cifrada en reposo, o es una fila legacy en texto plano?
      secretEncrypted: isEncrypted(s.password),
    }));
  }

  async createServer(dto: any, user?: AuthUser) {
    if (!dto.name || !dto.nbiUrl) throw new BadRequestException('Nombre y URL del NBI son obligatorios.');
    const sedeLegacy = Number(dto.sedeLegacy) || 0;
    const already = await this.prisma.genieacsServer.count();
    const s = await this.prisma.genieacsServer.create({
      data: {
        name: dto.name, nbiUrl: String(dto.nbiUrl).trim(),
        username: dto.username || '', password: encryptSecret(dto.password || ''),
        sedeLegacy, isDefault: already === 0,
      },
    });
    await this.audit('LINK', s, true, false, `Crear servidor GenieACS ${s.name}`, { user });
    return { ok: true, id: s.id };
  }

  async updateServer(id: string, dto: any, user?: AuthUser) {
    const s = await this.resolveServer(id);
    const data: Prisma.GenieacsServerUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.nbiUrl !== undefined) data.nbiUrl = String(dto.nbiUrl).trim();
    if (dto.username !== undefined) data.username = dto.username;
    if (dto.password && !/^\*+$/.test(dto.password)) data.password = encryptSecret(dto.password);
    if (dto.sedeLegacy !== undefined) data.sedeLegacy = Number(dto.sedeLegacy) || 0;
    await this.prisma.genieacsServer.update({ where: { id }, data });
    await this.audit('LINK', s, true, false, `Actualizar servidor GenieACS ${s.name}`, { user });
    return { ok: true };
  }

  async deleteServer(id: string, user?: AuthUser) {
    const s = await this.resolveServer(id);
    await this.prisma.genieacsServer.delete({ where: { id } });
    await this.audit('DELETE', s, true, false, `Eliminar servidor GenieACS ${s.name}`, { user });
    return { ok: true };
  }

  async setDefault(id: string) {
    const s = await this.resolveServer(id);
    await this.prisma.genieacsServer.updateMany({ data: { isDefault: false } });
    await this.prisma.genieacsServer.update({ where: { id }, data: { isDefault: true } });
    return { ok: true, name: s.name };
  }

  async testConnection(id: string, user?: AuthUser) {
    const s = await this.resolveServer(id);
    const auth = s.username ? `basic-auth como "${s.username}"` : 'SIN auth';
    this.logger.log(`TEST NBI "${s.name}" → ${s.nbiUrl} (${auth})${user?.name ? ` — pedido por ${user.name}` : ''}`);
    const r = await this.nbi(s).ping();
    this.logger.log(`TEST NBI "${s.name}" resultado: ${r.ok ? 'OK (200)' : 'FALLÓ — ' + r.error}`);
    await this.prisma.genieacsServer.update({ where: { id }, data: { online: r.ok } });
    await this.audit('TEST', s, r.ok, false, r.ok ? 'NBI OK' : `ERROR: ${r.error}`, { user });
    return r;
  }

  // ------------------------------------------------------------------ //
  //  Lecturas en vivo (NBI) — siempre en vivo, sin gate                //
  // ------------------------------------------------------------------ //

  private daysSince(iso: string | null): number | null {
    if (!iso) return null;
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return null;
    return Math.floor((Date.now() - t) / 86400000);
  }

  /** KPIs del parque: total, vivos, muertos, por marca/modelo. */
  async dashboard(serverId?: string) {
    const s = await this.resolveServer(serverId);
    const devices = await this.devicesOf(s);
    let active = 0, stale = 0, mid = 0, suspended = 0;
    const byManufacturer: Record<string, number> = {};
    const byModel: Record<string, number> = {};
    for (const d of devices) {
      const days = this.daysSince(d.lastInform);
      if (days === null) stale++;
      else if (days <= ACTIVE_DAYS) active++;
      else if (days > STALE_DAYS) stale++;
      else mid++;
      if (d.tags.includes(TV_TAG)) suspended++;
      byManufacturer[d.manufacturer || '?'] = (byManufacturer[d.manufacturer || '?'] || 0) + 1;
      byModel[d.productClass || '?'] = (byModel[d.productClass || '?'] || 0) + 1;
    }
    const top = (o: Record<string, number>) =>
      Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => ({ name: k, count: v }));
    return {
      total: devices.length, active, mid, stale, suspended,
      byManufacturer: top(byManufacturer), byModel: top(byModel),
    };
  }

  /** Inventario de CPEs con filtros (búsqueda/marca/modelo/actividad/suspendidos), orden y paginación. */
  async inventory(params: {
    serverId?: string; search?: string; model?: string; manufacturer?: string; estado?: string;
    sortBy?: string; sortDir?: string; page?: number; pageSize?: number;
  }) {
    const s = await this.resolveServer(params.serverId);
    const all = await this.devicesOf(s);
    const search = (params.search || '').trim().toLowerCase();
    let items = all;
    if (params.model) items = items.filter((d) => (d.productClass || '?') === params.model);
    if (params.manufacturer) items = items.filter((d) => (d.manufacturer || '?') === params.manufacturer);
    if (params.estado === 'vivos') items = items.filter((d) => { const x = this.daysSince(d.lastInform); return x !== null && x <= ACTIVE_DAYS; });
    if (params.estado === 'recientes') items = items.filter((d) => { const x = this.daysSince(d.lastInform); return x !== null && x > ACTIVE_DAYS && x <= STALE_DAYS; });
    if (params.estado === 'muertos') items = items.filter((d) => { const x = this.daysSince(d.lastInform); return x === null || x > STALE_DAYS; });
    if (params.estado === 'suspendidos') items = items.filter((d) => d.tags.includes(TV_TAG));
    if (params.estado === 'activos') items = items.filter((d) => !d.tags.includes(TV_TAG));
    if (search) {
      items = items.filter((d) =>
        [d.pppUser, d.serial, d.productClass, d.manufacturer, d.wanIp, d.id]
          .some((v) => (v || '').toLowerCase().includes(search)));
    }
    const total = items.length;
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(params.pageSize) || 50));
    const rows = items.map((d) => this.toRow(d));
    rows.sort(this.rowComparator(params.sortBy, params.sortDir));

    // Al buscar, sumar las ONUs del inventario de la OLT que NO están en el ACS
    // (gestión OMCI, sin TR-069): de otro modo son invisibles aquí y su TV sí se
    // corta (por la OLT). Van al frente de la página 1 — son hits de la búsqueda.
    const oltExtras = search ? await this.oltOnuMatches(search, all) : [];
    return {
      items: page === 1 ? [...oltExtras, ...rows.slice(0, pageSize)] : rows.slice((page - 1) * pageSize, page * pageSize),
      total: total + oltExtras.length, page, pageSize, pages: Math.ceil(total / pageSize) || (oltExtras.length ? 1 : 0),
    };
  }

  /** ONUs de la OLT que matchean la búsqueda y NO existen en el ACS (dedupe por serial). */
  private async oltOnuMatches(search: string, acsDevices: NbiDevice[]): Promise<CpeRow[]> {
    try {
      const onus = await this.prisma.oltOnu.findMany({
        where: {
          sn: { not: null },
          OR: [
            { sn: { contains: search, mode: 'insensitive' } },
            { description: { contains: search, mode: 'insensitive' } },
            { clientName: { contains: search, mode: 'insensitive' } },
          ],
        },
        include: { olt: { select: { id: true, name: true } }, subscriber: { select: { fullName: true, pppUsername: true } } },
        take: 20,
      });
      if (!onus.length) return [];
      const enAcs = new Set(acsDevices.map((d) => (d.serial || '').toUpperCase()).filter(Boolean));
      return onus
        .filter((o) => !enAcs.has((o.sn || '').toUpperCase()))
        .map((o) => ({
          id: `olt:${o.oltId}:${o.sn}`,
          manufacturer: 'Sin TR-069',
          model: 'ONU por OLT',
          serial: o.sn,
          pppUser: o.subscriber?.pppUsername ?? o.clientName ?? o.description ?? null,
          wanIp: null, lastInform: null, daysSince: null,
          alive: (o.runState || '').toLowerCase() === 'online',
          tvSuspended: false, tags: [],
          source: 'olt' as const,
          oltId: o.oltId, oltName: o.olt?.name ?? undefined,
          fsp: o.slot !== null && o.port !== null ? `${o.frame}/${o.slot}/${o.port}${o.ontId !== null ? ':' + o.ontId : ''}` : undefined,
          runState: o.runState,
        }));
    } catch (e) {
      this.logger.warn(`No se pudo consultar el inventario OLT para la búsqueda: ${(e as Error).message}`);
      return [];
    }
  }

  /** IPv4 a entero para ordenar por IP como número y no como texto ("10." < "9."). */
  private ipKey(ip: string | null): number {
    const p = (ip || '').split('.');
    if (p.length !== 4) return -1;
    return p.reduce((acc, o) => {
      const n = Number(o);
      return acc < 0 || !Number.isInteger(n) || n < 0 || n > 255 ? -1 : acc * 256 + n;
    }, 0);
  }

  /**
   * Comparador de filas para el orden del inventario. Por defecto (y ante una
   * `sortBy` desconocida) mantiene el orden histórico: último inform, el más
   * reciente primero.
   */
  private rowComparator(sortBy?: string, sortDir?: string) {
    const by = sortBy || 'lastInform';
    const dir = sortDir === 'asc' ? 1 : -1;
    const txt = (v: string | null) => (v || '').trim().toLowerCase();

    /** Clave de orden de la fila. `null` = dato desconocido. */
    const key = (r: CpeRow): string | number | null => {
      switch (by) {
        case 'pppUser': return txt(r.pppUser) || null;
        case 'model': return `${txt(r.manufacturer)} ${txt(r.model)}`.trim() || null;
        case 'serial': return txt(r.serial) || null;
        case 'wanIp': { const n = this.ipKey(r.wanIp); return n < 0 ? null : n; }
        case 'tv': return Number(r.tvSuspended);
        case 'inform':
        case 'lastInform':
        default: return r.lastInform || null;
      }
    };

    return (a: CpeRow, b: CpeRow): number => {
      const ka = key(a), kb = key(b);
      // Un CPE sin abonado / sin IP / sin inform es un dato que falta, no "el
      // menor de la lista": va al fondo en ambas direcciones, para que invertir
      // el orden no llene la primera página de guiones.
      if (ka === null || kb === null) return Number(kb !== null) - Number(ka !== null);
      if (typeof ka === 'number' && typeof kb === 'number') return dir * (ka - kb);
      return dir * String(ka).localeCompare(String(kb), 'es');
    };
  }

  private toRow(d: NbiDevice): CpeRow {
    const days = this.daysSince(d.lastInform);
    return {
      id: d.id, manufacturer: d.manufacturer, model: d.productClass, serial: d.serial,
      pppUser: d.pppUser, wanIp: d.wanIp, lastInform: d.lastInform, daysSince: days,
      alive: days !== null && days <= ACTIVE_DAYS,
      tvSuspended: d.tags.includes(TV_TAG), tags: d.tags,
    };
  }

  async history(serverId?: string, limit = 100) {
    return this.prisma.genieacsActionLog.findMany({
      where: serverId ? { serverId } : {},
      orderBy: { createdAt: 'desc' },
      take: Math.min(300, Math.max(1, limit)),
    });
  }

  // ------------------------------------------------------------------ //
  //  Escrituras (GATE dry-run)                                         //
  // ------------------------------------------------------------------ //

  /** Corte MASIVO de TV: etiqueta cada CPE y fuerza X_CATVConfiguration.Enable=false. */
  cutTv(ids: string[], user?: AuthUser, serverId?: string) {
    return this.tvBatch('TAG_CUT', ids, false, user, serverId);
  }
  /** Alta MASIVA de TV: retira el tag y fuerza X_CATVConfiguration.Enable=true. */
  restoreTv(ids: string[], user?: AuthUser, serverId?: string) {
    return this.tvBatch('TAG_RESTORE', ids, true, user, serverId);
  }

  private async tvBatch(action: 'TAG_CUT' | 'TAG_RESTORE', ids: string[], enable: boolean, user?: AuthUser, serverId?: string) {
    await this.syncLive();
    const s = await this.resolveServer(serverId);
    const list = (ids || []).filter(Boolean);
    if (!list.length) throw new BadRequestException('No se indicaron dispositivos.');
    const verb = enable ? 'ALTA' : 'CORTE';

    if (!this.live) {
      const plan = enable
        ? `quitar tag "${TV_TAG}" + ${TV_PARAM}=true`
        : `poner tag "${TV_TAG}" + ${TV_PARAM}=false`;
      await this.audit(action, s, true, true, `DRY-RUN ${verb} TV en ${list.length} CPEs: ${plan}`, { count: list.length, user });
      return {
        ok: true, dryRun: true,
        message: `DRY-RUN: no se contacta el ACS. Active GENIEACS_LIVE=true (y asegure el NBI) para ejecutar.`,
        plan: { action, tag: TV_TAG, param: TV_PARAM, value: enable, devices: list.length },
      };
    }

    const nbi = this.nbi(s);
    let done = 0, failed = 0, encoladas = 0;
    const errors: string[] = [];
    // Qué pasó con CADA CPE. Antes quien llamaba tenía que deducirlo leyendo las
    // cadenas de `errors` —topadas a 10—, así que a partir del fallo nº 11 los
    // equipos pasaban por buenos. La verdad equipo por equipo es lo que decide si
    // se cierra o no la orden de reconexión de un cliente.
    const porDispositivo: Record<string, { ok: boolean; encolada: boolean; detalle: string }> = {};
    for (const id of list) {
      try {
        const tagOk = enable ? await nbi.removeTag(id, TV_TAG) : await nbi.addTag(id, TV_TAG);
        const p = await nbi.setBool(id, TV_PARAM, enable, true);
        // 202 = el ACS ENCOLÓ la tarea porque el CPE no contestó al connection request
        // (apagado, sin fibra, fuera de línea). Para fetch eso es un `ok`, y ahí estaba
        // la mentira. En el CORTE no importa: el tag queda puesto y el provision aplica
        // el corte en el próximo inform. En el ALTA sí, y mucho: al quitar el tag el
        // provision YA NO corre sobre ese equipo (su precondición ES el tag), así que
        // lo único que puede devolver la señal es esta tarea. Mientras el CPE no vuelva
        // la TV sigue apagada, y darla por restaurada cerraba la orden de un cliente
        // que acababa de pagar y no veía nada.
        const encolada = enable && p.queued;
        if (tagOk && p.ok && !encolada) {
          done++;
          porDispositivo[id] = { ok: true, encolada: false, detalle: enable ? 'TV restaurada por TR-069.' : 'TV cortada por TR-069.' };
          continue;
        }
        failed++;
        if (encolada) encoladas++;
        porDispositivo[id] = {
          ok: false,
          encolada,
          // La tarea encolada NO se cancela (a diferencia del WiFi, ver `setWifiBySubscriber`):
          // encender la TV tarde no le hace daño a nadie, y si el equipo vuelve solo,
          // el cliente recupera la señal sin que vaya nadie.
          detalle: encolada
            ? 'El equipo del cliente no contestó (apagado, sin fibra o fuera de línea): el ACS dejó la orden encolada y la TV volverá sola en cuanto el equipo vuelva a línea.'
            : `El ACS no pudo aplicar el cambio (tag=${tagOk}, tarea=HTTP ${p.status}).`,
        };
        if (errors.length < 10) errors.push(`${id}: tag=${tagOk} task=${p.status}${encolada ? ' (encolada: equipo fuera de línea)' : ''}`);
      } catch (e) {
        failed++;
        porDispositivo[id] = { ok: false, encolada: false, detalle: (e as Error).message };
        if (errors.length < 10) errors.push(`${id}: ${(e as Error).message}`);
      }
    }
    const resumen = `${verb} TV: ${done} ok, ${failed} fallidos${encoladas ? ` (${encoladas} con el equipo fuera de línea)` : ''}${errors.length ? ' — ' + errors.join('; ') : ''}`;
    await this.audit(action, s, failed === 0, false, resumen, { count: list.length, user });
    return { ok: failed === 0, dryRun: false, done, failed, encoladas, errors, porDispositivo };
  }

  /** refreshObject de un subárbol de un CPE (lectura; puebla valores). Sin gate (no modifica config). */
  async refresh(deviceId: string, objectName: string, serverId?: string, user?: AuthUser) {
    const s = await this.resolveServer(serverId);
    const obj = objectName || 'InternetGatewayDevice.X_CATVConfiguration';
    const r = await this.nbi(s).refreshObject(deviceId, obj, true);
    await this.audit('REFRESH', s, r.ok, false, `refreshObject ${obj} → HTTP ${r.status}`, { deviceId, user });
    return { ok: r.ok, status: r.status };
  }

  /** Instala/actualiza en el ACS el provision + preset que sostienen el corte de TV entre informs. */
  async installProvision(serverId?: string, user?: AuthUser) {
    await this.syncLive();
    const s = await this.resolveServer(serverId);
    if (!this.live) {
      await this.audit('INSTALL_PROVISION', s, true, true, `DRY-RUN instalar provision "${TV_PROVISION_NAME}" + preset "${TV_PRESET_NAME}"`, { user });
      return {
        ok: true, dryRun: true,
        message: 'DRY-RUN: no se toca el ACS. Active GENIEACS_LIVE=true para instalar.',
        provision: { name: TV_PROVISION_NAME, script: TV_PROVISION_SCRIPT },
        preset: { name: TV_PRESET_NAME, ...TV_PRESET },
      };
    }
    const nbi = this.nbi(s);
    const pOk = await nbi.putProvision(TV_PROVISION_NAME, TV_PROVISION_SCRIPT);
    const prOk = await nbi.putPreset(TV_PRESET_NAME, TV_PRESET);
    const ok = pOk && prOk;
    await this.audit('INSTALL_PROVISION', s, ok, false, `Instalar provision=${pOk} preset=${prOk}`, { user });
    return { ok, dryRun: false, provision: pOk, preset: prOk };
  }

  // ------------------------------------------------------------------ //
  //  Corte de TV MASIVO POR ABONADO (dos vías: TR-069 u OLT/OMCI)      //
  // ------------------------------------------------------------------ //

  /**
   * Corta/restaura la TV de una lista de ABONADOS resolviendo el equipo de cada
   * uno por la vía que le corresponda:
   *  - CPE en el ACS (casado por usuario PPPoE / ConnectionRequestUsername) →
   *    TR-069: tag + parámetro CATV, en un solo lote.
   *  - ONU OMCI vinculada al abonado en OltOnu → puerto CATV por la OLT.
   *  - Sin equipo identificable → se reporta, no se inventa nada.
   * Cada vía respeta su propio gate LIVE y deja su propia auditoría.
   */
  async tvBatchBySubscribers(subscriberIds: string[], enable: boolean, user?: AuthUser) {
    const ids = [...new Set((subscriberIds || []).filter(Boolean))];
    if (!ids.length) throw new BadRequestException('No se indicaron clientes.');

    const subs = await this.prisma.subscriber.findMany({
      where: { id: { in: ids } },
      select: { id: true, abonado: true, fullName: true, pppUsername: true },
    });
    const s = await this.resolveServer(undefined);
    const devices = await this.devicesOf(s);
    const byUser = new Map<string, NbiDevice>();
    for (const d of devices) {
      const u = (d.pppUser || '').trim().toUpperCase();
      if (u && !byUser.has(u)) byUser.set(u, d);
    }
    const onus = await this.prisma.oltOnu.findMany({
      where: { subscriberId: { in: ids }, sn: { not: null } },
      select: { subscriberId: true, sn: true, oltId: true },
    });
    const onuBySub = new Map(onus.map((o) => [o.subscriberId as string, o]));

    type Sub = (typeof subs)[number];
    const acsTargets: { sub: Sub; device: NbiDevice }[] = [];
    const oltTargets: { sub: Sub; sn: string; oltId: string }[] = [];
    const results: Array<{
      subscriberId: string; abonado?: number; name?: string | null;
      via: 'TR069' | 'OLT' | null; ok: boolean; dryRun?: boolean; detail: string;
    }> = [];

    for (const sub of subs) {
      const dev = sub.pppUsername ? byUser.get(sub.pppUsername.trim().toUpperCase()) : undefined;
      if (dev) { acsTargets.push({ sub, device: dev }); continue; }
      const onu = onuBySub.get(sub.id);
      if (onu?.sn && onu.oltId) { oltTargets.push({ sub, sn: onu.sn, oltId: onu.oltId }); continue; }
      results.push({
        subscriberId: sub.id, abonado: sub.abonado, name: sub.fullName, via: null, ok: false,
        detail: 'Sin equipo identificado: ni CPE en el ACS (usuario PPPoE) ni ONU vinculada en la OLT.',
      });
    }
    const encontrados = new Set(subs.map((x) => x.id));
    for (const id of ids) {
      if (!encontrados.has(id)) results.push({ subscriberId: id, via: null, ok: false, detail: 'Cliente no encontrado.' });
    }

    // Vía TR-069: un solo lote (cutTv/restoreTv auditan y respetan el gate del ACS).
    if (acsTargets.length) {
      const r = await (enable
        ? this.restoreTv(acsTargets.map((t) => t.device.id), user)
        : this.cutTv(acsTargets.map((t) => t.device.id), user));
      // Equipo por equipo, tal como lo reportó el ACS: un CPE que no contestó NO cuenta
      // como hecho aunque el lote entero no se haya caído.
      const porCpe = (r as any).porDispositivo as Record<string, { ok: boolean; encolada: boolean; detalle: string }> | undefined;
      for (const t of acsTargets) {
        const fila = porCpe?.[t.device.id];
        const ok = r.dryRun ? true : fila ? fila.ok : !!(r as any).ok;
        results.push({
          subscriberId: t.sub.id, abonado: t.sub.abonado, name: t.sub.fullName, via: 'TR069',
          ok, dryRun: !!r.dryRun,
          detail: r.dryRun
            ? 'DRY-RUN (ACS): plan sin aplicar.'
            : fila?.detalle ?? (ok ? (enable ? 'TV restaurada por TR-069.' : 'TV cortada por TR-069.') : 'El ACS no pudo aplicar el cambio.'),
        });
      }
    }

    // Vía OLT/OMCI: una a una (cada setCatv audita y confirma releyendo el puerto).
    for (const t of oltTargets) {
      try {
        const r = await this.olt.setCatv(t.oltId, { sn: t.sn, enable }, user);
        results.push({
          subscriberId: t.sub.id, abonado: t.sub.abonado, name: t.sub.fullName, via: 'OLT',
          ok: !!r.ok, dryRun: !!r.dryRun,
          detail: r.dryRun ? 'DRY-RUN (OLT): plan sin aplicar.' : (r as any).message ?? (r as any).error ?? '',
        });
      } catch (e) {
        results.push({ subscriberId: t.sub.id, abonado: t.sub.abonado, name: t.sub.fullName, via: 'OLT', ok: false, detail: (e as Error).message });
      }
    }

    // La foto por servicio en BD sigue a los equipos. Sin esto el corte de TV no
    // deja rastro en la ficha del abonado (que no cambia de estado: se le corta la
    // TV, no el internet) y la reconexión automática al pagar no tendría cómo saber
    // que a ese cliente hay que devolverle la señal. En dry-run no se marca nada:
    // no se tocó ningún equipo.
    const aplicados = results.filter((r) => r.ok && r.via && !r.dryRun).map((r) => r.subscriberId);
    if (aplicados.length) {
      await this.prisma.subscriberService
        .updateMany({
          where: { subscriberId: { in: aplicados }, kind: { in: ['TV', 'PUNTOS'] } },
          data: { status: enable ? 'ACTIVO' : 'CORTADO' },
        })
        .catch((e) => this.logger.warn(`No se pudo marcar el estado del servicio de TV: ${e.message}`));
    }

    const done = results.filter((r) => r.ok && r.via).length;
    const failed = results.filter((r) => !r.ok && r.via).length;
    const sinEquipo = results.filter((r) => !r.via).length;
    const dryRun = results.some((r) => r.dryRun);
    this.logger.log(`TV MASIVO por abonado (${enable ? 'ALTA' : 'CORTE'}): ${ids.length} pedidos → TR069=${acsTargets.length} OLT=${oltTargets.length} sinEquipo=${sinEquipo} · ok=${done} fallidos=${failed}${dryRun ? ' (dry-run)' : ''}`);
    return { ok: failed === 0, dryRun, total: ids.length, done, failed, sinEquipo, results };
  }

  // ------------------------------------------------------------------ //
  //  WiFi del abonado: nombre y clave por TR-069                        //
  // ------------------------------------------------------------------ //

  /**
   * Cambia el nombre y/o la clave del WiFi de UN abonado en su propio equipo.
   *
   * Es la vía rápida del trámite «Cambio de clave»: si el CPE está en el ACS y
   * contesta, el cambio queda hecho en el momento y no hace falta que vaya nadie. Si
   * no —y es lo más frecuente: solo 605 de los 5.097 abonados activos tienen equipo
   * en el ACS y unos 420 informan a diario—, esto devuelve POR QUÉ no se pudo y quien
   * llama abre la orden de servicio de siempre. Nunca se inventa un éxito.
   *
   * Cómo se sabe que de verdad quedó: el NBI contesta **200 cuando el CPE ejecutó** la
   * tarea y **202 cuando la encoló** porque el equipo no contestó al connection
   * request. Solo el 200 cuenta como aplicado; la tarea encolada se CANCELA, para que
   * no le cambie la clave al cliente tres días después, cuando ya fue el técnico y le
   * puso otra.
   *
   * Lo que NO se puede hacer: releer la clave para verificarla. Los CPEs del parque
   * exponen `KeyPassphrase` como solo-escritura (viene vacío en los 549 equipos
   * vivos), así que la confirmación honesta es "el equipo aceptó el cambio", no
   * "verifiqué que quedó". Y la clave JAMÁS entra en la auditoría ni en el log.
   */
  async setWifiBySubscriber(
    subscriberId: string,
    cambio: { ssid?: string; clave?: string },
    user?: AuthUser,
  ): Promise<WifiCambioResultado> {
    await this.syncLive();

    const ssid = String(cambio.ssid ?? '').trim();
    const clave = String(cambio.clave ?? '');
    if (!ssid && !clave) throw new BadRequestException('Indica el nombre nuevo de la red, la clave nueva, o las dos.');
    const malo = (ssid && validarSsid(ssid)) || (clave && validarClave(clave));
    if (malo) return { ok: false, resultado: 'DATOS_INVALIDOS', detalle: malo as string };

    const sub = await this.prisma.subscriber.findUnique({
      where: { id: subscriberId },
      select: { id: true, abonado: true, fullName: true, pppUsername: true },
    });
    if (!sub) throw new NotFoundException('Cliente no encontrado.');

    const s = await this.resolveServer(undefined);
    const device = await this.buscarCpe(s, sub.pppUsername);
    if (!device) {
      return {
        ok: false, resultado: 'SIN_EQUIPO',
        detalle: sub.pppUsername
          ? `El equipo del abonado (${sub.pppUsername}) no está en el ACS: no se puede configurar a distancia.`
          : 'El abonado no tiene usuario PPPoE, así que no hay forma de identificar su equipo en el ACS.',
      };
    }

    if (!this.live) {
      await this.audit('SET_PARAM', s, true, true, `DRY-RUN WiFi del abonado ${sub.abonado ?? sub.id}: ${this.quePide(ssid, clave)}`, { deviceId: device.id, subscriberId, user });
      return {
        ok: false, resultado: 'DRY_RUN', deviceId: device.id,
        detalle: 'La red está en modo simulación (GENIEACS_LIVE apagado): no se tocó el equipo.',
      };
    }

    const nbi = this.nbi(s);

    // Paso 1: refrescar el subárbol WiFi. Sirve para dos cosas — leer las redes tal
    // como están HOY (los nombres del caché pueden ser de hace meses) y saber de una
    // si el equipo contesta, antes de mandarle ninguna escritura.
    const refresco = await nbi.refreshObject(device.id, WLAN_PATH, true);
    if (refresco.queued || !refresco.ok) {
      if (refresco.taskId) await nbi.deleteTask(refresco.taskId).catch(() => false);
      await this.audit('SET_PARAM', s, false, false, `WiFi ${sub.abonado ?? sub.id}: el equipo no contestó (refresh HTTP ${refresco.status})`, { deviceId: device.id, subscriberId, user });
      return {
        ok: false, resultado: 'EQUIPO_OFFLINE', deviceId: device.id,
        detalle: 'El equipo del cliente no contestó: está apagado, sin fibra o fuera de línea.',
      };
    }

    // Paso 2: elegir SOBRE QUÉ redes se escribe (ver wifi-targets.ts: el índice no
    // significa lo mismo en cada marca).
    const arbol = await nbi.getDevice(device.id, [WLAN_PATH]);
    const wlan = arbol?.InternetGatewayDevice?.LANDevice?.['1']?.WLANConfiguration;
    const redes = elegirRedes(wlan);
    const plan = planWifi(redes, { ssid: ssid || undefined, clave: clave || undefined });
    if (!plan.pares.length) {
      await this.audit('SET_PARAM', s, false, false, `WiFi ${sub.abonado ?? sub.id}: el equipo no expone parámetros escribibles de WiFi`, { deviceId: device.id, subscriberId, user });
      return {
        ok: false, resultado: 'RECHAZADO', deviceId: device.id,
        detalle: 'El equipo no deja cambiar el WiFi a distancia (no expone los parámetros).',
      };
    }

    // Paso 3: escribir. Todo en UNA tarea: un solo connection request y, si el equipo
    // se cae a la mitad, no queda con el nombre nuevo y la clave vieja.
    const r = await nbi.setStrings(device.id, plan.pares, true);
    if (r.queued || !r.ok) {
      if (r.taskId) await nbi.deleteTask(r.taskId).catch(() => false);
      await this.audit('SET_PARAM', s, false, false, `WiFi ${sub.abonado ?? sub.id}: el equipo no aplicó el cambio (HTTP ${r.status})`, { deviceId: device.id, subscriberId, user });
      return {
        ok: false, resultado: r.queued ? 'EQUIPO_OFFLINE' : 'RECHAZADO', deviceId: device.id,
        detalle: r.queued
          ? 'El equipo dejó de contestar antes de aplicar el cambio; la tarea se canceló para que no salte más tarde.'
          : `El ACS rechazó el cambio (HTTP ${r.status}).`,
      };
    }

    await this.audit('SET_PARAM', s, true, false, `WiFi del abonado ${sub.abonado ?? sub.id}: ${this.quePide(ssid, clave)} · ${plan.resumen.join(' | ')}`, { deviceId: device.id, subscriberId, count: plan.pares.length, user });
    this.logger.log(`WiFi aplicado por TR-069 al abonado ${sub.abonado ?? sub.id} (${device.id}): ${plan.resumen.join(' | ')}`);
    // Si alguna banda se quedó con la clave vieja porque el equipo no deja tocarla, se
    // dice aquí: un "listo, ya quedó" a medias es una llamada más la semana que viene.
    const cojera = plan.sinClave.length
      ? ` OJO: ${plan.sinClave.join(' y ')} se quedó con la clave anterior porque el equipo no deja cambiársela.`
      : '';
    return {
      ok: true, resultado: 'APLICADO', deviceId: device.id,
      redes: plan.resumen,
      detalle: `Aplicado en el equipo (${plan.objetivos.length} red${plan.objetivos.length === 1 ? '' : 'es'}).${cojera}`,
    };
  }

  /** Qué se pidió cambiar, para la auditoría. La clave NO se registra: solo que se cambió. */
  private quePide(ssid: string, clave: string): string {
    return [ssid ? `nombre → «${ssid}»` : '', clave ? 'clave nueva (no se registra)' : ''].filter(Boolean).join(' + ');
  }

  /**
   * El CPE de un abonado en el ACS, buscado por su usuario PPPoE.
   *
   * Primero pregunta directo al NBI por ese usuario (medio segundo) y solo si no lo
   * encuentra recorre el parque entero comparando sin distinguir mayúsculas (segundo
   * y pico). Si el usuario casa con MÁS de un equipo no devuelve ninguno: usuarios
   * basura como "pppoe" o "v" existen en la BD y escribirle la clave al equipo
   * equivocado es peor que no hacer nada.
   */
  private async buscarCpe(
    s: { nbiUrl: string; username: string; password: string },
    pppUsername: string | null,
  ): Promise<NbiDevice | null> {
    const u = (pppUsername || '').trim();
    if (!u) return null;
    const nbi = this.nbi(s);
    const WAN_USER = 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username._value';
    const CR_USER = 'InternetGatewayDevice.ManagementServer.ConnectionRequestUsername._value';
    const variantes = [...new Set([u, u.toUpperCase(), u.toLowerCase()])];

    try {
      const query = { $or: variantes.flatMap((v) => [{ [WAN_USER]: v }, { [CR_USER]: v }]) };
      const rows = await nbi.listDevices(query as any);
      if (rows.length === 1) return rows[0];
      if (rows.length > 1) return null;
    } catch (e) {
      this.logger.warn(`Búsqueda directa del CPE falló (${(e as Error).message}); se recorre el parque.`);
    }

    const todos = await this.devicesOf(s);
    const casan = todos.filter((d) => (d.pppUser || '').trim().toUpperCase() === u.toUpperCase());
    return casan.length === 1 ? casan[0] : null;
  }
}
