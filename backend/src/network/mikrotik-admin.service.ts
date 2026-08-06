import { BadRequestException, NotFoundException } from '../core/http/errores';
import { Logger } from '../core/logger';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/current-user.decorator';
import { RouterosClient, RouterosError, RosRow } from './routeros/routeros-client';
import { decryptSecret, encryptSecret } from '../common/secret-box';

/**
 * MikrotikAdminService — clon de `application/controllers/Mikrotiks.php` del legacy.
 *
 * Gestión de los routers MikroTik (no de un cliente puntual): alta/edición/baja,
 * router por defecto por sede, validación de conexión, y —en la vista de operación—
 * lecturas en vivo por la API de RouterOS (sistema, /ppp/secret, /ppp/active,
 * /ppp/profile, address-lists ACTIVOS/MOROSOS) y unas pocas escrituras.
 *
 * ⚠️ SEGURIDAD: por defecto DRY-RUN. Las escrituras devuelven el plan de comandos
 * SIN tocar el router. Para operar de verdad arrancar el backend con MIKROTIK_LIVE=true.
 * Cada acción queda auditada en MikrotikActionLog (subscriberId = null en las de router).
 *
 * Reutiliza el mismo cliente binario RouterosClient que usa la corte/reconexión.
 */

const ADDRESS_LIST_ACTIVE = 'ACTIVOS';
const ADDRESS_LIST_DEBTOR = 'MOROSOS';

export type MkAdminAction =
  | 'CREATE' | 'UPDATE' | 'DELETE' | 'DEFAULT' | 'TEST'
  | 'SYSTEM' | 'SECRETS' | 'ACTIVE' | 'PROFILES' | 'SUMMARY'
  | 'TOGGLE' | 'KICK';

type SecretRow = {
  id: string; name: string; profile: string; service: string;
  remoteAddress: string; localAddress: string; disabled: boolean; comment: string;
};

export class MikrotikAdminService {
  private readonly logger = new Logger(MikrotikAdminService.name);
  private live = process.env.MIKROTIK_LIVE === 'true';
  private liveCheckedAt = 0;

  constructor(private readonly prisma: PrismaService) {}

  get isLive(): boolean {
    return this.live;
  }

  /** Sincroniza el modo real desde el ajuste `network.mikrotikLive` (interruptor en Configuración, cache 15s). MIKROTIK_LIVE=true lo fuerza. */
  private async syncLive(): Promise<void> {
    const now = Date.now();
    if (now - this.liveCheckedAt < 15000) return;
    this.liveCheckedAt = now;
    const row = await this.prisma.appSetting.findUnique({ where: { key: 'network.mikrotikLive' } });
    // El interruptor de Configuración MANDA si está definido; si no, cae a la env.
    this.live = row?.value === 'true' || row?.value === 'false'
      ? row.value === 'true'
      : process.env.MIKROTIK_LIVE === 'true';
  }

  async mode() {
    await this.syncLive();
    return { live: this.live, mode: this.live ? 'LIVE' : 'DRY_RUN' };
  }

  // ------------------------------------------------------------------ //
  //  Auditoría                                                         //
  // ------------------------------------------------------------------ //

  private async audit(
    action: MkAdminAction,
    router: { id: string; name: string } | null,
    ok: boolean,
    dryRun: boolean,
    detail: string,
    user?: AuthUser,
  ) {
    try {
      await this.prisma.mikrotikActionLog.create({
        data: {
          subscriberId: null,
          mikrotikId: router?.id ?? null,
          mikrotikName: router?.name ?? null,
          action,
          ok,
          dryRun,
          detail: detail.slice(0, 1900),
          userId: user?.id ?? null,
          userName: user?.name ?? null,
        },
      });
    } catch (e) {
      this.logger.warn(`No se pudo auditar acción Mikrotik: ${(e as Error).message}`);
    }
  }

  private async resolve(id: string) {
    const mk = await this.prisma.mikrotik.findUnique({ where: { id } });
    if (!mk) throw new NotFoundException('Mikrotik no encontrado.');
    return mk;
  }

  /** Abre la API RouterOS, ejecuta `fn`, siempre cierra. */
  private async withApi<T>(
    router: { ip: string; port: string; username: string; password: string },
    fn: (api: RouterosClient) => Promise<T>,
  ): Promise<{ ok: boolean; error: string; data: T | null }> {
    const api = new RouterosClient();
    try {
      await api.connect(router.ip, Number(router.port), router.username, decryptSecret(router.password), { timeoutMs: 8000 });
      const data = await fn(api);
      api.close();
      return { ok: true, error: '', data };
    } catch (e) {
      api.close();
      const error = e instanceof RouterosError ? e.message : (e as Error).message;
      return { ok: false, error, data: null };
    }
  }

  // ------------------------------------------------------------------ //
  //  CRUD de routers                                                   //
  // ------------------------------------------------------------------ //

  /** Sedes disponibles para el select del formulario (id + gid legacy). */
  async branches() {
    const rows = await this.prisma.branch.findMany({
      orderBy: { name: 'asc' },
      select: { id: true, name: true, legacyId: true },
    });
    return rows.map((b) => ({ id: b.id, name: b.name, legacyId: b.legacyId }));
  }

  /** Listado de routers con sede y nº de otros routers en su misma sede. */
  async listRouters() {
    const rows = await this.prisma.mikrotik.findMany({
      orderBy: [{ sedeLegacy: 'asc' }, { name: 'asc' }],
      include: { branch: { select: { name: true } } },
    });
    // Cuántos routers hay por sede (para mostrar el flag "por defecto" sólo cuando aplica).
    const bySede = new Map<number, number>();
    for (const r of rows) bySede.set(r.sedeLegacy, (bySede.get(r.sedeLegacy) ?? 0) + 1);
    return rows.map((m) => ({
      id: m.id, name: m.name, ip: m.ip, port: m.port, tech: m.tech,
      branch: m.branch?.name ?? null, branchId: m.branchId, sedeLegacy: m.sedeLegacy,
      username: m.username, isDefault: m.isDefault, online: m.online,
      sedeRouters: bySede.get(m.sedeLegacy) ?? 1,
    }));
  }

  async createRouter(dto: any, user?: AuthUser) {
    if (!dto.name || !dto.ip) throw new BadRequestException('Nombre e IP son obligatorios.');
    if (!dto.branchId) throw new BadRequestException('Debe indicar la sede.');
    const branch = await this.prisma.branch.findUnique({ where: { id: dto.branchId }, select: { legacyId: true } });
    if (!branch) throw new BadRequestException('Sede no encontrada.');

    // legacyId es @unique y obligatorio: los routers nativos de la app toman el siguiente libre.
    const max = await this.prisma.mikrotik.aggregate({ _max: { legacyId: true } });
    const nextLegacy = (max._max.legacyId ?? 0) + 1;

    // Primer router de la sede → por defecto.
    const already = await this.prisma.mikrotik.count({ where: { sedeLegacy: branch.legacyId } });

    const mk = await this.prisma.mikrotik.create({
      data: {
        legacyId: nextLegacy,
        name: dto.name,
        ip: dto.ip,
        port: String(dto.port || '8728'),
        tech: dto.tech || '',
        branchId: dto.branchId,
        sedeLegacy: branch.legacyId,
        username: dto.username || '',
        password: encryptSecret(dto.password || ''),
        isDefault: already === 0,
      },
    });
    await this.audit('CREATE', mk, true, false, `Crear Mikrotik ${mk.name} (${mk.ip}:${mk.port})`, user);
    return { ok: true, id: mk.id };
  }

  async updateRouter(id: string, dto: any, user?: AuthUser) {
    const mk = await this.resolve(id);
    const data: Prisma.MikrotikUpdateInput = {};
    for (const k of ['name', 'ip', 'tech', 'username'] as const) {
      if (dto[k] !== undefined) (data as any)[k] = dto[k];
    }
    if (dto.port !== undefined) data.port = String(dto.port);
    // password: sólo si viene y no es la máscara de asteriscos.
    if (dto.password && !/^\*+$/.test(dto.password)) data.password = encryptSecret(dto.password);
    if (dto.branchId !== undefined && dto.branchId !== mk.branchId) {
      const branch = await this.prisma.branch.findUnique({ where: { id: dto.branchId }, select: { id: true, legacyId: true } });
      if (!branch) throw new BadRequestException('Sede no encontrada.');
      data.branch = { connect: { id: branch.id } };
      data.sedeLegacy = branch.legacyId;
    }
    await this.prisma.mikrotik.update({ where: { id }, data });
    await this.audit('UPDATE', mk, true, false, `Actualizar Mikrotik ${mk.name}`, user);
    return { ok: true };
  }

  async deleteRouter(id: string, user?: AuthUser) {
    const mk = await this.resolve(id);
    await this.prisma.mikrotik.delete({ where: { id } });
    await this.audit('DELETE', mk, true, false, `Eliminar Mikrotik ${mk.name}`, user);
    return { ok: true };
  }

  /** Marca este router como el por defecto de su sede (quita el flag a los demás). */
  async setDefault(id: string, user?: AuthUser) {
    const mk = await this.resolve(id);
    await this.prisma.mikrotik.updateMany({ where: { sedeLegacy: mk.sedeLegacy }, data: { isDefault: false } });
    await this.prisma.mikrotik.update({ where: { id }, data: { isDefault: true } });
    await this.audit('DEFAULT', mk, true, false, `Marcar ${mk.name} por defecto de la sede`, user);
    return { ok: true };
  }

  // ------------------------------------------------------------------ //
  //  Validación de conexión (estado_mikrotik del legacy)               //
  // ------------------------------------------------------------------ //

  async testRouter(id: string, user?: AuthUser) {
    const mk = await this.resolve(id);
    const r = await this.withApi(mk, (api) => api.comm('/system/identity/print'));
    const online = r.ok;
    const identity = r.data?.[0]?.['name'] ?? '';
    await this.prisma.mikrotik.update({ where: { id }, data: { online } }).catch(() => undefined);
    await this.audit('TEST', mk, online, false, online ? `Conexión OK (identity=${identity})` : `ERROR: ${r.error}`, user);
    return { ok: online, error: r.error, identity };
  }

  // ------------------------------------------------------------------ //
  //  Lecturas en vivo (RouterOS API)                                   //
  // ------------------------------------------------------------------ //

  async systemInfo(id: string) {
    const mk = await this.resolve(id);
    const r = await this.withApi(mk, async (api) => {
      const [identity, resource, board] = await Promise.all([
        api.comm('/system/identity/print').catch(() => [] as RosRow[]),
        api.comm('/system/resource/print').catch(() => [] as RosRow[]),
        api.comm('/system/routerboard/print').catch(() => [] as RosRow[]),
      ]);
      const res = resource[0] ?? {};
      const rb = board[0] ?? {};
      return {
        identity: identity[0]?.['name'] ?? '',
        version: res['version'] ?? '',
        uptime: res['uptime'] ?? '',
        boardName: res['board-name'] ?? rb['model'] ?? '',
        architecture: res['architecture-name'] ?? '',
        cpuLoad: res['cpu-load'] ?? '',
        totalMemory: res['total-memory'] ?? '',
        freeMemory: res['free-memory'] ?? '',
        model: rb['model'] ?? '',
        serial: rb['serial-number'] ?? '',
        firmware: rb['current-firmware'] ?? '',
      };
    });
    return { ok: r.ok, error: r.error, info: r.data ?? {} };
  }

  /**
   * Resumen de listas de acceso y contadores globales del router.
   *
   * Se piden con `count-only`: el router devuelve solo el total (=ret=) en vez
   * de miles de filas (~100 ms contra ~350 ms trayendo 2.300 secrets).
   *
   * Nada de `.catch(() => [])` aquí: un fallo de lectura contado como 0 es
   * indistinguible de "no hay morosos" y es justo lo que ocultaba el bug.
   * Si una lectura falla, cae al catch de withApi y la vista avisa.
   */
  async summary(id: string) {
    const mk = await this.resolve(id);
    const r = await this.withApi(mk, async (api) => {
      const count = async (path: string, query: RosRow = {}) => {
        const rows = await api.comm(path, { 'count-only': '', ...query }, 15000);
        const ret = rows[0]?.['ret'];
        return ret !== undefined ? Number(ret) || 0 : rows.length;
      };
      return {
        secrets: await count('/ppp/secret/print'),
        active: await count('/ppp/active/print'),
        activos: await count('/ip/firewall/address-list/print', { '?list': ADDRESS_LIST_ACTIVE }),
        morosos: await count('/ip/firewall/address-list/print', { '?list': ADDRESS_LIST_DEBTOR }),
      };
    });
    return { ok: r.ok, error: r.error, summary: r.data ?? { secrets: 0, active: 0, activos: 0, morosos: 0 } };
  }

  /** Secrets PPPoE (con filtro y paginado en memoria). */
  /**
   * Columnas ordenables de la tabla de secrets. Aquí no hay SQL: las filas
   * llegan enteras del router y se cortan en memoria, así que el orden se
   * aplica sobre TODAS antes de partir la página.
   */
  private static readonly ORDEN_SECRETS: Record<string, (s: SecretRow) => string | number | boolean> = {
    name: (x) => x.name,
    profile: (x) => x.profile,
    remote: (x) => x.remoteAddress,
    service: (x) => x.service,
    st: (x) => x.disabled,
    comment: (x) => x.comment,
  };

  async secrets(id: string, params: { search?: string; page?: number; pageSize?: number; sortBy?: string; sortDir?: string }) {
    const mk = await this.resolve(id);
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(params.pageSize) || 50));
    const r = await this.withApi(mk, (api) =>
      api.comm('/ppp/secret/print', {
        '.proplist': '.id,name,profile,service,remote-address,local-address,disabled,comment',
      }),
    );
    if (!r.ok) return { ok: false, error: r.error, items: [], total: 0, page, pageSize, pages: 0 };
    let rows = (r.data ?? []).map((s) => ({
      id: s['.id'] ?? '',
      name: s['name'] ?? '',
      profile: s['profile'] ?? '',
      service: s['service'] ?? '',
      remoteAddress: s['remote-address'] ?? '',
      localAddress: s['local-address'] ?? '',
      disabled: s['disabled'] === 'true',
      comment: s['comment'] ?? '',
    }));
    const s = (params.search ?? '').trim().toLowerCase();
    if (s) rows = rows.filter((x) => `${x.name} ${x.remoteAddress} ${x.comment} ${x.profile}`.toLowerCase().includes(s));
    const sacar = MikrotikAdminService.ORDEN_SECRETS[params.sortBy ?? ''] ?? ((x: SecretRow) => x.name);
    const signo = params.sortDir === 'desc' ? -1 : 1;
    rows.sort((a, b) => {
      const va = sacar(a), vb = sacar(b);
      if (typeof va === 'boolean' || typeof vb === 'boolean') return signo * (Number(va) - Number(vb));
      if (typeof va === 'number' && typeof vb === 'number') return signo * (va - vb);
      // Las IP y los nombres con número ordenan mejor con `numeric`.
      const c = String(va).localeCompare(String(vb), 'es', { numeric: true, sensitivity: 'base' });
      return c !== 0 ? signo * c : a.name.localeCompare(b.name);
    });
    const total = rows.length;
    const items = rows.slice((page - 1) * pageSize, page * pageSize);
    return { ok: true, error: '', items, total, page, pageSize, pages: Math.ceil(total / pageSize) };
  }

  /** Sesiones PPP activas en este momento. */
  async active(id: string) {
    const mk = await this.resolve(id);
    const r = await this.withApi(mk, (api) =>
      api.comm('/ppp/active/print', { '.proplist': '.id,name,address,uptime,caller-id,service' }),
    );
    const items = (r.data ?? []).map((a) => ({
      id: a['.id'] ?? '',
      name: a['name'] ?? '',
      address: a['address'] ?? '',
      uptime: a['uptime'] ?? '',
      callerId: a['caller-id'] ?? '',
      service: a['service'] ?? '',
    }));
    items.sort((x, y) => x.name.localeCompare(y.name));
    return { ok: r.ok, error: r.error, items };
  }

  /** Perfiles PPP (planes de velocidad) configurados en el router. */
  async profiles(id: string) {
    const mk = await this.resolve(id);
    const r = await this.withApi(mk, (api) =>
      api.comm('/ppp/profile/print', { '.proplist': '.id,name,rate-limit,local-address,remote-address,only-one' }),
    );
    const items = (r.data ?? []).map((p) => ({
      id: p['.id'] ?? '',
      name: p['name'] ?? '',
      rateLimit: p['rate-limit'] ?? '',
      localAddress: p['local-address'] ?? '',
      remoteAddress: p['remote-address'] ?? '',
      onlyOne: p['only-one'] ?? '',
    }));
    return { ok: r.ok, error: r.error, items };
  }

  /**
   * Vista de direccionamiento IP — clon de `mikrotiks/lista_vista_ips`.
   * Lista las IPs asignadas a cada abonado (remote-address del secret PPPoE),
   * cruzadas con las sesiones activas para saber si la IP está online ahora,
   * y marca las IPs DUPLICADAS (misma IP en más de un secret → conflicto).
   */
  async ips(id: string) {
    const mk = await this.resolve(id);
    const r = await this.withApi(mk, async (api) => {
      const [secrets, active] = await Promise.all([
        api.comm('/ppp/secret/print', { '.proplist': '.id,name,profile,remote-address,disabled,comment' }),
        api.comm('/ppp/active/print', { '.proplist': 'name,address' }).catch(() => [] as RosRow[]),
      ]);
      return { secrets, active };
    });
    if (!r.ok || !r.data) {
      return { ok: false, error: r.error, items: [], stats: { total: 0, online: 0, offline: 0, disabled: 0, conflicts: 0 } };
    }
    // Mapa usuario → IP en vivo (la sesión activa puede tener una IP dinámica distinta a la del secret).
    const liveByUser = new Map<string, string>();
    for (const a of r.data.active) if (a['name']) liveByUser.set(a['name'], a['address'] ?? '');

    const rows = r.data.secrets
      .map((s) => {
        const user = s['name'] ?? '';
        const ip = s['remote-address'] || liveByUser.get(user) || '';
        const online = liveByUser.has(user);
        return {
          ip,
          user,
          profile: s['profile'] ?? '',
          disabled: s['disabled'] === 'true',
          online,
          liveAddress: online ? (liveByUser.get(user) ?? '') : '',
          comment: s['comment'] ?? '',
          conflict: false,
        };
      })
      .filter((x) => x.ip); // solo filas con IP asignada

    // Detecta IPs repetidas (misma IP en >1 secret) — lo que esta vista sirve para cazar.
    const seen = new Map<string, number>();
    for (const x of rows) seen.set(x.ip, (seen.get(x.ip) ?? 0) + 1);
    for (const x of rows) x.conflict = (seen.get(x.ip) ?? 0) > 1;

    rows.sort((a, b) => this.ipSortKey(a.ip) - this.ipSortKey(b.ip) || a.user.localeCompare(b.user));

    const stats = {
      total: rows.length,
      online: rows.filter((x) => x.online).length,
      offline: rows.filter((x) => !x.online).length,
      disabled: rows.filter((x) => x.disabled).length,
      conflicts: rows.filter((x) => x.conflict).length,
    };
    return { ok: true, error: '', items: rows, stats };
  }

  /** Clave numérica de una IPv4 para ordenar (192.168.1.10 < 192.168.1.100). */
  private ipSortKey(ip: string): number {
    const p = ip.split('.').map((n) => Number(n));
    if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return Number.MAX_SAFE_INTEGER;
    return ((p[0] * 256 + p[1]) * 256 + p[2]) * 256 + p[3];
  }

  // ------------------------------------------------------------------ //
  //  Escrituras (GATE dry-run)                                         //
  // ------------------------------------------------------------------ //

  /** Habilita / deshabilita un secret PPPoE por nombre. */
  async toggleSecret(id: string, name: string, disabled: boolean, user?: AuthUser) {
    await this.syncLive();
    const mk = await this.resolve(id);
    if (!name) throw new BadRequestException('Debe indicar el nombre del secret.');
    const verb = disabled ? 'deshabilitar' : 'habilitar';

    if (!this.live) {
      const plan = `/ppp/secret/set ?name=${name} disabled=${disabled ? 'yes' : 'no'}`;
      await this.audit('TOGGLE', mk, true, true, `DRY-RUN ${verb} secret ${name}: ${plan}`, user);
      return { ok: true, dryRun: true, message: `DRY-RUN: no se contacta el router. Active MIKROTIK_LIVE=true para ejecutar.`, plan };
    }

    const r = await this.withApi(mk, async (api) => {
      const secrets = await api.comm('/ppp/secret/getall', { '.proplist': '.id', '?name': name });
      if (!secrets.length || !secrets[0]['.id']) throw new RouterosError(`No existe el secret '${name}'.`);
      await api.comm('/ppp/secret/set', { '.id': secrets[0]['.id'], disabled: disabled ? 'yes' : 'no' });
      return true;
    });
    await this.audit('TOGGLE', mk, r.ok, false, r.ok ? `Secret ${name} ${disabled ? 'deshabilitado' : 'habilitado'}` : `ERROR: ${r.error}`, user);
    if (!r.ok) return { ok: false, dryRun: false, error: r.error };
    return { ok: true, dryRun: false, message: `Secret ${name} ${disabled ? 'deshabilitado' : 'habilitado'}.` };
  }

  /** Cierra (reinicia) una sesión PPP activa por nombre. */
  async kickActive(id: string, name: string, user?: AuthUser) {
    await this.syncLive();
    const mk = await this.resolve(id);
    if (!name) throw new BadRequestException('Debe indicar el nombre de la sesión.');

    if (!this.live) {
      const plan = `/ppp/active/remove ?name=${name}`;
      await this.audit('KICK', mk, true, true, `DRY-RUN cerrar sesión ${name}: ${plan}`, user);
      return { ok: true, dryRun: true, message: `DRY-RUN: no se contacta el router. Active MIKROTIK_LIVE=true para ejecutar.`, plan };
    }

    const r = await this.withApi(mk, async (api) => {
      const active = await api.comm('/ppp/active/getall', { '.proplist': '.id', '?name': name });
      if (!active.length || !active[0]['.id']) throw new RouterosError(`No hay sesión activa de '${name}'.`);
      await api.comm('/ppp/active/remove', { '.id': active[0]['.id'] });
      return true;
    });
    await this.audit('KICK', mk, r.ok, false, r.ok ? `Sesión ${name} cerrada` : `ERROR: ${r.error}`, user);
    if (!r.ok) return { ok: false, dryRun: false, error: r.error };
    return { ok: true, dryRun: false, message: `Sesión de ${name} cerrada.` };
  }

  // ------------------------------------------------------------------ //
  //  Historial de acciones del router                                  //
  // ------------------------------------------------------------------ //

  async history(id: string, limit = 100) {
    return this.prisma.mikrotikActionLog.findMany({
      where: { mikrotikId: id },
      orderBy: { createdAt: 'desc' },
      take: Math.min(300, Math.max(1, limit)),
    });
  }
}
