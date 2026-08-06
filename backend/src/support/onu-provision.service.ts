import { BadRequestException, NotFoundException } from '../core/http/errores';
import { Logger } from '../core/logger';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/current-user.decorator';
import { exigirSedeSuscriptor } from '../common/sede-scope';
import { OltService } from '../network/olt.service';
import { OltPlanProfileService } from '../network/olt-plan-profile.service';

/**
 * OnuProvisionService — autenticar la ONU DESDE LA ORDEN DE INSTALACIÓN.
 *
 * Antes, autenticar era un trámite aparte: el técnico salía de la orden, se iba a
 * /red/olt, buscaba su ONU entre todas las del autofind y rellenaba a mano ocho
 * campos, incluidas DOS traffic-tables ("73 · 300 Mbps") que tenía que acertar de
 * memoria. Elegir la velocidad a mano es justo lo que aquí desaparece: el plan
 * contratado por el abonado manda, y su equivalencia en la OLT la configuró
 * administración una vez (PlanOltProfile).
 *
 * Lo que sí queda en manos del técnico es la ÚNICA decisión que solo él puede
 * tomar: cuál de las ONUs que se están anunciando es la que acaba de instalar.
 * Eso es el desplegable. Todo lo demás —OLT por sede, puerto, VLAN, perfiles,
 * velocidad, comentario y vínculo con el abonado— se deduce y se aplica con el
 * botón.
 *
 * Regla dura: si el plan del abonado no tiene velocidad configurada en la OLT,
 * NO se autentica. Una ONU sin traffic-table queda sin tope de velocidad, y eso
 * no se nota hasta que alguien mira el consumo dentro de un mes.
 */

/** Tipos de orden donde se AUTENTICA una ONU nueva contra la OLT. */
const TIPOS_AUTENTICAR = ['instalac', 'traslado', 'cambio de equipo', 'reinstalac'];
/** Tipos de orden donde la ONU ya existe y solo cambia la velocidad del plan. */
const TIPOS_VELOCIDAD = ['subir megas', 'bajar megas', 'cambio de plan'];

export type ModoOnu = 'AUTENTICAR' | 'VELOCIDAD' | null;

/** Qué se puede hacer con la OLT en una orden de este tipo. */
export function modoDeOrden(type: string | null | undefined): ModoOnu {
  const t = (type ?? '').toLowerCase();
  if (!t.trim()) return null;
  if (TIPOS_VELOCIDAD.some((k) => t.includes(k))) return 'VELOCIDAD';
  if (TIPOS_AUTENTICAR.some((k) => t.includes(k))) return 'AUTENTICAR';
  return null;
}

/** Serial comparable: mayúsculas y sin signos (el inventario trae espacios y guiones). */
export function normalizarSerial(s: string | null | undefined): string {
  return String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Las formas con las que un mismo equipo puede estar escrito en el inventario.
 *
 * La OLT reporta el SN en 16 hex (`47504F4E120278E5`), pero en el inventario los
 * seriales suelen venir como los imprime el fabricante en la etiqueta: los 4
 * primeros bytes son el OUI en ASCII (`GPON`, `HWTC`, `XPON`, `XGTC`) seguidos
 * de los 8 hex restantes → `GPON120278E5`. Sin esta traducción el cruce
 * inventario↔OLT pasa de 424 equipos a 90: la mayoría de los que SÍ casan lo
 * hacen por esta vía.
 */
export function formasDeSerial(sn: string | null | undefined): string[] {
  const hex = normalizarSerial(sn);
  if (!hex) return [];
  const formas = new Set<string>([hex]);
  if (/^[0-9A-F]{16}$/.test(hex)) {
    const ascii = (hex.slice(0, 8).match(/../g) ?? [])
      .map((par) => String.fromCharCode(parseInt(par, 16)))
      .join('');
    // Solo si los 4 bytes son texto imprimible: hay ONUs cuyo prefijo es binario
    // y convertirlo produciría un serial fantasma que casaría con cualquier cosa.
    if (/^[A-Z0-9]{4}$/.test(ascii)) formas.add(ascii + hex.slice(8));
  }
  return [...formas];
}

function nombreDe(s: any): string {
  if (!s) return '';
  if (s.fullName?.trim()) return s.fullName.trim();
  const p = [s.firstName, s.secondName, s.lastName1, s.lastName2].map((x: any) => (x || '').trim()).filter(Boolean).join(' ');
  return p || (s.companyName || '').trim();
}

export class OnuProvisionService {
  private readonly logger = new Logger(OnuProvisionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly olt: OltService,
    private readonly planProfiles: OltPlanProfileService,
  ) {}

  /** Orden + abonado + comprobación de sede. Punto único de entrada de permisos. */
  private async cargarOrden(ticketId: string, user?: AuthUser) {
    const t = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      select: { id: true, code: true, type: true, subscriberId: true },
    });
    if (!t) throw new NotFoundException('Orden no encontrada.');
    if (t.subscriberId) await exigirSedeSuscriptor(this.prisma, user, t.subscriberId);
    if (!t.subscriberId) throw new BadRequestException('La orden no tiene abonado: no hay a quién autenticarle la ONU.');
    const sub = await this.prisma.subscriber.findUnique({
      where: { id: t.subscriberId },
      select: {
        id: true, abonado: true, branchId: true, fullName: true,
        firstName: true, secondName: true, lastName1: true, lastName2: true, companyName: true,
        branch: { select: { name: true } },
      },
    });
    if (!sub) throw new BadRequestException('El abonado de la orden ya no existe.');
    return { t, sub };
  }

  /**
   * OLT que le toca al abonado: la de su sede. Si la sede tiene varias, la
   * marcada por defecto. Si la sede no tiene ninguna configurada se devuelve
   * null y la UI lo dice — adivinar el equipo equivocado sería peor.
   */
  private async oltDeSede(branchId: string | null) {
    if (!branchId) return null;
    return this.prisma.olt.findFirst({
      where: { branchId },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      select: { id: true, name: true, ip: true, defaultLineProfile: true, defaultSrvProfile: true, defaultVlan: true, defaultGemport: true, defaultUserVlan: true },
    });
  }

  /**
   * Cruza los SN que reporta la OLT con el inventario de equipos.
   *
   * Devuelve, por cada SN, la ficha del equipo si existe: de qué bodega salió y
   * si ya está instalado en otro abonado. Ese último dato es el que impide el
   * error que de verdad duele — montarle a un cliente el equipo que figura a
   * nombre de otro— y que hoy no se detectaba porque nadie cruzaba nada.
   *
   * Se hace en SQL crudo porque hay que normalizar el serial en la comparación:
   * el inventario guarda `" BA1310-2007008434 "`, con espacios y guiones.
   */
  private async equiposPorSn(sns: string[]) {
    const porForma = new Map<string, string>(); // forma normalizada → SN original
    for (const sn of sns) for (const f of formasDeSerial(sn)) porForma.set(f, sn);
    const formas = [...porForma.keys()];
    if (!formas.length) return new Map<string, any>();

    const filas = await this.prisma.$queryRaw<any[]>`
      SELECT e.id, e.code, e.serial, e.status, e."subscriberId",
             upper(regexp_replace(coalesce(e.serial, ''), '[^A-Za-z0-9]', '', 'g')) AS norma,
             w.name AS bodega,
             s.abonado AS sub_abonado, s."fullName" AS sub_full,
             s."firstName" AS sub_n1, s."lastName1" AS sub_a1, s."companyName" AS sub_emp
      FROM "Equipment" e
      LEFT JOIN "EquipmentWarehouse" w ON w.id = e."warehouseId"
      LEFT JOIN "Subscriber" s ON s.id = e."subscriberId"
      WHERE upper(regexp_replace(coalesce(e.serial, ''), '[^A-Za-z0-9]', '', 'g')) = ANY(${formas}::text[])
    `;

    const porSn = new Map<string, any>();
    for (const f of filas) {
      const sn = porForma.get(f.norma);
      if (!sn || porSn.has(sn)) continue; // si hay duplicados, manda el primero
      porSn.set(sn, {
        id: f.id,
        code: f.code,
        serial: f.serial,
        status: f.status,
        bodega: f.bodega ?? null,
        subscriberId: f.subscriberId ?? null,
        subscriberNombre: f.subscriberId
          ? nombreDe({ fullName: f.sub_full, firstName: f.sub_n1, lastName1: f.sub_a1, companyName: f.sub_emp })
            || (f.sub_abonado != null ? `abonado ${f.sub_abonado}` : 'otro cliente')
          : null,
      });
    }
    return porSn;
  }

  /**
   * ¿La bodega del equipo es de la sede del abonado? Las bodegas de equipos son
   * por sede y se llaman igual que ella ("Yopal", "Almacen cabecera Yopal"), así
   * que se compara por nombre. "Depurados" no es de ninguna sede: eso también se
   * avisa, porque un equipo depurado no debería estar instalándose.
   */
  private avisoDeBodega(bodega: string | null, sede: string | null): string | null {
    if (!bodega) return 'El equipo no está en ninguna bodega (figura en tránsito).';
    // Sin tildes ni signos: "Almacén cabecera Yopal" tiene que casar con "Yopal".
    const n = (x: string) => x.toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z]/g, '');
    if (/DEPURAD/i.test(bodega)) return `El equipo figura en la bodega "${bodega}": está dado de baja.`;
    if (!sede) return null;
    return n(bodega).includes(n(sede))
      ? null
      : `El equipo está en la bodega "${bodega}" y el abonado es de ${sede}.`;
  }

  /** Plan de internet vigente del abonado (el ACTIVO manda sobre cualquier otro). */
  private async planDeAbonado(subscriberId: string) {
    const servicios = await this.prisma.subscriberService.findMany({
      where: { subscriberId, kind: 'INTERNET' },
      select: { planId: true, planName: true, megas: true, status: true },
      orderBy: { updatedAt: 'desc' },
    });
    return servicios.find((s) => s.status === 'ACTIVO') ?? servicios[0] ?? null;
  }

  /**
   * Todo lo que la orden necesita saber para enseñar el bloque de la ONU:
   * OLT, plan, velocidad que se aplicará y ONUs esperando autenticación.
   *
   * El autofind es una consulta SSH en vivo (unos segundos): se pide al abrir el
   * bloque y con el botón de refrescar, no en cada render.
   */
  async estado(ticketId: string, user?: AuthUser) {
    const { t, sub } = await this.cargarOrden(ticketId, user);
    const modo = modoDeOrden(t.type);
    const olt = await this.oltDeSede(sub.branchId);
    const plan = await this.planDeAbonado(sub.id);
    const mapeo = await this.planProfiles.resolveConEtiqueta(plan?.planId, olt?.id);
    const { live } = await this.olt.mode();

    const base = {
      modo,
      live,
      olt: olt ? { id: olt.id, name: olt.name } : null,
      plan: plan
        ? { id: plan.planId, name: plan.planName, megas: plan.megas, estado: plan.status }
        : null,
      velocidad: mapeo
        ? {
            trafficIn: mapeo.trafficIn, trafficOut: mapeo.trafficOut,
            mbpsIn: (mapeo as any).mbpsIn ?? null, mbpsOut: (mapeo as any).mbpsOut ?? null,
            origen: mapeo.origen,
          }
        : null,
      // Motivo por el que el botón no se puede usar (uno solo, el primero que aplica).
      bloqueo: this.motivoDeBloqueo({ modo, olt, plan, mapeo }),
      candidatos: [] as any[],
      onuActual: null as any,
    };

    // Sin OLT, sin plan o sin mapeo no tiene sentido gastar una sesión SSH: se
    // devuelve el motivo y la UI enseña qué hay que arreglar y dónde.
    if (base.bloqueo) return base;

    // ONU ya vinculada al abonado (para "subir megas" y para avisar de duplicados).
    const yaTiene = await this.prisma.oltOnu.findFirst({
      where: { subscriberId: sub.id },
      orderBy: { lastSync: 'desc' },
      select: { id: true, sn: true, oltId: true, frame: true, slot: true, port: true, ontId: true, runState: true, description: true },
    });
    base.onuActual = yaTiene;

    if (modo === 'AUTENTICAR' && olt) {
      const r = await this.olt.autofind(olt.id);
      // Seriales de los equipos que el sistema ya tiene registrados a nombre de
      // este abonado: si uno de ellos está en el autofind, es casi seguro el que
      // acaba de instalar y se marca para que salte a la vista.
      const equipos = await this.prisma.equipment.findMany({
        where: { subscriberId: sub.id },
        select: { serial: true, mac: true },
      });
      const mios = new Set(
        equipos.flatMap((e) => [e.serial, e.mac]).filter(Boolean).map((x) => String(x).toUpperCase().replace(/[^A-Z0-9]/g, '')),
      );
      const onus = Array.isArray(r.onus) ? r.onus : [];
      // Ficha de inventario de cada SN: bodega de la que salió y si ya está
      // instalado en otro cliente.
      const inv = await this.equiposPorSn(onus.map((o: any) => String(o.sn ?? '')));
      const sede = sub.branch?.name ?? null;
      base.candidatos = onus.map((o: any) => {
        const eq = inv.get(String(o.sn ?? '')) ?? null;
        const deOtro = !!eq?.subscriberId && eq.subscriberId !== sub.id;
        return {
          sn: o.sn,
          fsp: o.fsp,
          model: o.model || null,
          vendor: o.vendor || null,
          mac: o.mac || null,
          delAbonado: mios.has(normalizarSerial(o.sn)) || (o.mac ? mios.has(normalizarSerial(o.mac)) : false),
          equipo: eq && { code: eq.code, serial: eq.serial, bodega: eq.bodega, status: eq.status },
          // Motivo por el que NO se puede autenticar este equipo concreto.
          impedimento: deOtro
            ? `Este equipo está instalado a nombre de ${eq.subscriberNombre} (código ${eq.code}). No se puede montar en otro cliente.`
            : null,
          // Aviso que no impide seguir, pero que hay que ver antes de pulsar.
          aviso: eq && !deOtro ? this.avisoDeBodega(eq.bodega, sede) : null,
        };
      });
      if (!r.ok) {
        base.bloqueo = { code: 'AUTOFIND_ERROR', message: `No se pudo leer el autofind de la OLT ${olt.name}: ${r.error}` };
      } else if (!base.candidatos.length) {
        base.bloqueo = {
          code: 'AUTOFIND_VACIO',
          message: `La OLT ${olt.name} no ve ninguna ONU esperando autenticación. `
            + 'Conecte la fibra y encienda el equipo; luego refresque.',
        };
      }
      // Ordena: primero las del abonado, luego las que no tienen impedimento, y
      // al final por puerto — el desplegable no debe obligar a leer 30 seriales
      // iguales para encontrar el bueno.
      base.candidatos.sort((a: any, b: any) =>
        Number(b.delAbonado) - Number(a.delAbonado)
        || Number(!!a.impedimento) - Number(!!b.impedimento)
        || String(a.fsp).localeCompare(String(b.fsp)));
    }

    if (modo === 'VELOCIDAD' && !yaTiene) {
      base.bloqueo = {
        code: 'SIN_ONU',
        message: 'Este abonado no tiene ninguna ONU vinculada en el inventario de la OLT, '
          + 'así que no hay velocidad que cambiar. Autentíquela primero o vincúlela en Red › OLT.',
      };
    }
    return base;
  }

  /** El primer impedimento real, en el orden en que hay que resolverlos. */
  private motivoDeBloqueo(x: { modo: ModoOnu; olt: any; plan: any; mapeo: any }): { code: string; message: string } | null {
    if (!x.modo) {
      return { code: 'TIPO', message: 'Esta orden no es de instalación ni de cambio de velocidad: no aplica la autenticación de ONU.' };
    }
    if (!x.olt) {
      return { code: 'SIN_OLT', message: 'La sede del abonado no tiene ninguna OLT configurada. Configúrela en Red › OLT.' };
    }
    if (!x.plan?.planId) {
      return {
        code: 'SIN_PLAN',
        message: x.plan
          ? `El servicio de internet del abonado ("${x.plan.planName ?? 'sin nombre'}") no está ligado a un plan del catálogo, `
            + 'así que no se sabe qué velocidad aplicar. Asígnele un plan desde su ficha.'
          : 'El abonado no tiene servicio de internet registrado: no hay plan del que sacar la velocidad.',
      };
    }
    if (!x.mapeo) {
      return {
        code: 'SIN_VELOCIDAD',
        message: `El plan "${x.plan.planName ?? x.plan.planId}" no tiene velocidad configurada para esta OLT. `
          + 'Administración debe mapearlo en Configuración › Planes › Velocidad en OLT. '
          + 'Sin eso la ONU quedaría sin tope de velocidad y no se autentica.',
      };
    }
    return null;
  }

  /**
   * AUTENTICA la ONU elegida y la deja lista: perfiles y VLAN clonados de lo que
   * ya funciona en ese puerto, velocidad tomada del plan, comentario con el
   * abonado y vínculo ONU↔cliente en el inventario.
   */
  async autenticar(ticketId: string, dto: { sn: string; equipmentId?: string }, user?: AuthUser) {
    const { t, sub } = await this.cargarOrden(ticketId, user);
    if (modoDeOrden(t.type) !== 'AUTENTICAR') {
      throw new BadRequestException(`Las órdenes de tipo "${t.type}" no autentican ONUs.`);
    }
    const sn = String(dto?.sn ?? '').trim().toUpperCase();
    if (!sn) throw new BadRequestException('Elija la ONU que va a autenticar.');

    // El equipo, ANTES de tocar la OLT. Que el aviso lo pinte el navegador no
    // sirve de nada si la petición se puede mandar igual: el que decide es este.
    const equipo = (await this.equiposPorSn([sn])).get(sn) ?? null;
    if (equipo?.subscriberId && equipo.subscriberId !== sub.id) {
      throw new BadRequestException(
        `La ONU ${sn} corresponde al equipo ${equipo.code}, que figura instalado a nombre de ${equipo.subscriberNombre}. `
        + 'No se autentica en otro cliente: si el equipo cambió de dueño, primero retírelo de esa cuenta.',
      );
    }
    // Equipo del inventario al que el técnico dice que corresponde esta ONU
    // (solo cuando el SN no estaba registrado). Se valida aquí y se usa al final.
    let equipoAVincular: { id: string; code: number } | null = null;
    if (!equipo && dto?.equipmentId) {
      const cand = await this.prisma.equipment.findUnique({
        where: { id: dto.equipmentId },
        select: { id: true, code: true, subscriberId: true },
      });
      if (!cand) throw new BadRequestException('El equipo del inventario que eligió ya no existe.');
      if (cand.subscriberId && cand.subscriberId !== sub.id) {
        throw new BadRequestException(`El equipo ${cand.code} ya está instalado en otro cliente.`);
      }
      equipoAVincular = { id: cand.id, code: cand.code };
    }

    const olt = await this.oltDeSede(sub.branchId);
    const plan = await this.planDeAbonado(sub.id);
    const mapeo = await this.planProfiles.resolve(plan?.planId, olt?.id);
    const bloqueo = this.motivoDeBloqueo({ modo: 'AUTENTICAR', olt, plan, mapeo });
    if (bloqueo) throw new BadRequestException(bloqueo.message);

    // El F/S/P se relee del autofind en vez de fiarse de lo que mandó el
    // navegador: entre que se pintó la lista y que se pulsó el botón, la ONU pudo
    // moverse de puerto (o ser otra). Autenticar en el puerto equivocado deja al
    // abonado sin servicio y a otro con una ONU fantasma.
    const af = await this.olt.autofind(olt!.id);
    if (!af.ok) throw new BadRequestException(`No se pudo leer el autofind de la OLT: ${af.error}`);
    const encontrada = (Array.isArray(af.onus) ? af.onus : []).find((o: any) => String(o.sn ?? '').toUpperCase() === sn);
    if (!encontrada) {
      throw new BadRequestException(
        `La ONU ${sn} ya no se está anunciando en la OLT ${olt!.name}. `
        + 'Puede que se haya apagado, que la autenticaran desde otro sitio o que perdiera la fibra. Refresque la lista.',
      );
    }
    const m = String(encontrada.fsp ?? '').match(/(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)/);
    if (!m) throw new BadRequestException(`La OLT reporta la ONU ${sn} sin puerto legible (F/S/P "${encontrada.fsp}").`);
    const [frame, slot, port] = [Number(m[1]), Number(m[2]), Number(m[3])];

    // Lo que ya funciona en ese puerto: VLAN, gemport y perfiles. El mapeo del
    // plan pisa lo que traiga configurado; si no, manda el puerto; y en último
    // término los valores por defecto de la OLT.
    const sug = (await this.olt.sugerencia(olt!.id, frame, slot, port)).sugerencia ?? {};
    const elegir = (...vs: any[]) => {
      for (const v of vs) if (v !== undefined && v !== null && v !== '') return v;
      return undefined;
    };
    const vlan = elegir(mapeo!.vlan, sug.vlan, olt!.defaultVlan);
    const params = {
      frame, slot, port, sn,
      lineprofile: elegir(mapeo!.lineprofile, sug.lineprofile, olt!.defaultLineProfile),
      srvprofile: elegir(mapeo!.srvprofile, sug.srvprofile, olt!.defaultSrvProfile),
      vlan,
      gemport: elegir(mapeo!.gemport, sug.gemport, olt!.defaultGemport, 1),
      user_vlan: elegir(mapeo!.userVlan, sug.user_vlan, olt!.defaultUserVlan, vlan),
      // La velocidad NO se pregunta: sale del plan.
      traffic_in: mapeo!.trafficIn ?? undefined,
      traffic_out: mapeo!.trafficOut ?? undefined,
      desc: this.comentario(sub),
    };
    if (!params.lineprofile || !params.srvprofile) {
      throw new BadRequestException(
        `No se pudo deducir el perfil de alta para el puerto ${frame}/${slot}/${port} `
        + '(no hay ONUs funcionando ahí de las que copiar, ni valores por defecto en la OLT). '
        + 'Autentíquela desde Red › OLT indicando line-profile y srv-profile, o configúrelos en el plan.',
      );
    }
    if (!params.vlan) {
      throw new BadRequestException(
        `No se pudo deducir la VLAN del puerto ${frame}/${slot}/${port}. Sin VLAN la ONU quedaría registrada pero sin servicio.`,
      );
    }

    const res: any = await this.olt.provision(olt!.id, params, user);
    if (!res.ok) return res;

    let equipoRegistrado: { code: number; serialCorregido: boolean } | null = null;
    if (!res.dryRun) {
      equipoRegistrado = await this.registrarEquipo(sn, sub.id, equipo?.id ?? equipoAVincular?.id ?? null);
      await this.vincularYAnotar(olt!.id, sn, sub, t, params, res, plan, equipoRegistrado);
    }
    return {
      ...res,
      plan: { id: plan!.planId, name: plan!.planName },
      velocidad: { trafficIn: mapeo!.trafficIn, trafficOut: mapeo!.trafficOut },
      fsp: `${frame}/${slot}/${port}`,
      equipo: equipoRegistrado,
    };
  }

  /**
   * Marca el equipo como instalado en el abonado y le graba el SN REAL.
   *
   * Esto último es lo que va limpiando el inventario: hoy ~3.400 equipos tienen
   * de serial la palabra "solicitar" o "asignar", y por eso solo el 3,5% se
   * puede cruzar con lo que ve la OLT. Cada instalación corrige un registro con
   * el dato bueno —el que reporta el propio equipo— en vez de con lo que alguien
   * tecleó. Sin este cruce arreglado, filtrar por bodega es imposible.
   */
  private async registrarEquipo(sn: string, subscriberId: string, equipmentId: string | null) {
    if (!equipmentId) return null;
    try {
      const previo = await this.prisma.equipment.findUnique({
        where: { id: equipmentId },
        select: { code: true, serial: true },
      });
      const serialCorregido = normalizarSerial(previo?.serial) !== normalizarSerial(sn);
      await this.prisma.equipment.update({
        where: { id: equipmentId },
        data: {
          subscriberId,
          serial: sn,
          installType: 'FTTH',
          // Sale del stock disponible: la bodega ya no lo tiene, lo tiene el cliente.
          warehouseId: null,
        },
      });
      return { code: previo?.code ?? 0, serialCorregido };
    } catch (e) {
      // El alta en la OLT ya está hecha y es lo que da servicio: un fallo
      // registrando el inventario se avisa, no se convierte en un alta fallida.
      this.logger.warn(`ONU ${sn} autenticada pero no se pudo registrar el equipo ${equipmentId}: ${(e as Error).message}`);
      return null;
    }
  }

  /** Comentario que queda en la OLT. Formato del legacy: `<abonado><nombre>`, que es lo que lee el auto-vinculador. */
  private comentario(sub: any): string {
    const nombre = nombreDe(sub).replace(/[^A-Za-zÁÉÍÓÚÑáéíóúñ ]/g, '').trim().split(/\s+/).slice(0, 2).join('');
    return `${sub.abonado ?? ''}${nombre}`.slice(0, 32);
  }

  /**
   * Deja constancia: ONU vinculada al abonado en el inventario y una entrada en
   * el hilo de la orden. Sin esto el alta se pierde: nadie sabría, leyendo la
   * orden, que la ONU se autenticó desde ahí ni con qué velocidad.
   */
  private async vincularYAnotar(oltId: string, sn: string, sub: any, t: any, params: any, res: any, plan: any, equipo: { code: number; serialCorregido: boolean } | null) {
    try {
      const onu = await this.prisma.oltOnu.findFirst({ where: { oltId, sn }, select: { id: true } });
      if (onu) {
        await this.prisma.oltOnu.update({
          where: { id: onu.id },
          data: { subscriberId: sub.id, clientName: nombreDe(sub) || String(sub.abonado ?? '') },
        });
      }
    } catch (e) {
      this.logger.warn(`ONU ${sn} autenticada pero no se pudo vincular al abonado ${sub.id}: ${(e as Error).message}`);
    }
    if (t.code == null) return;
    const avisos: string[] = res.verificacion?.avisos ?? [];
    const msg =
      `ONU autenticada desde la orden · SN ${sn} · puerto ${params.frame}/${params.slot}/${params.port}`
      + (res.ontId ? ` · ONT-ID ${res.ontId}` : '')
      + `\nPlan: ${plan?.planName ?? '—'} · velocidad aplicada: traffic-table bajada ${params.traffic_in ?? '—'} / subida ${params.traffic_out ?? '—'}`
      + `\nEstado: ${res.verificacion?.run_state ?? '—'} · config ${res.verificacion?.config_state ?? '—'} · ${res.verificacion?.servicePorts?.length ?? 0} service-port(s)`
      + (equipo ? `\nEquipo ${equipo.code} registrado a nombre del abonado${equipo.serialCorregido ? ' (se corrigió su serial con el que reporta la OLT)' : ''}` : '')
      + (avisos.length ? `\nAvisos: ${avisos.join(' | ')}` : '');
    await this.prisma.ticketThread
      .create({ data: { ticketCode: t.code, message: msg, subscriberId: sub.id, employeeId: 0, date: new Date() } })
      .catch((e) => this.logger.warn(`No se pudo anotar el alta en la orden ${t.code}: ${e.message}`));
  }

  /**
   * Aplica al service-port la velocidad del plan vigente, sobre la ONU que el
   * abonado YA tiene autenticada. Es el "subir/bajar megas" sin tocar el alta.
   */
  async aplicarVelocidad(ticketId: string, user?: AuthUser) {
    const { t, sub } = await this.cargarOrden(ticketId, user);
    if (modoDeOrden(t.type) !== 'VELOCIDAD') {
      throw new BadRequestException(`Las órdenes de tipo "${t.type}" no cambian la velocidad de la ONU.`);
    }
    const olt = await this.oltDeSede(sub.branchId);
    const plan = await this.planDeAbonado(sub.id);
    const mapeo = await this.planProfiles.resolve(plan?.planId, olt?.id);
    const bloqueo = this.motivoDeBloqueo({ modo: 'VELOCIDAD', olt, plan, mapeo });
    if (bloqueo) throw new BadRequestException(bloqueo.message);

    const onu = await this.prisma.oltOnu.findFirst({
      where: { subscriberId: sub.id },
      orderBy: { lastSync: 'desc' },
      select: { sn: true, oltId: true },
    });
    if (!onu?.sn) {
      throw new BadRequestException('Este abonado no tiene ninguna ONU vinculada: no hay velocidad que cambiar.');
    }

    const res: any = await this.olt.setSpeed(
      onu.oltId ?? olt!.id,
      { sn: onu.sn, traffic_in: mapeo!.trafficIn, traffic_out: mapeo!.trafficOut },
      user,
    );
    if (res.ok && !res.dryRun && t.code != null) {
      await this.prisma.ticketThread
        .create({
          data: {
            ticketCode: t.code,
            message: `Velocidad actualizada desde la orden · SN ${onu.sn} · plan ${plan!.planName ?? '—'}`
              + ` · traffic-table bajada ${mapeo!.trafficIn ?? '—'} / subida ${mapeo!.trafficOut ?? '—'}`,
            subscriberId: sub.id, employeeId: 0, date: new Date(),
          },
        })
        .catch(() => undefined);
    }
    return { ...res, plan: { id: plan!.planId, name: plan!.planName } };
  }
}
