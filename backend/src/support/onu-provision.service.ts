import { BadRequestException, NotFoundException } from '../core/http/errores';
import { Logger } from '../core/logger';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/current-user.decorator';
import { exigirSedeSuscriptor } from '../common/sede-scope';
import { OltService } from '../network/olt.service';
import { OltPlanProfileService } from '../network/olt-plan-profile.service';
import { EquipoReservaService } from './equipo-reserva.service';

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
 * Lo que quedaba en manos del técnico era la única decisión que el sistema no
 * podía tomar: cuál de las ONUs que se están anunciando es la que acaba de
 * instalar. Eso es el desplegable. Todo lo demás —OLT por sede, puerto, VLAN,
 * perfiles, velocidad, comentario y vínculo con el abonado— se deduce y se
 * aplica con el botón.
 *
 * **Desde 2026-09-03 esa decisión también se toma sola** cuando no hay
 * ambigüedad (`decidirAutomatico`): se autentica el equipo que el cliente TIENE
 * ASIGNADO y, si es un cliente nuevo que no tiene ninguno, se le carga uno de la
 * bodega de su sede. La condición innegociable es que el equipo elegido esté
 * anunciándose en el autofind: el inventario dice de quién es un aparato, pero
 * solo la OLT sabe cuál está colgado del puerto de esa casa. Con dos ONUs en
 * juego y ninguna a nombre del cliente, vuelve a mandar el desplegable.
 *
 * Regla dura: si el plan del abonado no tiene velocidad configurada en la OLT,
 * NO se autentica. Una ONU sin traffic-table queda sin tope de velocidad, y eso
 * no se nota hasta que alguien mira el consumo dentro de un mes.
 */

/**
 * Tipos de orden donde se AUTENTICA una ONU contra la OLT.
 *
 * Los cinco que pidió el usuario (2026-09-03) son «Instalacion», «Cambio de
 * equipo», «Subir megas», «Traslado» y «Migracion»; se mantiene «Reinstalacion»,
 * que ya autenticaba y es el mismo trabajo. Se comparan por fragmento porque el
 * `detalle` del legacy es `varchar(50)` y viene escrito de varias formas:
 * `migraci` casa con «Migracion» (2.134 órdenes) y con «Migración».
 *
 * «Subir megas» está aquí Y en la lista de velocidad: en un aumento de megas la
 * ONU suele seguir siendo la misma —y entonces solo se le aplica la velocidad—,
 * pero cuando el equipo viejo no da el plan nuevo el técnico monta otro, y ahí
 * hay que autenticar. La orden ofrece las dos cosas (modo `AMBOS`) en vez de
 * obligarle a salirse a /red/olt para la mitad del trabajo.
 */
const TIPOS_AUTENTICAR = ['instalac', 'traslado', 'cambio de equipo', 'reinstalac', 'migraci', 'subir megas'];
/** Tipos de orden donde la ONU ya existe y solo cambia la velocidad del plan. */
const TIPOS_VELOCIDAD = ['subir megas', 'bajar megas', 'cambio de plan'];

/** `AMBOS` = la orden puede autenticar una ONU nueva y/o aplicar la velocidad. */
export type ModoOnu = 'AUTENTICAR' | 'VELOCIDAD' | 'AMBOS' | null;

/** Qué se puede hacer con la OLT en una orden de este tipo. */
export function modoDeOrden(type: string | null | undefined): ModoOnu {
  const t = (type ?? '').toLowerCase();
  if (!t.trim()) return null;
  // OJO al orden de las comprobaciones: «Cambio de equipo» y «Cambio de plan»
  // empiezan igual, así que cada lista se evalúa entera y por separado.
  const autentica = TIPOS_AUTENTICAR.some((k) => t.includes(k));
  const velocidad = TIPOS_VELOCIDAD.some((k) => t.includes(k));
  if (autentica && velocidad) return 'AMBOS';
  if (velocidad) return 'VELOCIDAD';
  if (autentica) return 'AUTENTICAR';
  return null;
}

/** ¿En esta orden se puede autenticar una ONU? */
export const puedeAutenticar = (m: ModoOnu): boolean => m === 'AUTENTICAR' || m === 'AMBOS';
/** ¿En esta orden se puede aplicar la velocidad del plan a la ONU que ya tiene? */
export const puedeVelocidad = (m: ModoOnu): boolean => m === 'VELOCIDAD' || m === 'AMBOS';

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

/**
 * Cuánto puede llevar anunciándose una ONU para seguir siendo "la que se acaba
 * de instalar".
 *
 * El autofind de esta planta NO es una lista de recién llegadas: en VILLANUEVA
 * hay 66 ONUs sonando y la más vieja lleva desde el 19 de agosto (equipos
 * retirados, unidades de bodega enchufadas a fibra, altas que nunca se hicieron).
 * Sin esta ventana no existe el caso "una sola candidata" y el automático no
 * saltaría jamás. Dos horas es de sobra para una instalación —el equipo empieza
 * a anunciarse en cuanto le llega luz— y deja fuera todo lo demás.
 */
const VENTANA_RECIEN_VISTA_MS = 2 * 60 * 60 * 1000;

/** Hace cuántos minutos empezó a anunciarse (null si la OLT no lo reporta). */
function minutosDesde(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 60000));
}

/** Lo que quedó apuntado en el inventario al autenticar (null = no se registró nada). */
type EquipoRegistrado = { code: number; serialCorregido: boolean; bodega: string | null } | null;

/** Coletilla de la nota: de dónde salió el equipo y si se le corrigió el serial. */
function lineaDelEquipo(e: NonNullable<EquipoRegistrado>): string {
  return (e.bodega ? ` (tomado de la bodega ${e.bodega})` : '')
    + (e.serialCorregido ? ' · se corrigió su serial con el que reporta la OLT' : '');
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
    /** Cuadra la reserva hecha al abrir la orden con lo que la OLT demostró. */
    private readonly reserva: EquipoReservaService = new EquipoReservaService(prisma),
  ) {}

  /** Orden + abonado + comprobación de sede. Punto único de entrada de permisos. */
  private async cargarOrden(ticketId: string, user?: AuthUser) {
    const t = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      select: {
        id: true, code: true, type: true, subscriberId: true,
        // El plan DESTINO de una orden de megas: desde 2026-09-02 el cliente no se
        // mueve de plan hasta que la orden se cierra, así que la velocidad que hay
        // que aplicar está aquí y no en su ficha (ver `planDeLaOrden`).
        planToId: true, planToName: true, planToMegas: true, planAppliedAt: true,
      },
    });
    if (!t) throw new NotFoundException('Orden no encontrada.');
    if (t.subscriberId) await exigirSedeSuscriptor(this.prisma, user, t.subscriberId);
    if (!t.subscriberId) throw new BadRequestException('La orden no tiene abonado: no hay a quién autenticarle la ONU.');
    const sub = await this.prisma.subscriber.findUnique({
      where: { id: t.subscriberId },
      select: {
        id: true, abonado: true, branchId: true, fullName: true,
        firstName: true, secondName: true, lastName1: true, lastName2: true, companyName: true,
        // `legacyId` es la llave con la que las bodegas de equipos dicen de qué
        // sede son (`EquipmentWarehouse.branchLegacy`): sin ella no se puede
        // sacar del stock de SU sede el equipo que se le va a instalar.
        branch: { select: { name: true, legacyId: true } },
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
      SELECT e.id, e.code, e.serial, e.status, e."subscriberId", e.brand, e."reservedTicketId",
             upper(regexp_replace(coalesce(e.serial, ''), '[^A-Za-z0-9]', '', 'g')) AS norma,
             w.name AS bodega, w."branchLegacy" AS bodega_sede,
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
        brand: f.brand ?? null,
        /** Orden para la que se apartó al abrirla (ver `EquipoReservaService`). */
        reservedTicketId: f.reservedTicketId ?? null,
        bodega: f.bodega ?? null,
        /** Sede de la bodega (`Branch.legacyId`); null = bodega sin sede ("Depurados"). */
        bodegaSede: f.bodega_sede ?? null,
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

  /**
   * Las ONUs del autofind, ya cruzadas con el inventario: de qué bodega salió
   * cada una y si se puede o no montar en este abonado.
   *
   * Lo usan las dos puertas —la pantalla y la autenticación— y tiene que ser la
   * MISMA lista en las dos: si el navegador viera un impedimento que el servidor
   * no calcula, bastaría con mandar el SN a mano para saltárselo.
   */
  private async candidatosDeAutofind(sub: any, onus: any[]) {
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
    // Ficha de inventario de cada SN: bodega de la que salió y si ya está
    // instalado en otro cliente.
    const inv = await this.equiposPorSn(onus.map((o: any) => String(o.sn ?? '')));
    const sede = sub.branch?.name ?? null;
    const candidatos = onus.map((o: any) => {
      const eq = inv.get(String(o.sn ?? '')) ?? null;
      const deOtro = !!eq?.subscriberId && eq.subscriberId !== sub.id;
      return {
        sn: o.sn,
        fsp: o.fsp,
        model: o.model || null,
        vendor: o.vendor || null,
        mac: o.mac || null,
        /** Desde cuándo se anuncia, en minutos. null = la OLT no lo reporta. */
        haceMin: minutosDesde(o.autofind_time),
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
    // Ordena: primero las del abonado, luego las que no tienen impedimento, y
    // dentro de eso LA MÁS RECIÉN APARECIDA — que en una lista de 66 seriales
    // iguales es lo único que ayuda a encontrar el suyo. El puerto ya solo
    // desempata a las que ni siquiera traen hora.
    candidatos.sort((a: any, b: any) =>
      Number(b.delAbonado) - Number(a.delAbonado)
      || Number(!!a.impedimento) - Number(!!b.impedimento)
      || (a.haceMin ?? Number.MAX_SAFE_INTEGER) - (b.haceMin ?? Number.MAX_SAFE_INTEGER)
      || String(a.fsp).localeCompare(String(b.fsp)));
    return { candidatos, inv };
  }

  /**
   * Unidad del stock de la sede con la que se registra una ONU que el inventario
   * no conoce (el caso del cliente NUEVO).
   *
   * Solo se echa mano de las unidades cuyo serial no dice nada — "solicitar",
   * "asignar", "pendiente" o vacío: 540 de las que hay en las bodegas de sede—.
   * Una unidad ROTULADA con un SN real no se toca aunque esté libre: pisarle el
   * serial con el de la ONU que se acaba de instalar sería apuntar como entregado
   * un aparato que sigue estando en otra casa, y perder la pista de los dos.
   *
   * `Depurados` queda fuera sola, porque es una bodega sin sede.
   */
  private async tomarDeStock(branchLegacy: number | null, vendor: string | null) {
    if (branchLegacy == null) return null;
    // El VendorID que reporta la OLT ("HWTC", "ZTEG") y la marca que teclea el
    // almacén ("Huawei", "ZTE") no se escriben igual: se traduce para poder
    // PREFERIR —nunca exigir— la unidad de la misma marca que la ONU instalada.
    const marca = { HWTC: 'HUAWEI', ZTEG: 'ZTE', ZTEC: 'ZTE', VSOL: 'V-SOL', BEST: 'BESTCOM' }[
      (vendor ?? '').trim().toUpperCase().slice(0, 4)
    ] ?? null;
    const filas = await this.prisma.$queryRaw<any[]>`
      SELECT e.id, e.code, e.serial, e.brand, w.name AS bodega
        FROM "Equipment" e
        JOIN "EquipmentWarehouse" w ON w.id = e."warehouseId"
       WHERE e."subscriberId" IS NULL
         AND w."branchLegacy" = ${branchLegacy}
         AND upper(coalesce(e.status, '')) IN ('BUENO', 'DISPONIBLE')
         AND (e.serial ~* '(solicit|asignar|pendient)' OR coalesce(btrim(e.serial), '') = '')
       ORDER BY (CASE WHEN ${marca}::text IS NOT NULL
                       AND upper(coalesce(e.brand, '')) LIKE '%' || ${marca}::text || '%'
                      THEN 0 ELSE 1 END),
                e.code ASC
       LIMIT 1`;
    const f = filas[0];
    return f ? { id: f.id as string, code: f.code as number, serial: f.serial as string | null, bodega: f.bodega as string | null } : null;
  }

  /**
   * QUÉ ONU autenticar, sin preguntarle nada al técnico.
   *
   * La regla es la del usuario: se autentica **el equipo que el cliente tenga
   * asignado**, y si es un cliente nuevo que no tiene ninguno, se le entrega uno
   * **de la bodega de su sede**. Lo que añade este método es la comprobación
   * física que evita inventar: el equipo elegido tiene que estar ANUNCIÁNDOSE en
   * el autofind de la OLT. Eso es lo único que prueba que ese aparato es el que
   * está colgado del puerto del cliente y no el que alguien apuntó en una hoja.
   *
   * Y hace falta un segundo filtro que no era evidente: **la hora**. El autofind
   * de esta planta no es una lista de recién llegadas —VILLANUEVA tiene 66 ONUs
   * sonando, la más vieja desde hace 15 días—, así que "la única que se anuncia"
   * no ocurre nunca. La que el técnico acaba de conectar es la que apareció hace
   * un rato (`Ont autofind time`, ver `VENTANA_RECIEN_VISTA_MS`).
   *
   * Con eso, el orden de decisión:
   *
   *   1. `DEL_ABONADO`   el SN anunciándose ya figura a nombre de este cliente.
   *                      Gana pase lo que pase: no admite otra lectura.
   *   2. Si no, se mira SOLO lo aparecido en las últimas 2 horas, y tiene que ser
   *      una sola. Sobre esa:
   *      · `BODEGA_SEDE` es una unidad libre de una bodega de SU sede → se le
   *                      asigna al cliente y sale del stock.
   *      · `STOCK_SEDE`  no está en el inventario (el 32% de las ONUs de la
   *                      planta) → se le carga una unidad sin rotular del stock
   *                      de su sede y se le graba el SN de verdad, que es como se
   *                      va limpiando el inventario.
   *      · de la bodega de otra sede o de "Depurados" → no se decide sola.
   *
   * Todo lo que no encaje ahí devuelve el motivo escrito y la elección vuelve al
   * desplegable: automatizar una corazonada es autenticarle la ONU al vecino.
   */
  private async decidirAutomatico(sub: any, candidatos: any[], inv: Map<string, any>, ticketId?: string) {
    const noAuto = (motivo: string) => ({ sn: null as string | null, origen: null, equipo: null, deStock: false, motivo, haceMin: null as number | null });
    const libres = candidatos.filter((c) => !c.impedimento);
    if (!libres.length) {
      return noAuto(candidatos.length
        ? 'Las ONUs que se están anunciando están instaladas a nombre de otros clientes.'
        : 'La OLT no ve ninguna ONU esperando autenticación.');
    }

    const sede = sub.branch?.legacyId ?? null;
    const eqDe = (c: any) => inv.get(String(c.sn ?? '')) ?? null;

    // 1. El equipo que YA figura a nombre del cliente y está anunciándose es
    //    suyo con seguridad: da igual cuánto ruido haya alrededor ni cuánto
    //    lleve sonando. No admite otra lectura.
    const suyas = libres.filter((c) => eqDe(c)?.subscriberId === sub.id);
    if (suyas.length === 1) {
      const eq = eqDe(suyas[0]);
      return {
        sn: String(suyas[0].sn), origen: 'DEL_ABONADO', deStock: false, motivo: '', haceMin: suyas[0].haceMin ?? null,
        // `reservado`: es la unidad que el sistema apartó AL ABRIR esta orden y el
        // técnico se llevó justo esa. Es el caso redondo, y se dice.
        equipo: { id: eq.id, code: eq.code, serial: eq.serial, bodega: eq.bodega, reservado: !!ticketId && eq.reservedTicketId === ticketId },
      };
    }
    if (suyas.length > 1) {
      return noAuto(
        `Este cliente tiene ${suyas.length} equipos suyos anunciándose (${suyas.map((c: any) => c.sn).join(', ')}): `
        + 'elija cuál es el que acaba de instalar.');
    }

    // 2. Para todo lo demás manda LA HORA. El autofind arrastra decenas de ONUs
    //    que llevan semanas sonando; la que el técnico acaba de conectar es la
    //    que apareció hace un rato. Sin ese filtro no hay forma de distinguirla
    //    y elegir por corazonada es autenticarle la ONU al vecino.
    const minutos = Math.round(VENTANA_RECIEN_VISTA_MS / 60000);
    const recientes = libres.filter((c) => c.haceMin != null && c.haceMin <= minutos);
    if (!recientes.length) {
      const conHora = libres.filter((c) => c.haceMin != null);
      return noAuto(conHora.length
        ? `Ninguna de las ${libres.length} ONUs que se anuncian apareció en las últimas 2 horas `
          + `(la más reciente lleva ${Math.min(...conHora.map((c: any) => c.haceMin))} minutos): `
          + 'todas son de antes. Elija a mano cuál acaba de instalar.'
        : 'La OLT no dice desde cuándo se anuncia cada ONU, así que no se puede saber cuál es la recién instalada.');
    }
    if (recientes.length > 1) {
      return noAuto(
        `${recientes.length} ONUs aparecieron en las últimas 2 horas `
        + `(${recientes.map((c: any) => `${c.sn} hace ${c.haceMin} min`).join(', ')}). `
        + 'Elija a mano cuál acaba de instalar.');
    }

    const c = recientes[0];
    const eq = eqDe(c);
    // 2a. Es una unidad libre de una bodega de SU sede: se le carga al cliente.
    if (eq && sede != null && eq.bodegaSede === sede) {
      return {
        sn: String(c.sn), origen: 'BODEGA_SEDE', deStock: false, motivo: '', haceMin: c.haceMin ?? null,
        equipo: { id: eq.id, code: eq.code, serial: eq.serial, bodega: eq.bodega },
      };
    }
    // 2b. Está registrada, pero en la bodega de otra sede o en "Depurados". Eso
    //     lo mira una persona: el aviso existe justamente para eso.
    if (eq) {
      return noAuto(
        `La ONU que acaba de aparecer (${c.sn}) es el equipo ${eq.code}, que figura en la bodega `
        + `"${eq.bodega ?? 'sin bodega'}" y no en la de ${sub.branch?.name ?? 'esta sede'}. `
        + 'Revíselo y elíjala a mano si es la que instaló.');
    }
    // 2c. Cliente nuevo con una ONU que el inventario no conoce (el 32% de las
    //     de la planta): se le carga una unidad de la bodega de su sede y se le
    //     graba el SN de verdad, que es como se va limpiando el inventario.
    const stock = await this.tomarDeStock(sede, c.vendor ?? null);
    return {
      sn: String(c.sn), origen: 'STOCK_SEDE', deStock: !!stock, haceMin: c.haceMin ?? null,
      equipo: stock,
      motivo: stock
        ? ''
        : `No quedan unidades sin asignar en la bodega de ${sub.branch?.name ?? 'la sede'}: `
          + 'la ONU se autentica igual, pero no se descuenta ningún equipo del inventario.',
    };
  }

  /**
   * Plan de internet vigente del abonado (el ACTIVO manda sobre cualquier otro).
   *
   * Las megas se caen al catálogo cuando el servicio no las trae: `megas` de
   * `SubscriberService` llegó VACÍO en las 3.799 filas importadas del legacy, y
   * sin este respaldo el técnico veía el bloque sin la velocidad que iba a
   * aplicar. Es solo lo que se MUESTRA — el par de traffic-tables sale del
   * mapeo del plan, no de aquí.
   */
  /**
   * El plan del que sale la VELOCIDAD que se va a aplicar.
   *
   * En una orden de megas manda el plan DESTINO que la orden porta, no el que el
   * abonado tiene en la ficha: desde 2026-09-02 el cambio de plan se aplica al
   * CERRAR la orden (antes que eso el cliente sigue en el suyo y pagando su
   * precio), y el técnico aplica la velocidad antes de cerrar. Leer la ficha aquí
   * le dejaría la ONU a la velocidad VIEJA — justo el trabajo que venía a hacer.
   *
   * Cuando la orden ya se cerró (`planAppliedAt`) la ficha y la orden dicen lo
   * mismo, así que da igual por dónde se lea; se sigue prefiriendo la orden para
   * que reabrir una cerrada no cambie la velocidad de sitio.
   */
  private async planDeLaOrden(
    t: { type: string | null; planToId: string | null; planToName: string | null; planToMegas: number | null },
    subscriberId: string,
  ) {
    if (puedeVelocidad(modoDeOrden(t.type)) && t.planToId) {
      const p = await this.prisma.plan
        .findUnique({ where: { id: t.planToId }, select: { id: true, name: true, megas: true } })
        .catch(() => null);
      // El plan pudo borrarse del catálogo; la orden guarda copia del nombre.
      return {
        planId: t.planToId,
        planName: p?.name ?? t.planToName,
        megas: p?.megas ?? t.planToMegas ?? null,
        status: 'DE_LA_ORDEN',
        derivado: false,
        /** La orden manda: el abonado todavía está en el plan viejo. */
        deLaOrden: true,
      };
    }
    return this.planDeAbonado(subscriberId);
  }

  private async planDeAbonado(subscriberId: string) {
    const servicios = await this.prisma.subscriberService.findMany({
      where: { subscriberId, kind: 'INTERNET' },
      select: { planId: true, planName: true, megas: true, status: true, plan: { select: { megas: true } } },
      orderBy: { updatedAt: 'desc' },
    });
    const s = servicios.find((x) => x.status === 'ACTIVO') ?? servicios[0] ?? null;
    if (s) return { ...s, megas: s.megas ?? s.plan?.megas ?? null, derivado: false };
    return this.planDeSusFacturas(subscriberId);
  }

  /**
   * Plan de internet de un abonado que NO tiene fila en `SubscriberService`.
   *
   * La migración solo pobló ese registro para los ACTIVOS de aquel momento: hoy
   * son 3.036 abonados VIVOS sin plan registrado (1.176 de ellos activos), y sin
   * este respaldo a todos les salía "el abonado no tiene servicio de internet"
   * al ir a autenticarles la ONU. Facturación resuelve el mismo hueco leyendo
   * las facturas; aquí basta con la IDENTIDAD del plan (de ella sale el mapeo de
   * velocidad), no con el precio, así que la consulta es mucho más corta.
   *
   * Se miran las 2 últimas facturas con renglón que case con el catálogo, no la
   * última sola: un prorrateo de mes parcial puede omitir el servicio.
   *
   * Va marcado `derivado: true` — sale de lo que se le facturó, no de lo que
   * tiene registrado, y el técnico debe verlo antes de aplicar una velocidad.
   */
  private async planDeSusFacturas(subscriberId: string) {
    const filas = await this.prisma.$queryRaw<{ planId: string; name: string; megas: number | null }[]>`
      WITH con_plan AS (
        -- Se ordenan SOLO las facturas que traen mensualidad. Ranquear todas deja
        -- fuera al abonado cuyas dos últimas son un traslado y una afiliación:
        -- su plan está vivo, pero en la tercera factura hacia atrás.
        SELECT i.id, dense_rank() OVER (ORDER BY i."invoiceDate" DESC, i.tid DESC) AS rk
          FROM "SubInvoice" i
         WHERE i."subscriberId" = ${subscriberId} AND i.status <> 'CANCELED'
           AND EXISTS (
             SELECT 1 FROM "SubInvoiceItem" it JOIN "Plan" pl
                    ON lower(btrim(pl.name)) = lower(btrim(COALESCE(it."productName", it.description)))
              WHERE it."invoiceId" = i.id AND it.price > 0
                AND pl.kind = 'INTERNET' AND pl.megas IS NOT NULL)
      )
      SELECT pl.id AS "planId", pl.name, pl.megas
        FROM con_plan c
        JOIN "SubInvoiceItem" it ON it."invoiceId" = c.id
        JOIN "Plan" pl ON lower(btrim(pl.name)) = lower(btrim(COALESCE(it."productName", it.description)))
       WHERE c.rk <= 2 AND it.price > 0 AND pl.kind = 'INTERNET' AND pl.megas IS NOT NULL
       ORDER BY c.rk ASC, pl.megas DESC
       LIMIT 1`;
    const f = filas[0];
    return f
      ? { planId: f.planId, planName: f.name, megas: f.megas, status: 'DERIVADO', derivado: true }
      : null;
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
    const plan = await this.planDeLaOrden(t, sub.id);
    const mapeo = await this.planProfiles.resolveConEtiqueta(plan?.planId, olt?.id);
    const { live } = await this.olt.mode();

    const base = {
      modo,
      live,
      olt: olt ? { id: olt.id, name: olt.name } : null,
      plan: plan
        // `derivado` viaja para que la orden pueda avisar de dónde salió el plan:
        // del registro del abonado o de lo que se le viene facturando.
        ? { id: plan.planId, name: plan.planName, megas: plan.megas, estado: plan.status, derivado: plan.derivado }
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
      /**
       * Qué haría el botón de "autenticar solo": la ONU elegida, de dónde sale y
       * qué equipo se le va a cargar al cliente. Con `sn` en null trae el motivo
       * por el que hace falta una persona.
       */
      auto: null as any,
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

    if (puedeAutenticar(modo) && olt) {
      const r = await this.olt.autofind(olt.id);
      const { candidatos, inv } = await this.candidatosDeAutofind(sub, Array.isArray(r.onus) ? r.onus : []);
      base.candidatos = candidatos;
      if (!r.ok) {
        base.bloqueo = { code: 'AUTOFIND_ERROR', message: `No se pudo leer el autofind de la OLT ${olt.name}: ${r.error}` };
      } else if (!base.candidatos.length) {
        base.bloqueo = {
          code: 'AUTOFIND_VACIO',
          message: `La OLT ${olt.name} no ve ninguna ONU esperando autenticación. `
            + 'Conecte la fibra y encienda el equipo; luego refresque.',
        };
      }
      base.auto = await this.decidirAutomatico(sub, base.candidatos, inv, t.id);
    }

    // En una orden que SOLO cambia la velocidad, no tener ONU vinculada es un
    // callejón sin salida y hay que decirlo. En una de tipo `AMBOS` no lo es: el
    // técnico puede estar montando el equipo nuevo justamente porque el viejo no
    // daba el plan, y ahí lo que toca es autenticar, no bloquear la pantalla.
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
  async autenticar(ticketId: string, dto: { sn?: string; equipmentId?: string }, user?: AuthUser) {
    const { t, sub } = await this.cargarOrden(ticketId, user);
    if (!puedeAutenticar(modoDeOrden(t.type))) {
      throw new BadRequestException(`Las órdenes de tipo "${t.type}" no autentican ONUs.`);
    }

    const olt = await this.oltDeSede(sub.branchId);
    const plan = await this.planDeLaOrden(t, sub.id);
    const mapeo = await this.planProfiles.resolve(plan?.planId, olt?.id);
    const bloqueo = this.motivoDeBloqueo({ modo: 'AUTENTICAR', olt, plan, mapeo });
    if (bloqueo) throw new BadRequestException(bloqueo.message);

    /**
     * Sin SN: lo elige el sistema. Se autentica el equipo que el cliente tenga
     * asignado y, si no tiene ninguno (cliente nuevo), se le carga uno de la
     * bodega de su sede — pero solo entre los que la OLT está viendo, que es lo
     * único que prueba cuál es el aparato que está en esa casa.
     */
    let sn = String(dto?.sn ?? '').trim().toUpperCase();
    let auto: Awaited<ReturnType<typeof this.decidirAutomatico>> | null = null;
    /** El autofind que se acaba de leer para decidir, para no pedir dos sesiones SSH seguidas. */
    let afReciente: any = null;
    if (!sn) {
      const r = await this.olt.autofind(olt!.id);
      if (!r.ok) throw new BadRequestException(`No se pudo leer el autofind de la OLT: ${r.error}`);
      afReciente = r;
      const { candidatos, inv } = await this.candidatosDeAutofind(sub, Array.isArray(r.onus) ? r.onus : []);
      auto = await this.decidirAutomatico(sub, candidatos, inv, t.id);
      if (!auto.sn) throw new BadRequestException(auto.motivo);
      sn = auto.sn;
      // La unidad que se saca del stock viaja como si la hubiera elegido una
      // persona: a partir de aquí el camino es exactamente el mismo.
      if (auto.origen === 'STOCK_SEDE' && auto.equipo) dto = { ...dto, equipmentId: auto.equipo.id };
    }

    const resumenAuto = auto?.sn
      ? { origen: auto.origen, deStock: auto.deStock, aviso: auto.motivo || null }
      : null;

    // El equipo, ANTES de tocar la OLT. Que el aviso lo pinte el navegador no
    // sirve de nada si la petición se puede mandar igual: el que decide es este.
    const equipo = (await this.equiposPorSn([sn])).get(sn) ?? null;
    if (equipo?.subscriberId && equipo.subscriberId !== sub.id) {
      throw new BadRequestException(
        `La ONU ${sn} corresponde al equipo ${equipo.code}, que figura instalado a nombre de ${equipo.subscriberNombre}. `
        + 'No se autentica en otro cliente: si el equipo cambió de dueño, primero retírelo de esa cuenta.',
      );
    }
    // Y la otra vía por la que un SN puede tener dueño: estar ya vinculado a
    // otro abonado en el inventario de la OLT. Importa sobre todo al ADOPTAR una
    // ONU ya autenticada, donde no hay autofind que confirme que es la recién
    // instalada: sin esta guarda se le podría quitar la ONU a un vecino.
    const vinculada = await this.prisma.oltOnu.findFirst({
      where: { sn, subscriberId: { not: null } },
      select: { subscriberId: true, clientName: true },
    });
    if (vinculada?.subscriberId && vinculada.subscriberId !== sub.id) {
      throw new BadRequestException(
        `La ONU ${sn} ya figura instalada en el abonado ${vinculada.clientName ?? vinculada.subscriberId}. `
        + 'No se puede montar en otro cliente: primero hay que liberarla desde Red › OLT.',
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

    // El F/S/P se relee del autofind en vez de fiarse de lo que mandó el
    // navegador: entre que se pintó la lista y que se pulsó el botón, la ONU pudo
    // moverse de puerto (o ser otra). Autenticar en el puerto equivocado deja al
    // abonado sin servicio y a otro con una ONU fantasma.
    // En el camino automático el autofind se acaba de leer para decidir: pedirlo
    // otra vez serían dos sesiones SSH seguidas contra la misma OLT, y los slots
    // VTY de estos equipos son contados.
    const af = afReciente ?? await this.olt.autofind(olt!.id);
    if (!af.ok) throw new BadRequestException(`No se pudo leer el autofind de la OLT: ${af.error}`);
    const encontrada = (Array.isArray(af.onus) ? af.onus : []).find((o: any) => String(o.sn ?? '').toUpperCase() === sn);
    if (!encontrada) {
      // Una ONU deja el autofind por dos motivos opuestos: se apagó, o YA está
      // autenticada. Antes se daban los dos por perdidos con el mismo mensaje y
      // el técnico se quedaba sin salida ante una ONU que ya estaba dada de alta
      // desde SmartOLT (la planta vieja está llena de ellas). Se comprueba.
      const yaEsta = await this.olt.findBySn(olt!.id, sn);
      if (yaEsta.ok && yaEsta.onu && (yaEsta.onu as any).fsp) {
        return this.adoptarExistente({ t, sub, olt: olt!, sn, plan, mapeo, equipo, equipoAVincular, user });
      }
      throw new BadRequestException(
        `La ONU ${sn} ya no se está anunciando en la OLT ${olt!.name} y tampoco está autenticada en ella. `
        + 'Puede que se haya apagado o que perdiera la fibra. Refresque la lista.',
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
    // Carrera: estaba en el autofind al listar y para cuando se pulsó el botón ya
    // la había autenticado otro (o la OLT la tenía de antes en otro puerto).
    if (!res.ok && res.codigo === 'SN_YA_EXISTE') {
      return { ...(await this.adoptarExistente({ t, sub, olt: olt!, sn, plan, mapeo, equipo, equipoAVincular, user })), auto: resumenAuto };
    }
    if (!res.ok) return res;

    let equipoRegistrado: EquipoRegistrado = null;
    let conciliacion: { liberados: number[]; devuelto: number | null } | null = null;
    if (!res.dryRun) {
      const instaladoId = equipo?.id ?? equipoAVincular?.id ?? null;
      equipoRegistrado = await this.registrarEquipo(sn, sub.id, instaladoId);
      await this.vincularYAnotar(olt!.id, sn, sub, t, params, res, plan, equipoRegistrado);
      // Lo que se apartó al abrir la orden se cuadra con lo que la OLT acaba de
      // demostrar: la reserva que no se usó vuelve a bodega y, en un cambio de
      // equipo, la ONU vieja sale de la ficha.
      conciliacion = await this.reserva.conciliarTrasAutenticar({
        ticketId: t.id, ticketCode: t.code, ticketType: t.type, subscriberId: sub.id,
        instaladoId: equipoRegistrado ? instaladoId : null, sn,
      });
    }
    return {
      ...res,
      plan: { id: plan!.planId, name: plan!.planName },
      velocidad: { trafficIn: mapeo!.trafficIn, trafficOut: mapeo!.trafficOut },
      fsp: `${frame}/${slot}/${port}`,
      equipo: equipoRegistrado,
      conciliacion,
      // Cuando la eligió el sistema: por qué esa y no otra. La orden lo enseña
      // para que el técnico pueda desdecirlo si ve que no es la que instaló.
      auto: resumenAuto,
    };
  }

  /**
   * ADOPTA una ONU que ya estaba autenticada en la OLT, en vez de fallar.
   *
   * El caso es corriente en esta planta: la ONU se dio de alta desde SmartOLT (o
   * a mano por SSH) y el abonado lleva navegando desde entonces, pero para el
   * sistema no existe. La OLT rechaza cualquier `ont add` con "SN already
   * exists". Borrarla para rehacerla dejaría al cliente sin servicio a cambio de
   * nada —y con las ZTE es justo lo que las deja pegadas en "config: failed"—,
   * así que se aprovecha lo que ya está: se le pone el comentario del abonado,
   * la velocidad de su plan y se registra el vínculo y el equipo.
   */
  private async adoptarExistente(x: {
    t: any; sub: any; olt: { id: string; name: string }; sn: string;
    plan: any; mapeo: any;
    equipo: { id: string; code: number } | null;
    equipoAVincular: { id: string; code: number } | null;
    user?: AuthUser;
  }) {
    const { t, sub, olt, sn, plan, mapeo, user } = x;
    const res: any = await this.olt.adoptar(
      olt.id,
      {
        sn,
        desc: this.comentario(sub),
        // La velocidad sigue saliendo del plan, igual que en un alta normal.
        traffic_in: mapeo?.trafficIn ?? null,
        traffic_out: mapeo?.trafficOut ?? null,
        // Por si la ONU está registrada pero SIN service-port: con esto se le
        // puede crear. Lo que no venga en el plan lo pone el propio puerto.
        vlan: mapeo?.vlan ?? null,
        gemport: mapeo?.gemport ?? null,
        user_vlan: mapeo?.userVlan ?? null,
        subscriberId: sub.id,
      },
      user,
    );
    if (!res.ok) return res;

    let equipoRegistrado: EquipoRegistrado = null;
    let conciliacion: { liberados: number[]; devuelto: number | null } | null = null;
    if (!res.dryRun) {
      const instaladoId = x.equipo?.id ?? x.equipoAVincular?.id ?? null;
      equipoRegistrado = await this.registrarEquipo(sn, sub.id, instaladoId);
      conciliacion = await this.reserva.conciliarTrasAutenticar({
        ticketId: t.id, ticketCode: t.code, ticketType: t.type, subscriberId: sub.id,
        instaladoId: equipoRegistrado ? instaladoId : null, sn,
      });
      if (t.code != null) {
        const msg =
          `ONU ADOPTADA desde la orden · SN ${sn} · puerto ${res.fsp ?? '—'}`
          + (res.ontId ? ` · ONT-ID ${res.ontId}` : '')
          + '\nYa estaba autenticada en la OLT (alta anterior o hecha desde SmartOLT): no se volvió a dar de alta, '
          + 'se ajustó lo que le faltaba y se vinculó al abonado.'
          + `\nPlan: ${plan?.planName ?? '—'} · velocidad: traffic-table bajada ${mapeo?.trafficIn ?? '—'} / subida ${mapeo?.trafficOut ?? '—'}`
          + (res.cambios?.length ? `\nCambios: ${res.cambios.join(' · ')}` : '\nNo hizo falta cambiar nada.')
          + `\nEstado: ${res.verificacion?.run_state ?? '—'} · config ${res.verificacion?.config_state ?? '—'} · ${res.verificacion?.servicePorts?.length ?? 0} service-port(s)`
          + (equipoRegistrado ? `\nEquipo ${equipoRegistrado.code} registrado a nombre del abonado${lineaDelEquipo(equipoRegistrado)}` : '')
          + (res.avisos?.length ? `\nAvisos: ${res.avisos.join(' | ')}` : '');
        await this.prisma.ticketThread
          .create({ data: { ticketCode: t.code, message: msg, subscriberId: sub.id, employeeId: 0, date: new Date() } })
          .catch((e) => this.logger.warn(`No se pudo anotar la adopción en la orden ${t.code}: ${e.message}`));
      }
    }
    return {
      ...res,
      plan: plan ? { id: plan.planId, name: plan.planName } : null,
      velocidad: { trafficIn: mapeo?.trafficIn ?? null, trafficOut: mapeo?.trafficOut ?? null },
      equipo: equipoRegistrado,
      conciliacion,
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
        select: { code: true, serial: true, warehouse: { select: { name: true } } },
      });
      const serialCorregido = normalizarSerial(previo?.serial) !== normalizarSerial(sn);
      // `updateMany` con la condición del dueño y no `update` a secas: cuando la
      // unidad la elige el sistema del stock de la sede, dos instalaciones a la
      // vez pueden apuntar a la misma. El que llega segundo no se la quita al
      // primero: se queda sin registrar y se avisa.
      const { count } = await this.prisma.equipment.updateMany({
        where: { id: equipmentId, OR: [{ subscriberId: null }, { subscriberId }] },
        data: {
          subscriberId,
          serial: sn,
          installType: 'FTTH',
          // Sale del stock disponible: la bodega ya no lo tiene, lo tiene el cliente.
          warehouseId: null,
          // Lo mismo que deja `assignEquipment`, para que un equipo entregado por
          // aquí se lea igual que uno entregado desde el modal de la orden.
          status: 'Asignado',
          returnedAt: null,
          editedAt: new Date(),
        },
      });
      if (!count) {
        this.logger.warn(`ONU ${sn} autenticada pero el equipo ${equipmentId} ya estaba asignado a otro cliente: no se registró.`);
        return null;
      }
      return { code: previo?.code ?? 0, serialCorregido, bodega: previo?.warehouse?.name ?? null };
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
  private async vincularYAnotar(oltId: string, sn: string, sub: any, t: any, params: any, res: any, plan: any, equipo: EquipoRegistrado) {
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
      + (equipo ? `\nEquipo ${equipo.code} registrado a nombre del abonado${lineaDelEquipo(equipo)}` : '')
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
    if (!puedeVelocidad(modoDeOrden(t.type))) {
      throw new BadRequestException(`Las órdenes de tipo "${t.type}" no cambian la velocidad de la ONU.`);
    }
    const olt = await this.oltDeSede(sub.branchId);
    const plan = await this.planDeLaOrden(t, sub.id);
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
