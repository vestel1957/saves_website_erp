import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/current-user.decorator';
import { GenieacsNbi, NbiDevice, NbiError, nbiHttpMessage } from './genieacs/genieacs-nbi.client';
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
/** Precondición: sólo CPEs que exponen el parámetro CATV (evita faults en el parque xPON sin TV). */
export const TV_PRESET = {
  weight: 0,
  precondition: JSON.stringify({ [`${TV_PARAM}._value`]: { $exists: true } }),
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
}

@Injectable()
export class GenieacsService {
  private readonly logger = new Logger(GenieacsService.name);
  private live = process.env.GENIEACS_LIVE === 'true';
  private liveCheckedAt = 0;

  constructor(private readonly prisma: PrismaService) {}

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
    return {
      items: rows.slice((page - 1) * pageSize, page * pageSize),
      total, page, pageSize, pages: Math.ceil(total / pageSize),
    };
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
    let done = 0, failed = 0;
    const errors: string[] = [];
    for (const id of list) {
      try {
        const tagOk = enable ? await nbi.removeTag(id, TV_TAG) : await nbi.addTag(id, TV_TAG);
        const p = await nbi.setBool(id, TV_PARAM, enable, true);
        if (tagOk && p.ok) done++;
        else { failed++; if (errors.length < 10) errors.push(`${id}: tag=${tagOk} task=${p.status}`); }
      } catch (e) {
        failed++; if (errors.length < 10) errors.push(`${id}: ${(e as Error).message}`);
      }
    }
    await this.audit(action, s, failed === 0, false, `${verb} TV: ${done} ok, ${failed} fallidos${errors.length ? ' — ' + errors.join('; ') : ''}`, { count: list.length, user });
    return { ok: failed === 0, dryRun: false, done, failed, errors };
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
}
