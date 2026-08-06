import { BadRequestException, NotFoundException } from '../core/http/errores';
import { Logger } from '../core/logger';
import { PrismaService } from '../prisma/prisma.service';
import { OltService } from './olt.service';

/**
 * OltPlanProfileService — el puente que faltaba entre el CATÁLOGO DE PLANES y la
 * VELOCIDAD REAL de la OLT (`PlanOltProfile`).
 *
 * Hasta ahora la velocidad del abonado se elegía a mano en cada alta: el técnico
 * abría dos desplegables de traffic-tables crudas ("73 · 300 Mbps") y acertaba de
 * memoria. Eso es lo que este servicio elimina: la velocidad la decide el PLAN
 * contratado, se configura UNA vez por administración y el alta ya no pregunta.
 *
 * Por qué una tabla y no una fórmula: el índice de traffic-table NO se deduce de
 * las megas. En esta planta 100M usa in=54/out=53 y 300M usa in=70/out=73 — ni el
 * orden ni la distancia entre índices son consistentes, así que el par correcto lo
 * confirma un humano una sola vez y queda guardado.
 *
 * Herencia: una fila con `oltId` concreto SOBREESCRIBE la fila `oltId = null`
 * (default para todas las OLTs). Los TID varían de equipo a equipo.
 */
export class OltPlanProfileService {
  private readonly logger = new Logger(OltPlanProfileService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly olt: OltService,
  ) {}

  /**
   * Megas que declara el NOMBRE del plan ("300Megas26F" → 300, "1 Mega" → 1).
   *
   * Se lee el número que va ANTES de "mega": los nombres del legacy traen sufijos
   * numéricos de sede ("300Megas26F", "100Megasf24") y tomar "el primer número"
   * o "el último" acierta unas veces y falla otras. Solo sirve para SUGERIR el
   * par de traffic-tables en la pantalla de configuración — nunca para decidir
   * sola la velocidad de un alta.
   */
  static megasDeNombre(name: string | null | undefined): number | null {
    const s = (name ?? '').trim();
    if (!s) return null;
    // Sin `\b` tras la unidad a propósito: en el catálogo del legacy el nombre y
    // el sufijo de sede van pegados ("300Megas26F", "100Megasf24", "5MegasFS") y
    // exigir un límite de palabra dejaba sin leer la mitad de los planes.
    const giga = s.match(/(\d+(?:[.,]\d+)?)\s*(?:giga|gbps|gb)/i);
    if (giga) {
      const n = Number(giga[1].replace(',', '.'));
      return Number.isFinite(n) ? Math.round(n * 1000) : null;
    }
    const mega = s.match(/(\d+(?:[.,]\d+)?)\s*(?:mega|mbps|mb)/i);
    if (mega) {
      const n = Number(mega[1].replace(',', '.'));
      return Number.isFinite(n) ? Math.round(n) : null;
    }
    return null;
  }

  /**
   * Mapeo efectivo de un plan en una OLT concreta: la fila específica de esa OLT
   * pisa campo a campo a la fila por defecto (`oltId = null`). Devuelve null si
   * el plan no tiene NINGUNA velocidad configurada — que es el caso que hace
   * abortar el alta con un aviso, en vez de dar de alta una ONU sin tope.
   */
  async resolve(planId: string | null | undefined, oltId: string | null | undefined) {
    if (!planId) return null;
    const filas = await this.prisma.planOltProfile.findMany({
      where: { planId, OR: [{ oltId: null }, ...(oltId ? [{ oltId }] : [])] },
    });
    if (!filas.length) return null;
    const base = filas.find((f) => f.oltId === null) ?? null;
    const propia = oltId ? (filas.find((f) => f.oltId === oltId) ?? null) : null;
    const pick = <K extends keyof typeof filas[number]>(k: K) =>
      (propia?.[k] ?? base?.[k] ?? null) as number | null;

    const trafficIn = pick('trafficIn');
    const trafficOut = pick('trafficOut');
    // Sin par de traffic-tables el mapeo no sirve para lo único que importa aquí
    // (poner la velocidad), aunque traiga overrides de vlan o perfiles.
    if (trafficIn === null && trafficOut === null) return null;
    return {
      trafficIn, trafficOut,
      lineprofile: pick('lineprofile'),
      srvprofile: pick('srvprofile'),
      vlan: pick('vlan'),
      gemport: pick('gemport'),
      userVlan: pick('userVlan'),
      origen: propia ? 'olt' : 'default',
    };
  }

  /**
   * Mapeo + etiqueta legible ("300 Mbps bajada / 300 Mbps subida"). La UI del
   * técnico enseña ESTO antes de autenticar: si va a aplicar una velocidad, que
   * se vea cuál, no un número de índice.
   */
  async resolveConEtiqueta(planId: string | null | undefined, oltId: string | null | undefined) {
    const map = await this.resolve(planId, oltId);
    if (!map || !oltId) return map ? { ...map, mbpsIn: null, mbpsOut: null } : null;
    const mbps = await this.mbpsPorIndice(oltId).catch(() => new Map<number, number | null>());
    return {
      ...map,
      mbpsIn: map.trafficIn !== null ? (mbps.get(map.trafficIn) ?? null) : null,
      mbpsOut: map.trafficOut !== null ? (mbps.get(map.trafficOut) ?? null) : null,
    };
  }

  /** índice de traffic-table → Mbps (PIR), leído de la propia OLT (con caché del OltService). */
  private async mbpsPorIndice(oltId: string): Promise<Map<number, number | null>> {
    const r = await this.olt.trafficTables(oltId);
    const m = new Map<number, number | null>();
    for (const t of (r as any).tables ?? []) m.set(Number(t.id), t.mbps ?? null);
    return m;
  }

  /**
   * Tablero de configuración: todos los planes de internet con su mapeo actual y
   * las traffic-tables candidatas según las megas de su nombre.
   *
   * Se ordena por número de abonados: con 64 planes en el catálogo, lo que hay
   * que mapear primero es lo que de verdad se vende, no el orden alfabético.
   */
  async tablero(oltId: string | null) {
    const [planes, filas, tablas] = await Promise.all([
      this.prisma.plan.findMany({
        where: { kind: 'INTERNET' },
        orderBy: { name: 'asc' },
        include: { _count: { select: { services: true } } },
      }),
      this.prisma.planOltProfile.findMany(),
      oltId
        ? this.olt.trafficTables(oltId).then((r) => ((r as any).tables ?? []) as { id: string; mbps: number | null }[]).catch(() => [])
        : Promise.resolve([] as { id: string; mbps: number | null }[]),
    ]);

    const porPlan = new Map<string, typeof filas>();
    for (const f of filas) {
      const arr = porPlan.get(f.planId) ?? [];
      arr.push(f);
      porPlan.set(f.planId, arr);
    }

    const items = planes.map((p) => {
      const mias = porPlan.get(p.id) ?? [];
      const base = mias.find((f) => f.oltId === null) ?? null;
      const propia = oltId ? (mias.find((f) => f.oltId === oltId) ?? null) : null;
      const megas = p.megas ?? OltPlanProfileService.megasDeNombre(p.name);
      return {
        id: p.id,
        name: p.name,
        active: p.active,
        subscribers: p._count.services,
        // `megas` puede venir del catálogo o leerse del nombre: se marca de dónde
        // salió para que nadie confunda un dato confirmado con una lectura.
        megas,
        megasDelNombre: p.megas == null && megas != null,
        // Lo guardado, separado: la fila propia de la OLT y la de "todas".
        propia: propia && { trafficIn: propia.trafficIn, trafficOut: propia.trafficOut, lineprofile: propia.lineprofile, srvprofile: propia.srvprofile, vlan: propia.vlan, gemport: propia.gemport, userVlan: propia.userVlan },
        base: base && { trafficIn: base.trafficIn, trafficOut: base.trafficOut },
        // Candidatas = traffic-tables cuyo PIR encaja con las megas del plan.
        //
        // La ventana es ASIMÉTRICA (-10% / +35%) porque así están hechas las
        // tablas de esta planta: se aprovisiona con holgura por encima de lo
        // vendido (300 Megas → 302, 307) y a veces justo por debajo (293), y no
        // hay tabla exacta para las velocidades bajas (3 Megas se sirve con la
        // de 4). Una ventana simétrica del 5% dejaba fuera esos casos y, en los
        // planes pequeños, colaba tablas del plan de al lado (4,9 para 3 Megas).
        //
        // NO se elige cuál es subida y cuál bajada: en esta planta no hay regla
        // (100M → in 54/out 53, pero 300M → in 70/out 73). Lo confirma el humano.
        candidatas: megas != null
          ? tablas
              .filter((t) => t.mbps != null && t.mbps >= megas * 0.9 && t.mbps <= megas * 1.35)
              .map((t) => ({ id: Number(t.id), mbps: t.mbps }))
          : [],
      };
    });

    items.sort((a, b) => b.subscribers - a.subscribers || a.name.localeCompare(b.name, 'es'));
    const sinMapear = items.filter((i) => i.subscribers > 0 && !i.propia?.trafficOut && !i.base?.trafficOut).length;
    return { items, tablas, sinMapear, oltId };
  }

  /**
   * DEDUCE el mapeo plan→velocidad mirando la planta, no adivinándolo.
   *
   * El problema de rellenar esta tabla a mano es que nadie se sabe de memoria qué
   * índice de traffic-table le corresponde a cada plan, y no hay regla que lo
   * derive de las megas (100M usa subida 54 / bajada 53, pero 300M usa 70/73).
   * Pero el dato SÍ existe: está en los cientos de abonados que ya están
   * funcionando. Para cada plan se mira con qué par de traffic-tables están
   * configurados sus abonados en la OLT y gana la mayoría.
   *
   * Es el mismo principio que ya usa el alta para deducir VLAN y perfiles
   * ("clonar lo que funciona") aplicado al catálogo entero: la fuente de verdad
   * es el equipo, no lo que alguien recuerde.
   *
   * Devuelve propuestas con su evidencia (cuántos abonados la respaldan y qué
   * porcentaje representan) para que se confirmen, no las guarda solas.
   */
  async deducirDePlanta(oltId: string) {
    // ONUs de esta OLT que están vinculadas a un abonado con plan del catálogo.
    // Sin `ontId` no se pueden casar con la fila del service-port.
    const onus = await this.prisma.oltOnu.findMany({
      where: { oltId, subscriberId: { not: null }, ontId: { not: null }, slot: { not: null }, port: { not: null } },
      select: { subscriberId: true, frame: true, slot: true, port: true, ontId: true, runState: true },
    });
    if (!onus.length) {
      return {
        ok: false,
        error: 'Esta OLT no tiene ninguna ONU vinculada a un abonado en el inventario local. '
          + 'Sincronice los slots y ejecute el auto-vínculo en Red › OLT antes de deducir.',
        propuestas: [], puertos: 0, onus: 0,
      };
    }

    const servicios = await this.prisma.subscriberService.findMany({
      where: { subscriberId: { in: onus.map((o) => o.subscriberId!) }, kind: 'INTERNET', planId: { not: null } },
      select: { subscriberId: true, planId: true, status: true, plan: { select: { name: true } } },
      orderBy: { updatedAt: 'desc' },
    });
    const planPorAbonado = new Map<string, { planId: string; name: string }>();
    for (const s of servicios) {
      // El ACTIVO manda; si no hay, vale el más reciente.
      const previo = planPorAbonado.get(s.subscriberId);
      if (previo && s.status !== 'ACTIVO') continue;
      planPorAbonado.set(s.subscriberId, { planId: s.planId!, name: s.plan?.name ?? '' });
    }

    const conPlan = onus.filter((o) => planPorAbonado.has(o.subscriberId!));
    if (!conPlan.length) {
      return {
        ok: false,
        error: 'Las ONUs vinculadas de esta OLT no tienen plan del catálogo asignado, '
          + 'así que no hay de dónde deducir la velocidad.',
        propuestas: [], puertos: 0, onus: onus.length,
      };
    }

    // Un comando por PUERTO, no por abonado.
    const clave = (o: { frame: number | null; slot: number | null; port: number | null }) => `${o.frame ?? 0}/${o.slot}/${o.port}`;
    const puertos = [...new Map(conPlan.map((o) => [clave(o), { frame: o.frame ?? 0, slot: o.slot!, port: o.port! }])).values()];
    const lectura = await this.olt.servicePortsDePuertos(oltId, puertos);
    if (!lectura.ok) {
      return { ok: false, error: `No se pudo leer la OLT: ${lectura.error}`, propuestas: [], puertos: puertos.length, onus: conPlan.length };
    }

    // (puerto, ont-id) → traffic-tables reales.
    const spPorOnt = new Map<string, { rx: string; tx: string }>();
    for (const p of lectura.puertos) {
      for (const f of p.filas ?? []) spPorOnt.set(`${p.frame}/${p.slot}/${p.port}#${f.ontId}`, { rx: f.rx, tx: f.tx });
    }

    // Recuento por plan del par (bajada, subida) con el que está cada abonado.
    const votos = new Map<string, { name: string; total: number; pares: Map<string, number> }>();
    let sinServicePort = 0;
    for (const o of conPlan) {
      const sp = spPorOnt.get(`${clave(o)}#${o.ontId}`);
      if (!sp) { sinServicePort++; continue; }
      const baja = Number(sp.rx), sube = Number(sp.tx);
      if (!Number.isFinite(baja) || !Number.isFinite(sube)) { sinServicePort++; continue; }
      const plan = planPorAbonado.get(o.subscriberId!)!;
      const v = votos.get(plan.planId) ?? { name: plan.name, total: 0, pares: new Map<string, number>() };
      const k = `${baja}/${sube}`;
      v.pares.set(k, (v.pares.get(k) ?? 0) + 1);
      v.total++;
      votos.set(plan.planId, v);
    }

    const mbps = await this.mbpsPorIndice(oltId).catch(() => new Map<number, number | null>());
    const previas = await this.prisma.planOltProfile.findMany({ where: { oltId } });
    const yaGuardado = new Map(previas.map((p) => [p.planId, p]));
    const megasDelCatalogo = new Map(
      (await this.prisma.plan.findMany({ where: { kind: 'INTERNET' }, select: { id: true, name: true, megas: true } }))
        .map((p) => [p.id, p.megas ?? OltPlanProfileService.megasDeNombre(p.name)]),
    );

    const propuestas = [...votos.entries()].map(([planId, v]) => {
      const ordenados = [...v.pares.entries()]
        .map(([par, veces]) => {
          const [baja, sube] = par.split('/').map(Number);
          return { baja, sube, veces, mbpsBajada: mbps.get(baja) ?? null, mbpsSubida: mbps.get(sube) ?? null };
        })
        .sort((a, b) => b.veces - a.veces);

      // NO gana la mayoría a secas. En esta planta la mayoría suele estar MAL:
      // hay un par heredado que se aplicó a todo el mundo sin mirar el plan (por
      // eso cientos de abonados de 100 Megas están con una tabla de 55). Se
      // exige que la BAJADA del par se parezca a las megas que vende el plan; de
      // lo contrario se estaría automatizando el error existente.
      const megas = megasDelCatalogo.get(planId) ?? null;
      const encaja = (m: number | null) => m != null && megas != null && m >= megas * 0.9 && m <= megas * 1.35;
      const buenos = ordenados.filter((p) => encaja(p.mbpsBajada));
      const elegido = buenos[0] ?? null;

      // Abonados de este plan que hoy NO tienen una velocidad acorde a lo que
      // pagan. Es el dato que justifica revisar la planta.
      const desalineados = ordenados.filter((p) => !encaja(p.mbpsBajada)).reduce((s, p) => s + p.veces, 0);
      const actual = yaGuardado.get(planId);
      return {
        planId,
        name: v.name,
        megas,
        muestras: v.total,
        // Cuántos abonados respaldan el par propuesto, y qué parte del total es.
        respaldo: elegido?.veces ?? 0,
        confianza: elegido ? Math.round((elegido.veces / v.total) * 100) : 0,
        desalineados,
        // `trafficIn` es el índice `inbound`, que en la OLT es la columna RX =
        // BAJADA (verificado sobre 1.551 service-ports de la planta: la primera
        // columna es la mayor en el 99,9% de los casos).
        trafficIn: elegido?.baja ?? null,
        trafficOut: elegido?.sube ?? null,
        mbpsBajada: elegido?.mbpsBajada ?? null,
        mbpsSubida: elegido?.mbpsSubida ?? null,
        // Motivo por el que no hay propuesta, para que no parezca un fallo.
        sinPropuesta: elegido
          ? null
          : megas == null
            ? 'No se sabe cuántas megas vende este plan: complételo en el catálogo.'
            : `Ninguno de sus ${v.total} abonado(s) tiene hoy una velocidad de ~${megas} Mbps en la OLT. Elíjala a mano.`,
        // Todo lo que se vio, incluido lo descartado: la planta a la vista.
        observado: ordenados.slice(0, 5).map((p) => ({
          trafficIn: p.baja, trafficOut: p.sube, veces: p.veces,
          mbpsBajada: p.mbpsBajada, mbpsSubida: p.mbpsSubida,
          acorde: encaja(p.mbpsBajada),
        })),
        difiereDeLoGuardado: !!actual && !!elegido && (actual.trafficIn !== elegido.baja || actual.trafficOut !== elegido.sube),
      };
    });
    propuestas.sort((a, b) => b.muestras - a.muestras || a.name.localeCompare(b.name, 'es'));

    return {
      ok: true,
      error: '',
      propuestas,
      puertos: puertos.length,
      onus: conPlan.length,
      sinServicePort,
      // Total de abonados leídos que están con una velocidad que no corresponde
      // a su plan. Es un hallazgo de la planta, no del mapeo.
      desalineados: propuestas.reduce((s, p) => s + p.desalineados, 0),
    };
  }

  /** Guarda varias propuestas de una vez (lo que confirma el operador tras deducir). */
  async guardarLote(oltId: string | null, filas: { planId: string; trafficIn?: number | null; trafficOut?: number | null }[]) {
    let guardadas = 0;
    for (const f of filas) {
      if (!f?.planId) continue;
      await this.guardar({ planId: f.planId, oltId, trafficIn: f.trafficIn, trafficOut: f.trafficOut });
      guardadas++;
    }
    return { ok: true, guardadas };
  }

  /**
   * Guarda el mapeo de un plan. `oltId` null = default para todas las OLTs.
   *
   * De paso rellena `Plan.megas` si estaba vacío y el nombre lo dice: es el mismo
   * dato, escrito por la misma persona en la misma pantalla, y sin él la
   * elegibilidad de PlayHub y los informes siguen viendo el plan como "sin megas".
   */
  async guardar(dto: {
    planId: string; oltId?: string | null;
    trafficIn?: number | null; trafficOut?: number | null;
    lineprofile?: number | null; srvprofile?: number | null;
    vlan?: number | null; gemport?: number | null; userVlan?: number | null;
  }) {
    const plan = await this.prisma.plan.findUnique({ where: { id: dto.planId }, select: { id: true, name: true, megas: true } });
    if (!plan) throw new NotFoundException('Plan no encontrado.');
    const oltId = dto.oltId || null;
    if (oltId) {
      const existe = await this.prisma.olt.count({ where: { id: oltId } });
      if (!existe) throw new NotFoundException('OLT no encontrada.');
    }
    const n = (v: unknown) => (v === undefined || v === null || v === '' ? null : Number(v));
    const data = {
      trafficIn: n(dto.trafficIn), trafficOut: n(dto.trafficOut),
      lineprofile: n(dto.lineprofile), srvprofile: n(dto.srvprofile),
      vlan: n(dto.vlan), gemport: n(dto.gemport), userVlan: n(dto.userVlan),
    };
    for (const [k, v] of Object.entries(data)) {
      if (v !== null && (!Number.isFinite(v) || v < 0)) throw new BadRequestException(`Valor inválido en ${k}.`);
    }

    const previa = await this.prisma.planOltProfile.findFirst({ where: { planId: dto.planId, oltId } });
    if (previa) {
      await this.prisma.planOltProfile.update({ where: { id: previa.id }, data });
    } else {
      await this.prisma.planOltProfile.create({ data: { planId: dto.planId, oltId, ...data } });
    }

    if (plan.megas == null) {
      const megas = OltPlanProfileService.megasDeNombre(plan.name);
      if (megas != null) {
        await this.prisma.plan.update({ where: { id: plan.id }, data: { megas } });
        this.logger.log(`Plan "${plan.name}": se completó megas=${megas} leído del nombre al configurar su velocidad en la OLT.`);
      }
    }
    return { ok: true };
  }

  /** Borra el mapeo de un plan (en una OLT concreta o el default). */
  async borrar(planId: string, oltId: string | null) {
    const previa = await this.prisma.planOltProfile.findFirst({ where: { planId, oltId: oltId || null } });
    if (!previa) return { ok: true, borrado: false };
    await this.prisma.planOltProfile.delete({ where: { id: previa.id } });
    return { ok: true, borrado: true };
  }
}
