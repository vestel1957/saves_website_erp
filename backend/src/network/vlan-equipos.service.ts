import { BadRequestException, ForbiddenException, NotFoundException } from '../core/http/errores';
import { APP_PERMISSIONS, SUPERADMIN_PERMISSION } from '../auth/permissions.catalog';
import { Logger } from '../core/logger';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/current-user.decorator';
import { OltService } from './olt.service';
import type { MikrotikService } from './mikrotik.service';
import {
  interfazHaciaOlt, pasoRouterOsComoTexto, planMikrotikParaVlan, routerDeLaOlt, saludDeVlans,
  sugerirVlanParaPuerto, uplinkHabitual, uplinksDeVlan,
  type LecturaMikrotikVlans, type LecturaOltVlans, type SaludVlan,
} from './vlan-salud';
import { comandosOltParaVlan } from './olt/olt-huawei.driver';

/**
 * Las VLANs de punta a punta en los EQUIPOS (2026-09-23): OLT (creada + en el
 * uplink) y Mikrotik (interfaz VLAN + servidor PPPoE). El catálogo sigue en
 * `NetworkWriteService`; esto lee los equipos, dice qué falta
 * (`vlan-salud.ts`) y —solo cuando una persona lo confirma— agrega lo que falta.
 *
 * Nació de la 590 de Villanueva: existía en la OLT y en el Mikrotik pero no en
 * el uplink, y la clienta quedó con la ONU en línea y sin internet.
 *
 * Reglas: nunca borra ni modifica lo existente; el uplink y el puerto del
 * Mikrotik se DEDUCEN de lo que ya usan las demás VLANs (si es ambiguo, se pide
 * elegir); las escrituras pasan por los gates de siempre (OLT_LIVE /
 * MIKROTIK_LIVE o sus interruptores) y quedan auditadas con el usuario.
 */
export class VlanEquiposService {
  private readonly logger = new Logger(VlanEquiposService.name);
  /** Lectura de los Mikrotik por sede: 2 min (la de la OLT la cachea `OltService`, 10 min). */
  private static readonly cacheRouters = new Map<string, { at: number; data: { routers: LecturaMikrotikVlans[]; errores: string[] } }>();
  private static readonly ROUTERS_TTL_MS = 2 * 60_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly olt: OltService,
    private readonly mikrotik: MikrotikService,
  ) {}

  private async routersDeSede(branchId: string, refresh: boolean) {
    const hit = VlanEquiposService.cacheRouters.get(branchId);
    if (!refresh && hit && Date.now() - hit.at < VlanEquiposService.ROUTERS_TTL_MS) return hit.data;
    const data = await this.mikrotik.vlansDeRoutersDeSede(branchId);
    if (data.routers.length) VlanEquiposService.cacheRouters.set(branchId, { at: Date.now(), data });
    return data;
  }

  /**
   * `GET /network/vlans/salud?branchId=` — por cada OLT de la sede, cada VLAN con
   * su catálogo, OLT, uplink, Mikrotik, veredicto y qué falta. SOLO LECTURA.
   */
  async salud(branchId: string, refresh: boolean | 'vlans' = false) {
    if (!branchId) throw new BadRequestException('Falta la sede.');
    const olts = await this.prisma.olt.findMany({ where: { branchId }, orderBy: [{ isDefault: 'desc' }, { name: 'asc' }] });
    const { routers, errores } = await this.routersDeSede(branchId, !!refresh);
    const catalogo = await this.prisma.vlan.findMany({
      where: { branchId },
      select: { id: true, vlan: true, detail: true, tray: true, oltPort: true, oltId: true },
    });
    const salida = [];
    for (const o of olts) {
      const l = await this.olt.lecturaVlansDeOlt(o.id, refresh);
      if (!l.ok || !l.data) {
        salida.push({ id: o.id, name: o.name, ok: false, error: l.error, leidoEn: null, uplink: null, router: null, filas: [] as SaludVlan[] });
        continue;
      }
      const router = routerDeLaOlt(l.data, routers);
      const hab = uplinkHabitual(l.data);
      salida.push({
        id: o.id, name: o.name, ok: true, error: null, leidoEn: l.leidoEn, cached: !!l.cached,
        uplink: {
          fsp: hab.fsp, ambiguo: hab.ambiguo,
          candidatos: hab.candidatos.map((c) => ({ ...c, interfazMikrotik: router ? interfazHaciaOlt(l.data!, router, c.fsp) : null })),
        },
        router: router ? { id: router.id, name: router.name } : null,
        filas: saludDeVlans({
          oltId: o.id, lectura: l.data, router, catalogo,
          routerError: router ? null : errores.join('; ') || 'ningún Mikrotik de la sede tiene las VLANs de esta OLT',
        }),
      });
    }
    return { branchId, olts: salida, mikrotikErrores: errores };
  }

  /**
   * `POST /network/vlans/:id/configurar-equipos` — deja la VLAN del catálogo en
   * la OLT (creada + uplink) y en el Mikrotik (interfaz + PPPoE). Con `dryRun`
   * (por defecto) solo dice qué comandos correría y dónde. Sin él, los corre —
   * cada equipo con su gate— y vuelve a leer para contar qué quedó bien.
   */
  async configurarEquipos(
    vlanId: string,
    opts: { dryRun?: boolean; uplink?: string | null },
    user?: AuthUser,
  ) {
    const dryRun = opts.dryRun !== false;
    const v = await this.prisma.vlan.findUnique({ where: { id: vlanId } });
    if (!v) throw new NotFoundException('VLAN no encontrada');
    if (!v.branchId) throw new BadRequestException('La VLAN no tiene sede: asígnele una antes de configurarla en los equipos.');
    if (!Number.isInteger(v.vlan) || v.vlan < 2 || v.vlan > 4094) throw new BadRequestException(`El número ${v.vlan} no es una VLAN válida (2-4094).`);
    const oltId = await this.oltDeLaVlan(v);

    // Siempre releer la OLT antes de decidir: lo que falta tiene que ser de ahora.
    const l = await this.olt.lecturaVlansDeOlt(oltId, 'vlans');
    if (!l.ok || !l.data) throw new BadRequestException(`No se pudo leer la OLT: ${l.error}`);
    const { routers, errores } = await this.routersDeSede(v.branchId, true);

    const plan = this.plan(v.vlan, l.data, routers, opts.uplink ?? null);
    if (plan.necesitaUplink) {
      return { ok: false, dryRun, vlan: v.vlan, necesitaUplink: true, candidatos: plan.candidatos, avisos: plan.avisos, mikrotikErrores: errores };
    }
    const base = {
      vlan: v.vlan,
      olt: { id: oltId, comandos: plan.olt.comandos, uplink: plan.olt.uplink },
      mikrotik: plan.router
        ? { id: plan.router.id, name: plan.router.name, interfaz: plan.interfaz, comandos: plan.mk.pasos.map(pasoRouterOsComoTexto) }
        : null,
      avisos: plan.avisos,
      mikrotikErrores: errores,
      nadaQueHacer: !plan.olt.comandos.length && !plan.mk.pasos.length,
    };
    if (dryRun || base.nadaQueHacer) return { ok: true, dryRun: true, ...base };

    // Ver el plan lo puede quien ve las VLANs; ESCRIBIR en la OLT y en el router
    // exige los mismos permisos que ya piden esas escrituras en el resto del
    // sistema (autenticar ONUs / administrar routers). No se abre nada nuevo.
    const concedidos = user?.permissions ?? [];
    const faltan = ([
      plan.olt.comandos.length ? APP_PERMISSIONS.NETWORK_OLT_MANAGE : null,
      plan.mk.pasos.length ? APP_PERMISSIONS.NETWORK_ROUTERS_MANAGE : null,
    ] as (string | null)[]).filter((x): x is string => !!x && !concedidos.includes(x) && !concedidos.includes(SUPERADMIN_PERMISSION));
    if (faltan.length) throw new ForbiddenException(`Para configurar los equipos le falta el permiso: ${faltan.join(', ')}.`);

    const resOlt = plan.olt.comandos.length
      ? await this.olt.configurarVlanEnOlt(oltId, { vlan: v.vlan, crear: plan.olt.crear, uplink: plan.olt.uplinkAPoner }, user)
      : null;
    // Si la OLT dijo que no, no se sigue: un Mikrotik listo para una VLAN que no
    // sale de la OLT es justo el estado a medias que esto quiere evitar.
    const resMk = plan.router && plan.mk.pasos.length && (!resOlt || resOlt.ok)
      ? await this.mikrotik.configurarVlanEnRouter(plan.router.id, v.vlan, plan.mk.pasos, user)
      : null;

    // Releer los dos equipos y contar qué quedó.
    const despues = await this.salud(v.branchId, 'vlans').catch((e) => {
      this.logger.warn(`Relectura tras configurar la VLAN ${v.vlan}: ${(e as Error).message}`);
      return null;
    });
    const fila = despues?.olts.find((o) => o.id === oltId)?.filas.find((f) => f.vlan === v.vlan) ?? null;
    return {
      ok: (!resOlt || resOlt.ok) && (!resMk || resMk.ok) && fila?.estado === 'OK',
      dryRun: false,
      ...base,
      resultado: {
        olt: resOlt, mikrotik: resMk,
        mikrotikOmitido: plan.router && plan.mk.pasos.length && resOlt && !resOlt.ok
          ? 'No se tocó el Mikrotik porque la OLT rechazó la configuración.' : null,
      },
      despues: fila,
    };
  }

  /**
   * Qué falta y con qué comandos, sin tocar nada. Público para que el alta de
   * ONUs (Fase 3) pueda avisar ANTES de autenticar con el mismo criterio.
   */
  plan(vlan: number, l: LecturaOltVlans, routers: LecturaMikrotikVlans[], uplinkPedido: string | null) {
    const avisos: string[] = [];
    const existe = l.vlans.some((x) => x.vlan === vlan);
    const enUplink = uplinksDeVlan(l, vlan).filter((u) => u.estado === 'up');
    const hab = uplinkHabitual(l);
    let uplink: string | null = enUplink[0]?.fsp ?? null;
    let uplinkAPoner: string | null = null;
    if (!uplink) {
      if (uplinkPedido) {
        if (!hab.candidatos.some((c) => c.fsp === uplinkPedido)) {
          throw new BadRequestException(`El uplink ${uplinkPedido} no es uno de los de la OLT: ${hab.candidatos.map((c) => c.fsp).join(', ') || 'ninguno'}.`);
        }
        uplinkAPoner = uplinkPedido;
      } else if (hab.fsp) {
        uplinkAPoner = hab.fsp;
      } else {
        const candidatos = hab.candidatos.map((c) => ({ fsp: c.fsp, vlans: c.vlans }));
        return {
          necesitaUplink: true as const, candidatos,
          avisos: [hab.candidatos.length
            ? `La OLT usa varios uplinks (${hab.candidatos.map((c) => `${c.fsp}: ${c.vlans} VLANs`).join(', ')}): elija por cuál sale la VLAN ${vlan}.`
            : 'La OLT no tiene un uplink arriba con VLANs de clientes: no se puede deducir.'],
        };
      }
      uplink = uplinkAPoner;
    }
    const comandos = comandosOltParaVlan({ vlan, crear: !existe, uplink: uplinkAPoner });
    const router = routerDeLaOlt(l, routers);
    const interfaz = router ? interfazHaciaOlt(l, router, uplink) : null;
    const mk = router ? planMikrotikParaVlan(router, vlan, interfaz) : { pasos: [], avisos: [], nombre: null };
    if (!router) avisos.push('Ningún Mikrotik de la sede tiene las VLANs de esta OLT (o no se pudieron leer): el tramo del router no se configura.');
    avisos.push(...mk.avisos);
    return {
      necesitaUplink: false as const, candidatos: [] as { fsp: string; vlans: number }[],
      olt: { comandos, crear: !existe, uplink, uplinkAPoner },
      router, interfaz, mk, avisos,
    };
  }

  /**
   * ¿La VLAN de este PON llega al PPPoE? Para avisar ANTES de autenticar (Fase 3):
   * que la ONU quede en línea sin internet fue lo que pasó con la 590. Rápido
   * (dos comandos en la OLT + la lectura cacheada de los Mikrotik) y NUNCA lanza:
   * si algo no se puede comprobar, `ok` queda en null con el porqué.
   */
  async chequeoDePuerto(oltId: string, frame: number, slot: number, port: number, vlanForzada?: number | null) {
    const fsp = `${frame}/${slot}/${port}`;
    // La tarjeta de la orden se refresca a menudo y leer los service-ports de un
    // PON lleno cuesta ~2 s: el resultado vale unos minutos (solo los concluyentes).
    const clave = `${oltId}:${fsp}:${vlanForzada ?? ''}`;
    const hit = VlanEquiposService.cacheChequeo.get(clave);
    if (hit && Date.now() - hit.at < VlanEquiposService.CHEQUEO_TTL_MS) return hit.data;
    const r = await this.chequeoDePuertoSinCache(oltId, fsp, frame, slot, port, vlanForzada);
    if (r.ok !== null) VlanEquiposService.cacheChequeo.set(clave, { at: Date.now(), data: r });
    return r;
  }

  private static readonly cacheChequeo = new Map<string, { at: number; data: Awaited<ReturnType<VlanEquiposService['chequeoDePuertoSinCache']>> }>();
  private static readonly CHEQUEO_TTL_MS = 3 * 60_000;

  private async chequeoDePuertoSinCache(oltId: string, fsp: string, frame: number, slot: number, port: number, vlanForzada?: number | null) {
    const salida = {
      fsp, vlan: null as number | null, origen: null as string | null,
      ok: null as boolean | null, falta: [] as string[],
      /** Fila del catálogo con esa VLAN en la sede, para el botón "Configurar en equipos". */
      vlanCatalogoId: null as string | null,
      /** Sede, para enlazar a Red › VLANs. */
      branchId: null as string | null,
    };
    try {
      const o = await this.prisma.olt.findUnique({ where: { id: oltId }, select: { branchId: true } });
      salida.branchId = o?.branchId ?? null;
      const r = await this.olt.vlanDePuerto(oltId, frame, slot, port, vlanForzada);
      if (!r.ok) { salida.falta.push(`no se pudo leer la OLT: ${r.error}`); return salida; }
      if (!r.vlan) {
        salida.falta.push(`el puerto ${fsp} no tiene VLAN: ni clientes ni fila en el catálogo de VLANs`);
        salida.ok = false;
        return salida;
      }
      salida.vlan = r.vlan;
      salida.origen = r.origen;
      if (o?.branchId) {
        const cat = await this.prisma.vlan.findFirst({ where: { branchId: o.branchId, vlan: r.vlan }, select: { id: true } });
        salida.vlanCatalogoId = cat?.id ?? null;
      }
      if (!r.detalle?.existe) salida.falta.push(`la VLAN ${r.vlan} no existe en la OLT`);
      else if (!r.detalle.uplinks.some((u) => u.estado === 'up')) salida.falta.push(`la VLAN ${r.vlan} no sale por el uplink de la OLT`);
      let mkRevisado = false;
      if (o?.branchId) {
        const { routers, errores } = await this.routersDeSede(o.branchId, false);
        if (routers.length) {
          mkRevisado = true;
          const iface = routers.flatMap((x) => x.vlans.map((v) => ({ x, v }))).find(({ v }) => v.vlanId === r.vlan && !v.disabled);
          if (!iface) salida.falta.push(`la VLAN ${r.vlan} no existe en el Mikrotik de la sede`);
          else if (!iface.x.pppoe.some((p) => p.interfaz === iface.v.name && !p.disabled)) {
            salida.falta.push(`el Mikrotik ${iface.x.name} no tiene servidor PPPoE en ${iface.v.name}`);
          }
        } else if (errores.length) {
          salida.falta.push(`Mikrotik sin revisar: ${errores.join('; ')}`);
        }
      }
      const reales = salida.falta.filter((f) => !f.startsWith('Mikrotik sin revisar'));
      salida.ok = reales.length ? false : mkRevisado ? true : null;
    } catch (e) {
      salida.falta.push(`no se pudo comprobar: ${(e as Error).message}`);
    }
    return salida;
  }

  /**
   * `GET /network/vlans/sugerir?oltId=&slot=&port=` — número de VLAN para un PON
   * que no tiene ninguna, según el patrón de su tarjeta. Solo sugiere.
   */
  async sugerir(oltId: string, frame: number, slot: number, port: number) {
    if (!oltId || !Number.isInteger(slot) || !Number.isInteger(port)) throw new BadRequestException('Faltan la OLT, la bandeja o el puerto.');
    const o = await this.prisma.olt.findUnique({ where: { id: oltId }, select: { id: true, branchId: true } });
    if (!o) throw new NotFoundException('OLT no encontrada');
    const l = await this.olt.lecturaVlansDeOlt(oltId, false);
    if (!l.ok || !l.data) return { vlan: null, motivo: `No se pudo leer la OLT: ${l.error}` };
    const catalogo = o.branchId
      ? (await this.prisma.vlan.findMany({ where: { branchId: o.branchId }, select: { vlan: true } })).map((x) => x.vlan)
      : [];
    return sugerirVlanParaPuerto(l.data.puertos, frame, slot, port, {
      olt: l.data.vlans.filter((x) => x.servicePorts > 0).map((x) => x.vlan),
      catalogo,
    });
  }

  /** La OLT de una fila del catálogo: la ligada o, si la sede solo tiene una, esa. */
  private async oltDeLaVlan(v: { oltId: string | null; branchId: string | null }): Promise<string> {
    if (v.oltId) return v.oltId;
    const olts = await this.prisma.olt.findMany({ where: { branchId: v.branchId }, select: { id: true } });
    if (olts.length === 1) return olts[0].id;
    throw new BadRequestException(olts.length
      ? 'La sede tiene varias OLT: elija en la VLAN a cuál pertenece antes de configurarla.'
      : 'La sede no tiene ninguna OLT registrada.');
  }
}
