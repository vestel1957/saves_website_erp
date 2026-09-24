import { BadRequestException, NotFoundException } from '../core/http/errores';
import { Logger } from '../core/logger';
import { ordenSql } from '../common/pagination-params';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/current-user.decorator';
import { OltDriver } from './olt/olt-ssh.client';
import { OltHuawei, comandosOltParaVlan } from './olt/olt-huawei.driver';
import type { LecturaOltVlans } from './vlan-salud';
import { createOltDriver, OLT_BRANDS } from './olt/olt-factory';
import type { OltTransporte } from './olt/olt-ssh.client';
import { decryptSecret, encryptSecret } from '../common/secret-box';
import { formaHex } from '../common/serial-onu';

/**
 * OltService — clon de SmartOLT: control total de ONUs por SSH.
 *
 * Porta application/controllers/Olts.php + application/models/Olt_onus_model.php:
 *   - Lecturas en vivo (test, tableros, ONUs, autofind, perfiles, detalle, buscar SN, sistema).
 *   - Escrituras (autenticar/aprovisionar, reiniciar, eliminar) con GATE dry-run.
 *   - Inventario local sobre la tabla OltOnu (sync, listado con filtros, dashboard, vínculo cliente).
 *
 * ⚠️ SEGURIDAD: por defecto DRY-RUN. Las escrituras devuelven el plan de comandos
 * SIN abrir sesión de escritura. Para operar de verdad contra las OLT de producción
 * arrancar el backend con OLT_LIVE=true. Cada acción queda auditada en OltActionLog.
 *
 * Umbrales de señal óptica (Rx, dBm): OK ≥ -25 · débil -25..-28 · crítica < -28.
 */

export type OltAction =
  | 'TEST' | 'BOARDS' | 'ONUS' | 'AUTOFIND' | 'PROFILES' | 'SYSTEM'
  | 'DETAIL' | 'FIND' | 'PROVISION' | 'ADOPTAR' | 'REBOOT' | 'DELETE' | 'SYNC' | 'LINK' | 'DESC' | 'CATV'
  /** Crear una VLAN / ponerla en el uplink (`VlanEquiposService`). */
  | 'VLAN';

interface AuditMeta {
  sn?: string | null;
  fsp?: string | null;
  subscriberId?: string | null;
  user?: AuthUser;
}

const SUB_SELECT = {
  id: true, abonado: true, firstName: true, secondName: true,
  lastName1: true, lastName2: true, companyName: true, fullName: true,
  docNumber: true, phone1: true,
} as const;

function subName(s: any): string | null {
  if (!s) return null;
  if (s.fullName && s.fullName.trim()) return s.fullName.trim();
  const p = [s.firstName, s.secondName, s.lastName1, s.lastName2].map((x: any) => (x || '').trim()).filter(Boolean).join(' ');
  return p || (s.companyName || '').trim() || null;
}

/**
 * Elige el srv-profile correcto para una ONU a partir de su EquipmentID.
 *
 * En esta planta hay un srv-profile con el NOMBRE EXACTO del modelo de cada ONU
 * (autofind reporta EquipmentID "BCD-FD702XW-X-R410" y existe el srv-profile
 * llamado "BCD-FD702XW-X-R410"). Elegir el que coincide evita el `match: mismatch`
 * que deja al abonado registrado pero SIN servicio. Se compara normalizando
 * (mayúsculas, sin signos) para tolerar guiones/espacios entre modelo y perfil.
 *
 * Si no hay coincidencia exacta se devuelve null a propósito: NO se adivina un
 * genérico solo, porque un genérico con distinto número de puertos ETH vuelve a
 * dar mismatch. En ese caso el auto-alta deja la solicitud en REVIEW para que un
 * humano elija el perfil, en vez de dar de alta algo roto.
 */
export function pickSrvProfileByModel(
  model: string,
  srvList: { id: string; name: string }[],
): { id: string; name: string } | null {
  const norm = (s: string) => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const target = norm(model);
  if (!target) return null;
  return srvList.find((p) => norm(p.name) === target) ?? null;
}


/**
 * Transporte de una OLT. Se normaliza aquí y no en cada llamada porque las
 * fichas viejas traen la columna vacía: sin este respaldo, una OLT importada
 * del legacy intentaría conectarse por telnet a un puerto SSH.
 */
function transporteDe(olt: { transport?: string | null }): OltTransporte {
  return String(olt.transport || '').toLowerCase() === 'telnet' ? 'telnet' : 'ssh';
}

export class OltService {
  private readonly logger = new Logger(OltService.name);
  private live = process.env.OLT_LIVE === 'true';
  private liveCheckedAt = 0;
  private autoProvision = process.env.AUTO_PROVISION_ENABLED === 'true';
  private autoProvisionCheckedAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    /**
     * Opcional y por forma, no por clase: sólo hace falta para que la señal óptica
     * encuentre el equipo por la MAC con que navega cuando el inventario no cuadra.
     * Sin él (scripts, smokes) todo lo demás funciona igual.
     */
    private readonly mikrotik?: { callerIdDeAbonado(subscriberId: string): Promise<string | null> },
  ) {}

  get isLive(): boolean {
    return this.live;
  }

  /** Sincroniza el modo real desde el ajuste `network.oltLive` (interruptor en Configuración, cache 15s). OLT_LIVE=true lo fuerza. */
  private async syncLive(): Promise<void> {
    const now = Date.now();
    if (now - this.liveCheckedAt < 15000) return;
    this.liveCheckedAt = now;
    const row = await this.prisma.appSetting.findUnique({ where: { key: 'network.oltLive' } });
    // El interruptor de Configuración MANDA si está definido; si no, cae a la env.
    this.live = row?.value === 'true' || row?.value === 'false'
      ? row.value === 'true'
      : process.env.OLT_LIVE === 'true';
  }

  /** Gate del auto-alta: ajuste `network.oltAutoProvision` (cache 15s). AUTO_PROVISION_ENABLED lo fuerza. */
  private async syncAutoProvision(): Promise<void> {
    const now = Date.now();
    if (now - this.autoProvisionCheckedAt < 15000) return;
    this.autoProvisionCheckedAt = now;
    const row = await this.prisma.appSetting.findUnique({ where: { key: 'network.oltAutoProvision' } });
    this.autoProvision = row?.value === 'true' || row?.value === 'false'
      ? row.value === 'true'
      : process.env.AUTO_PROVISION_ENABLED === 'true';
  }

  async mode() {
    await this.syncLive();
    await this.syncAutoProvision();
    return { live: this.live, mode: this.live ? 'LIVE' : 'DRY_RUN', autoProvision: this.autoProvision, brands: OLT_BRANDS };
  }

  // ------------------------------------------------------------------ //
  //  Resolución + sesión                                               //
  // ------------------------------------------------------------------ //

  /**
   * Deja en el log la transcripción SSH de una sesión que falló. Sin esto, los
   * errores del CLI ("Reenter times…", prompts inesperados) solo se ven en la
   * respuesta HTTP y se pierden: no hay forma de saber QUÉ pregunta del equipo
   * quedó sin responder. Se recorta para no inundar el log.
   */
  private logSesionFallida(olt: { ip: string }, error: string, raw: string) {
    const t = (raw || '').slice(-4000);
    this.logger.warn(
      `Sesión OLT ${olt.ip} falló: ${error}\n` +
      `--- transcripción SSH (últimos ${t.length} car.) ---\n${t}\n--- fin ---`,
    );
  }

  private async resolveOlt(id: string) {
    const olt = await this.prisma.olt.findUnique({ where: { id } });
    if (!olt) throw new NotFoundException('OLT no encontrada.');
    return olt;
  }

  /**
   * Sesiones SSH abiertas ahora mismo, por IP de OLT. Los Huawei aceptan pocas
   * sesiones VTY simultáneas (típico 4-8) y solo las liberan por timeout de
   * inactividad: si se agotan, NADIE entra al equipo — ni el sistema ni un
   * técnico por consola. Serializamos por equipo para no llegar nunca a ese
   * punto y REUTILIZAMOS una única sesión ya autenticada (pool): el costo de
   * conexión (handshake legacy + banner + enable + config ≈ 4-6 s) se paga una
   * vez y no en cada consulta. La sesión se cierra sola tras un rato ociosa.
   */
  private static readonly colaPorOlt = new Map<string, Promise<unknown>>();

  /** Sesión SSH viva por IP de OLT, con temporizador de cierre por inactividad. */
  private static readonly sesionPorOlt = new Map<string, { driver: OltDriver; timer: NodeJS.Timeout; lastUsed: number }>();
  /** Ociosa este tiempo → se cierra (muy por debajo del idle-timeout VTY del equipo). */
  private static readonly SESION_IDLE_MS = 90_000;

  /**
   * Caché de lecturas que casi nunca cambian (perfiles, tablas de tráfico,
   * tableros, system info): evita una sesión SSH completa cada vez que se abre
   * el modal de autenticar. Los botones "Refrescar" fuerzan lectura real.
   */
  private static readonly cacheLecturas = new Map<string, { at: number; data: any }>();
  private static readonly CACHE_TTL_MS = 10 * 60_000;

  private guardarSesion(ip: string, driver: OltDriver): void {
    const previa = OltService.sesionPorOlt.get(ip);
    if (previa) clearTimeout(previa.timer);
    const timer = setTimeout(() => this.descartarSesion(ip), OltService.SESION_IDLE_MS);
    timer.unref?.();
    OltService.sesionPorOlt.set(ip, { driver, timer, lastUsed: Date.now() });
  }

  private descartarSesion(ip: string): void {
    const s = OltService.sesionPorOlt.get(ip);
    if (!s) return;
    clearTimeout(s.timer);
    OltService.sesionPorOlt.delete(ip);
    try { s.driver.disconnect(); } catch { /* cerrando */ }
  }

  onModuleDestroy(): void {
    for (const ip of [...OltService.sesionPorOlt.keys()]) this.descartarSesion(ip);
  }

  /** Devuelve la respuesta cacheada si está vigente; si no, ejecuta y cachea (solo éxitos). */
  private async conCache<T extends { ok: boolean }>(key: string, refresh: boolean, fn: () => Promise<T>): Promise<T> {
    if (!refresh) {
      const hit = OltService.cacheLecturas.get(key);
      if (hit && Date.now() - hit.at < OltService.CACHE_TTL_MS) return { ...hit.data, cached: true };
    }
    const data = await fn();
    if (data.ok) OltService.cacheLecturas.set(key, { at: Date.now(), data });
    return data;
  }

  /** Encola `fn` detrás de lo que ya esté corriendo contra esa misma OLT. */
  private enFila<T>(ip: string, fn: () => Promise<T>): Promise<T> {
    const previo = OltService.colaPorOlt.get(ip) ?? Promise.resolve();
    const siguiente = previo.catch(() => {}).then(fn);
    // La cola guarda la promesa "silenciada" para que un fallo no la rompa.
    OltService.colaPorOlt.set(ip, siguiente.catch(() => {}));
    return siguiente;
  }

  /**
   * Ejecuta `fn` sobre una sesión conectada+preparada. Reutiliza la sesión del
   * pool si sigue viva (probe con ENTER); si no, conecta una nueva. Tras un uso
   * exitoso la sesión VUELVE al pool (no se desconecta); ante una excepción se
   * descarta, porque el CLI pudo quedar en un submodo desconocido.
   */
  private async withDriver<T>(
    olt: { id: string; brand: string; ip: string; port: string; username: string; password: string; transport?: string },
    fn: (driver: OltDriver) => Promise<T>,
  ): Promise<{ ok: boolean; error: string; raw: string; data: T | null }> {
    return this.enFila(olt.ip, async () => {
      const pooled = OltService.sesionPorOlt.get(olt.ip);
      let driver = pooled?.driver ?? null;
      if (driver && pooled) {
        // Usada hace <10 s y sin señales de muerte → se confía sin probe: en una
        // ráfaga (listar → detalle → óptica) el probe es un viaje extra por
        // consulta. Tras más tiempo ociosa sí se verifica con un ENTER.
        const recienUsada = Date.now() - pooled.lastUsed < 10_000;
        const usable = driver.isAlive() && (recienUsada || (await driver.probe()));
        if (usable) {
          driver.resetSession();
        } else {
          this.descartarSesion(olt.ip);
          driver = null;
        }
      }
      if (!driver) {
        driver = createOltDriver(olt.brand, olt.ip, olt.port, olt.username, decryptSecret(olt.password), transporteDe(olt));
        const connected = await driver.connect();
        if (!connected) {
          const error = driver.getError();
          driver.disconnect();
          if (/Reenter times|maximum|too many|number of users/i.test(error)) {
            this.logger.error(
              `OLT ${olt.ip}: el equipo rechaza nuevas sesiones SSH (${error}). ` +
              'Probablemente quedaron sesiones VTY colgadas; se liberan por timeout de inactividad.',
            );
          }
          return { ok: false, error, raw: driver.getRawLog(), data: null };
        }
        await driver.prepare();
      }
      try {
        const data = await fn(driver);
        const error = data === false ? driver.getError() : '';
        if (data === false) this.logSesionFallida(olt, error, driver.getRawLog());
        // Éxito o fallo lógico (p.ej. "SN no encontrado"): el CLI quedó en el
        // prompt de config y la sesión sirve para la próxima consulta. Pero si
        // el CLI quedó atascado en una pregunta (reenter/prompt repetido), la
        // sesión no es confiable y se descarta.
        if (/Reenter times|prompt repetido|repitió la misma pregunta|falta un parámetro|pide un parámetro/i.test(error)) {
          this.descartarSesion(olt.ip);
          driver.disconnect();
        } else {
          this.guardarSesion(olt.ip, driver);
        }
        return { ok: data !== false, error, raw: driver.getRawLog(), data: data === false ? null : data };
      } catch (e) {
        const error = (e as Error).message;
        this.logSesionFallida(olt, error, driver.getRawLog());
        this.descartarSesion(olt.ip);
        driver.disconnect();
        return { ok: false, error, raw: driver.getRawLog(), data: null };
      }
    });
  }

  private async audit(action: OltAction, olt: { id: string; name: string } | null, ok: boolean, dryRun: boolean, detail: string, meta: AuditMeta = {}) {
    try {
      await this.prisma.oltActionLog.create({
        data: {
          oltId: olt?.id ?? null,
          oltName: olt?.name ?? null,
          action, ok, dryRun,
          detail: detail.slice(0, 1900),
          sn: meta.sn ?? null,
          fsp: meta.fsp ?? null,
          subscriberId: meta.subscriberId ?? null,
          userId: meta.user?.id ?? null,
          userName: meta.user?.name ?? null,
        },
      });
    } catch (e) {
      this.logger.warn(`No se pudo auditar acción OLT: ${(e as Error).message}`);
    }
  }

  // ------------------------------------------------------------------ //
  //  CRUD de OLTs                                                       //
  // ------------------------------------------------------------------ //

  async listOlts() {
    const rows = await this.prisma.olt.findMany({
      orderBy: [{ sedeLegacy: 'asc' }, { name: 'asc' }],
      include: { branch: { select: { name: true } }, _count: { select: { onus: true } } },
    });
    return rows.map((o) => ({
      id: o.id, name: o.name, brand: o.brand, ip: o.ip, port: o.port, tech: o.tech, transport: transporteDe(o),
      // `branchId` además del nombre: el modal de edición necesita el id para
      // poder cambiar la sede (el nombre solo sirve para pintar la tabla).
      branch: o.branch?.name ?? null, branchId: o.branchId, sedeLegacy: o.sedeLegacy, username: o.username,
      isDefault: o.isDefault, online: o.online, onus: o._count.onus,
      defaults: {
        lineProfile: o.defaultLineProfile, srvProfile: o.defaultSrvProfile,
        vlan: o.defaultVlan, gemport: o.defaultGemport, userVlan: o.defaultUserVlan,
      },
    }));
  }

  async createOlt(dto: any, user?: AuthUser) {
    if (!dto.name || !dto.ip) throw new BadRequestException('Nombre e IP son obligatorios.');
    const sedeLegacy = Number(dto.sedeLegacy) || 0;
    // Primera OLT de la sede → por defecto.
    const already = await this.prisma.olt.count({ where: { sedeLegacy } });
    const olt = await this.prisma.olt.create({
      data: {
        name: dto.name, brand: dto.brand || 'Huawei', ip: dto.ip, port: String(dto.port || '22'),
        tech: dto.tech || 'GPON', transport: transporteDe(dto), sedeLegacy, branchId: dto.branchId || null,
        username: dto.username || '', password: encryptSecret(dto.password || ''),
        isDefault: already === 0,
        defaultLineProfile: dto.defaultLineProfile ? Number(dto.defaultLineProfile) : null,
        defaultSrvProfile: dto.defaultSrvProfile ? Number(dto.defaultSrvProfile) : null,
        defaultVlan: dto.defaultVlan ? Number(dto.defaultVlan) : null,
        defaultGemport: dto.defaultGemport ? Number(dto.defaultGemport) : null,
        defaultUserVlan: dto.defaultUserVlan ? Number(dto.defaultUserVlan) : null,
      },
    });
    await this.audit('LINK', olt, true, false, `Crear OLT ${olt.name}`, { user });
    return { ok: true, id: olt.id };
  }

  async updateOlt(id: string, dto: any, user?: AuthUser) {
    const olt = await this.resolveOlt(id);
    const data: Prisma.OltUpdateInput = {};
    for (const k of ['name', 'brand', 'ip', 'tech', 'username'] as const) {
      if (dto[k] !== undefined) (data as any)[k] = dto[k];
    }
    if (dto.transport !== undefined) data.transport = transporteDe(dto);
    if (dto.port !== undefined) data.port = String(dto.port);
    if (dto.sedeLegacy !== undefined) data.sedeLegacy = Number(dto.sedeLegacy);
    // La SEDE no se podía cambiar al editar, y de ella depende que una orden
    // encuentre su OLT: `oltDeSede` resuelve por `branchId`. Una OLT sin sede
    // —o con la equivocada— deja al técnico sin botón de autenticar.
    if (dto.branchId !== undefined) {
      data.branch = dto.branchId ? { connect: { id: dto.branchId } } : { disconnect: true };
    }
    // password: sólo si viene y no es la máscara.
    if (dto.password && !/^\*+$/.test(dto.password)) data.password = encryptSecret(dto.password);
    for (const k of ['defaultLineProfile', 'defaultSrvProfile', 'defaultVlan', 'defaultGemport', 'defaultUserVlan'] as const) {
      if (dto[k] !== undefined) (data as any)[k] = dto[k] === '' || dto[k] === null ? null : Number(dto[k]);
    }
    await this.prisma.olt.update({ where: { id }, data });
    await this.audit('LINK', olt, true, false, `Actualizar OLT ${olt.name}`, { user });
    return { ok: true };
  }

  async deleteOlt(id: string, user?: AuthUser) {
    const olt = await this.resolveOlt(id);
    await this.prisma.olt.delete({ where: { id } });
    await this.audit('DELETE', olt, true, false, `Eliminar OLT ${olt.name}`, { user });
    return { ok: true };
  }

  async setDefault(id: string) {
    const olt = await this.resolveOlt(id);
    await this.prisma.olt.updateMany({ where: { sedeLegacy: olt.sedeLegacy }, data: { isDefault: false } });
    await this.prisma.olt.update({ where: { id }, data: { isDefault: true } });
    return { ok: true };
  }

  // ------------------------------------------------------------------ //
  //  Lecturas en vivo (SSH)                                            //
  // ------------------------------------------------------------------ //

  async testConnection(id: string, user?: AuthUser) {
    const olt = await this.resolveOlt(id);
    const via = transporteDe(olt).toUpperCase();
    this.logger.log(`TEST OLT "${olt.name}" → ${olt.ip}:${olt.port} (${via} como "${olt.username}")${user?.name ? ` — pedido por ${user.name}` : ''}`);
    const driver = createOltDriver(olt.brand, olt.ip, olt.port, olt.username, decryptSecret(olt.password), transporteDe(olt));
    const ok = await driver.connect();
    const error = driver.getError();
    driver.disconnect();
    this.logger.log(`TEST OLT "${olt.name}" resultado: ${ok ? 'Conexión OK' : 'FALLÓ — ' + error}`);
    await this.prisma.olt.update({ where: { id }, data: { online: ok } });
    await this.audit('TEST', olt, ok, false, ok ? 'Conexión OK' : `ERROR: ${error}`, { user });
    return { ok, error };
  }

  async boards(id: string, frame = 0, refresh = false) {
    const olt = await this.resolveOlt(id);
    return this.conCache(`${olt.id}:boards:${frame}`, refresh, async () => {
      const r = await this.withDriver(olt, (d) => d.getBoards(frame));
      return { ok: r.ok, error: r.error, boards: r.data ?? [], raw: r.raw };
    });
  }

  async onus(id: string, frame = 0, slot: number | null, port: number | null) {
    const olt = await this.resolveOlt(id);
    const r = await this.withDriver(olt, (d) => d.getOnus(frame, slot, port));
    const onus = (r.data ?? []) as any[];
    // La OLT solo devuelve serial y estados; el abonado detrás de cada ONU vive
    // en el inventario local (sync/vínculo). Se cruza por SN para que la lista
    // diga de quién es cada ONU sin tener que abrir la ficha una por una.
    if (onus.length) {
      const sns = [...new Set(onus.map((o) => String(o.sn || '')).filter(Boolean))];
      const locales = await this.prisma.oltOnu.findMany({
        where: { oltId: olt.id, sn: { in: sns } },
        select: { sn: true, description: true, clientName: true, subscriberId: true },
      });
      const porSn = new Map(locales.map((l) => [String(l.sn).toUpperCase(), l]));
      for (const o of onus) {
        const l = porSn.get(String(o.sn || '').toUpperCase());
        o.client = l?.clientName ?? null;
        o.subscriberId = l?.subscriberId ?? null;
        // El comentario vivo de la OLT manda; la BD local solo complementa
        // (antes se pisaba con la BD y las descripciones recién grabadas
        // "desaparecían" hasta el siguiente sync).
        o.description = o.description || l?.description || null;
      }
    }
    return { ok: r.ok, error: r.error, onus, raw: r.raw };
  }

  async autofind(id: string) {
    const olt = await this.resolveOlt(id);
    const r = await this.withDriver(olt, (d) => d.getAutofind());
    return { ok: r.ok, error: r.error, onus: r.data ?? [], raw: r.raw };
  }

  /**
   * Velocidades disponibles = tablas de tráfico del equipo. Se devuelven con el
   * PIR ya convertido a Mbps para poder etiquetarlas en la UI ("102,5 Mbps").
   * OJO: no se infiere qué índice es subida y cuál bajada — en esta OLT no hay
   * regla consistente (100M usa in=54/out=53, pero 300M usa in=70/out=73), así
   * que la elección de cada sentido la hace el operador.
   */
  async trafficTables(id: string, refresh = false) {
    const olt = await this.resolveOlt(id);
    return this.conCache(`${olt.id}:traffic`, refresh, async () => {
      const r = await this.withDriver(olt, (d) => d.getTrafficTables());
      const tables = (r.data ?? []).map((t) => {
        const pir = Number(t.pir);
        const cir = Number(t.cir);
        return {
          ...t,
          mbps: Number.isFinite(pir) ? Math.round((pir / 1024) * 10) / 10 : null,
          cirMbps: Number.isFinite(cir) ? Math.round((cir / 1024) * 10) / 10 : null,
        };
      });
      return { ok: r.ok, error: r.error, tables, raw: r.raw };
    });
  }

  /**
   * Qué VLAN / perfil / velocidad usan los abonados que ya están en ese puerto.
   * Sirve para precargar el alta sin que el técnico se sepa la planta de memoria.
   */
  async sugerencia(id: string, frame: number, slot: number, port: number, model?: string | null) {
    // OJO: con vecinas NO se elige el srv-profile por el nombre del modelo. Se
    // probó y en esta planta el perfil "del modelo" (F680V9.0) deja la ONU en
    // `config: failed`; el que sí aplica es el que usan las ONTs que están en
    // `config: normal`. Por eso el srv-profile sugerido lo calcula
    // `sugerenciaDePuerto` a partir de lo que YA funciona en el puerto. El modelo
    // y el catálogo de VLANs solo entran cuando el puerto está VACÍO.
    const olt = await this.resolveOlt(id);
    const vlanCatalogo = await this.vlansDeCatalogo(olt, slot, port);
    const r = await this.withDriver(olt, (d) =>
      d.sugerenciaDePuerto(frame, slot, port, { model: model || null, vlanCatalogo }),
    );
    return { ok: r.ok, error: r.error, sugerencia: r.data ?? null };
  }

  /**
   * El mapa de la(s) OLT de una sede para el catálogo de VLANs: sus tarjetas
   * GPON/EPON, cuántos puertos tiene cada una y qué VLAN usa HOY cada puerto
   * según sus service-ports. Con esto `/red/vlans` deja de pedir que se teclee
   * la OLT, la bandeja y el puerto: se eligen de lo que el equipo tiene, y cada
   * fila del catálogo se puede contrastar con la planta.
   * Cacheado 10 min: leer todos los service-ports cuesta ~20 s por OLT.
   */
  async mapaVlansDeSede(branchId: string, refresh = false) {
    if (!branchId) throw new BadRequestException('Falta la sede.');
    const olts = await this.prisma.olt.findMany({
      where: { branchId },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });
    const salida = [];
    for (const olt of olts) {
      const r = await this.mapaDeOlt(olt, refresh);
      const tarjetas = (r.data?.tarjetas ?? [])
        .filter((b: any) => b.gpon || b.epon)
        .map((b: any) => {
          const slot = Number(b.slot);
          const n = puertosDeTarjeta(b.board);
          return {
            slot, board: b.board, status: b.status, tech: b.gpon ? 'GPON' : 'EPON',
            puertos: Array.from({ length: n }, (_, port) => {
              const p = (r.data?.puertos ?? []).find((q: any) => q.frame === 0 && q.slot === slot && q.port === port);
              return { port, servicios: p?.servicios ?? 0, vlans: p?.vlans ?? [] };
            }),
          };
        });
      salida.push({
        id: olt.id, name: olt.name, ok: r.ok, error: r.ok ? null : r.error,
        leidoEn: (r as any).leidoEn ?? null, cached: !!(r as any).cached, tarjetas,
      });
    }
    return { olts: salida };
  }

  /** Tarjetas + VLANs por PON de una OLT (caché 10 min, compartida con la salud de VLANs). */
  private mapaDeOlt(olt: Parameters<OltService['withDriver']>[0] & { id: string }, refresh: boolean) {
    return this.conCache(`${olt.id}:mapa-vlans`, refresh, async () => {
      const x = await this.withDriver(olt, async (d) => {
        const tarjetas = await d.getBoards(0);
        const puertos = await d.vlansPorPuerto();
        return { tarjetas: tarjetas || [], puertos: puertos || [] };
      });
      return { ok: x.ok, error: x.error, data: x.data, leidoEn: new Date().toISOString() };
    });
  }

  /**
   * Lo que la OLT dice de sus VLANs para `vlan-salud.ts`: cuáles existen, por
   * qué uplink sale cada una y qué VLAN lleva cada PON. SOLO LECTURA (`display`).
   * Caché 10 min como el mapa; `refresh` la salta (y relee también el mapa).
   * `'vlans'` relee solo las VLANs y deja los service-ports cacheados (~20 s):
   * es lo que hace falta justo antes de configurar.
   */
  async lecturaVlansDeOlt(oltId: string, refresh: boolean | 'vlans' = false): Promise<{
    ok: boolean; error: string; leidoEn: string | null; cached?: boolean; data: LecturaOltVlans | null;
  }> {
    const olt = await this.resolveOlt(oltId);
    const mapa = await this.mapaDeOlt(olt, refresh === true);
    if (!mapa.ok) return { ok: false, error: mapa.error, leidoEn: null, data: null };
    const r = await this.conCache(`${olt.id}:salud-vlans`, !!refresh, async () => {
      const x = await this.withDriver(olt, (d) => d.leerVlans());
      return { ok: x.ok && !!x.data, error: x.error, data: x.data || null, leidoEn: new Date().toISOString() };
    });
    if (!r.ok || !r.data) return { ok: false, error: r.error || 'No se pudieron leer las VLANs de la OLT.', leidoEn: null, data: null };
    return {
      ok: true, error: '', leidoEn: r.leidoEn, cached: !!(r as any).cached,
      data: { ...r.data, puertos: mapa.data?.puertos ?? [] },
    };
  }

  /**
   * Chequeo RÁPIDO de la VLAN de un PON, para avisar antes de autenticar: qué
   * VLAN lleva el puerto (la forzada, la principal de sus service-ports —del mapa
   * si está en caché, si no `display service-port port`— o la del catálogo) y
   * qué dice `display vlan N`. Una sola sesión, dos comandos. SOLO LECTURA.
   */
  async vlanDePuerto(oltId: string, frame: number, slot: number, port: number, vlanForzada?: number | null): Promise<{
    ok: boolean; error: string; vlan: number | null; origen: 'PLAN' | 'PUERTO' | 'CATALOGO' | null;
    detalle: { existe: boolean; uplinks: { fsp: string; estado: string }[] } | null;
  }> {
    const olt = await this.resolveOlt(oltId);
    const mapa = OltService.cacheLecturas.get(`${olt.id}:mapa-vlans`);
    const enMapa = mapa && Date.now() - mapa.at < OltService.CACHE_TTL_MS
      ? (mapa.data?.data?.puertos ?? []).find((q: any) => q.frame === frame && q.slot === slot && q.port === port)
      : undefined;
    const catalogo = await this.vlansDeCatalogo(olt, slot, port);
    const r = await this.withDriver(olt, async (d) => {
      let vlan: number | null = vlanForzada ?? null;
      let origen: 'PLAN' | 'PUERTO' | 'CATALOGO' | null = vlan ? 'PLAN' : null;
      if (!vlan) {
        let principal: number | null = enMapa?.vlans?.[0]?.vlan ?? null;
        if (!principal && !mapa) {
          const cuenta = new Map<number, number>();
          for (const f of await d.servicePortsDePuerto(frame, slot, port)) {
            const n = Number(f.vlan);
            if (n > 0) cuenta.set(n, (cuenta.get(n) ?? 0) + 1);
          }
          principal = [...cuenta.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
        }
        if (principal) { vlan = principal; origen = 'PUERTO'; }
        else if (catalogo.length === 1) { vlan = catalogo[0]; origen = 'CATALOGO'; }
      }
      if (!vlan) return { vlan: null, origen: null, detalle: null };
      const det = await d.detalleVlan(vlan);
      return { vlan, origen, detalle: det ? { existe: det.existe, uplinks: det.uplinks.map((u) => ({ fsp: u.fsp, estado: u.estado })) } : null };
    });
    return { ok: r.ok && !!r.data, error: r.error, vlan: r.data?.vlan ?? null, origen: r.data?.origen ?? null, detalle: r.data?.detalle ?? null };
  }

  /**
   * Crea una VLAN en la OLT y/o la pone en el uplink. Lo decide y lo pide
   * `VlanEquiposService` tras leer qué falta; aquí solo se ejecuta, con el mismo
   * gate que todas las escrituras de OLT (dry-run salvo OLT_LIVE / interruptor) y
   * quedando en `OltActionLog` con el usuario. Tras escribir se olvida la caché
   * para que la relectura vea el cambio.
   */
  async configurarVlanEnOlt(
    oltId: string, p: { vlan: number; crear: boolean; uplink: string | null }, user?: AuthUser, forzarDryRun = false,
  ): Promise<{ ok: boolean; dryRun: boolean; commands: string[]; respuestas?: { cmd: string; out: string }[]; error?: string }> {
    await this.syncLive();
    const olt = await this.resolveOlt(oltId);
    const commands = comandosOltParaVlan(p);
    if (!commands.length) return { ok: true, dryRun: forzarDryRun || !this.live, commands };
    if (forzarDryRun || !this.live) {
      if (!forzarDryRun) {
        await this.audit('VLAN', olt, true, true, `DRY-RUN VLAN ${p.vlan}: ` + commands.join(' · '), { fsp: p.uplink, user });
      }
      return { ok: true, dryRun: true, commands };
    }
    const r = await this.withDriver(olt, (d) => d.configurarVlan(p));
    const res = r.data || null;
    const ok = r.ok && !!res && res.ok;
    const error = ok ? undefined : (res && res.error) || r.error || 'La OLT no confirmó la configuración.';
    await this.audit('VLAN', olt, ok, false,
      `VLAN ${p.vlan}: ` + (res?.respuestas ?? commands.map((cmd) => ({ cmd, out: '' })))
        .map((x) => `${x.cmd} → ${x.out || '(sin respuesta)'}`).join(' · ') + (error ? ` | ERROR: ${error}` : ''),
      { fsp: p.uplink, user });
    OltService.cacheLecturas.delete(`${olt.id}:salud-vlans`);
    return { ok, dryRun: false, commands, respuestas: res?.respuestas, error };
  }

  /**
   * VLAN(s) que el catálogo de la sede (`/red/vlans`) apunta a esa bandeja y
   * puerto de OLT. Es lo único que dice qué VLAN lleva un PON que aún no tiene
   * ningún abonado. El catálogo no guarda el frame (todas las OLT son frame 0).
   */
  private async vlansDeCatalogo(olt: { id: string; branchId: string | null }, slot: number, port: number): Promise<number[]> {
    if (!olt.branchId || !Number.isFinite(slot) || !Number.isFinite(port)) return [];
    // Las heredadas del legacy no tienen OLT ligada: valen si son de la sede.
    const filas = await this.prisma.vlan.findMany({
      where: { branchId: olt.branchId, tray: slot, oltPort: port, OR: [{ oltId: olt.id }, { oltId: null }] },
      select: { vlan: true },
    });
    return [...new Set(filas.map((f) => f.vlan).filter((v) => v > 0))];
  }

  /**
   * Service-ports de VARIOS puertos PON en una sola sesión SSH.
   *
   * Se usa para averiguar a qué velocidad está funcionando de verdad cada plan
   * en la planta: con ~25 puertos se cubren cientos de abonados. Hacerlo con una
   * sesión por puerto agotaría las VTY del equipo (que son 4-8).
   */
  async servicePortsDePuertos(id: string, puertos: { frame: number; slot: number; port: number }[]) {
    const olt = await this.resolveOlt(id);
    const r = await this.withDriver(olt, async (d) => {
      const salida: { frame: number; slot: number; port: number; filas: any[] }[] = [];
      for (const p of puertos) {
        const filas = await d.servicePortsDePuerto(p.frame, p.slot, p.port);
        salida.push({ ...p, filas });
      }
      return salida;
    });
    return { ok: r.ok, error: r.error, puertos: (r.data as any[]) ?? [] };
  }

  async profiles(id: string, refresh = false) {
    const olt = await this.resolveOlt(id);
    return this.conCache(`${olt.id}:profiles`, refresh, async () => {
      const r = await this.withDriver(olt, (d) => d.getProfiles());
      const data = r.data as { line: any[]; srv: any[] } | null;
      return { ok: r.ok, error: r.error, line: data?.line ?? [], srv: data?.srv ?? [], raw: r.raw };
    });
  }

  async systemInfo(id: string, refresh = false) {
    const olt = await this.resolveOlt(id);
    return this.conCache(`${olt.id}:system`, refresh, async () => {
      const r = await this.withDriver(olt, (d) => d.getSystemInfo());
      return { ok: r.ok, error: r.error, info: r.data ?? {}, raw: r.raw };
    });
  }

  /**
   * Resumen de ocupación de un slot (ONUs por puerto). Recorre los 16 puertos
   * por SSH, así que se cachea como las demás lecturas lentas; `refresh` fuerza
   * el barrido real.
   */
  async slotSummary(id: string, frame = 0, slot: number, refresh = false) {
    const olt = await this.resolveOlt(id);
    return this.conCache(`${olt.id}:slotsum:${frame}/${slot}`, refresh, async () => {
      const r = await this.withDriver(olt, (d) => d.getSlotSummary(frame, slot));
      return { ok: r.ok, error: r.error, summary: r.data ?? {}, raw: r.raw };
    });
  }

  async ontDetail(id: string, frame: number, slot: number, port: number, ontId: number) {
    const olt = await this.resolveOlt(id);
    const r = await this.withDriver(olt, (d) => d.getOntDetail(frame, slot, port, ontId));
    return { ok: r.ok, error: r.error, detail: r.data ?? {}, raw: r.raw };
  }

  /** Óptica en vivo de una ONU: se pide aparte del detalle porque es lo lento. */
  async ontOptical(id: string, frame: number, slot: number, port: number, ontId: number) {
    const olt = await this.resolveOlt(id);
    const r = await this.withDriver(olt, (d) => d.getOntOptical(frame, slot, port, ontId));
    return { ok: r.ok, error: r.error, optical: r.data ?? {}, raw: r.raw };
  }

  // ------------------------------------------------------------------ //
  //  Señal óptica del abonado (bloque de la ficha del cliente)          //
  // ------------------------------------------------------------------ //

  /**
   * Dónde está la ONU de un abonado, para poder preguntarle a la OLT por ella.
   *
   * Manda el EQUIPO ASIGNADO en inventario, no el vínculo de `OltOnu`: cuando al
   * cliente le cambian la ONU, el inventario se actualiza en la orden, pero la fila
   * vieja de `OltOnu` sigue apuntándolo hasta que alguien la desvincule (abonado
   * 54519: la ficha leía la ONU que ya tenía otro cliente). En orden:
   *  1. El serial rotulado del equipo asignado, traducido a HEX
   *     (`ZTEGDE519D2C` → `5A544547DE519D2C`) y buscado en `OltOnu`.
   *  2. Ese mismo SN preguntado a la OLT de su sede (`display ont info by-sn`):
   *     cubre los puertos que el sync aún no ha leído.
   *  3. Sólo si el cliente NO tiene ningún equipo con serial de ONU (EoC, legacy sin
   *     inventario): la ONU vinculada (`OltOnu.subscriberId`), la `presente` primero.
   */
  private async ubicarOnuDeAbonado(sub: { id: string; branchId: string | null }) {
    const equipos = await this.prisma.equipment.findMany({
      where: { subscriberId: sub.id },
      select: { serial: true, code: true },
      orderBy: { code: 'desc' },
    });
    // El más reciente primero (`code` desc): si arrastra dos, el nuevo es el instalado.
    const onus = equipos
      .map((e) => ({ serial: String(e.serial ?? ''), hex: formaHex(e.serial) }))
      .filter((e): e is { serial: string; hex: string } => !!e.hex);

    if (onus.length) {
      const hex = [...new Set(onus.map((e) => e.hex))];
      const filas = await this.prisma.oltOnu.findMany({
        where: { sn: { in: hex } },
        include: { olt: true },
        orderBy: { lastSync: 'desc' },
      });
      const porSerial = filas.find((o) => o.syncState === 'presente' && o.ontId !== null) ?? filas[0];
      if (porSerial) {
        const serial = onus.find((e) => e.hex === porSerial.sn)?.serial ?? porSerial.sn;
        return { fila: porSerial, olt: porSerial.olt, via: 'SERIAL' as const, serial };
      }
      const olt = sub.branchId
        ? await this.prisma.olt.findFirst({
            where: { branchId: sub.branchId },
            orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
          })
        : null;
      if (olt) return { fila: null, olt, sn: onus[0].hex, serial: onus[0].serial, via: 'BUSQUEDA' as const };
    }

    const vinculadas = await this.prisma.oltOnu.findMany({
      where: { subscriberId: sub.id },
      include: { olt: true },
      orderBy: { lastSync: 'desc' },
    });
    const vinculada = vinculadas.find((o) => o.syncState === 'presente' && o.ontId !== null)
      ?? vinculadas.find((o) => o.ontId !== null)
      ?? vinculadas[0];
    if (vinculada) return { fila: vinculada, olt: vinculada.olt, via: 'VINCULADA' as const, serial: vinculada.sn };
    return null;
  }

  /** Número de un valor que la OLT devuelve como texto ("-21.50" → -21.5). */
  private numeroOptico(v: unknown): number | null {
    const s = String(v ?? '').trim().replace(',', '.');
    if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  /**
   * Potencias ópticas de la ONU del abonado — el bloque "Señal óptica" de la
   * ficha del cliente.
   *
   * Es UNA sesión contra la OLT que trae dos cosas: el estado de la ONT
   * (`display ont info`, con la distancia y por qué se cayó la última vez) y las
   * potencias (`display ont optical-info`: lo que RECIBE la ONT, lo que TRANSMITE
   * y lo que la OLT recibe de ella). Nada de esto está guardado en la base —
   * `OltOnu.rxPower` es la foto del último sync — así que se pregunta en vivo.
   *
   * Se cachea 60 s: la ficha del cliente la abre medio mundo y las OLT Huawei
   * aguantan pocas sesiones VTY. `refresh` (el botón "Refrescar") la salta.
   */
  async opticaDeAbonado(subscriberId: string, refresh = false) {
    const sub = await this.prisma.subscriber.findUnique({
      where: { id: subscriberId },
      select: { id: true, abonado: true, branchId: true, installTech: true },
    });
    if (!sub) throw new NotFoundException('Cliente no encontrado.');

    const ubic = await this.ubicarOnuDeAbonado(sub);
    if (!ubic) {
      return {
        ok: false,
        motivo: 'SIN_ONU',
        error: 'Este cliente no tiene ninguna ONU vinculada en la OLT ni un equipo con serial de ONU en el inventario.',
      };
    }
    const { olt, via } = ubic;
    const snAsignado: string | null = ubic.fila?.sn ?? (ubic as any).sn ?? null;

    return this.conCache(`${olt.id}:optica-abonado:${sub.id}`, refresh, async () => {
      const primera = await this.leerOpticaDeOnu(sub, olt, via, ubic.fila, snAsignado, ubic.serial ?? null);
      if (primera.motivo !== 'NO_AUTENTICADA') return primera;

      // El inventario dice un equipo y la OLT no lo tiene. Antes de decirlo, se mira
      // con QUÉ equipo está conectado de verdad: la MAC de su sesión PPPoE (caller-id)
      // es la del aparato que está en la casa (abonado 54519: el inventario tenía el
      // ZTE ...CDF y en la casa estaba el ...CBD, un carácter de diferencia).
      const mac = await this.mikrotik?.callerIdDeAbonado(sub.id).catch(() => null);
      if (!mac) return primera;
      const eq = await this.prisma.equipment.findFirst({
        where: { mac: { equals: mac, mode: 'insensitive' } },
        select: { serial: true, code: true },
      });
      const hex = formaHex(eq?.serial);
      if (!eq || !hex || hex === snAsignado) return primera;
      const segunda = await this.leerOpticaDeOnu(sub, olt, 'MAC', null, hex, eq.serial);
      if (!segunda.ok) return primera;
      return {
        ...segunda,
        avisoVinculo:
          `El inventario le asigna ${ubic.serial ?? snAsignado}, pero está conectado con ${eq.serial} ` +
          `(código ${eq.code}, MAC ${mac}): la lectura es de ese equipo. Corrija el equipo asignado.`,
      };
    });
  }

  /** Una lectura de estado + óptica de UNA ONU (por posición guardada o por SN). */
  private async leerOpticaDeOnu(
    sub: { id: string; abonado: number | null },
    olt: any,
    via: string,
    fila: any,
    snBuscado: string | null,
    serial: string | null,
  ): Promise<any> {
      const r = await this.withDriver(olt, async (d) => {
        let frame = fila?.frame ?? 0;
        let slot = fila?.slot ?? null;
        let port = fila?.port ?? null;
        let ontId = fila?.ontId ?? null;
        let sn = snBuscado;

        // Sin F/S/P no hay a quién preguntarle: se localiza por SN en la OLT.
        if (slot === null || port === null || ontId === null) {
          if (!sn) return false;
          const onu = await d.findBySn(sn);
          // El equipo asignado no está dado de alta en la OLT: no es un fallo de
          // lectura, y se dice con el serial rotulado, que es el que se ve en la caja.
          if (!onu) {
            return {
              motivo: 'NO_AUTENTICADA',
              error: `El equipo asignado (${serial ?? sn}) no aparece autenticado en la OLT ${olt.name}: sin eso la OLT no tiene potencias que dar.`,
            } as any;
          }
          const pos = this.fspDeOnu(onu);
          if (!pos) return { error: 'La OLT encontró la ONU pero no reporta F/S/P u ont-id.' } as any;
          ({ frame, slot, port, ontId } = pos);
          sn = String(onu.sn ?? sn);
        }

        let detail = await d.getOntDetail(frame, slot as number, port as number, ontId as number);
        // La posición guardada es la del último sync, y la ONU se pudo mover desde
        // entonces (re-autenticada desde SmartOLT en otro puerto): la OLT contesta
        // "The ONT does not exist". Se busca por SN antes de rendirse.
        let movida: { antes: string; descripcion: string } | null = null;
        if (detail === false && fila && sn && /does not exist/i.test(d.getError())) {
          const antes = `${frame}/${slot}/${port}:${ontId}`;
          const onu = await d.findBySn(sn);
          const pos = onu ? this.fspDeOnu(onu) : null;
          if (!pos) return { error: `La ONU ${sn} ya no está autenticada en la OLT (estaba en ${antes}).` } as any;
          movida = { antes, descripcion: String(onu.description ?? '') };
          ({ frame, slot, port, ontId } = pos);
          detail = await d.getOntDetail(frame, slot, port, ontId);
        }
        if (detail === false) return false;
        const optical = await d.getOntOptical(frame, slot as number, port as number, ontId as number);
        return {
          fsp: `${frame}/${slot}/${port}`,
          frame, slot, port, ontId,
          sn: String(detail.sn ?? sn ?? ''),
          detail,
          movida,
          optical: optical === false ? null : optical,
          errorOptica: optical === false ? d.getError() : '',
        } as any;
      });

      if (!r.ok || !r.data) {
        return {
          ok: false,
          motivo: 'OLT',
          error: r.error || 'No se pudo consultar la OLT.',
          olt: { id: olt.id, name: olt.name },
        };
      }
      const dat = r.data;
      if (dat.error) {
        return { ok: false, motivo: dat.motivo ?? 'OLT', error: dat.error, olt: { id: olt.id, name: olt.name } };
      }
      const o = dat.optical ?? {};
      const sinLecturas = [o.rx, o.tx, o.olt_rx].every((v) => this.numeroOptico(v) === null);
      // Si apareció en otra posición, su descripción dice de quién es: empieza por
      // el número de abonado. Si es OTRO, las potencias no son de este cliente y el
      // vínculo de la ficha quedó viejo.
      let avisoVinculo = '';
      if (dat.movida) {
        const num = String(dat.movida.descripcion).match(/^\s*(\d{3,})/)?.[1];
        const nueva = `${dat.fsp}:${dat.ontId}`;
        avisoVinculo = num && sub.abonado != null && num !== String(sub.abonado)
          ? `Esta ONU ya no está en ${dat.movida.antes}: la OLT la tiene en ${nueva} a nombre de otro abonado (${dat.movida.descripcion}). El vínculo de esta ficha está desactualizado.`
          : `La ONU se movió de ${dat.movida.antes} a ${nueva}; la lectura es de la posición actual.`;
      }
      return {
        ok: true,
        via,
        avisoVinculo,
        olt: { id: olt.id, name: olt.name },
        onu: {
          sn: dat.sn || null,
          fsp: dat.fsp,
          ontId: dat.ontId,
          descripcion: dat.detail.description ?? null,
        },
        estado: {
          run: dat.detail.run_state ?? null,
          config: dat.detail.config_state ?? null,
          match: dat.detail.match_state ?? null,
          distancia: this.numeroOptico(dat.detail.distance),
          ultimaCaida: dat.detail.last_down ?? null,
          causaCaida: dat.detail.last_down_cause ?? null,
          desdeCuando: dat.detail.online_duration ?? dat.detail.last_up ?? null,
        },
        // Las tres potencias que se miran para decidir si la fibra está bien:
        // rx = lo que RECIBE la ONT del cliente (la que manda), tx = lo que ella
        // emite, oltRx = lo que la OLT recibe de ella (delata un empalme flojo
        // en el camino de vuelta aunque el rx del cliente se vea bien).
        optica: {
          rx: this.numeroOptico(o.rx),
          tx: this.numeroOptico(o.tx),
          oltRx: this.numeroOptico(o.olt_rx),
          temperatura: this.numeroOptico(o.temp),
          voltaje: this.numeroOptico(o.voltage),
          corriente: this.numeroOptico(o.current),
        },
        // La ONT apagada no tiene óptica que dar: la OLT responde el bloque con los
        // campos vacíos. Se dice con palabras en vez de pintar tres guiones, que es
        // la diferencia entre "está apagada" y "esto no funciona".
        avisoOptica: dat.errorOptica || (sinLecturas
          ? (/offline|down/i.test(String(dat.detail.run_state ?? ''))
            ? 'La ONT está offline, así que la OLT no reporta potencias: equipo apagado, sin luz en la casa, fibra cortada o sin sincronizar.'
            : 'La OLT no devolvió lecturas ópticas para esta ONU.')
          : ''),
        consultadoEn: new Date().toISOString(),
      };
  }

  /**
   * La VLAN con la que la OLT tiene dada de alta la ONU del abonado: la de su
   * service-port (`display service-port port F/S/P`, filtrado por su ONT-ID).
   *
   * Es la que manda de verdad —la caja NAP o la ficha pueden decir otra, pero el
   * tráfico del cliente sale por ésta—, así que la pestaña Equipos la rellena sola
   * en vez de pedírsela a quien edita. Con varios service-ports (internet + TV/voz)
   * se devuelven todos y `vlan` es el de índice más bajo, que es el que se crea
   * primero al autenticar: el de datos.
   *
   * Se localiza la ONU igual que la óptica (`ubicarOnuDeAbonado`) y se cachea 60 s.
   */
  async vlanDeAbonado(subscriberId: string, refresh = false) {
    const sub = await this.prisma.subscriber.findUnique({
      where: { id: subscriberId },
      select: { id: true, branchId: true },
    });
    if (!sub) throw new NotFoundException('Cliente no encontrado.');

    const ubic = await this.ubicarOnuDeAbonado(sub);
    if (!ubic) {
      return {
        ok: false, motivo: 'SIN_ONU', vlan: null as number | null, vlans: [] as number[],
        error: 'Este cliente no tiene ninguna ONU vinculada en la OLT ni un equipo con serial de ONU en el inventario.',
      };
    }
    const { fila, olt } = ubic;
    const snBuscado = fila?.sn ?? (ubic as any).sn ?? null;

    return this.conCache(`${olt.id}:vlan-abonado:${sub.id}`, refresh, async () => {
      const r = await this.withDriver(olt, async (d) => {
        let frame = fila?.frame ?? 0;
        let slot = fila?.slot ?? null;
        let port = fila?.port ?? null;
        let ontId = fila?.ontId ?? null;
        if (slot === null || port === null || ontId === null) {
          if (!snBuscado) return false;
          const onu = await d.findBySn(snBuscado);
          if (!onu) return false;
          const pos = this.fspDeOnu(onu);
          if (!pos) return false;
          ({ frame, slot, port, ontId } = pos);
        }
        const leer = async (f: number, s: number, p: number, id: number) => ({
          fsp: `${f}/${s}/${p}`, ontId: id,
          sps: ((await d.servicePortsDePuerto(f, s, p)) ?? []).filter((x: any) => Number(x.ontId) === Number(id)),
        });
        const enSuSitio = await leer(frame, slot as number, port as number, ontId as number);
        if (enSuSitio.sps.length || !fila) return enSuSitio;

        // La fila vinculada puede estar vieja: la ONU se movió de puerto o se volvió a
        // autenticar con otro ONT-ID, y en esa posición ya no hay nada (visto con un
        // cliente de VILLANUEVA: 0/0/10 ONT 2 "does not exist"). Se busca por serial
        // —el de la ONU vinculada y el del equipo del inventario— antes de rendirse.
        const equipos = await this.prisma.equipment.findMany({ where: { subscriberId: sub.id }, select: { serial: true } });
        const seriales = [...new Set([fila.sn, ...equipos.map((e) => formaHex(e.serial))].filter(Boolean) as string[])];
        for (const sn of seriales) {
          const onu = await d.findBySn(sn);
          const pos = onu ? this.fspDeOnu(onu) : null;
          if (!pos) continue;
          const alli = await leer(pos.frame, pos.slot, pos.port, pos.ontId);
          if (alli.sps.length) return alli;
        }
        return enSuSitio;
      });

      const base = { olt: { id: olt.id, name: olt.name } };
      if (!r.ok || !r.data) {
        return { ok: false, motivo: 'OLT', vlan: null as number | null, vlans: [] as number[], error: r.error || 'No se pudo consultar la OLT.', ...base };
      }
      const sps = [...r.data.sps].sort((a: any, b: any) => Number(a.index) - Number(b.index));
      const vlans = [...new Set(sps.map((s: any) => Number(s.vlan)).filter((v) => Number.isInteger(v) && v > 0))];
      if (!vlans.length) {
        return {
          ok: false, motivo: 'SIN_SERVICE_PORT', vlan: null as number | null, vlans,
          error: `La ONU ${r.data.fsp}:${r.data.ontId} no tiene service-port en la OLT: no hay VLAN que leer.`,
          ...base,
        };
      }
      return { ok: true, vlan: vlans[0], vlans, fsp: r.data.fsp, ontId: r.data.ontId, ...base, consultadoEn: new Date().toISOString() };
    });
  }

  async findBySn(id: string, sn: string) {
    const olt = await this.resolveOlt(id);
    const r = await this.withDriver(olt, (d) => d.findBySn(sn));
    return { ok: r.ok, error: r.error, onu: r.data ?? {}, raw: r.raw };
  }

  /**
   * Dónde está y CÓMO está dada de alta una ONU, buscada por SN: puerto, ONT-ID,
   * line/srv-profile, comentario y sus service-ports (VLAN, GEM y traffic-tables).
   * Solo lectura. Es lo que hace falta para volver a darla de alta igual que
   * estaba cambiando únicamente la velocidad (ver `OnuProvisionService.reautenticarConPlan`).
   */
  async estadoPorSn(id: string, sn: string) {
    const olt = await this.resolveOlt(id);
    const r = await this.withDriver(olt, (d) => d.estadoPorSn(sn));
    return { ok: r.ok && !!r.data, error: r.error || (r.data ? '' : 'La ONU no está autenticada en esta OLT.'), estado: r.data ?? null };
  }

  /** F/S/P + ont-id a partir del bloque que devuelve findBySn. */
  private fspDeOnu(onu: any): { frame: number; slot: number; port: number; ontId: number } | null {
    const m = String(onu?.fsp || '').match(/(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)/);
    const ontId = Number(onu?.ont_id);
    if (!m || Number.isNaN(ontId)) return null;
    return { frame: Number(m[1]), slot: Number(m[2]), port: Number(m[3]), ontId };
  }

  /**
   * Estado del puerto CATV (RF) de una ONT buscada por SN. Es el corte de TV
   * para ONTs combo SIN TR-069 (gestión OMCI): la palanca vive en la OLT.
   * Lectura en vivo, sin gate.
   */
  async catvState(id: string, sn: string) {
    const olt = await this.resolveOlt(id);
    if (!sn) throw new BadRequestException('Debe indicar el SN de la ONT.');
    const r = await this.withDriver(olt, async (d) => {
      const onu = await d.findBySn(sn);
      if (!onu) return false;
      const pos = this.fspDeOnu(onu);
      if (!pos) return { onu, ports: null, error: 'La ONT no reporta F/S/P u ont-id.' };
      const ports = await d.getCatvPorts(pos.frame, pos.slot, pos.port, pos.ontId);
      return { onu, ports: ports === false ? null : ports, error: ports === false ? d.getError() : '' };
    });
    if (!r.ok) return { ok: false, error: r.error, onu: null, ports: null };
    const data = r.data as any;
    return { ok: !data.error, error: data.error || '', onu: data.onu, ports: data.ports };
  }

  /** Corta/activa el puerto CATV de una ONT por SN (OMCI). Dry-run salvo OLT_LIVE=true. */
  async setCatv(id: string, params: { sn: string; catvPort?: number | string; enable: boolean }, user?: AuthUser) {
    await this.syncLive();
    const olt = await this.resolveOlt(id);
    const sn = String(params.sn ?? '').trim();
    if (!sn) throw new BadRequestException('Debe indicar el SN de la ONT.');
    const catvPort = Number(params.catvPort ?? 1) || 1;
    const enable = params.enable === true;
    const verb = enable ? 'ACTIVAR' : 'CORTAR';

    if (!this.live) {
      const commands = [`display ont info by-sn ${sn}`, 'interface gpon <f>/<s>', `ont port attribute <p> <ont-id> catv ${catvPort} operational-state ${enable ? 'on' : 'off'}`, 'quit'];
      await this.audit('CATV', olt, true, true, `DRY-RUN ${verb} CATV SN ${sn}: ` + commands.join(' · '), { sn, user });
      return { ok: true, dryRun: true, message: `DRY-RUN: no se contacta la OLT. Active OLT_LIVE=true para ejecutar.`, commands };
    }

    this.logger.warn(`${verb} CATV (LIVE) SN ${sn} en "${olt.name}" (${olt.ip})${user?.name ? ` — pedido por ${user.name}` : ''}`);
    const r = await this.withDriver(olt, async (d) => {
      const onu = await d.findBySn(sn);
      if (!onu) return false;
      const pos = this.fspDeOnu(onu);
      if (!pos) { return { error: 'La ONT no reporta F/S/P u ont-id.' }; }
      const res = await d.setCatvState({ frame: pos.frame, slot: pos.slot, port: pos.port, ont_id: pos.ontId, catvPort, enable });
      if (!res) return false;
      // Releer el estado: la confirmación de verdad es el LinkState del puerto.
      // La OLT tarda 1-2 s en reflejar el cambio; una releída inmediata devuelve
      // el estado VIEJO (pasó en vivo: corte OK auditado como "catv1=up"). Se
      // reintenta hasta ver el estado esperado o agotar los intentos.
      const esperado = enable ? 'up' : 'down';
      let ports: any[] | null = null;
      for (let i = 0; i < 4; i++) {
        await new Promise((w) => setTimeout(w, i === 0 ? 900 : 1300));
        const read = await d.getCatvPorts(pos.frame, pos.slot, pos.port, pos.ontId);
        if (read !== false) {
          ports = read;
          const objetivo = read.find((x: any) => Number(x.portId) === catvPort);
          if (objetivo?.linkState === esperado) break;
        }
      }
      return { ...res, fsp: `${pos.frame}/${pos.slot}/${pos.port}:${pos.ontId}`, ports };
    });
    const res = r.data as any;
    const fsp = res?.fsp ?? null;
    const err = !r.ok ? r.error : res?.error;
    const estado = res?.ports?.map((p: any) => `catv${p.portId}=${p.linkState}`).join(',') ?? 'sin lectura';
    await this.audit('CATV', olt, r.ok && !res?.error, false,
      r.ok && !res?.error ? `${verb} CATV SN ${sn} (${fsp}) → ${estado}` : `ERROR: ${err}`,
      { sn, fsp, user });
    if (!r.ok || res?.error) return { ok: false, dryRun: false, error: err, raw: r.raw };
    return { ok: true, dryRun: false, message: res.message, fsp, ports: res.ports, raw: r.raw };
  }

  // ------------------------------------------------------------------ //
  //  Escrituras (GATE dry-run)                                         //
  // ------------------------------------------------------------------ //

  /** Autenticar/aprovisionar una ONU por SN. Dry-run salvo OLT_LIVE=true. */
  async provision(id: string, params: any, user?: AuthUser) {
    await this.syncLive();
    const olt = await this.resolveOlt(id);
    if (!params.sn) throw new BadRequestException('Debe indicar el SN de la ONU.');
    if (params.slot === undefined || params.slot === '' || params.port === undefined || params.port === '') {
      throw new BadRequestException('Debe indicar slot y puerto.');
    }
    if (!params.lineprofile || !params.srvprofile) {
      throw new BadRequestException('Debe indicar line-profile y srv-profile.');
    }
    const fsp = `${params.frame ?? 0}/${params.slot}/${params.port}`;

    if (!this.live) {
      const drv = new OltHuawei(olt.ip, olt.port, olt.username, decryptSecret(olt.password));
      const commands = drv.buildProvisionCommands(params);
      this.logger.log(`AUTENTICAR ONU (DRY-RUN) SN ${params.sn} en "${olt.name}" fsp ${fsp} — ${commands.length} comandos, NO se contacta la OLT`);
      await this.audit('PROVISION', olt, true, true, `DRY-RUN autenticar SN ${params.sn}: ` + commands.join(' · '), { sn: params.sn, fsp, user });
      return { ok: true, dryRun: true, message: `DRY-RUN: no se contacta la OLT. Active OLT_LIVE=true para autenticar de verdad.`, commands };
    }

    this.logger.warn(`AUTENTICAR ONU (LIVE) SN ${params.sn} en "${olt.name}" (${olt.ip}) fsp ${fsp}${user?.name ? ` — pedido por ${user.name}` : ''}`);
    const r = await this.withDriver(olt, (d) => d.provisionOnu(params));
    const res = r.data as any;

    // La ONU ya estaba dada de alta (aquí, desde SmartOLT o a mano). No es un
    // error de perfil: se devuelve DÓNDE está y con qué velocidad, para que la
    // UI pueda ofrecer adoptarla en vez de mandar a reintentar a ciegas.
    if (r.ok && res?.ok === false && res?.codigo === 'SN_YA_EXISTE') {
      const e = res.existente;
      this.logger.warn(
        `AUTENTICAR SN ${params.sn}: la OLT "${olt.name}" dice que el SN ya existe`
        + (e ? ` — está en ${e.fsp}:${e.ont_id}, ${e.run_state}/${e.config_state}, ${e.servicePorts?.length ?? 0} service-port(s)` : ' y no se pudo localizar'),
      );
      await this.audit('PROVISION', olt, false, false,
        `SN ${params.sn} YA EXISTE${e ? ` en ${e.fsp}:${e.ont_id}` : ''} — no se re-autentica`,
        { sn: params.sn, fsp: e ? `${e.fsp}:${e.ont_id}` : fsp, user });
      return { ok: false, dryRun: false, codigo: 'SN_YA_EXISTE', error: res.error, existente: e ?? null, raw: r.raw };
    }
    await this.audit('PROVISION', olt, r.ok, false, r.ok ? (res?.message ?? 'ONT agregada') : `ERROR: ${r.error}`, { sn: params.sn, fsp, user });
    // Traza SIEMPRE la sesión de un alta, aunque el CLI no diera error: el fallo
    // típico (config: failed / sin service-port) no es un error de comando y de
    // otro modo no quedaría rastro para diagnosticar.
    const v = res?.verificacion;
    this.logger.log(
      `AUTENTICAR resultado SN ${params.sn} fsp ${fsp} · lp=${params.lineprofile} sp=${params.srvprofile} ` +
      `vlan=${params.vlan ?? '-'} gem=${params.gemport ?? '-'} rx=${params.traffic_in ?? '-'} tx=${params.traffic_out ?? '-'} · ` +
      (v ? `verif: run=${v.run_state} config=${v.config_state} match=${v.match_state} sp=${v.servicePorts?.length ?? 0}` +
           (v.avisos?.length ? ` · avisos: ${v.avisos.join(' | ')}` : '') : 'sin verificación') +
      // Lo que contestó la OLT a CADA comando de escritura, íntegro. La
      // transcripción se recorta por la cola y en un alta la cola es el listado
      // del puerto entero, así que el "Failure:" del service-port se perdía.
      (res?.respuestas?.length
        ? '\n--- respuestas de la OLT ---\n'
          + res.respuestas.map((x: any) => `$ ${x.cmd}\n  → ${x.out || '(sin salida)'}`).join('\n')
        : '') +
      `\n--- transcripción SSH ---\n${(r.raw || '').slice(-4000)}\n--- fin ---`,
    );
    if (!r.ok) return { ok: false, dryRun: false, error: r.error, raw: r.raw };
    // Registrar el alta en el inventario local de una vez: el comentario y el
    // vínculo F/S/P quedan visibles sin esperar al próximo sync del slot.
    await this.upsertOnu(olt.id, {
      sn: String(params.sn).trim().toUpperCase(),
      frame: params.frame ?? 0, slot: params.slot, port: params.port,
      ont_id: res.ont_id !== '' ? res.ont_id : undefined,
      description: params.desc !== undefined && params.desc !== '' ? String(params.desc) : undefined,
      run_state: v?.run_state, config_state: v?.config_state, match_state: v?.match_state,
    }, new Date()).catch((e) => this.logger.warn(`No se pudo guardar la ONU recién autenticada en el inventario local: ${e.message}`));
    return { ok: true, dryRun: false, message: res.message, ontId: res.ont_id, commands: res.commands, verificacion: res.verificacion ?? null, raw: r.raw };
  }

  /**
   * ADOPTA una ONU que ya está autenticada en la OLT: le pone el comentario y la
   * velocidad que le tocan y la registra en el inventario (opcionalmente
   * vinculada a un abonado). No la borra ni la vuelve a dar de alta.
   *
   * Existe porque la planta lleva años dándose de alta desde SmartOLT y a mano:
   * cuando esas ONUs se tocan desde aquí, la OLT responde "SN already exists" y
   * hasta ahora eso era un callejón sin salida. Borrar y rehacer sería dejar al
   * abonado sin servicio a cambio de nada.
   * Dry-run salvo OLT_LIVE=true.
   */
  async adoptar(
    id: string,
    params: {
      sn: string; desc?: string | null;
      traffic_in?: number | string | null; traffic_out?: number | string | null;
      /** Solo se usan si la ONU está SIN service-port y hay que crearle uno. */
      vlan?: number | string | null; gemport?: number | string | null; user_vlan?: number | string | null;
      subscriberId?: string | null;
    },
    user?: AuthUser,
  ) {
    await this.syncLive();
    const olt = await this.resolveOlt(id);
    const sn = String(params.sn ?? '').trim().toUpperCase();
    if (!sn) throw new BadRequestException('Debe indicar el SN de la ONU.');

    if (!this.live) {
      const commands = [
        `display ont info by-sn ${sn}`,
        ...(params.desc ? [`ont modify <puerto> <ont-id> desc "${params.desc}"`] : []),
        ...(params.traffic_in || params.traffic_out
          ? [`service-port <índice> inbound traffic-table index ${params.traffic_in ?? '-'} outbound traffic-table index ${params.traffic_out ?? '-'}`]
          : []),
        '(si la ONU no tiene service-port, se le crea uno con la VLAN y el GEM del puerto)',
      ];
      await this.audit('ADOPTAR', olt, true, true, `DRY-RUN adoptar SN ${sn}: ` + commands.join(' · '), { sn, user, subscriberId: params.subscriberId ?? null });
      return { ok: true, dryRun: true, message: 'DRY-RUN: no se contacta la OLT. Active OLT_LIVE=true para adoptar de verdad.', commands };
    }

    this.logger.warn(`ADOPTAR ONU (LIVE) SN ${sn} en "${olt.name}" (${olt.ip})${user?.name ? ` — pedido por ${user.name}` : ''}`);
    const r = await this.withDriver(olt, (d) => d.adoptarOnu({
      sn, desc: params.desc ?? null,
      traffic_in: params.traffic_in ?? null, traffic_out: params.traffic_out ?? null,
      // Sin valores por defecto de la OLT a propósito: si hay que crear el
      // service-port, manda lo que YA funciona en ese puerto (y el GEM real de
      // la ONT), no un ajuste global que puede no valer para este PON.
      vlan: params.vlan ?? null,
      gemport: params.gemport ?? null,
      user_vlan: params.user_vlan ?? null,
    }));
    const res = r.data as any;
    const fsp = res?.fsp ? `${res.fsp}:${res.ont_id}` : null;
    await this.audit('ADOPTAR', olt, r.ok, false,
      r.ok ? (res?.message ?? 'ONU adoptada') : `ERROR: ${r.error}`,
      { sn, fsp, user, subscriberId: params.subscriberId ?? null });
    this.logger.log(
      `ADOPTAR resultado SN ${sn} ${fsp ?? '(sin posición)'} · ${r.ok ? (res?.cambios?.join(' · ') || 'sin cambios') : 'ERROR: ' + r.error}`
      + (res?.avisos?.length ? ` · avisos: ${res.avisos.join(' | ')}` : ''),
    );
    if (!r.ok) return { ok: false, dryRun: false, error: r.error, raw: r.raw };

    // Al inventario local, con el estado real que reportó la OLT. Es lo que hace
    // que la ONU pase a existir para el resto del sistema (ficha del abonado,
    // "subir megas", cortes): hasta aquí solo existía en el equipo.
    const v = res.verificacion;
    await this.upsertOnu(olt.id, {
      sn, frame: res.frame, slot: res.slot, port: res.port, ont_id: res.ont_id,
      description: res.antes?.description !== undefined && params.desc ? String(params.desc) : res.antes?.description,
      run_state: v?.run_state, config_state: v?.config_state, match_state: v?.match_state,
    }, new Date()).catch((e) => this.logger.warn(`ONU ${sn} adoptada pero no se pudo guardar en el inventario local: ${e.message}`));
    if (params.subscriberId) {
      const onu = await this.prisma.oltOnu.findFirst({ where: { oltId: olt.id, sn }, select: { id: true } });
      if (onu) await this.linkCustomer(onu.id, params.subscriberId, user).catch((e) => this.logger.warn(`ONU ${sn} adoptada pero no se pudo vincular al abonado: ${e.message}`));
    }
    return {
      ok: true, dryRun: false, adoptada: true,
      message: res.message, ontId: res.ont_id, fsp: res.fsp,
      cambios: res.cambios ?? [], avisos: res.avisos ?? [],
      antes: res.antes ?? null, velocidad: res.velocidad ?? null,
      commands: res.commands ?? [], verificacion: res.verificacion ?? null, raw: r.raw,
    };
  }

  /** Cambia el comentario (desc) de una ONU ya autorizada. Dry-run salvo OLT_LIVE=true. */
  async setDescription(id: string, params: any, user?: AuthUser) {
    await this.syncLive();
    const olt = await this.resolveOlt(id);
    const f = Number(params.frame ?? 0) || 0;
    if (params.slot === undefined || params.port === undefined || params.ont_id === undefined) {
      throw new BadRequestException('Faltan datos (slot/puerto/ont-id).');
    }
    const fsp = `${f}/${params.slot}/${params.port}:${params.ont_id}`;
    const desc = String(params.desc ?? '').trim();

    if (!this.live) {
      const commands = [`interface gpon ${f}/${params.slot}`, `ont modify ${params.port} ${params.ont_id} desc "${desc}"`, 'quit'];
      await this.audit('DESC', olt, true, true, `DRY-RUN comentario ${fsp}: ` + commands.join(' · '), { fsp, sn: params.sn ?? null, user });
      return { ok: true, dryRun: true, message: `DRY-RUN: no se contacta la OLT. Active OLT_LIVE=true para ejecutar.`, commands };
    }

    const r = await this.withDriver(olt, (d) => d.setOnuDescription(params));
    const res = r.data as any;
    await this.audit('DESC', olt, r.ok, false, r.ok ? `Comentario ${fsp} → "${desc}"` : `ERROR: ${r.error}`, { fsp, sn: params.sn ?? null, user });
    if (!r.ok) return { ok: false, dryRun: false, error: r.error, raw: r.raw };
    // Reflejar el cambio en el inventario local sin esperar al próximo sync.
    if (params.sn) {
      await this.prisma.oltOnu.updateMany({
        where: { oltId: olt.id, sn: String(params.sn).trim().toUpperCase() },
        data: { description: desc || null },
      });
    }
    return { ok: true, dryRun: false, message: res.message, desc: res.desc ?? desc, raw: r.raw };
  }

  /**
   * Cambia la VELOCIDAD de una ONU ya autenticada (buscada por SN), reapuntando
   * las traffic-tables de su service-port. Es el "subir/bajar megas" sin volver a
   * dar de alta: no se toca el `ont add`, así que el abonado no pierde el enlace.
   * Dry-run salvo OLT_LIVE=true.
   */
  async setSpeed(id: string, params: { sn: string; traffic_in?: number | null; traffic_out?: number | null }, user?: AuthUser) {
    await this.syncLive();
    const olt = await this.resolveOlt(id);
    const sn = String(params.sn ?? '').trim();
    if (!sn) throw new BadRequestException('Debe indicar el SN de la ONU.');

    if (!this.live) {
      const drv = new OltHuawei(olt.ip, olt.port, olt.username, decryptSecret(olt.password));
      const commands = drv.buildSpeedCommands(params);
      await this.audit('PROVISION', olt, true, true, `DRY-RUN velocidad SN ${sn}: ` + commands.join(' · '), { sn, user });
      return { ok: true, dryRun: true, message: 'DRY-RUN: no se contacta la OLT. Active OLT_LIVE=true para aplicar la velocidad.', commands };
    }

    const r = await this.withDriver(olt, async (d) => {
      const onu = await d.findBySn(sn);
      if (!onu) return false;
      const pos = this.fspDeOnu(onu);
      if (!pos) { return { error: 'La ONT no reporta F/S/P u ont-id.' }; }
      const res = await d.setServicePortSpeed({
        frame: pos.frame, slot: pos.slot, port: pos.port, ontId: pos.ontId,
        traffic_in: params.traffic_in ?? null, traffic_out: params.traffic_out ?? null,
      });
      if (!res) return false;
      return { ...res, fsp: `${pos.frame}/${pos.slot}/${pos.port}:${pos.ontId}` };
    });
    const res = r.data as any;
    const err = !r.ok ? r.error : res?.error;
    await this.audit('PROVISION', olt, r.ok && !res?.error, false,
      r.ok && !res?.error
        ? `Velocidad SN ${sn} (${res.fsp}) → bajada tt ${params.traffic_in ?? '-'} / subida tt ${params.traffic_out ?? '-'}`
        : `ERROR velocidad SN ${sn}: ${err}`,
      { sn, fsp: res?.fsp ?? null, user });
    if (!r.ok || res?.error) return { ok: false, dryRun: false, error: err, raw: r.raw };
    return { ok: true, dryRun: false, message: res.message, fsp: res.fsp, antes: res.antes, despues: res.despues, commands: res.commands, raw: r.raw };
  }

  async reboot(id: string, params: any, user?: AuthUser) {
    await this.syncLive();
    return this.onuAction('REBOOT', id, params, user);
  }
  async remove(id: string, params: any, user?: AuthUser) {
    await this.syncLive();
    return this.onuAction('DELETE', id, params, user);
  }

  private async onuAction(action: 'REBOOT' | 'DELETE', id: string, params: any, user?: AuthUser) {
    const olt = await this.resolveOlt(id);
    const f = Number(params.frame ?? 0) || 0;
    if (params.slot === undefined || params.port === undefined || params.ont_id === undefined) {
      throw new BadRequestException('Faltan datos (slot/puerto/ont-id).');
    }
    const fsp = `${f}/${params.slot}/${params.port}:${params.ont_id}`;
    const verb = action === 'DELETE' ? 'delete' : 'reset';

    if (!this.live) {
      const commands = [
        ...(action === 'DELETE' ? ['undo service-port <los de esta ONT>'] : []),
        `interface gpon ${f}/${params.slot}`,
        `ont ${verb} ${params.port} ${params.ont_id}`,
        'quit',
      ];
      await this.audit(action, olt, true, true, `DRY-RUN ${action} ${fsp}: ` + commands.join(' · '), { fsp, sn: params.sn ?? null, user });
      return { ok: true, dryRun: true, message: `DRY-RUN: no se contacta la OLT. Active OLT_LIVE=true para ejecutar.`, commands };
    }

    const r = await this.withDriver(olt, (d) => (action === 'DELETE' ? d.deleteOnu(params) : d.rebootOnu(params)));
    const res = r.data as any;
    await this.audit(action, olt, r.ok, false, r.ok ? (res?.message ?? action) : `ERROR: ${r.error}`, { fsp, sn: params.sn ?? null, user });
    if (!r.ok) return { ok: false, dryRun: false, error: r.error, raw: r.raw };
    return { ok: true, dryRun: false, message: res.message, servicePorts: res.servicePorts ?? [], raw: r.raw };
  }

  // ------------------------------------------------------------------ //
  //  Inventario local (tabla OltOnu)                                   //
  // ------------------------------------------------------------------ //

  /** Sincroniza un slot de una OLT hacia OltOnu (upsert por olt+sn). */
  /**
   * AUTO-VINCULADOR ONU↔abonado: casa la descripción que cada ONT trae en la
   * OLT (formato SmartOLT `<usuario|abonado>_zone_<zona>_authd_<fecha>`, o el
   * número de abonado pelado) contra la BD. Solo vincula cuando el match es
   * ÚNICO e inequívoco; lo demás se reporta. No toca vínculos ya existentes.
   * Requiere descripciones sincronizadas (correr sync de slots antes).
   */
  async autoLinkOnus(oltId?: string, user?: AuthUser) {
    const where: Prisma.OltOnuWhereInput = {
      subscriberId: null,
      description: { not: null },
      ...(oltId ? { oltId } : {}),
    };
    const onus = (await this.prisma.oltOnu.findMany({
      where, select: { id: true, sn: true, description: true, oltId: true },
    })).filter((o) => (o.description || '').trim() !== '');

    const subs = await this.prisma.subscriber.findMany({
      // fullName es un caché que puede venir null: para validar nombres se
      // concatenan también las piezas reales (nombres/apellidos/razón social).
      select: {
        id: true, abonado: true, pppUsername: true, fullName: true,
        firstName: true, secondName: true, lastName1: true, lastName2: true, companyName: true,
      },
    });
    const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9Ñ]/g, '');
    const push = (m: Map<string, string[]>, k: string, id: string) => {
      if (!k) return;
      const arr = m.get(k) ?? [];
      arr.push(id);
      m.set(k, arr);
    };
    const byAbonado = new Map<string, string[]>();
    const byPpp = new Map<string, string[]>();
    const byName = new Map<string, string[]>();
    const subById = new Map(subs.map((s) => [s.id, s]));
    const nombreCompleto = (s: (typeof subs)[number]) =>
      norm([s.fullName, s.firstName, s.secondName, s.lastName1, s.lastName2, s.companyName, s.pppUsername].filter(Boolean).join(''));
    for (const s of subs) {
      push(byAbonado, String(s.abonado), s.id);
      if (s.pppUsername) push(byPpp, norm(s.pppUsername), s.id);
      if (s.fullName) push(byName, norm(s.fullName), s.id);
    }

    let vinculadas = 0, ambiguas = 0, sinMatch = 0;
    const muestraSinMatch: string[] = [];
    for (const o of onus) {
      // Identidad = lo que va antes de `_zone_...` (sufijo de SmartOLT/authd).
      let ident = (o.description || '').trim();
      const z = ident.toLowerCase().indexOf('_zone_');
      if (z > 0) ident = ident.slice(0, z);
      ident = ident.trim();
      if (!ident) { sinMatch++; continue; }

      let candidatos: string[] | undefined;
      if (/^\d{2,7}$/.test(ident)) {
        candidatos = byAbonado.get(ident);
      } else {
        candidatos = byPpp.get(norm(ident)) ?? byName.get(norm(ident));
        // Formato dominante del legacy: `<abonado><nombre>` pegados
        // ("1893Julieth", "52086Andrea"). Se toma el número y se VALIDA que el
        // nombre que sigue aparezca en el nombre del abonado — sin esa
        // validación un número cualquiera vincularía a ciegas.
        if (!candidatos) {
          const m = ident.match(/^(\d{2,7})(\D.+)$/);
          if (m) {
            // El número de abonado viene DUPLICADO en la BD (herencia del
            // legacy, se repite entre sedes): el nombre que sigue al número es
            // el desempate — se exige que UN solo candidato lo contenga.
            const porNumero = byAbonado.get(m[1]) ?? [];
            const frag = norm(m[2]);
            if (porNumero.length >= 1 && frag) {
              const validos = [...new Set(porNumero)].filter((id) => {
                const sub = subById.get(id);
                const nombre = sub ? nombreCompleto(sub) : '';
                return nombre.includes(frag) || (frag.length >= 4 && nombre.includes(frag.slice(0, 6)));
              });
              if (validos.length === 1) candidatos = validos;
            }
          }
        }
      }

      if (!candidatos || candidatos.length === 0) {
        sinMatch++;
        if (muestraSinMatch.length < 8) muestraSinMatch.push(`${o.sn}:"${ident}"`);
        continue;
      }
      if (candidatos.length > 1 || new Set(candidatos).size > 1) { ambiguas++; continue; }
      await this.prisma.oltOnu.update({
        where: { id: o.id },
        data: { subscriberId: candidatos[0], clientName: ident },
      });
      vinculadas++;
    }

    const olt = oltId ? await this.resolveOlt(oltId) : null;
    const detalle = `Auto-vínculo ONU↔abonado: ${vinculadas} vinculadas, ${ambiguas} ambiguas, ${sinMatch} sin match de ${onus.length} con descripción` +
      (muestraSinMatch.length ? ` — sin match ej.: ${muestraSinMatch.join(', ')}` : '');
    await this.audit('LINK', olt, true, false, detalle, { user });
    this.logger.log(detalle);
    return { ok: true, examinadas: onus.length, vinculadas, ambiguas, sinMatch };
  }

  async syncSlot(id: string, frame = 0, slot: number, user?: AuthUser) {
    const olt = await this.resolveOlt(id);
    const ts = new Date();
    const r = await this.withDriver(olt, (d) => d.getSlotOnus(frame, slot));
    if (!r.ok) {
      await this.audit('SYNC', olt, false, false, `ERROR slot ${slot}: ${r.error}`, { user });
      return { ok: false, error: r.error, synced: 0, raw: r.raw };
    }
    const onus = (r.data as any[]) ?? [];
    for (const o of onus) await this.upsertOnu(olt.id, o, ts);
    // ONUs del slot no vistas en esta corrida → ausentes.
    await this.prisma.oltOnu.updateMany({
      where: { oltId: olt.id, slot: Number(slot), OR: [{ lastSync: { lt: ts } }, { lastSync: null }] },
      data: { syncState: 'ausente' },
    });
    await this.audit('SYNC', olt, true, false, `Sync slot ${slot}: ${onus.length} ONUs`, { user });
    return { ok: true, synced: onus.length, raw: r.raw };
  }

  /** Upsert de una ONU por (oltId, sn). NO toca el vínculo de cliente. */
  private async upsertOnu(oltId: string, onu: any, ts: Date) {
    const sn = (onu.sn ?? '').trim();
    if (sn === '') return;
    const base: Prisma.OltOnuUncheckedUpdateInput = {
      frame: onu.frame !== undefined ? Number(onu.frame) : 0,
      slot: onu.slot !== undefined && onu.slot !== '' ? Number(onu.slot) : null,
      port: onu.port !== undefined && onu.port !== '' ? Number(onu.port) : null,
      ontId: onu.ont_id !== undefined && onu.ont_id !== '' ? Number(onu.ont_id) : null,
      runState: onu.run_state ?? null,
      configState: onu.config_state ?? null,
      matchState: onu.match_state ?? null,
      rxPower: onu.rx_power !== undefined && onu.rx_power !== '' ? String(onu.rx_power) : null,
      syncState: 'presente',
      lastSync: ts,
    };
    // El comentario solo se toca si la lectura lo trajo: un driver que no lo
    // parsea (u otra marca) no debe borrar el que ya está guardado.
    if (onu.description !== undefined) base.description = onu.description || null;
    const existing = await this.prisma.oltOnu.findFirst({ where: { oltId, sn }, select: { id: true } });
    if (existing) {
      await this.prisma.oltOnu.update({ where: { id: existing.id }, data: base });
    } else {
      await this.prisma.oltOnu.create({ data: { ...(base as any), oltId, sn, firstSeen: ts } });
    }
  }

  /** Listado del inventario local con filtros (búsqueda/olt/estado/señal/cliente). */
  /**
   * Columnas ordenables del inventario de ONUs. Va en SQL crudo (la consulta ya
   * lo era por los filtros de señal, que castean texto a numérico), así que la
   * lista blanca guarda el trozo de SQL: lo que llega del usuario solo ELIGE,
   * nunca se interpola. `rx` se castea a numérico porque `rxPower` es texto y
   * ordenarlo como texto pondría "-9" después de "-28".
   */
  private static readonly ORDEN_INVENTARIO: Record<string, string> = {
    sn: 'o.sn',
    olt: 'olt.name',
    pos: 'o.slot',
    client: 'o."clientName"',
    rx: `NULLIF(regexp_replace(o."rxPower", '[^0-9.-]', '', 'g'), '')::numeric`,
    run: 'o."runState"',
    sync: 'o."syncState"',
  };

  async inventory(params: { search?: string; oltId?: string; estado?: string; senal?: string; cliente?: string; page?: number; pageSize?: number; sortBy?: string; sortDir?: string }) {
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(params.pageSize) || 25));
    const conds: Prisma.Sql[] = [];
    if (params.oltId) conds.push(Prisma.sql`o."oltId" = ${params.oltId}`);
    if (params.estado === 'online') conds.push(Prisma.sql`o."runState" ILIKE '%online%'`);
    if (params.estado === 'offline') conds.push(Prisma.sql`o."runState" ILIKE '%offline%'`);
    if (params.senal === 'critica') conds.push(Prisma.sql`(o."rxPower" ~ '^-?[0-9.]+$' AND o."rxPower"::numeric < -28)`);
    if (params.senal === 'debil') conds.push(Prisma.sql`(o."rxPower" ~ '^-?[0-9.]+$' AND o."rxPower"::numeric < -25 AND o."rxPower"::numeric >= -28)`);
    if (params.cliente === 'sin') conds.push(Prisma.sql`o."subscriberId" IS NULL`);
    if (params.cliente === 'con') conds.push(Prisma.sql`o."subscriberId" IS NOT NULL`);
    if (params.search?.trim()) {
      const s = `%${params.search.trim()}%`;
      conds.push(Prisma.sql`(o.sn ILIKE ${s} OR o.description ILIKE ${s} OR o."clientName" ILIKE ${s})`);
    }
    const where = conds.length ? Prisma.sql`WHERE ${Prisma.join(conds, ' AND ')}` : Prisma.empty;

    // El desempate por id evita que una ONU salga en dos páginas cuando hay
    // empate (p. ej. media OLT con la misma señal).
    const ordenar = ordenSql(
      params, OltService.ORDEN_INVENTARIO,
      'o."oltId" ASC, o.slot ASC NULLS LAST, o.port ASC NULLS LAST',
      { desempate: 'o.id ASC' },
    );

    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT o.id, o."oltId", o.sn, o.description, o.frame, o.slot, o.port, o."ontId",
             o."runState", o."rxPower", o."syncState", o."subscriberId", o."clientName", o."lastSync",
             olt.name AS olt_name
      FROM "OltOnu" o LEFT JOIN "Olt" olt ON olt.id = o."oltId"
      ${where}
      ORDER BY ${Prisma.raw(ordenar)}
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`;
    const totalRow = await this.prisma.$queryRaw<{ c: number }[]>`SELECT COUNT(*)::int AS c FROM "OltOnu" o ${where}`;
    const total = totalRow[0]?.c ?? 0;

    return {
      items: rows.map((r) => ({
        id: r.id, oltId: r.oltId, olt: r.olt_name, sn: r.sn, description: r.description,
        frame: r.frame, slot: r.slot, port: r.port, ontId: r.ontId,
        fsp: `${r.frame ?? 0}/${r.slot ?? '-'}/${r.port ?? '-'}`,
        runState: r.runState, rxPower: r.rxPower, syncState: r.syncState,
        subscriberId: r.subscriberId, client: r.clientName, lastSync: r.lastSync,
      })),
      total, page, pageSize, pages: Math.ceil(total / pageSize),
    };
  }

  /** KPIs globales del inventario + desglose por OLT (SmartOLT dashboard). */
  async dashboard() {
    const g = await this.prisma.$queryRaw<any[]>`
      SELECT
        COUNT(*)::int AS total,
        SUM(CASE WHEN "runState" ILIKE '%online%' THEN 1 ELSE 0 END)::int AS online,
        SUM(CASE WHEN "runState" ILIKE '%offline%' THEN 1 ELSE 0 END)::int AS offline,
        SUM(CASE WHEN "rxPower" ~ '^-?[0-9.]+$' AND "rxPower"::numeric < -25 AND "rxPower"::numeric >= -28 THEN 1 ELSE 0 END)::int AS debil,
        SUM(CASE WHEN "rxPower" ~ '^-?[0-9.]+$' AND "rxPower"::numeric < -28 THEN 1 ELSE 0 END)::int AS critica,
        SUM(CASE WHEN "subscriberId" IS NULL THEN 1 ELSE 0 END)::int AS sin_cliente
      FROM "OltOnu"`;
    const porOlt = await this.prisma.$queryRaw<any[]>`
      SELECT o."oltId" AS olt_id, olt.name AS nombre,
             COUNT(*)::int AS total,
             SUM(CASE WHEN o."runState" ILIKE '%online%' THEN 1 ELSE 0 END)::int AS online,
             SUM(CASE WHEN o."runState" ILIKE '%offline%' THEN 1 ELSE 0 END)::int AS offline,
             SUM(CASE WHEN o."rxPower" ~ '^-?[0-9.]+$' AND o."rxPower"::numeric < -28 THEN 1 ELSE 0 END)::int AS critica,
             MAX(o."lastSync") AS last_sync
      FROM "OltOnu" o LEFT JOIN "Olt" olt ON olt.id = o."oltId"
      GROUP BY o."oltId", olt.name ORDER BY olt.name`;
    const row = g[0] ?? {};
    return {
      total: row.total ?? 0, online: row.online ?? 0, offline: row.offline ?? 0,
      debil: row.debil ?? 0, critica: row.critica ?? 0, sinCliente: row.sin_cliente ?? 0,
      porOlt: porOlt.map((p) => ({ oltId: p.olt_id, nombre: p.nombre, total: p.total, online: p.online, offline: p.offline, critica: p.critica, lastSync: p.last_sync })),
    };
  }

  /** Vincula (o desvincula si subscriberId vacío) una ONU con un cliente. */
  async linkCustomer(onuId: string, subscriberId: string | null, user?: AuthUser) {
    const onu = await this.prisma.oltOnu.findUnique({ where: { id: onuId }, include: { olt: { select: { id: true, name: true } } } });
    if (!onu) throw new NotFoundException('ONU no encontrada.');
    let clientName: string | null = null;
    if (subscriberId) {
      const sub = await this.prisma.subscriber.findUnique({ where: { id: subscriberId }, select: SUB_SELECT });
      if (!sub) throw new BadRequestException('Cliente no encontrado.');
      clientName = subName(sub);
    }
    await this.prisma.oltOnu.update({ where: { id: onuId }, data: { subscriberId: subscriberId || null, clientName } });
    await this.audit('LINK', onu.olt, true, false, subscriberId ? `Vincular ONU ${onu.sn} → ${clientName}` : `Desvincular ONU ${onu.sn}`, { sn: onu.sn, subscriberId, user });
    return { ok: true, client: clientName };
  }

  /** Busca clientes para vincular (tokenizado, top 15). Reusa la lógica de subscribers. */
  async searchSubscribers(q: string) {
    const search = (q || '').trim();
    if (search.length < 2) return { ok: true, clientes: [] };
    const tokens = search.split(/\s+/).filter(Boolean);
    const perToken = (tok: string): Prisma.SubscriberWhereInput => ({
      OR: [
        { firstName: { contains: tok, mode: 'insensitive' } },
        { secondName: { contains: tok, mode: 'insensitive' } },
        { lastName1: { contains: tok, mode: 'insensitive' } },
        { lastName2: { contains: tok, mode: 'insensitive' } },
        { companyName: { contains: tok, mode: 'insensitive' } },
        { docNumber: { contains: tok } },
        { phone1: { contains: tok } },
      ],
    });
    const asNum = Number(search);
    const rows = await this.prisma.subscriber.findMany({
      where: { OR: [{ AND: tokens.map(perToken) }, ...(Number.isFinite(asNum) ? [{ abonado: asNum }] : [])] },
      select: SUB_SELECT, take: 15, orderBy: { abonado: 'asc' },
    });
    return { ok: true, clientes: rows.map((r) => ({ id: r.id, abonado: r.abonado, nombre: subName(r), documento: r.docNumber, celular: r.phone1 })) };
  }

  /** Historial de auditoría de una OLT (o global). */
  async history(oltId?: string, limit = 100) {
    const rows = await this.prisma.oltActionLog.findMany({
      where: oltId ? { oltId } : {},
      orderBy: { createdAt: 'desc' },
      take: Math.min(300, Math.max(1, limit)),
    });
    return rows;
  }
}

/**
 * Puertos PON de una tarjeta Huawei por su modelo. Las GPBD/EPBD son de 8; las
 * GPFD/GPHF/GPSF/GPUF (las de esta planta) y el resto, de 16.
 */
export function puertosDeTarjeta(board: string): number {
  return /GPBD|EPBD|GPBH/i.test(board) ? 8 : 16;
}
