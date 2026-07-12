import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Mikrotik } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/current-user.decorator';
import { WhatsappService } from '../common/whatsapp/whatsapp.service';
import { RouterosClient, RouterosError } from './routeros/routeros-client';

/**
 * Integración real de corte / reconexión contra los MikroTik de Vestel.
 *
 * Porta las funciones de producción del legacy
 * (`Customers_model.php::activar_estado_usuario` / `desactivar_estado_usuario`):
 *   CORTE:      cerrar sesión PPP activa → deshabilitar secret → mover IP de ACTIVOS a MOROSOS
 *   RECONEXIÓN: habilitar secret → quitar de MOROSOS → agregar a ACTIVOS
 *
 * Resolución de router: por sede (branch.legacyId == mikrotik.sedeLegacy) y tecnología
 * de instalación; si no hay match exacto se usa el marcado como `isDefault`.
 *
 * ⚠️ SEGURIDAD: por defecto opera en DRY-RUN (no abre socket, sólo devuelve el plan de
 * comandos). Para ejecutar de verdad contra los routers de producción hay que arrancar
 * el backend con MIKROTIK_LIVE=true. Cada intento —real o simulado— queda auditado.
 */

const ADDRESS_LIST_ACTIVE = 'ACTIVOS';
const ADDRESS_LIST_DEBTOR = 'MOROSOS';

export type MikrotikAction = 'CUT' | 'RECONNECT' | 'STATUS' | 'TEST' | 'PROVISION' | 'PROFILE';

export interface MikrotikActionResult {
  ok: boolean;
  dryRun: boolean;
  action: MikrotikAction;
  subscriberId?: string;
  mikrotik?: { id: string; name: string; host: string; tech: string };
  /** Comandos que se enviaron (o que se enviarían en dry-run). */
  steps: string[];
  /** Estado en vivo leído del router (sólo en STATUS/TEST cuando aplica). */
  live?: {
    secretExists?: boolean;
    secretDisabled?: boolean;
    sessionActive?: boolean;
    ip?: string;
    inActivos?: boolean;
    inMorosos?: boolean;
  };
  message: string;
  error?: string;
}

type SubForNet = {
  id: string;
  legacyId: number | null;
  pppUsername: string | null;
  ipRemote: string | null;
  installTech: string | null;
  status: string | null;
  branch: { legacyId: number } | null;
};

@Injectable()
export class MikrotikService {
  private readonly logger = new Logger('MikrotikService');
  /** true ⇒ ejecuta de verdad contra los routers. false ⇒ dry-run (simulación segura). */
  private readonly live = process.env.MIKROTIK_LIVE === 'true';

  constructor(
    private prisma: PrismaService,
    private whatsapp: WhatsappService,
  ) {}

  get isLive(): boolean {
    return this.live;
  }

  // ------------------------------------------------------------------
  // Mensajería masiva (WhatsApp) — cobro a morosos estilo Clientgroup
  // ------------------------------------------------------------------
  /** Normaliza a E.164 Colombia: 10 dígitos ⇒ prefija 57. */
  private toE164(phone?: string | null): string | null {
    if (!phone) return null;
    const d = phone.replace(/\D/g, '');
    if (!d) return null;
    if (d.length === 10) return `57${d}`;
    if (d.startsWith('57')) return d;
    return d;
  }

  async messageBatch(ids: string[], message: string, user?: AuthUser) {
    const subs = await this.prisma.subscriber.findMany({
      where: { id: { in: ids } },
      select: { id: true, abonado: true, firstName: true, lastName1: true, fullName: true, phone1: true, phone2: true },
    });
    const results: { subscriberId: string; ok: boolean; phone?: string; error?: string }[] = [];
    for (const s of subs) {
      const phone = this.toE164(s.phone1) ?? this.toE164(s.phone2);
      if (!phone) { results.push({ subscriberId: s.id, ok: false, error: 'sin teléfono' }); continue; }
      const name = (s.fullName || [s.firstName, s.lastName1].filter(Boolean).join(' ')).trim();
      const text = message
        .replace(/\{nombre\}/gi, name || 'estimado cliente')
        .replace(/\{abonado\}/gi, String(s.abonado ?? ''));
      try {
        const ok = await this.whatsapp.sendText(phone, text);
        results.push({ subscriberId: s.id, ok, phone });
      } catch (e) {
        results.push({ subscriberId: s.id, ok: false, phone, error: (e as Error).message });
      }
    }
    return { total: ids.length, sent: results.filter((r) => r.ok).length, results };
  }

  // ------------------------------------------------------------------
  // Resolución de router
  // ------------------------------------------------------------------
  private async loadSubscriber(id: string): Promise<SubForNet> {
    const s = await this.prisma.subscriber.findUnique({
      where: { id },
      select: {
        id: true,
        legacyId: true,
        pppUsername: true,
        ipRemote: true,
        installTech: true,
        status: true,
        branch: { select: { legacyId: true } },
      },
    });
    if (!s) throw new NotFoundException('Cliente no encontrado');
    return s as SubForNet;
  }

  /** Elige el Mikrotik para una sede+tecnología (fallback: isDefault de la sede). */
  async resolveRouter(sub: SubForNet) {
    if (!sub.branch) {
      throw new BadRequestException('El cliente no tiene sede asignada; no se puede resolver el Mikrotik.');
    }
    const routers = await this.prisma.mikrotik.findMany({
      where: { sedeLegacy: sub.branch.legacyId },
    });
    if (routers.length === 0) {
      throw new BadRequestException(`No hay Mikrotik configurado para la sede (gid ${sub.branch.legacyId}).`);
    }
    const byTech = sub.installTech
      ? routers.find((r) => r.tech?.toUpperCase() === String(sub.installTech).toUpperCase())
      : undefined;
    const chosen = byTech ?? routers.find((r) => r.isDefault) ?? routers[0];
    return chosen;
  }

  /** Comentario usado en address-list, igual que el legacy: `activo_<idLegacy>`. */
  private comment(sub: SubForNet): string {
    return `activo_${sub.legacyId ?? sub.id}`;
  }

  // ------------------------------------------------------------------
  // Auditoría
  // ------------------------------------------------------------------
  private async audit(
    action: MikrotikAction,
    sub: SubForNet | null,
    router: { id: string; name: string } | null,
    res: MikrotikActionResult,
    user?: AuthUser,
  ) {
    try {
      await this.prisma.mikrotikActionLog.create({
        data: {
          subscriberId: sub?.id ?? null,
          mikrotikId: router?.id ?? null,
          mikrotikName: router?.name ?? null,
          action,
          ok: res.ok,
          dryRun: res.dryRun,
          detail: (res.error ? `ERROR: ${res.error} | ` : '') + res.steps.join(' · ').slice(0, 1900),
          pppUsername: sub?.pppUsername ?? null,
          userId: user?.id ?? null,
          userName: user?.name ?? null,
        },
      });
    } catch (e) {
      this.logger.warn(`No se pudo auditar acción Mikrotik: ${(e as Error).message}`);
    }
  }

  // ------------------------------------------------------------------
  // Primitivas de corte/reconexión sobre una conexión YA abierta.
  // Se reutilizan tanto en la acción individual como en el lote (una sola
  // conexión por router → cientos de clientes sin reconectar cada vez).
  // No abren/cierran socket, no auditan, no tocan el estado en BD.
  // ------------------------------------------------------------------
  private async cutOnApi(api: RouterosClient, sub: SubForNet): Promise<{ ok: boolean; steps: string[]; error?: string }> {
    const name = sub.pppUsername!.replace(/\s+/g, '');
    const comment = this.comment(sub);
    const steps: string[] = [];
    try {
      const secrets = await api.comm('/ppp/secret/getall', { '?name': name });
      if (secrets.length === 0) {
        steps.push(`secret '${name}' no existe en el router`);
      } else {
        const secret = secrets[0];
        const active = await api.comm('/ppp/active/getall', { '.proplist': '.id,address', '?name': name });
        if (active.length && active[0]['.id']) {
          await api.comm('/ppp/active/remove', { '.id': active[0]['.id'] });
          steps.push('sesión PPP activa cerrada');
        }
        await api.comm('/ppp/secret/set', { '.id': secret['.id'], disabled: 'yes' });
        steps.push('secret deshabilitado (disabled=yes)');

        const ip = secret['remote-address'] || active[0]?.['address'] || sub.ipRemote || '';
        if (ip) {
          const inAct = await api.comm('/ip/firewall/address-list/print', { '?list': ADDRESS_LIST_ACTIVE, '?comment': comment });
          for (const e of inAct) if (e['.id']) await api.comm('/ip/firewall/address-list/remove', { '.id': e['.id'] });
          const inMor = await api.comm('/ip/firewall/address-list/print', { '?list': ADDRESS_LIST_DEBTOR, '?comment': comment });
          if (inMor.length === 0) {
            await api.comm('/ip/firewall/address-list/add', { address: ip, list: ADDRESS_LIST_DEBTOR, comment });
          } else {
            for (const e of inMor) if (e['.id']) await api.comm('/ip/firewall/address-list/set', { '.id': e['.id'], address: ip });
          }
          steps.push(`IP ${ip}: ${ADDRESS_LIST_ACTIVE} → ${ADDRESS_LIST_DEBTOR}`);
        } else {
          steps.push('sin IP conocida: no se tocaron address-list');
        }
      }
      return { ok: true, steps };
    } catch (e) {
      return { ok: false, steps, error: e instanceof RouterosError ? e.message : (e as Error).message };
    }
  }

  private async reconnectOnApi(api: RouterosClient, sub: SubForNet): Promise<{ ok: boolean; steps: string[]; error?: string }> {
    const name = sub.pppUsername!.replace(/\s+/g, '');
    const comment = this.comment(sub);
    const steps: string[] = [];
    try {
      const secrets = await api.comm('/ppp/secret/getall', { '?name': name });
      let ip = secrets[0]?.['remote-address'] || '';
      if (!ip) {
        const active = await api.comm('/ppp/active/getall', { '?name': name });
        ip = active[0]?.['address'] || '';
      }
      if (!ip) ip = sub.ipRemote || '';

      if (secrets[0]?.['.id']) {
        await api.comm('/ppp/secret/set', { '.id': secrets[0]['.id'], disabled: 'no' });
        steps.push('secret habilitado (disabled=no)');
      } else {
        steps.push(`secret '${name}' no existe en el router`);
      }

      const inMor = await api.comm('/ip/firewall/address-list/print', { '?list': ADDRESS_LIST_DEBTOR, '?comment': comment });
      for (const e of inMor) if (e['.id']) await api.comm('/ip/firewall/address-list/remove', { '.id': e['.id'] });
      if (inMor.length) steps.push(`removido de ${ADDRESS_LIST_DEBTOR}`);

      if (ip) {
        const inAct = await api.comm('/ip/firewall/address-list/print', { '?list': ADDRESS_LIST_ACTIVE, '?comment': comment });
        if (inAct.length === 0) {
          await api.comm('/ip/firewall/address-list/add', { address: ip, list: ADDRESS_LIST_ACTIVE, comment });
        } else {
          for (const e of inAct) if (e['.id']) await api.comm('/ip/firewall/address-list/set', { '.id': e['.id'], address: ip });
        }
        steps.push(`IP ${ip} en ${ADDRESS_LIST_ACTIVE}`);
      }
      return { ok: true, steps };
    } catch (e) {
      return { ok: false, steps, error: e instanceof RouterosError ? e.message : (e as Error).message };
    }
  }

  /**
   * Solo mueve la IP a la lista MOROSOS (quita de ACTIVOS) sin tocar el secret.
   * Se usa en los OTROS Mikrotiks de la sede donde el cliente no tiene su secret,
   * para que quede en morosos "en cada mikrotik" (fiel al legacy).
   */
  private async markMorosoOnApi(api: RouterosClient, sub: SubForNet, ip: string): Promise<{ ok: boolean; steps: string[]; error?: string }> {
    const comment = this.comment(sub);
    const steps: string[] = [];
    try {
      if (!ip) { steps.push('sin IP conocida: no se marcó moroso'); return { ok: true, steps }; }
      const inAct = await api.comm('/ip/firewall/address-list/print', { '?list': ADDRESS_LIST_ACTIVE, '?comment': comment });
      for (const e of inAct) if (e['.id']) await api.comm('/ip/firewall/address-list/remove', { '.id': e['.id'] });
      const inMor = await api.comm('/ip/firewall/address-list/print', { '?list': ADDRESS_LIST_DEBTOR, '?comment': comment });
      if (inMor.length === 0) await api.comm('/ip/firewall/address-list/add', { address: ip, list: ADDRESS_LIST_DEBTOR, comment });
      else for (const e of inMor) if (e['.id']) await api.comm('/ip/firewall/address-list/set', { '.id': e['.id'], address: ip });
      steps.push(`IP ${ip} → ${ADDRESS_LIST_DEBTOR}`);
      return { ok: true, steps };
    } catch (e) {
      return { ok: false, steps, error: e instanceof RouterosError ? e.message : (e as Error).message };
    }
  }

  /** Quita la IP de MOROSOS (y la devuelve a ACTIVOS) sin tocar el secret — reverso de markMorosoOnApi. */
  private async unmarkMorosoOnApi(api: RouterosClient, sub: SubForNet, ip: string): Promise<{ ok: boolean; steps: string[]; error?: string }> {
    const comment = this.comment(sub);
    const steps: string[] = [];
    try {
      const inMor = await api.comm('/ip/firewall/address-list/print', { '?list': ADDRESS_LIST_DEBTOR, '?comment': comment });
      for (const e of inMor) if (e['.id']) await api.comm('/ip/firewall/address-list/remove', { '.id': e['.id'] });
      if (inMor.length) steps.push(`removido de ${ADDRESS_LIST_DEBTOR}`);
      if (ip) {
        const inAct = await api.comm('/ip/firewall/address-list/print', { '?list': ADDRESS_LIST_ACTIVE, '?comment': comment });
        if (inAct.length === 0) await api.comm('/ip/firewall/address-list/add', { address: ip, list: ADDRESS_LIST_ACTIVE, comment });
        else for (const e of inAct) if (e['.id']) await api.comm('/ip/firewall/address-list/set', { '.id': e['.id'], address: ip });
        steps.push(`IP ${ip} en ${ADDRESS_LIST_ACTIVE}`);
      }
      return { ok: true, steps };
    } catch (e) {
      return { ok: false, steps, error: e instanceof RouterosError ? e.message : (e as Error).message };
    }
  }

  /** Otros Mikrotiks de la sede (distintos al router primario) para replicar morosos. */
  private async sedeOtherRouters(sub: SubForNet, primaryId: string): Promise<Mikrotik[]> {
    if (!sub.branch) return [];
    const routers = await this.prisma.mikrotik.findMany({ where: { sedeLegacy: sub.branch.legacyId } });
    return routers.filter((r) => r.id !== primaryId);
  }

  /**
   * Abre conexión a cada router "other" de la sede y marca/desmarca la IP en MOROSOS
   * (sin tocar el secret, que solo vive en el router primario). Best-effort: los
   * fallos por router se anotan en los steps pero no tumban la acción principal.
   */
  private async replicateMorosoOnSede(sub: SubForNet, others: Mikrotik[], mode: 'mark' | 'unmark', res: MikrotikActionResult) {
    const ip = sub.ipRemote || '';
    for (const other of others) {
      const oapi = new RouterosClient();
      try {
        await oapi.connect(other.ip, Number(other.port), other.username, other.password, { timeoutMs: 8000 });
        const mr = mode === 'mark' ? await this.markMorosoOnApi(oapi, sub, ip) : await this.unmarkMorosoOnApi(oapi, sub, ip);
        oapi.close();
        res.steps.push(`[${other.name}] ${mr.ok ? mr.steps.join(' · ') : '✗ ' + mr.error}`);
      } catch (e) {
        oapi.close();
        res.steps.push(`[${other.name}] ✗ no conectó: ${e instanceof RouterosError ? e.message : (e as Error).message}`);
      }
    }
  }

  // ------------------------------------------------------------------
  // CORTE
  // ------------------------------------------------------------------
  async cut(subscriberId: string, user?: AuthUser): Promise<MikrotikActionResult> {
    const sub = await this.loadSubscriber(subscriberId);
    if (!sub.pppUsername) {
      throw new BadRequestException('El cliente no tiene usuario PPPoE (name_s); no hay conexión que cortar.');
    }
    const router = await this.resolveRouter(sub);
    const name = sub.pppUsername.replace(/\s+/g, '');
    const comment = this.comment(sub);
    const routerInfo = { id: router.id, name: router.name, host: `${router.ip}:${router.port}`, tech: router.tech };

    const res: MikrotikActionResult = {
      ok: false,
      dryRun: !this.live,
      action: 'CUT',
      subscriberId,
      mikrotik: routerInfo,
      steps: [],
      message: '',
    };

    const others = await this.sedeOtherRouters(sub, router.id);

    if (!this.live) {
      res.steps = [
        `connect ${routerInfo.host}`,
        `/ppp/active/getall ?name=${name}  → /ppp/active/remove`,
        `/ppp/secret/set ?name=${name} disabled=yes`,
        `address-list ${ADDRESS_LIST_ACTIVE} remove (comment=${comment})`,
        `address-list ${ADDRESS_LIST_DEBTOR} add/set (comment=${comment})`,
        ...others.map((o) => `[${o.name}] address-list ${ADDRESS_LIST_DEBTOR} add (comment=${comment})`),
      ];
      res.ok = true;
      res.message = `DRY-RUN: corte simulado de ${name} en ${router.name}${others.length ? ` + morosos en ${others.length} router(es) de la sede` : ''}. Sin cambios reales.`;
      await this.audit('CUT', sub, router, res, user);
      return res;
    }

    const api = new RouterosClient();
    try {
      await api.connect(router.ip, Number(router.port), router.username, router.password, { timeoutMs: 8000 });
      res.steps.push(`conectado a ${routerInfo.host}`);

      const r = await this.cutOnApi(api, sub);
      api.close();
      res.steps.push(...r.steps);
      if (r.ok) {
        await this.markStatus(sub, 'CORTADO');
        res.ok = true;
        res.message = `Corte aplicado a ${name} en ${router.name}.`;
      } else {
        res.error = r.error;
        res.message = `Fallo el corte: ${r.error}`;
      }
    } catch (e) {
      api.close();
      res.error = e instanceof RouterosError ? e.message : (e as Error).message;
      res.message = `Fallo el corte: ${res.error}`;
    }

    // Replicar MOROSOS en los demás Mikrotiks de la sede (best-effort).
    await this.replicateMorosoOnSede(sub, others, 'mark', res);

    await this.audit('CUT', sub, router, res, user);
    return res;
  }

  // ------------------------------------------------------------------
  // RECONEXIÓN
  // ------------------------------------------------------------------
  async reconnect(subscriberId: string, user?: AuthUser): Promise<MikrotikActionResult> {
    const sub = await this.loadSubscriber(subscriberId);
    if (!sub.pppUsername) {
      throw new BadRequestException('El cliente no tiene usuario PPPoE (name_s); no hay conexión que reactivar.');
    }
    const router = await this.resolveRouter(sub);
    const name = sub.pppUsername.replace(/\s+/g, '');
    const comment = this.comment(sub);
    const routerInfo = { id: router.id, name: router.name, host: `${router.ip}:${router.port}`, tech: router.tech };

    const res: MikrotikActionResult = {
      ok: false,
      dryRun: !this.live,
      action: 'RECONNECT',
      subscriberId,
      mikrotik: routerInfo,
      steps: [],
      message: '',
    };

    const others = await this.sedeOtherRouters(sub, router.id);

    if (!this.live) {
      res.steps = [
        `connect ${routerInfo.host}`,
        `/ppp/secret/set ?name=${name} disabled=no`,
        `address-list ${ADDRESS_LIST_DEBTOR} remove (comment=${comment})`,
        `address-list ${ADDRESS_LIST_ACTIVE} add/set (comment=${comment})`,
        ...others.map((o) => `[${o.name}] address-list ${ADDRESS_LIST_DEBTOR} remove (comment=${comment})`),
      ];
      res.ok = true;
      res.message = `DRY-RUN: reconexión simulada de ${name} en ${router.name}${others.length ? ` + quitar de morosos en ${others.length} router(es) de la sede` : ''}. Sin cambios reales.`;
      await this.audit('RECONNECT', sub, router, res, user);
      return res;
    }

    const api = new RouterosClient();
    try {
      await api.connect(router.ip, Number(router.port), router.username, router.password, { timeoutMs: 8000 });
      res.steps.push(`conectado a ${routerInfo.host}`);

      const r = await this.reconnectOnApi(api, sub);
      api.close();
      res.steps.push(...r.steps);
      if (r.ok) {
        await this.markStatus(sub, 'ACTIVO');
        res.ok = true;
        res.message = `Reconexión aplicada a ${name} en ${router.name}.`;
      } else {
        res.error = r.error;
        res.message = `Fallo la reconexión: ${r.error}`;
      }
    } catch (e) {
      api.close();
      res.error = e instanceof RouterosError ? e.message : (e as Error).message;
      res.message = `Fallo la reconexión: ${res.error}`;
    }

    // Quitar de MOROSOS en los demás Mikrotiks de la sede (best-effort).
    await this.replicateMorosoOnSede(sub, others, 'unmark', res);

    await this.audit('RECONNECT', sub, router, res, user);
    return res;
  }

  // ------------------------------------------------------------------
  // ALTA / PROVISIÓN (crear el secret PPPoE en el router)
  // ------------------------------------------------------------------
  async provision(subscriberId: string, user?: AuthUser): Promise<MikrotikActionResult> {
    const full = await this.prisma.subscriber.findUnique({
      where: { id: subscriberId },
      select: {
        id: true, legacyId: true, pppUsername: true, pppPassword: true, pppProfile: true,
        pppService: true, ipRemote: true, ipLocal: true, netComment: true, abonado: true,
        installTech: true, status: true, neighborhood: true, branch: { select: { legacyId: true } },
      },
    });
    if (!full) throw new NotFoundException('Cliente no encontrado');
    if (!full.pppUsername) throw new BadRequestException('El cliente no tiene usuario PPPoE (name_s) para dar de alta.');

    const sub = full as unknown as SubForNet;
    const router = await this.resolveRouter(sub);
    const name = full.pppUsername.replace(/\s+/g, '');
    const comment = full.netComment || `${full.neighborhood ?? ''} ${full.abonado ?? ''}`.trim();
    const routerInfo = { id: router.id, name: router.name, host: `${router.ip}:${router.port}`, tech: router.tech };
    const res: MikrotikActionResult = {
      ok: false, dryRun: !this.live, action: 'PROVISION' as MikrotikAction, subscriberId,
      mikrotik: routerInfo, steps: [], message: '',
    };

    const secretData: Record<string, string> = {
      name,
      password: full.pppPassword || '',
      'remote-address': full.ipRemote || '',
      'local-address': full.ipLocal || '',
      profile: (full.pppProfile || 'default').trim(),
      comment,
      service: full.pppService || 'pppoe',
    };

    if (!this.live) {
      res.steps = [
        `connect ${routerInfo.host}`,
        `/ppp/secret/print ?name=${name}  (¿existe?)`,
        `si no existe → /ppp/secret/add name=${name} profile=${secretData.profile} remote-address=${secretData['remote-address']} service=${secretData.service}`,
        `si existe → /ppp/secret/set (actualiza perfil/IP/clave)`,
      ];
      res.ok = true;
      res.message = `DRY-RUN: alta simulada de ${name} en ${router.name}. Sin cambios reales.`;
      await this.audit('PROVISION' as MikrotikAction, sub, router, res, user);
      return res;
    }

    const api = new RouterosClient();
    try {
      await api.connect(router.ip, Number(router.port), router.username, router.password, { timeoutMs: 8000 });
      res.steps.push(`conectado a ${routerInfo.host}`);
      const existing = await api.comm('/ppp/secret/getall', { '.proplist': '.id', '?name': name });
      if (existing.length && existing[0]['.id']) {
        await api.comm('/ppp/secret/set', { '.id': existing[0]['.id'], ...secretData });
        res.steps.push('secret existente actualizado');
      } else {
        await api.comm('/ppp/secret/add', secretData);
        res.steps.push('secret creado');
      }
      api.close();
      res.ok = true;
      res.message = `Alta aplicada: ${name} provisionado en ${router.name}.`;
    } catch (e) {
      api.close();
      res.error = e instanceof RouterosError ? e.message : (e as Error).message;
      res.message = `Fallo el alta: ${res.error}`;
    }
    await this.audit('PROVISION' as MikrotikAction, sub, router, res, user);
    return res;
  }

  /**
   * Empuja un nuevo perfil PPP (velocidad/plan) al router y reinicia la sesión
   * activa para que tome efecto de inmediato. Dry-run salvo MIKROTIK_LIVE=true.
   * No cambia el estado del abonado; solo el perfil en el /ppp/secret.
   */
  async applyProfile(subscriberId: string, profileRaw: string, user?: AuthUser): Promise<MikrotikActionResult> {
    // Trim del perfil: un espacio inicial/final en los datos hacía que el perfil
    // no coincidiera con el del RouterOS y el cliente no tomara plan (bug conocido).
    const profile = (profileRaw || 'default').trim();
    const sub = await this.loadSubscriber(subscriberId);
    if (!sub.pppUsername) throw new BadRequestException('El cliente no tiene usuario PPPoE (name_s) para cambiar el perfil.');
    const router = await this.resolveRouter(sub);
    const name = sub.pppUsername.replace(/\s+/g, '');
    const routerInfo = { id: router.id, name: router.name, host: `${router.ip}:${router.port}`, tech: router.tech };
    const res: MikrotikActionResult = {
      ok: false, dryRun: !this.live, action: 'PROFILE', subscriberId,
      mikrotik: routerInfo, steps: [], message: '',
    };

    if (!this.live) {
      res.steps = [
        `connect ${routerInfo.host}`,
        `/ppp/secret/set ?name=${name} profile=${profile}`,
        `/ppp/active/remove ?name=${name}  (reinicia sesión para aplicar el perfil)`,
      ];
      res.ok = true;
      res.message = `DRY-RUN: perfil de ${name} → "${profile}" en ${router.name}. Sin cambios reales.`;
      await this.audit('PROFILE', sub, router, res, user);
      return res;
    }

    const api = new RouterosClient();
    try {
      await api.connect(router.ip, Number(router.port), router.username, router.password, { timeoutMs: 8000 });
      res.steps.push(`conectado a ${routerInfo.host}`);
      const secret = await api.comm('/ppp/secret/getall', { '.proplist': '.id', '?name': name });
      if (!secret.length || !secret[0]['.id']) throw new RouterosError(`No existe /ppp/secret para ${name}.`);
      await api.comm('/ppp/secret/set', { '.id': secret[0]['.id'], profile });
      res.steps.push(`perfil actualizado → ${profile}`);
      const active = await api.comm('/ppp/active/getall', { '.proplist': '.id', '?name': name });
      if (active.length && active[0]['.id']) {
        await api.comm('/ppp/active/remove', { '.id': active[0]['.id'] });
        res.steps.push('sesión activa reiniciada (aplica el nuevo perfil)');
      }
      api.close();
      res.ok = true;
      res.message = `Perfil aplicado: ${name} → "${profile}" en ${router.name}.`;
    } catch (e) {
      api.close();
      res.error = e instanceof RouterosError ? e.message : (e as Error).message;
      res.message = `Falló el cambio de perfil: ${res.error}`;
    }
    await this.audit('PROFILE', sub, router, res, user);
    return res;
  }

  // ------------------------------------------------------------------
  // ESTADO EN VIVO
  // ------------------------------------------------------------------
  async liveStatus(subscriberId: string): Promise<MikrotikActionResult> {
    const sub = await this.loadSubscriber(subscriberId);
    if (!sub.pppUsername) {
      throw new BadRequestException('El cliente no tiene usuario PPPoE (name_s).');
    }
    const router = await this.resolveRouter(sub);
    const name = sub.pppUsername.replace(/\s+/g, '');
    const comment = this.comment(sub);
    const routerInfo = { id: router.id, name: router.name, host: `${router.ip}:${router.port}`, tech: router.tech };

    const res: MikrotikActionResult = {
      ok: false,
      dryRun: !this.live,
      action: 'STATUS',
      subscriberId,
      mikrotik: routerInfo,
      steps: [],
      message: '',
    };

    if (!this.live) {
      res.ok = true;
      res.message = 'DRY-RUN: no se consulta el router. Active MIKROTIK_LIVE=true para estado real.';
      res.live = {};
      return res;
    }

    const api = new RouterosClient();
    try {
      await api.connect(router.ip, Number(router.port), router.username, router.password, { timeoutMs: 6000 });
      const secrets = await api.comm('/ppp/secret/getall', { '?name': name });
      const active = await api.comm('/ppp/active/getall', { '?name': name });
      const inAct = await api.comm('/ip/firewall/address-list/print', { '?list': ADDRESS_LIST_ACTIVE, '?comment': comment });
      const inMor = await api.comm('/ip/firewall/address-list/print', { '?list': ADDRESS_LIST_DEBTOR, '?comment': comment });
      api.close();
      res.live = {
        secretExists: secrets.length > 0,
        secretDisabled: secrets[0]?.['disabled'] === 'true',
        sessionActive: active.length > 0,
        ip: secrets[0]?.['remote-address'] || active[0]?.['address'] || sub.ipRemote || '',
        inActivos: inAct.length > 0,
        inMorosos: inMor.length > 0,
      };
      res.ok = true;
      res.message = 'Estado leído del router.';
    } catch (e) {
      api.close();
      res.error = e instanceof RouterosError ? e.message : (e as Error).message;
      res.message = `No se pudo leer el estado: ${res.error}`;
    }
    return res;
  }

  // ------------------------------------------------------------------
  // TEST de conexión a un router
  // ------------------------------------------------------------------
  async testRouter(mikrotikId: string): Promise<MikrotikActionResult> {
    const router = await this.prisma.mikrotik.findUnique({ where: { id: mikrotikId } });
    if (!router) throw new NotFoundException('Mikrotik no encontrado');
    const routerInfo = { id: router.id, name: router.name, host: `${router.ip}:${router.port}`, tech: router.tech };
    const res: MikrotikActionResult = {
      ok: false,
      dryRun: !this.live,
      action: 'TEST',
      mikrotik: routerInfo,
      steps: [],
      message: '',
    };
    if (!this.live) {
      res.ok = true;
      res.message = `DRY-RUN: no se contacta ${routerInfo.host}. Active MIKROTIK_LIVE=true para probar de verdad.`;
      return res;
    }
    const api = new RouterosClient();
    try {
      await api.connect(router.ip, Number(router.port), router.username, router.password, { timeoutMs: 6000 });
      const id = await api.comm('/system/identity/print');
      api.close();
      res.ok = true;
      res.steps.push(`identity=${id[0]?.['name'] ?? '?'}`);
      res.message = `Conexión OK con ${router.name} (${routerInfo.host}).`;
      await this.prisma.mikrotik.update({ where: { id: router.id }, data: { online: true } }).catch(() => undefined);
    } catch (e) {
      api.close();
      res.error = e instanceof RouterosError ? e.message : (e as Error).message;
      res.message = `No se pudo conectar a ${router.name}: ${res.error}`;
      await this.prisma.mikrotik.update({ where: { id: router.id }, data: { online: false } }).catch(() => undefined);
    }
    return res;
  }

  // ------------------------------------------------------------------
  // Lotes (corte/reconexión masivos, estilo Clientgroup)
  // ------------------------------------------------------------------
  cutBatch(ids: string[], user?: AuthUser) { return this.batchByRouter(ids, 'CUT', user); }
  reconnectBatch(ids: string[], user?: AuthUser) { return this.batchByRouter(ids, 'RECONNECT', user); }

  /**
   * Restaura / sincroniza los secrets PPP de toda una sede contra su(s) router(s):
   * recorre los abonados con usuario PPPoE y estado activo/cortado y (re)crea su
   * secret vía provision() — crea el que falte y actualiza el existente. Es la
   * herramienta de recuperación tras formatear un router y el "sync CRM→Mikrotik".
   * Respeta el gate dry-run de provision(): sin MIKROTIK_LIVE=true solo simula.
   */
  async restoreBranch(branchId: string, opts: { statuses?: string[]; limit?: number } = {}, user?: AuthUser) {
    const statuses = (opts.statuses?.length ? opts.statuses : ['ACTIVO', 'CORTADO']) as any[];
    const limit = Math.min(2000, Math.max(1, opts.limit ?? 800));
    const subs = await this.prisma.subscriber.findMany({
      where: { branchId, status: { in: statuses }, pppUsername: { not: null } },
      select: { id: true }, take: limit,
    });
    let ok = 0, failed = 0;
    const errors: { subscriberId: string; error: string }[] = [];
    for (const s of subs) {
      try {
        const r = await this.provision(s.id, user);
        if (r.ok) ok++; else { failed++; if (errors.length < 15) errors.push({ subscriberId: s.id, error: r.error ?? r.message }); }
      } catch (e) {
        failed++;
        if (errors.length < 15) errors.push({ subscriberId: s.id, error: (e as Error).message });
      }
    }
    return {
      dryRun: !this.live, branchId, total: subs.length, ok, failed, errors,
      message: !this.live
        ? `DRY-RUN: se simuló la restauración de ${subs.length} secret(s) de la sede; sin cambios reales.`
        : `Restauración de la sede: ${ok} secret(s) creados/actualizados${failed ? `, ${failed} con error` : ''}.`,
    };
  }

  /**
   * Corte/reconexión en lote agrupando por router: abre UNA sola conexión por
   * router y ejecuta todos sus clientes sobre ella (cientos de clientes sin
   * reconectar cada vez). Cada cliente se audita y marca su estado igual que la
   * acción individual. Respeta el gate dry-run.
   */
  private async batchByRouter(
    ids: string[],
    action: 'CUT' | 'RECONNECT',
    user?: AuthUser,
  ): Promise<{ total: number; ok: number; results: MikrotikActionResult[] }> {
    const results: MikrotikActionResult[] = [];
    const targetStatus = action === 'CUT' ? 'CORTADO' : 'ACTIVO';
    const verb = action === 'CUT' ? 'Corte' : 'Reconexión';
    const morosoMode: 'mark' | 'unmark' = action === 'CUT' ? 'mark' : 'unmark';

    // 1. Cargar abonados. Agrupar por router PRIMARIO (secret + acción completa) y,
    //    en paralelo, mapear los OTROS routers de la sede (solo lista MOROSOS).
    const groups = new Map<string, { router: Mikrotik; subs: SubForNet[] }>();
    const morosoGroups = new Map<string, { router: Mikrotik; subs: SubForNet[] }>();
    // Estado por-abonado que se va completando entre el router primario y los de sede.
    const state = new Map<string, { sub: SubForNet; primary: Mikrotik; res: MikrotikActionResult }>();

    for (const id of ids) {
      try {
        const sub = await this.loadSubscriber(id);
        if (!sub.pppUsername) {
          results.push({ ok: false, dryRun: !this.live, action, subscriberId: id, steps: [], message: 'El cliente no tiene usuario PPPoE (name_s).', error: 'sin pppUsername' });
          continue;
        }
        const router = await this.resolveRouter(sub);
        const g = groups.get(router.id) ?? { router, subs: [] };
        g.subs.push(sub);
        groups.set(router.id, g);
        for (const o of await this.sedeOtherRouters(sub, router.id)) {
          const mg = morosoGroups.get(o.id) ?? { router: o, subs: [] };
          mg.subs.push(sub);
          morosoGroups.set(o.id, mg);
        }
        state.set(sub.id, {
          sub, primary: router,
          res: { ok: false, dryRun: !this.live, action, subscriberId: sub.id, mikrotik: { id: router.id, name: router.name, host: `${router.ip}:${router.port}`, tech: router.tech }, steps: [], message: '' },
        });
      } catch (e) {
        results.push({ ok: false, dryRun: !this.live, action, subscriberId: id, steps: [], message: (e as Error).message, error: (e as Error).message });
      }
    }

    // 2. DRY-RUN: solo describe (router primario + morosos en los de la sede).
    if (!this.live) {
      for (const { sub, primary, res } of state.values()) {
        res.ok = true;
        res.steps.push(`DRY-RUN: ${verb.toLowerCase()} de ${sub.pppUsername} en ${primary.name} (secret + ${action === 'CUT' ? 'MOROSOS' : 'ACTIVOS'})`);
      }
      for (const { router, subs } of morosoGroups.values()) {
        for (const sub of subs) state.get(sub.id)?.res.steps.push(`DRY-RUN: [${router.name}] ${action === 'CUT' ? 'agregar a' : 'quitar de'} MOROSOS`);
      }
      for (const { sub, primary, res } of state.values()) {
        res.message = 'DRY-RUN: sin cambios reales.';
        await this.audit(action, sub, primary, res, user);
        results.push(res);
      }
      return { total: ids.length, ok: results.filter((r) => r.ok).length, results };
    }

    // 3. Router PRIMARIO por grupo: acción completa (una conexión por router).
    for (const { router, subs } of groups.values()) {
      const api = new RouterosClient();
      try {
        await api.connect(router.ip, Number(router.port), router.username, router.password, { timeoutMs: 8000 });
      } catch (e) {
        const msg = e instanceof RouterosError ? e.message : (e as Error).message;
        for (const sub of subs) { const st = state.get(sub.id)!; st.res.error = msg; st.res.message = `No se pudo conectar a ${router.name}`; st.res.steps.push(`✗ ${router.name}: ${msg}`); }
        await this.prisma.mikrotik.update({ where: { id: router.id }, data: { online: false } }).catch(() => undefined);
        continue;
      }
      await this.prisma.mikrotik.update({ where: { id: router.id }, data: { online: true } }).catch(() => undefined);
      for (const sub of subs) {
        const st = state.get(sub.id)!;
        const r = action === 'CUT' ? await this.cutOnApi(api, sub) : await this.reconnectOnApi(api, sub);
        st.res.ok = r.ok; st.res.error = r.error;
        st.res.steps.push(`[${router.name}] ${r.steps.join(' · ')}`);
        if (r.ok) { try { await this.markStatus(sub, targetStatus); } catch { /* estado BD best-effort */ } }
      }
      api.close();
    }

    // 4. OTROS routers de la sede: solo lista MOROSOS (una conexión por router).
    for (const { router, subs } of morosoGroups.values()) {
      const api = new RouterosClient();
      try {
        await api.connect(router.ip, Number(router.port), router.username, router.password, { timeoutMs: 8000 });
      } catch (e) {
        const msg = e instanceof RouterosError ? e.message : (e as Error).message;
        for (const sub of subs) state.get(sub.id)?.res.steps.push(`[${router.name}] ✗ no conectó: ${msg}`);
        continue;
      }
      for (const sub of subs) {
        const st = state.get(sub.id)!;
        const ip = sub.ipRemote || '';
        const mr = morosoMode === 'mark' ? await this.markMorosoOnApi(api, sub, ip) : await this.unmarkMorosoOnApi(api, sub, ip);
        st.res.steps.push(`[${router.name}] ${mr.ok ? mr.steps.join(' · ') : '✗ ' + mr.error}`);
      }
      api.close();
    }

    // 5. Finalizar: mensaje + auditoría por abonado.
    for (const { sub, primary, res } of state.values()) {
      res.message = res.ok ? `${verb} aplicado en ${primary.name}${morosoGroups.size ? ' + morosos en la sede' : ''}.` : `Fallo: ${res.error}`;
      await this.audit(action, sub, primary, res, user);
      results.push(res);
    }

    return { total: ids.length, ok: results.filter((r) => r.ok).length, results };
  }

  // ------------------------------------------------------------------
  // Historial de acciones (auditoría) de un cliente
  // ------------------------------------------------------------------
  async history(subscriberId: string, limit = 50) {
    return this.prisma.mikrotikActionLog.findMany({
      where: { subscriberId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 200),
    });
  }

  // ------------------------------------------------------------------
  private async markStatus(sub: SubForNet, next: 'CORTADO' | 'ACTIVO') {
    if (sub.status === next) return;
    await this.prisma.subscriber.update({
      where: { id: sub.id },
      data: {
        previousStatus: (sub.status as any) ?? undefined,
        status: next as any,
        statusChangedAt: new Date(),
      },
    }).catch((e) => this.logger.warn(`No se pudo actualizar estado del cliente: ${e.message}`));
  }
}
