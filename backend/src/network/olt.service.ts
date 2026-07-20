import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/current-user.decorator';
import { OltDriver } from './olt/olt-ssh.client';
import { OltHuawei } from './olt/olt-huawei.driver';
import { createOltDriver, OLT_BRANDS } from './olt/olt-factory';
import { decryptSecret, encryptSecret } from '../common/secret-box';

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
  | 'DETAIL' | 'FIND' | 'PROVISION' | 'REBOOT' | 'DELETE' | 'SYNC' | 'LINK';

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

@Injectable()
export class OltService {
  private readonly logger = new Logger(OltService.name);
  private live = process.env.OLT_LIVE === 'true';
  private liveCheckedAt = 0;

  constructor(private readonly prisma: PrismaService) {}

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

  async mode() {
    await this.syncLive();
    return { live: this.live, mode: this.live ? 'LIVE' : 'DRY_RUN', brands: OLT_BRANDS };
  }

  // ------------------------------------------------------------------ //
  //  Resolución + sesión                                               //
  // ------------------------------------------------------------------ //

  private async resolveOlt(id: string) {
    const olt = await this.prisma.olt.findUnique({ where: { id } });
    if (!olt) throw new NotFoundException('OLT no encontrada.');
    return olt;
  }

  /** Abre driver conectado+preparado y ejecuta `fn`. Siempre desconecta. */
  private async withDriver<T>(
    olt: { id: string; brand: string; ip: string; port: string; username: string; password: string },
    fn: (driver: OltDriver) => Promise<T>,
  ): Promise<{ ok: boolean; error: string; raw: string; data: T | null }> {
    const driver = createOltDriver(olt.brand, olt.ip, olt.port, olt.username, decryptSecret(olt.password));
    const connected = await driver.connect();
    if (!connected) {
      const error = driver.getError();
      driver.disconnect();
      return { ok: false, error, raw: driver.getRawLog(), data: null };
    }
    try {
      await driver.prepare();
      const data = await fn(driver);
      return { ok: data !== false, error: data === false ? driver.getError() : '', raw: driver.getRawLog(), data: data === false ? null : data };
    } catch (e) {
      return { ok: false, error: (e as Error).message, raw: driver.getRawLog(), data: null };
    } finally {
      driver.disconnect();
    }
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
      id: o.id, name: o.name, brand: o.brand, ip: o.ip, port: o.port, tech: o.tech,
      branch: o.branch?.name ?? null, sedeLegacy: o.sedeLegacy, username: o.username,
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
        tech: dto.tech || 'GPON', sedeLegacy, branchId: dto.branchId || null,
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
    if (dto.port !== undefined) data.port = String(dto.port);
    if (dto.sedeLegacy !== undefined) data.sedeLegacy = Number(dto.sedeLegacy);
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
    this.logger.log(`TEST OLT "${olt.name}" → ${olt.ip}:${olt.port} (SSH como "${olt.username}")${user?.name ? ` — pedido por ${user.name}` : ''}`);
    const driver = createOltDriver(olt.brand, olt.ip, olt.port, olt.username, decryptSecret(olt.password));
    const ok = await driver.connect();
    const error = driver.getError();
    driver.disconnect();
    this.logger.log(`TEST OLT "${olt.name}" resultado: ${ok ? 'Conexión OK' : 'FALLÓ — ' + error}`);
    await this.prisma.olt.update({ where: { id }, data: { online: ok } });
    await this.audit('TEST', olt, ok, false, ok ? 'Conexión OK' : `ERROR: ${error}`, { user });
    return { ok, error };
  }

  async boards(id: string, frame = 0) {
    const olt = await this.resolveOlt(id);
    const r = await this.withDriver(olt, (d) => d.getBoards(frame));
    return { ok: r.ok, error: r.error, boards: r.data ?? [], raw: r.raw };
  }

  async onus(id: string, frame = 0, slot: number | null, port: number | null) {
    const olt = await this.resolveOlt(id);
    const r = await this.withDriver(olt, (d) => d.getOnus(frame, slot, port));
    return { ok: r.ok, error: r.error, onus: r.data ?? [], raw: r.raw };
  }

  async autofind(id: string) {
    const olt = await this.resolveOlt(id);
    const r = await this.withDriver(olt, (d) => d.getAutofind());
    return { ok: r.ok, error: r.error, onus: r.data ?? [], raw: r.raw };
  }

  async profiles(id: string) {
    const olt = await this.resolveOlt(id);
    const r = await this.withDriver(olt, (d) => d.getProfiles());
    const data = r.data as { line: any[]; srv: any[] } | null;
    return { ok: r.ok, error: r.error, line: data?.line ?? [], srv: data?.srv ?? [], raw: r.raw };
  }

  async systemInfo(id: string) {
    const olt = await this.resolveOlt(id);
    const r = await this.withDriver(olt, (d) => d.getSystemInfo());
    return { ok: r.ok, error: r.error, info: r.data ?? {}, raw: r.raw };
  }

  async slotSummary(id: string, frame = 0, slot: number) {
    const olt = await this.resolveOlt(id);
    const r = await this.withDriver(olt, (d) => d.getSlotSummary(frame, slot));
    return { ok: r.ok, error: r.error, summary: r.data ?? {}, raw: r.raw };
  }

  async ontDetail(id: string, frame: number, slot: number, port: number, ontId: number) {
    const olt = await this.resolveOlt(id);
    const r = await this.withDriver(olt, (d) => d.getOntDetail(frame, slot, port, ontId));
    return { ok: r.ok, error: r.error, detail: r.data ?? {}, raw: r.raw };
  }

  async findBySn(id: string, sn: string) {
    const olt = await this.resolveOlt(id);
    const r = await this.withDriver(olt, (d) => d.findBySn(sn));
    return { ok: r.ok, error: r.error, onu: r.data ?? {}, raw: r.raw };
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
    await this.audit('PROVISION', olt, r.ok, false, r.ok ? (res?.message ?? 'ONT agregada') : `ERROR: ${r.error}`, { sn: params.sn, fsp, user });
    if (!r.ok) return { ok: false, dryRun: false, error: r.error, raw: r.raw };
    return { ok: true, dryRun: false, message: res.message, ontId: res.ont_id, commands: res.commands, raw: r.raw };
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
      const commands = [`interface gpon ${f}/${params.slot}`, `ont ${verb} ${params.port} ${params.ont_id}`, 'quit'];
      await this.audit(action, olt, true, true, `DRY-RUN ${action} ${fsp}: ` + commands.join(' · '), { fsp, sn: params.sn ?? null, user });
      return { ok: true, dryRun: true, message: `DRY-RUN: no se contacta la OLT. Active OLT_LIVE=true para ejecutar.`, commands };
    }

    const r = await this.withDriver(olt, (d) => (action === 'DELETE' ? d.deleteOnu(params) : d.rebootOnu(params)));
    const res = r.data as any;
    await this.audit(action, olt, r.ok, false, r.ok ? (res?.message ?? action) : `ERROR: ${r.error}`, { fsp, sn: params.sn ?? null, user });
    if (!r.ok) return { ok: false, dryRun: false, error: r.error, raw: r.raw };
    return { ok: true, dryRun: false, message: res.message, raw: r.raw };
  }

  // ------------------------------------------------------------------ //
  //  Inventario local (tabla OltOnu)                                   //
  // ------------------------------------------------------------------ //

  /** Sincroniza un slot de una OLT hacia OltOnu (upsert por olt+sn). */
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
    const base = {
      frame: onu.frame !== undefined ? Number(onu.frame) : 0,
      slot: onu.slot !== undefined && onu.slot !== '' ? Number(onu.slot) : null,
      port: onu.port !== undefined && onu.port !== '' ? Number(onu.port) : null,
      ontId: onu.ont_id !== undefined && onu.ont_id !== '' ? Number(onu.ont_id) : null,
      description: onu.description ?? null,
      runState: onu.run_state ?? null,
      configState: onu.config_state ?? null,
      matchState: onu.match_state ?? null,
      rxPower: onu.rx_power !== undefined && onu.rx_power !== '' ? String(onu.rx_power) : null,
      syncState: 'presente',
      lastSync: ts,
    };
    const existing = await this.prisma.oltOnu.findFirst({ where: { oltId, sn }, select: { id: true } });
    if (existing) {
      await this.prisma.oltOnu.update({ where: { id: existing.id }, data: base });
    } else {
      await this.prisma.oltOnu.create({ data: { ...base, oltId, sn, firstSeen: ts } });
    }
  }

  /** Listado del inventario local con filtros (búsqueda/olt/estado/señal/cliente). */
  async inventory(params: { search?: string; oltId?: string; estado?: string; senal?: string; cliente?: string; page?: number; pageSize?: number }) {
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

    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT o.id, o."oltId", o.sn, o.description, o.frame, o.slot, o.port, o."ontId",
             o."runState", o."rxPower", o."syncState", o."subscriberId", o."clientName", o."lastSync",
             olt.name AS olt_name
      FROM "OltOnu" o LEFT JOIN "Olt" olt ON olt.id = o."oltId"
      ${where}
      ORDER BY o."oltId" ASC, o.slot ASC NULLS LAST, o.port ASC NULLS LAST
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
