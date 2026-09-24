import { BadRequestException, NotFoundException } from '../core/http/errores';
import { Logger } from '../core/logger';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/current-user.decorator';
import { exigirSedeSuscriptor } from '../common/sede-scope';
import { OltService } from '../network/olt.service';
import { OltPlanProfileService } from '../network/olt-plan-profile.service';
import { MikrotikService } from '../network/mikrotik.service';
import { EquipoReservaService } from './equipo-reserva.service';
import { esAgregarInternet, esAltaDeInternet, esReinstalacion, esTraslado, FRAGMENTOS_TRABAJO_DE_CONEXION, sentidoDeMegas } from './order-types';
import { esUsuarioPppUtil } from '../subscribers/conexion-alta';
import type { SubscribersService } from '../subscribers/subscribers.service';
import type { VlanEquiposService } from '../network/vlan-equipos.service';
import { normalizarSerial, formasDeSerial, formaHex } from '../common/serial-onu';

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
 * Son los CINCO trabajos que dejan al cliente conectado —«Instalacion»,
 * «Traslado», «Migracion», «Cambio de equipo» y 'AgregarInternet', que va por el
 * predicado de abajo— más «Subir megas». La «Reinstalación» calza con 'instalac'
 * pero se descuenta arriba del todo: ahí no hay nada que autenticar. La
 * lista de los cinco es la MISMA que usa el cierre para no dejar a nadie en
 * 'INSTALAR' (`FRAGMENTOS_TRABAJO_DE_CONEXION` en `order-types.ts`): si un día se
 * añade un trabajo, se añade una vez y las dos cosas se enteran.
 *
 * «Subir megas» está aquí Y en la lista de velocidad: en un aumento de megas la
 * ONU suele seguir siendo la misma —y entonces solo se le aplica la velocidad—,
 * pero cuando el equipo viejo no da el plan nuevo el técnico monta otro, y ahí
 * hay que autenticar. La orden ofrece las dos cosas (modo `AMBOS`) en vez de
 * obligarle a salirse a /red/olt para la mitad del trabajo.
 */
const TIPOS_AUTENTICAR = [...FRAGMENTOS_TRABAJO_DE_CONEXION, 'subir megas'];
/** Tipos de orden donde la ONU ya existe y solo cambia la velocidad del plan. */
const TIPOS_VELOCIDAD = ['subir megas', 'bajar megas', 'cambio de plan'];

/**
 * AGREGAR INTERNET va por el predicado y no por las listas de arriba.
 *
 * Dos motivos, y los dos ya costaron caros antes en esta misma orden:
 *
 * 1. El nombre real del detalle es 'AgregarInternet' —sin espacio, tal cual está
 *    en la base— y no cae en ninguno de los fragmentos ('instalac' no casa con
 *    'agregarinternet'). Por eso el bloque de la ONU no salía en estas órdenes:
 *    `modoDeOrden` devolvía null y la orden decía "no aplica la autenticación".
 *
 * 2. Es `AMBOS`, no `AUTENTICAR`. Al cliente que solo tiene televisión hay que
 *    montarle el internet, y eso puede significar las dos cosas: la ONU de la TV
 *    ya está autenticada y solo falta ponerle la velocidad del plan que contrató,
 *    o el técnico monta un equipo nuevo y hay que darlo de alta. Además el plan
 *    TIENE que salir de la orden (`planToId`) y no de la ficha: el abonado aún no
 *    tiene servicio de internet registrado —se lo crea el cierre de esta misma
 *    orden—, así que leyendo la ficha el bloque se bloquearía siempre con
 *    "el abonado no tiene servicio de internet". `planDeLaOrden` prefiere el plan
 *    de la orden justo cuando el modo permite velocidad, de ahí `AMBOS`.
 */

/** `AMBOS` = la orden puede autenticar una ONU nueva y/o aplicar la velocidad. */
export type ModoOnu = 'AUTENTICAR' | 'VELOCIDAD' | 'AMBOS' | null;

/** Qué se puede hacer con la OLT en una orden de este tipo. */
export function modoDeOrden(type: string | null | undefined): ModoOnu {
  const t = (type ?? '').toLowerCase();
  if (!t.trim()) return null;
  // LA REINSTALACIÓN NO AUTENTICA (2026-09-08, dicho por el usuario). Va antes que
  // nada porque calza con el fragmento 'instalac' y hasta hoy entraba por ahí: el
  // equipo ya está puesto en la casa y ya está de alta en la OLT, así que el bloque
  // sobraba en la orden. Ver `esReinstalacion` en `order-types.ts`.
  if (esReinstalacion(t)) return null;
  if (esAgregarInternet(t)) return 'AMBOS';
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

/**
 * Tecnologías que NO pasan por la OLT (2026-09-05).
 *
 * En EPON no hay nada que autenticar en la planta: la OLT EPON no está —ni aquí
 * ni en el legacy, que solo tiene driver Huawei GPON— y el técnico da de alta el
 * equipo en la caja EPON, a mano. Lo que le da servicio y velocidad al abonado es
 * el perfil PPP de su `/ppp/secret` en la Mikrotik, exactamente igual que en el
 * legacy (`Customers_model::get_ip_coneccion_microtik_por_sede`, que elige el
 * router por SEDE + TECNOLOGÍA y escribe `profile => $perfil`).
 *
 * Así que para un EPON «autenticar» significa una sola cosa: ponerle el perfil
 * del plan que tiene contratado. Es la misma frase del usuario, hecha función.
 *
 * Hasta ahora la orden de un EPON abría una sesión SSH contra la OLT **GPON** de
 * su sede y le listaba ONUs que no eran suyas: ruido, y el riesgo de que alguien
 * autenticara el equipo de otro cliente.
 *
 * EOC está en la misma situación (256 activos) pero se deja fuera a propósito:
 * se pidió EPON. Añadirlo es meter 'EOC' en esta lista y nada más.
 */
const TECNOLOGIAS_SIN_OLT = ['EPON'];

/** Por dónde se le da servicio a este abonado: la OLT o el perfil de la Mikrotik. */
export type ViaOnu = 'OLT' | 'MIKROTIK';

/**
 * Lo que se hizo con el alta del abonado en la Mikrotik al autenticarle el equipo.
 * Ver `OnuProvisionService.asegurarAltaEnMikrotik`.
 */
export type AltaMikrotik = {
  /** false = no se pudo dejar el alta hecha; `mensaje` dice qué falta. */
  ok: boolean;
  /** El `/ppp/secret` no existía y se creó ahora. */
  creado: boolean;
  /** El abonado no tenía usuario PPPoE utilizable y se le derivó del nombre. */
  usuarioCreado: boolean;
  /** Simulación: MIKROTIK_LIVE no está activo, no se escribió en el router. */
  dryRun: boolean;
  pppUsername: string | null;
  perfil: string | null;
  router: string | null;
  /** Lo que se le mandó al router (o se le mandaría, en dry-run). */
  pasos: string[];
  mensaje: string;
};

/** @see TECNOLOGIAS_SIN_OLT */
export function viaDeTecnologia(installTech: string | null | undefined): ViaOnu {
  return TECNOLOGIAS_SIN_OLT.includes((installTech ?? '').trim().toUpperCase()) ? 'MIKROTIK' : 'OLT';
}

// Los traductores del serial (rotulado ↔ hex) viven en `common/serial-onu`:
// los comparte la ficha del cliente para localizar la ONU del abonado. Se
// re-exportan aquí porque este módulo era su casa y medio soporte los importa.
export { normalizarSerial, formasDeSerial, formaHex } from '../common/serial-onu';

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
    /** La vía de los abonados SIN OLT: el perfil PPP del secret. Ver `TECNOLOGIAS_SIN_OLT`. */
    private readonly mikrotik: MikrotikService,
    /** Cuadra la reserva hecha al abrir la orden con lo que la OLT demostró. */
    private readonly reserva: EquipoReservaService = new EquipoReservaService(prisma),
    /**
     * Quien sabe derivar el usuario PPPoE de un abonado que no lo tiene
     * (`asegurarCredencialesPpp`). Opcional para no atar este servicio al de
     * clientes en las pruebas; sin él, el alta en la Mikrotik solo puede avisar
     * de que falta el usuario en vez de crearlo.
     */
    private readonly subs?: SubscribersService,
    /**
     * La VLAN del puerto en los equipos (OLT + uplink + Mikrotik): avisa ANTES de
     * autenticar si no llega al PPPoE y, después, comprueba si el abonado navega.
     * Opcional: sin él (pruebas) la autenticación funciona igual, sin esos avisos.
     */
    private readonly vlanEquipos?: VlanEquiposService,
  ) {}

  /**
   * Resultado de la comprobación "¿navega?" que se hace 60 s después de
   * autenticar, por orden. En memoria (1 h): lo que perdura es la nota en el
   * seguimiento de la orden; esto es para que la pantalla lo recoja al refrescar.
   */
  private static readonly navegacion = new Map<string, { at: number; estado: 'PENDIENTE' | 'NAVEGANDO' | 'SIN_PPPOE' | 'SIN_REVISAR'; mensaje: string }>();
  private static readonly NAVEGACION_TTL_MS = 60 * 60_000;
  private static readonly ESPERA_NAVEGACION_MS = 60_000;

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
        // La tecnología decide POR DÓNDE se le da servicio: los EPON no pasan por
        // la OLT y se resuelven con el perfil del secret (ver `viaDeTecnologia`).
        // El resto son los campos que pide `MikrotikService.resolveRouter` para
        // elegir el router por sede+tecnología, igual que hace el legacy.
        installTech: true, pppUsername: true, legacyId: true, ipRemote: true, status: true,
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
  /**
   * El equipo que el inventario ya da por de este cliente, y qué dice la OLT de él.
   *
   * Nace de una pregunta del usuario (2026-09-04) que la pantalla no sabía
   * contestar: *"este cliente ya tiene un equipo asignado pero en la orden me
   * pide elegir uno, ¿y cómo sabemos si ya está listo para autenticar?"*. Las dos
   * mitades se responden con el mismo dato. El automático manda a elegir a mano
   * cuando el equipo del cliente NO se está anunciando —`DEL_ABONADO` exige que
   * la OLT lo vea— pero decía solo cuántas ONUs había sonando, nunca que la caja
   * apartada para esa casa no era ninguna de ellas.
   *
   * Y "listo para autenticar" no es un estado del inventario: es que la ONU
   * aparezca en el autofind. Hasta que la fibra no está conectada y el equipo
   * encendido, no hay nada que autenticar por mucho que el papel diga que es suyo.
   *
   * `anunciandose` = está en el autofind ahora · `autenticada` = ya tiene alta en
   * alguna OLT (y por eso NO sale en el autofind: no es un problema, es lo que
   * pasa con el equipo viejo de un cambio de equipo).
   */
  private async equipoDelAbonado(subscriberId: string, ticketId: string, candidatos: any[], oltId?: string | null) {
    const filas = await this.prisma.equipment.findMany({
      where: { OR: [{ subscriberId }, { reservedTicketId: ticketId }] },
      select: {
        id: true, code: true, serial: true, status: true, reservedTicketId: true,
        warehouse: { select: { name: true } },
      },
      orderBy: { code: 'desc' },
    });
    if (!filas.length) return null;

    // Índice del autofind por CUALQUIERA de las formas del serial: la OLT dice
    // `5A544547DE519D2C` y el almacén rotula `ZTEGDE519D2C`.
    const porForma = new Map<string, any>();
    for (const c of candidatos) for (const f of formasDeSerial(String(c.sn ?? ''))) porForma.set(f, c);

    // Altas ya hechas, para no llamar "perdido" a un equipo que lleva meses dando
    // servicio (un equipo autenticado desaparece del autofind).
    const hex = filas.map((e) => formaHex(e.serial)).filter(Boolean) as string[];
    const altas = hex.length
      ? new Set((await this.prisma.oltOnu.findMany({ where: { sn: { in: hex } }, select: { sn: true } })).map((o) => String(o.sn).toUpperCase()))
      : new Set<string>();

    const vistos = filas.map((e) => {
      const c = porForma.get(normalizarSerial(e.serial)) ?? null;
      return {
        id: e.id,
        code: e.code,
        serial: e.serial,
        status: e.status,
        bodega: e.warehouse?.name ?? null,
        /** Se apartó de la bodega AL ABRIR esta orden (`EquipoReservaService`). */
        reservado: e.reservedTicketId === ticketId,
        anunciandose: !!c,
        /** El SN tal y como lo reporta la OLT: es el que hay que autenticar. */
        sn: c ? String(c.sn) : formaHex(e.serial),
        haceMin: c?.haceMin ?? null,
        /** Ya está montado en otro cliente / bodega depurada… (mismo texto de la lista). */
        impedimento: c?.impedimento ?? null,
        autenticada: altas.has(String(formaHex(e.serial) ?? '')),
        /** Dónde la tiene dada de alta la OLT, cuando se le preguntó (ver abajo). */
        autenticadaEn: null as null | { fsp: string; ontId: number; descripcion: string; runState: string },
      };
    });

    // Manda el que la OLT está viendo; si ninguno, el apartado para ESTA orden.
    vistos.sort((a, b) =>
      Number(b.anunciandose) - Number(a.anunciandose)
      || Number(b.reservado) - Number(a.reservado)
      || Number(!!b.sn) - Number(!!a.sn));
    const elegido = vistos[0];

    // `OltOnu` no conoce las altas hechas desde SmartOLT ni las que nunca se
    // sincronizaron (2026-09-15, equipo 311071: seguía dado de alta en 0/1/11 a
    // nombre del cliente anterior y la orden decía "la OLT todavía no lo ve",
    // mandando a revisar la fibra de un equipo que estaba encendido). Antes de
    // decir eso se le pregunta a la OLT por el serial: es un comando más en la
    // misma sesión, y solo cuando no hay otra forma de saberlo.
    if (elegido && !elegido.anunciandose && !elegido.autenticada && elegido.sn && oltId) {
      // Una OLT que no contesta no puede tumbar la orden: se queda el aviso de siempre.
      let r: Awaited<ReturnType<OltService['estadoPorSn']>> | null = null;
      try { r = await this.olt.estadoPorSn(oltId, elegido.sn); } catch { r = null; }
      if (r?.ok && r.estado) {
        elegido.autenticada = true;
        elegido.autenticadaEn = {
          fsp: r.estado.fsp, ontId: r.estado.ont_id,
          descripcion: r.estado.description ?? '', runState: r.estado.run_state ?? '',
        };
      }
    }
    return elegido;
  }

  private async decidirAutomatico(
    sub: any, candidatos: any[], inv: Map<string, any>, ticketId?: string,
    /**
     * ¿Puede sacarse una unidad de la bodega para la ONU que la OLT anuncia y el
     * inventario no conoce? En un TRASLADO no: el aparato que se anuncia en la casa
     * nueva es el mismo que el cliente tenía en la vieja, y descontar una caja del
     * estante por él resta stock que nadie ha entregado (2026-09-04).
     */
    permiteStock = true,
  ) {
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
    if (!permiteStock) {
      return {
        sn: String(c.sn), origen: 'DEL_ABONADO', deStock: false, equipo: null, haceMin: c.haceMin ?? null,
        motivo: 'En un traslado no se entrega equipo: se autentica la ONU que se está anunciando '
          + '(la que el cliente se llevó) sin descontar ninguna unidad de la bodega.',
      };
    }
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
    /**
     * AGREGAR INTERNET: solo vale el plan que porta la orden. Aquí el abonado no
     * tiene internet —esa es la orden—, así que el respaldo de "leerlo de sus
     * últimas facturas" solo puede devolver ruido (un internet que tuvo hace
     * años, el de otro servicio) y con él se le aplicaría a la ONU una velocidad
     * que nadie contrató. Sin plan en la orden se prefiere el bloqueo, que dice
     * exactamente qué falta.
     */
    if (esAgregarInternet(t.type) && !t.planToId) return null;
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
    // Un EPON no tiene OLT que consultar: su "autenticación" es el perfil del
    // plan en la Mikrotik. Se sale antes de gastar la sesión SSH del autofind.
    if (viaDeTecnologia(sub.installTech) === 'MIKROTIK') return this.estadoMikrotik(t, sub, modo);
    const olt = await this.oltDeSede(sub.branchId);
    const plan = await this.planDeLaOrden(t, sub.id);
    const mapeo = await this.planProfiles.resolveConEtiqueta(plan?.planId, olt?.id);
    const { live } = await this.olt.mode();

    const base = {
      via: 'OLT' as ViaOnu,
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
      bloqueo: this.motivoDeBloqueo({ modo, olt, plan, mapeo, tipo: t.type }),
      candidatos: [] as any[],
      /**
       * Qué haría el botón de "autenticar solo": la ONU elegida, de dónde sale y
       * qué equipo se le va a cargar al cliente. Con `sn` en null trae el motivo
       * por el que hace falta una persona.
       */
      auto: null as any,
      onuActual: null as any,
      /**
       * El equipo que el inventario YA da por de este cliente (asignado o
       * apartado al abrir la orden) y si la OLT lo está viendo ahora mismo.
       * Es la respuesta a "el cliente ya tiene equipo, ¿por qué me pide elegir?"
       * y a "¿ya está listo para autenticar?".
       */
      equipoAsignado: null as any,
      /** Todas las ONUs vinculadas al abonado: con más de una, la orden lo avisa. */
      onusDelCliente: [] as any[],
      /**
       * El abonado va a estrenar internet y todavía no tiene usuario PPPoE: al
       * autenticar se le crean solos sus datos de integración con la Mikrotik
       * (ver `asegurarAltaEnMikrotik`). Se dice ANTES para que el técnico no lo
       * descubra en el resultado — y para que nadie lo vaya a crear a mano.
       */
      altaMikrotikPendiente: esAltaDeInternet(t.type) && !esUsuarioPppUtil(sub.pppUsername),
      /**
       * ¿La VLAN del puerto donde está la ONU llega al PPPoE? (OLT creada + uplink +
       * Mikrotik). Si no, la ONU quedará en línea y SIN internet: fue lo de la 590
       * de Villanueva. Se avisa antes de autenticar; no bloquea.
       */
      vlanPuerto: null as Awaited<ReturnType<VlanEquiposService['chequeoDePuerto']>> | null,
      /** El mismo chequeo para cada puerto con ONUs esperando (hasta 3): la pantalla enseña el de la elegida. */
      vlanPuertos: [] as Awaited<ReturnType<VlanEquiposService['chequeoDePuerto']>>[],
      /** Lo que dio la comprobación de navegación tras autenticar (60 s después). */
      navegacion: this.navegacionDeOrden(t.id),
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
      base.auto = await this.decidirAutomatico(sub, base.candidatos, inv, t.id, !esTraslado(t.type));
      // La VLAN de los puertos donde hay ONUs esperando: primero el de la que se
      // autenticaría sola, luego los demás (hasta 3: cada puerto nuevo cuesta ~2 s de
      // OLT la primera vez; luego sale de la caché de `chequeoDePuerto`).
      if (this.vlanEquipos && r.ok) {
        const elegida = base.candidatos.find((c: any) => c.sn && c.sn === base.auto?.sn) ?? base.candidatos[0];
        // Si el sistema ya eligió la ONU, basta su puerto; si elige el técnico, varios.
        const aRevisar = base.auto?.sn ? [elegida] : [elegida, ...base.candidatos];
        const fsps = [...new Set(aRevisar.map((c: any) => String(c?.fsp ?? '')).filter(Boolean))].slice(0, 3);
        for (const fsp of fsps) {
          const pos = fsp.match(/(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)/);
          if (!pos) continue;
          base.vlanPuertos.push(await this.vlanEquipos.chequeoDePuerto(
            olt.id, Number(pos[1]), Number(pos[2]), Number(pos[3]), Number((mapeo as any)?.vlan) || null,
          ));
        }
        base.vlanPuerto = base.vlanPuertos[0] ?? null;
      }
      base.equipoAsignado = await this.equipoDelAbonado(sub.id, t.id, base.candidatos, r.ok ? olt.id : null);
      // Dos ONUs dadas de alta a nombre del mismo cliente es lo que deja un cambio
      // de equipo a medias: autenticar la nueva no borra la vieja de la OLT (y no
      // debe hacerlo solo: puede ser la ONU de la TV). Se enseña para que alguien decida.
      base.onusDelCliente = await this.prisma.oltOnu.findMany({
        where: { subscriberId: sub.id },
        orderBy: { lastSync: 'desc' },
        select: { sn: true, frame: true, slot: true, port: true, ontId: true, runState: true, lastSync: true, olt: { select: { name: true } } },
      });
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
  private motivoDeBloqueo(x: { modo: ModoOnu; olt: any; plan: any; mapeo: any; tipo?: string | null }): { code: string; message: string } | null {
    if (!x.modo) {
      if (esReinstalacion(x.tipo)) {
        return {
          code: 'TIPO',
          message: 'Las órdenes de reinstalación no autentican ONU: el equipo del abonado ya está dado de alta en la OLT.',
        };
      }
      return { code: 'TIPO', message: 'Esta orden no es de instalación ni de cambio de velocidad: no aplica la autenticación de ONU.' };
    }
    if (!x.olt) {
      return { code: 'SIN_OLT', message: 'La sede del abonado no tiene ninguna OLT configurada. Configúrela en Red › OLT.' };
    }
    if (!x.plan?.planId) {
      // AGREGAR INTERNET: que el abonado no tenga servicio de internet es LA
      // PREMISA de la orden, no un error de datos — se lo crea el cierre. Lo que
      // falta es el plan DESTINO de la orden, y eso se arregla en otro sitio
      // (Editar orden), no en la ficha del cliente.
      if (esAgregarInternet(x.tipo)) {
        return {
          code: 'SIN_PLAN_DE_ORDEN',
          message: 'Esta orden de agregar internet no dice a qué plan se pasa el abonado, '
            + 'así que no se sabe qué velocidad aplicarle a la ONU. '
            + 'Indíquelo en «Editar orden» y vuelva a consultar.',
        };
      }
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

  // ------------------------------------------------------------------
  //  VÍA MIKROTIK — los abonados sin OLT (EPON). Ver `TECNOLOGIAS_SIN_OLT`.
  // ------------------------------------------------------------------

  /**
   * El perfil PPP que le toca al abonado por su plan: `Plan.pppProfile`, el mismo
   * campo que usa el alta y el cambio de plan para escribir el `/ppp/secret`.
   *
   * No se inventa a partir de las megas: en los routers conviven `100Megas`,
   * `100MegasD` y `100MegasSt` con topes distintos, y RouterOS resuelve por
   * PREFIJO —«100» casa con las tres y tumba la escritura entera—. El nombre
   * exacto lo decide el catálogo de planes, no una deducción.
   */
  private async perfilDelPlan(planId: string | null | undefined): Promise<string | null> {
    if (!planId) return null;
    const p = await this.prisma.plan
      .findUnique({ where: { id: planId }, select: { pppProfile: true } })
      .catch(() => null);
    return p?.pppProfile?.trim() || null;
  }

  /**
   * EL ALTA DEL ABONADO EN LA MIKROTIK, ANTES DE AUTENTICARLE EL EQUIPO.
   *
   * Autenticar la ONU es la mitad del trabajo: la OLT le da enlace, pero quien le
   * da INTERNET es el `/ppp/secret` de la Mikrotik de su sede. Un cliente que
   * llega a la instalación sin usuario PPPoE —o con el relleno del legacy ('0',
   * '-', 'null')— y sin secret en el router queda con la ONU online y sin
   * navegar, y eso no se nota hasta que llama: la orden se cierra en verde.
   *
   * Por eso, en las órdenes en las que el abonado EMPIEZA a navegar
   * (`esAltaDeInternet`: instalación, reinstalación y 'AgregarInternet'), sus
   * datos de integración se crean solos justo antes de autenticar:
   *
   *   1. USUARIO Y CLAVE, derivados del propio cliente con la convención de
   *      siempre —nombre pegado en mayúsculas / número de documento— y sin pisar
   *      nunca uno que ya sirve (`asegurarCredencialesPpp`).
   *   2. EL PERFIL DEL PLAN en la ficha, para que el secret nazca con la
   *      velocidad contratada y no con `default`. Va con `editedAt` por lo mismo
   *      que en `changePlan`: `perfil` baja del legacy y sin la marca el sync lo
   *      devuelve al valor viejo a los 15 minutos.
   *   3. EL SECRET en el router (`provision`, que crea el que falta y adopta el
   *      que ya esté).
   *
   * Un secret que YA existe no se toca: si el abonado tiene usuario y el router
   * dice que su secret está puesto, esto no escribe nada — reescribirlo solo
   * podría estropear un alta que funciona.
   *
   * NUNCA lanza. Que la Mikrotik no responda no puede impedir autenticar la ONU:
   * lo que no se pudo hacer viaja en el resultado y queda anotado en la orden.
   */
  private async asegurarAltaEnMikrotik(
    t: { type: string | null; code: number | null },
    sub: any,
    plan: { planId: string | null; planName: string | null } | null,
    user?: AuthUser,
  ): Promise<AltaMikrotik | null> {
    if (!esAltaDeInternet(t.type)) return null;
    const fallo = (mensaje: string): AltaMikrotik => ({
      ok: false, creado: false, usuarioCreado: false, dryRun: false,
      pppUsername: esUsuarioPppUtil(sub.pppUsername) ? String(sub.pppUsername).trim() : null,
      perfil: null, router: null, pasos: [], mensaje,
    });

    const alta = await this.altaEnMikrotik(sub, plan, user, fallo);
    // Queda en el hilo de la orden salvo cuando no hubo nada que hacer: que el
    // abonado ya tuviera su secret no es noticia; que se le creara —o que no se
    // pudiera— sí, y es lo que alguien va a buscar si mañana no navega.
    if (!alta.ok || alta.creado || alta.usuarioCreado) {
      await this.anotarEnLaOrden(t, sub, `Mikrotik · ${alta.mensaje}`, alta.dryRun && alta.ok);
    }
    return alta;
  }

  /** El trabajo de `asegurarAltaEnMikrotik`, sin la decisión de si toca hacerlo. */
  private async altaEnMikrotik(
    sub: any,
    plan: { planId: string | null; planName: string | null } | null,
    user: AuthUser | undefined,
    fallo: (mensaje: string) => AltaMikrotik,
  ): Promise<AltaMikrotik> {
    try {
      // 1) Usuario y clave. Los que ya sirven se dejan como están.
      let pppUsername = esUsuarioPppUtil(sub.pppUsername) ? String(sub.pppUsername).trim() : null;
      let usuarioCreado = false;
      if (!pppUsername) {
        if (!this.subs) {
          return fallo('El abonado no tiene usuario PPPoE y no se le pudo crear: hágalo desde su ficha antes de cerrar la orden.');
        }
        const cred = await this.subs.asegurarCredencialesPpp(sub.id, user);
        if (!cred.ok || !cred.pppUsername) {
          return fallo(`No se le pudo crear el usuario PPPoE: ${(cred as any).motivo ?? 'sin motivo'}`);
        }
        pppUsername = cred.pppUsername;
        usuarioCreado = !!cred.creado;
      }

      // 2) ¿Ya tiene su secret en el router? Si el usuario se acaba de crear, no
      // puede tenerlo. Si no, se pregunta al router antes de escribir nada.
      if (!usuarioCreado) {
        const st = await this.mikrotik.liveStatus(sub.id).catch(() => null);
        if (st?.ok && st.live?.secretExists) {
          // Lo único que se completa en un secret existente: la IP local, si
          // nació vacía (ver `MikrotikService.completarIpLocal`).
          const ipLocal = await this.mikrotik.completarIpLocal(sub.id, user).catch(() => null);
          return {
            ok: true, creado: false, usuarioCreado: false, dryRun: !!st.dryRun,
            pppUsername, perfil: null, router: st.mikrotik?.name ?? null,
            pasos: ipLocal ? [`IP local ${ipLocal} puesta en el secret (estaba vacía)`] : [],
            mensaje: `El abonado ya tenía su alta en la Mikrotik (secret ${pppUsername}${st.mikrotik?.name ? ` en ${st.mikrotik.name}` : ''})`
              + (ipLocal ? ` · se le puso la IP local ${ipLocal}, que le faltaba.` : '.'),
          };
        }
      }

      // 3) El perfil del plan en la ficha: `provision` escribe el secret con él.
      const perfil = await this.perfilDelPlan(plan?.planId);
      if (perfil) {
        await this.prisma.subscriber
          .update({ where: { id: sub.id }, data: { pppProfile: perfil, editedAt: new Date() } })
          .catch((e) => this.logger.warn(`No se pudo fijar el perfil ${perfil} en la ficha de ${sub.id}: ${(e as Error).message}`));
      }

      // 4) El secret.
      const r = await this.mikrotik.provision(sub.id, user);
      const creado = !!r.ok && (r.steps ?? []).some((s) => s.includes('secret creado'));
      const cabecera = usuarioCreado ? `Usuario PPPoE ${pppUsername} creado. ` : '';
      return {
        ok: !!r.ok,
        creado,
        usuarioCreado,
        dryRun: !!r.dryRun,
        pppUsername,
        perfil: perfil ?? null,
        router: r.mikrotik?.name ?? null,
        pasos: r.steps ?? [],
        mensaje: r.ok
          ? `${cabecera}${r.message}${perfil ? ` · perfil ${perfil}` : ''}`
          : `${cabecera}No se pudo crear su alta en la Mikrotik: ${r.error ?? r.message}. Reinténtelo desde la ficha del cliente.`,
      };
    } catch (e) {
      return fallo(`No se pudo crear su alta en la Mikrotik: ${(e as Error).message}. Reinténtelo desde la ficha del cliente.`);
    }
  }

  /**
   * Lo mismo que `estado()` pero para un abonado sin OLT: qué perfil se le va a
   * poner, en qué router, y qué falta si no se puede.
   *
   * Se devuelve con la MISMA forma que la vía OLT —`candidatos`, `auto`,
   * `onuActual` y `equipoAsignado` vacíos— para que la pantalla no tenga que
   * adivinar qué campos existen: lo único que mira para cambiar de cara es `via`.
   */
  private async estadoMikrotik(
    t: { type: string | null; planToId: string | null; planToName: string | null; planToMegas: number | null },
    sub: any,
    modo: ModoOnu,
  ) {
    const plan = await this.planDeLaOrden(t, sub.id);
    const perfil = await this.perfilDelPlan(plan?.planId);
    // `resolveRouter` es la MISMA elección que hace el corte, la reconexión y el
    // alta (sede + tecnología, con respaldo en el marcado por defecto). Tira si el
    // abonado no tiene sede: aquí eso es un bloqueo que se cuenta, no un error 400
    // que deja la pantalla en blanco.
    const router = await this.mikrotik.resolveRouter(sub).catch(() => null);

    return {
      via: 'MIKROTIK' as ViaOnu,
      modo,
      live: this.mikrotik.isLive,
      olt: null,
      /** El router y el perfil son, juntos, "lo que se va a aplicar". */
      mikrotik: router
        ? { id: router.id, name: router.name, host: `${router.ip}:${router.port}`, tech: router.tech }
        : null,
      pppUsername: sub.pppUsername ?? null,
      /** @see estado — aquí significa lo mismo: el secret se crea al aplicar. */
      altaMikrotikPendiente: esAltaDeInternet(t.type) && !esUsuarioPppUtil(sub.pppUsername),
      perfil,
      plan: plan
        ? { id: plan.planId, name: plan.planName, megas: plan.megas, estado: plan.status, derivado: plan.derivado }
        : null,
      velocidad: null,
      bloqueo: this.motivoDeBloqueoMikrotik({
        modo, router, plan, perfil, sub,
        puedeCrearPppoe: esAltaDeInternet(t.type) && !!this.subs,
      }),
      candidatos: [] as any[],
      auto: null as any,
      onuActual: null as any,
      equipoAsignado: null as any,
    };
  }

  /** El primer impedimento de la vía Mikrotik, en el orden en que hay que resolverlos. */
  private motivoDeBloqueoMikrotik(
    x: { modo: ModoOnu; router: any; plan: any; perfil: string | null; sub: any; puedeCrearPppoe?: boolean },
  ): { code: string; message: string } | null {
    if (!x.modo) {
      return { code: 'TIPO', message: 'Esta orden no es de instalación ni de cambio de velocidad: no aplica.' };
    }
    // En una instalación o un 'AgregarInternet' el usuario PPPoE ya no es un
    // impedimento: si no lo tiene se le crea antes de escribir el secret
    // (`asegurarAltaEnMikrotik`). Antes esto dejaba el alta EPON parada con un
    // mensaje que mandaba a la ficha a hacer a mano lo que el sistema sabe hacer.
    if (!x.sub.pppUsername && !x.puedeCrearPppoe) {
      return {
        code: 'SIN_PPPOE',
        message: 'El abonado no tiene usuario PPPoE en su ficha, así que no hay secret al que ponerle el perfil.',
      };
    }
    if (!x.router) {
      return {
        code: 'SIN_ROUTER',
        message: 'La sede del abonado no tiene ninguna Mikrotik configurada. Configúrela en Red › Mikrotik.',
      };
    }
    if (!x.plan?.planId) {
      return {
        code: 'SIN_PLAN',
        message: x.plan
          ? `El servicio de internet del abonado ("${x.plan.planName ?? 'sin nombre'}") no está ligado a un plan `
            + 'del catálogo, así que no se sabe qué perfil ponerle. Asígnele un plan desde su ficha.'
          : 'El abonado no tiene servicio de internet registrado: no hay plan del que sacar el perfil.',
      };
    }
    if (!x.perfil) {
      return {
        code: 'SIN_PERFIL',
        message: `El plan "${x.plan.planName ?? x.plan.planId}" no tiene perfil PPP configurado. `
          + 'Administración debe ponérselo en Configuración › Planes. '
          + 'Sin eso el abonado quedaría con el perfil que traiga de antes.',
      };
    }
    return null;
  }

  /**
   * «Autenticar» un EPON: ponerle a su `/ppp/secret` el perfil de su plan.
   *
   * Es el mismo `applyProfile` del botón de la ficha —una sola escritura de red,
   * con su auditoría y su dry-run—, así que no hay dos formas de cambiarle la
   * velocidad a un abonado. Si el perfil del plan no existe en ese router,
   * `applyProfile` falla diciendo cuáles hay: mejor eso que dejarlo a medias.
   */
  private async aplicarPlanEnMikrotik(t: any, sub: any, user?: AuthUser) {
    const plan = await this.planDeLaOrden(t, sub.id);
    const perfil = await this.perfilDelPlan(plan?.planId);
    const router = await this.mikrotik.resolveRouter(sub).catch(() => null);
    const esAlta = esAltaDeInternet(t.type);
    const bloqueo = this.motivoDeBloqueoMikrotik({
      modo: modoDeOrden(t.type), router, plan, perfil, sub, puedeCrearPppoe: esAlta && !!this.subs,
    });
    if (bloqueo) throw new BadRequestException(bloqueo.message);

    /**
     * Instalación / agregar internet: aquí el secret puede no existir todavía, y
     * `applyProfile` no sirve para eso —edita un `/ppp/secret` que tiene que
     * estar—. Se le crean primero sus datos de integración, ya con el perfil del
     * plan dentro; si el abonado ya los tenía, esto no escribe nada y el camino
     * sigue siendo el de siempre.
     */
    const alta = esAlta ? await this.asegurarAltaEnMikrotik(t, sub, plan, user) : null;
    if (alta && !alta.ok) {
      return {
        ok: false, dryRun: alta.dryRun, action: 'PROVISION', subscriberId: sub.id,
        steps: alta.pasos, message: alta.mensaje, error: alta.mensaje,
        via: 'MIKROTIK' as ViaOnu, perfil, altaMikrotik: alta,
        plan: { id: plan!.planId, name: plan!.planName },
      };
    }
    // El secret acaba de nacer con el perfil del plan: empujárselo otra vez sería
    // una segunda sesión contra el mismo router para escribir lo mismo.
    if (alta && (alta.creado || alta.usuarioCreado)) {
      return {
        ok: true, dryRun: alta.dryRun, action: 'PROVISION', subscriberId: sub.id,
        steps: alta.pasos, message: alta.mensaje,
        via: 'MIKROTIK' as ViaOnu, perfil: alta.perfil ?? perfil, altaMikrotik: alta,
        mikrotik: router ? { id: router.id, name: router.name, host: `${router.ip}:${router.port}`, tech: router.tech } : null,
        plan: { id: plan!.planId, name: plan!.planName },
      };
    }

    const res = await this.mikrotik.applyProfile(sub.id, perfil!, user);

    // El rastro va en el hilo de la orden, igual que la vía OLT: es donde el
    // técnico y quien audite después miran qué se hizo en esa visita.
    if (res.ok && !res.dryRun && t.code != null) {
      await this.prisma.ticketThread
        .create({
          data: {
            ticketCode: t.code,
            message: `Plan aplicado en la Mikrotik desde la orden · perfil ${perfil}`
              + ` · plan ${plan!.planName ?? '—'} · router ${res.mikrotik?.name ?? '—'}`,
            subscriberId: sub.id, employeeId: 0, date: new Date(),
          },
        })
        .catch(() => undefined);
    }
    return { ...res, via: 'MIKROTIK' as ViaOnu, perfil, plan: { id: plan!.planId, name: plan!.planName }, altaMikrotik: alta };
  }

  /** Una línea en el hilo de la orden. Nunca tumba lo que se acaba de hacer. */
  private async anotarEnLaOrden(t: { code: number | null }, sub: { id: string }, message: string, dryRun = false) {
    if (t.code == null || dryRun) return;
    await this.prisma.ticketThread
      .create({ data: { ticketCode: t.code, message, subscriberId: sub.id, employeeId: 0, date: new Date() } })
      .catch((e) => this.logger.warn(`No se pudo anotar en la orden ${t.code}: ${(e as Error).message}`));
  }

  /**
   * AUTENTICA la ONU elegida y la deja lista: perfiles y VLAN clonados de lo que
   * ya funciona en ese puerto, velocidad tomada del plan, comentario con el
   * abonado y vínculo ONU↔cliente en el inventario.
   */
  async autenticar(ticketId: string, dto: { sn?: string; equipmentId?: string }, user?: AuthUser) {
    const { t, sub } = await this.cargarOrden(ticketId, user);
    // En un EPON no hay ONU que dar de alta: autenticar es ponerle el perfil de
    // su plan en la Mikrotik. Mismo botón, misma orden, otra vía.
    if (viaDeTecnologia(sub.installTech) === 'MIKROTIK') return this.aplicarPlanEnMikrotik(t, sub, user);
    if (!puedeAutenticar(modoDeOrden(t.type))) {
      throw new BadRequestException(`Las órdenes de tipo "${t.type}" no autentican ONUs.`);
    }
    /**
     * TRASLADO: el trabajo no es montar un equipo, es MOVER el que el cliente ya
     * tiene. Por eso aquí no se aparta ni se entrega nada de la bodega (ver
     * `EquipoReservaService`) y, antes de dar de alta la ONU en el puerto de la casa
     * nueva, hay que desautenticarla de donde estaba (`liberarAltaAnterior`).
     * `esTraslado` deja fuera el 'Traslado interno De Equipos Red en cliente final',
     * que es mover el aparato de sitio dentro de la misma vivienda: ese no cambia de
     * puerto y su alta no se toca.
     */
    const traslado = esTraslado(t.type);

    const olt = await this.oltDeSede(sub.branchId);
    const plan = await this.planDeLaOrden(t, sub.id);
    const mapeo = await this.planProfiles.resolve(plan?.planId, olt?.id);
    const bloqueo = this.motivoDeBloqueo({ modo: 'AUTENTICAR', olt, plan, mapeo, tipo: t.type });
    if (bloqueo) throw new BadRequestException(bloqueo.message);

    /**
     * ANTES de tocar la OLT: el alta del abonado en la Mikrotik. La ONU le da
     * enlace, pero quien le da internet es su `/ppp/secret`, y en una instalación
     * (o en un 'AgregarInternet') puede no existir todavía. Va aquí y no al final
     * porque desde este punto la orden puede salir por varias puertas —adoptar un
     * alta que ya estaba, un SN repetido— y por todas el cliente tiene que quedar
     * con sus datos de red. No tumba la autenticación si el router no responde:
     * lo que falte viaja en el resultado. Ver `asegurarAltaEnMikrotik`.
     */
    const altaMikrotik = await this.asegurarAltaEnMikrotik(t, sub, plan, user);

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
      auto = await this.decidirAutomatico(sub, candidatos, inv, t.id, !traslado);
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
        return { ...(await this.adoptarExistente({ t, sub, olt: olt!, sn, plan, mapeo, equipo, equipoAVincular, user })), altaMikrotik };
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
    // El modelo que anuncia la ONU solo cuenta si el puerto está vacío: entonces
    // el srv-profile es el que se llama como él (ver `perfilesParaPuertoVacio`).
    const sug = (await this.olt.sugerencia(olt!.id, frame, slot, port, encontrada.model ?? null)).sugerencia ?? {};
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
    const vacio = sug.puertoVacio ?? null;
    if (!params.lineprofile || !params.srvprofile || !params.vlan) {
      throw new BadRequestException(this.motivoSinPerfil(`${frame}/${slot}/${port}`, params, vacio));
    }

    // En un traslado, el alta vieja se quita ANTES de hacer la nueva: si no, el
    // `ont add` choca con "SN already exists" y lo que hay en la OLT sigue apuntando
    // al PON de la dirección anterior.
    let liberacion = traslado ? await this.liberarAltaAnterior({ t, sub, olt: olt!, sn, fspNuevo: `${frame}/${slot}/${port}`, user }) : null;

    let res: any = await this.olt.provision(olt!.id, params, user);
    // Carrera: estaba en el autofind al listar y para cuando se pulsó el botón ya
    // la había autenticado otro (o la OLT la tenía de antes en otro puerto).
    if (!res.ok && res.codigo === 'SN_YA_EXISTE') {
      // En un traslado, "ya existe" es el alta anterior que hay que quitar, no una
      // ONU ajena que adoptar: la OLT dice dónde está, se borra ahí y se reintenta
      // una sola vez. Adoptarla dejaría al cliente con el service-port de la casa
      // vieja —que es justo lo que la orden viene a corregir—.
      if (traslado && !liberacion?.borrado && res.existente) {
        liberacion = await this.liberarAltaAnterior({ t, sub, olt: olt!, sn, fspNuevo: `${frame}/${slot}/${port}`, user, existente: res.existente });
        if (liberacion.borrado) res = await this.olt.provision(olt!.id, params, user);
      }
      if (!res.ok && res.codigo === 'SN_YA_EXISTE') {
        return {
          ...(await this.adoptarExistente({ t, sub, olt: olt!, sn, plan, mapeo, equipo, equipoAVincular, user })),
          auto: resumenAuto, liberacion, altaMikrotik,
        };
      }
    }
    if (!res.ok) return { ...res, liberacion, altaMikrotik };

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
    // ¿Navega? Se mira a los 60 s (lo que tarda la ONU en levantar PPPoE) sin
    // hacer esperar a la petición; el resultado queda en el seguimiento.
    const navegacion = !res.dryRun
      ? this.programarComprobacionDeNavegacion({ t, sub, oltId: olt!.id, frame, slot, port, vlan: Number(params.vlan) || null, verificacion: res.verificacion })
      : null;
    return {
      ...res,
      navegacion,
      plan: { id: plan!.planId, name: plan!.planName },
      velocidad: { trafficIn: mapeo!.trafficIn, trafficOut: mapeo!.trafficOut },
      fsp: `${frame}/${slot}/${port}`,
      equipo: equipoRegistrado,
      conciliacion,
      /** Traslado: de dónde se desautenticó la ONU antes de darla de alta aquí. */
      liberacion,
      // Cuando la eligió el sistema: por qué esa y no otra. La orden lo enseña
      // para que el técnico pueda desdecirlo si ve que no es la que instaló.
      auto: resumenAuto,
      /** El alta en la Mikrotik que se le dejó hecha (null = esta orden no la toca). */
      altaMikrotik,
    };
  }

  /** F/S/P + ont-id de un bloque de la OLT (el de `findBySn` o el `existente` de un alta). */
  private posicionDeOnu(onu: any): { frame: number; slot: number; port: number; ontId: number } | null {
    const m = String(onu?.fsp ?? '').match(/(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)/);
    const ontId = Number(onu?.ont_id ?? onu?.ontId);
    if (!m || !Number.isFinite(ontId)) return null;
    return { frame: Number(m[1]), slot: Number(m[2]), port: Number(m[3]), ontId };
  }

  /**
   * DESAUTENTICA la ONU de donde estaba, para poder darla de alta donde toca ahora.
   *
   * Es la mitad que le faltaba al traslado (2026-09-04, pedido por el usuario): "no
   * hay que asignarle un equipo nuevo de la bodega, simplemente se desautentica y se
   * vuelve a autenticar donde tiene que ser". El cliente se lleva SU ONU a la casa
   * nueva, y esa casa cuelga de otro puerto —o de otra OLT si cambia de sede—; el
   * alta anterior sobrevive al trasteo y estorba de dos maneras:
   *
   * - En la MISMA OLT, `ont add` responde "SN already exists" y no se puede dar de
   *   alta. Adoptar el alta vieja tampoco sirve: su service-port sigue colgando del
   *   PON de la dirección anterior, así que el abonado se quedaría sin navegar
   *   justo después de que el técnico diera la orden por buena.
   * - En OTRA OLT (traslado entre sedes) el alta ni siquiera estorba al comando: se
   *   queda ahí para siempre como una ONT fantasma ocupando un ont-id y, peor, con
   *   el nombre del abonado puesto en un nodo donde ya no vive.
   *
   * Por eso se borra en las dos: en la de destino (donde la OLT diga que está) y en
   * cualquier otra que el inventario local recuerde con ese SN. `ont delete` arrastra
   * sus service-ports (ver `OltHuawei.accionOnu`), que es lo que hay que quitar.
   *
   * NUNCA lanza: un traslado no se puede quedar a medias por no haber podido limpiar
   * lo de antes. Lo que no se pudo borrar viaja en `avisos` y queda anotado en la
   * orden, para que alguien lo mire desde Red › OLT.
   */
  private async liberarAltaAnterior(x: {
    t: any; sub: any; olt: { id: string; name: string }; sn: string; fspNuevo: string;
    user?: AuthUser;
    /** El bloque `existente` que devuelve un alta rechazada con SN_YA_EXISTE, si lo hubo. */
    existente?: any;
  }) {
    const out = {
      borrado: false,
      dryRun: false,
      /** Dónde estaba autenticada en la OLT de destino (F/S/P:ont-id). */
      anterior: null as string | null,
      /** Altas fantasma borradas en otras OLTs: "NODO 0/1/5:12". */
      tambienEn: [] as string[],
      avisos: [] as string[],
    };
    try {
      // 1. La OLT de destino. Se pregunta a la OLT (o se usa lo que ella acaba de
      //    contestar al alta): el inventario local puede llevar días sin sincronizar
      //    y borrar por un ont-id viejo es borrarle la ONT a otro abonado.
      let pos = this.posicionDeOnu(x.existente);
      if (!pos) {
        const y = await this.olt.findBySn(x.olt.id, x.sn);
        if (y.ok && (y.onu as any)?.fsp) pos = this.posicionDeOnu(y.onu);
      }
      if (pos) {
        const fsp = `${pos.frame}/${pos.slot}/${pos.port}:${pos.ontId}`;
        const r: any = await this.olt.remove(
          x.olt.id, { frame: pos.frame, slot: pos.slot, port: pos.port, ont_id: pos.ontId, sn: x.sn }, x.user);
        out.anterior = fsp;
        out.borrado = !!r.ok;
        out.dryRun = !!r.dryRun;
        if (!r.ok) out.avisos.push(`No se pudo desautenticar la ONU de ${fsp} en ${x.olt.name}: ${r.error}`);
      }

      // 2. Otras OLTs: el traslado que cambia de sede deja el alta en el nodo viejo.
      //    El inventario local solo dice DÓNDE mirar; la posición se vuelve a leer
      //    de esa OLT antes de tocar nada.
      const fuera = await this.prisma.oltOnu.findMany({
        where: { sn: x.sn, oltId: { not: x.olt.id } },
        select: { id: true, oltId: true, olt: { select: { name: true } } },
      });
      for (const o of fuera) {
        const y = await this.olt.findBySn(o.oltId, x.sn).catch(() => ({ ok: false } as any));
        const p2 = y.ok ? this.posicionDeOnu(y.onu) : null;
        if (!p2) {
          // Ya no está allá (o no se pudo entrar): el registro local es el fantasma.
          await this.prisma.oltOnu.delete({ where: { id: o.id } }).catch(() => undefined);
          continue;
        }
        const fsp = `${p2.frame}/${p2.slot}/${p2.port}:${p2.ontId}`;
        const r: any = await this.olt.remove(
          o.oltId, { frame: p2.frame, slot: p2.slot, port: p2.port, ont_id: p2.ontId, sn: x.sn }, x.user);
        if (r.ok && !r.dryRun) {
          out.tambienEn.push(`${o.olt?.name ?? o.oltId} ${fsp}`);
          await this.prisma.oltOnu.delete({ where: { id: o.id } }).catch(() => undefined);
        } else if (!r.ok) {
          out.avisos.push(`No se pudo desautenticar la ONU de ${fsp} en la OLT ${o.olt?.name ?? o.oltId}: ${r.error}`);
        }
      }

      if (x.t?.code != null && (out.anterior || out.tambienEn.length || out.avisos.length)) {
        const msg =
          `TRASLADO · ONU ${x.sn} desautenticada de su sitio anterior para volver a autenticarla en ${x.fspNuevo}`
          + (out.dryRun ? ' (DRY-RUN: la OLT no se tocó)' : '')
          + (out.anterior ? `\nEstaba en ${x.olt.name} ${out.anterior}${out.borrado ? ' — borrada con sus service-ports.' : ' — NO se pudo borrar.'}` : '')
          + (out.tambienEn.length ? `\nTambién se quitó el alta que había quedado en: ${out.tambienEn.join(' · ')}` : '')
          + '\nNo se descuenta ningún equipo de la bodega: es el mismo aparato que el cliente ya tenía.'
          + (out.avisos.length ? `\nAvisos: ${out.avisos.join(' | ')}` : '');
        await this.prisma.ticketThread
          .create({ data: { ticketCode: x.t.code, message: msg, subscriberId: x.sub.id, employeeId: 0, date: new Date() } })
          .catch((e) => this.logger.warn(`No se pudo anotar la liberación en la orden ${x.t.code}: ${e.message}`));
      }
    } catch (e) {
      out.avisos.push(`No se pudo revisar el alta anterior de la ONU ${x.sn}: ${(e as Error).message}`);
      this.logger.warn(`Traslado: liberar alta anterior de ${x.sn} — ${(e as Error).message}`);
    }
    return out;
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
  /**
   * Por qué no se pudo armar el alta, dicho de forma que alguien lo arregle. En
   * un puerto vacío dice QUÉ falta (VLAN en el catálogo, srv-profile del modelo…)
   * en vez de mandar a buscar "valores por defecto" que en esta planta no existen.
   */
  private motivoSinPerfil(
    fsp: string,
    params: { lineprofile?: any; srvprofile?: any; vlan?: any },
    vacio: { vlanMotivo?: string | null; lineMotivo?: string | null; srvMotivo?: string | null } | null,
  ): string {
    const salida = 'Autentíquela desde Red › OLT indicando line-profile, srv-profile y VLAN.';
    if (!vacio) {
      const falta = [
        !params.lineprofile && 'el line-profile',
        !params.srvprofile && 'el srv-profile',
        !params.vlan && 'la VLAN',
      ].filter(Boolean).join(', ');
      return `No se pudo deducir el alta para el puerto ${fsp}: de las ONUs que ya cuelgan de ahí no se pudo leer ${falta}. ${salida}`;
    }
    const motivos = [
      !params.vlan && vacio.vlanMotivo
        ? `${vacio.vlanMotivo} (corríjalo en Red › VLANs: bandeja y puerto de OLT)`
        : null,
      !params.lineprofile && vacio.lineMotivo,
      !params.srvprofile && vacio.srvMotivo,
    ].filter(Boolean);
    return `El puerto ${fsp} no tiene ninguna otra ONU de la que copiar la configuración, y `
      + `${motivos.join('; ') || 'no se pudo completar el alta'}. ${salida}`;
  }

  private comentario(sub: any): string {
    const nombre = nombreDe(sub).replace(/[^A-Za-zÁÉÍÓÚÑáéíóúñ ]/g, '').trim().split(/\s+/).slice(0, 2).join('');
    return `${sub.abonado ?? ''}${nombre}`.slice(0, 32);
  }

  /**
   * Deja constancia: ONU vinculada al abonado en el inventario y una entrada en
   * el hilo de la orden. Sin esto el alta se pierde: nadie sabría, leyendo la
   * orden, que la ONU se autenticó desde ahí ni con qué velocidad.
   */
  private navegacionDeOrden(ticketId: string) {
    const x = OnuProvisionService.navegacion.get(ticketId);
    if (!x || Date.now() - x.at > OnuProvisionService.NAVEGACION_TTL_MS) return null;
    return x;
  }

  /**
   * Deja programada la comprobación "¿navega?" y responde enseguida con
   * `{ estado: 'PENDIENTE', enSegundos }`. La comprobación mira la sesión PPPoE
   * del abonado en su Mikrotik; si no hay, revisa la VLAN del puerto en los
   * equipos para decir QUÉ falta. Solo lectura. Nunca lanza.
   */
  private programarComprobacionDeNavegacion(x: {
    t: any; sub: any; oltId: string; frame: number; slot: number; port: number; vlan: number | null; verificacion: any;
  }) {
    if (!this.vlanEquipos) return null;
    const enSegundos = Math.round(OnuProvisionService.ESPERA_NAVEGACION_MS / 1000);
    OnuProvisionService.navegacion.set(x.t.id, {
      at: Date.now(), estado: 'PENDIENTE', mensaje: `Comprobando si el abonado navega en ${enSegundos} s…`,
    });
    const timer = setTimeout(() => {
      this.comprobarNavegacion(x).catch((e) => this.logger.warn(`Comprobación de navegación de la orden ${x.t.code}: ${(e as Error).message}`));
    }, OnuProvisionService.ESPERA_NAVEGACION_MS);
    timer.unref?.();
    return { estado: 'PENDIENTE' as const, enSegundos };
  }

  private async comprobarNavegacion(x: {
    t: any; sub: any; oltId: string; frame: number; slot: number; port: number; vlan: number | null; verificacion: any;
  }) {
    const fsp = `${x.frame}/${x.slot}/${x.port}`;
    let estado: 'NAVEGANDO' | 'SIN_PPPOE' | 'SIN_REVISAR' = 'SIN_REVISAR';
    let mensaje = '';
    let st: any = null;
    try {
      st = esUsuarioPppUtil(x.sub.pppUsername) ? await this.mikrotik.liveStatus(x.sub.id) : null;
    } catch (e) {
      mensaje = `No se pudo consultar la sesión PPPoE: ${(e as Error).message}`;
    }
    if (!st && !mensaje) mensaje = 'El abonado no tiene usuario PPPoE en su ficha: no hay sesión que buscar.';
    else if (st?.dryRun) mensaje = 'Mikrotik en dry-run: no se consultó la sesión PPPoE.';
    else if (st && !st.ok) mensaje = `No se pudo consultar la sesión PPPoE: ${st.error ?? st.message}`;
    else if (st?.live?.sessionActive) {
      estado = 'NAVEGANDO';
      mensaje = `Navegando: sesión PPPoE activa en ${st.mikrotik?.name ?? 'el Mikrotik'}${st.live.ip ? ` (IP ${st.live.ip})` : ''}.`;
    } else if (st) {
      estado = 'SIN_PPPOE';
      const enLinea = /online/i.test(String(x.verificacion?.run_state ?? ''));
      const ch = await this.vlanEquipos!.chequeoDePuerto(x.oltId, x.frame, x.slot, x.port, x.vlan);
      mensaje = (enLinea ? 'La ONU está en línea pero NO hay sesión PPPoE' : 'No hay sesión PPPoE')
        + ` a los ${Math.round(OnuProvisionService.ESPERA_NAVEGACION_MS / 1000)} s — revisar VLAN/uplink/credenciales.`
        + (ch.falta.length
          ? ` VLAN ${ch.vlan ?? '?'} de ${fsp}: ${ch.falta.join('; ')}. Se arregla en Red › VLANs › "Configurar en equipos".`
          : ` La VLAN ${ch.vlan ?? '?'} está completa en OLT y Mikrotik: revisar usuario/clave PPPoE en el equipo del cliente`
            + (st.live?.secretExists === false ? ' (el secret NO existe en el router)' : st.live?.secretDisabled ? ' (el secret está deshabilitado)' : '')
            + '.');
    }
    OnuProvisionService.navegacion.set(x.t.id, { at: Date.now(), estado, mensaje });
    if (x.t.code == null) return;
    await this.prisma.ticketThread
      .create({ data: { ticketCode: x.t.code, message: `Comprobación tras autenticar (${fsp}): ${mensaje}`, subscriberId: x.sub.id, employeeId: 0, date: new Date() } })
      .catch((e) => this.logger.warn(`No se pudo anotar la comprobación en la orden ${x.t.code}: ${e.message}`));
  }

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
   * Aplica la velocidad del plan de la orden a la ONU que el abonado YA tiene
   * autenticada.
   *
   * - «Subir megas»: se DESAUTENTICA la ONU y se vuelve a autenticar con las megas
   *   de la orden (pedido por el usuario, 2026-09-14). Ver `reautenticarConPlan`.
   * - «Bajar megas» / «Cambio de plan»: se reapuntan las traffic-tables del
   *   service-port sin tocar el alta.
   */
  async aplicarVelocidad(ticketId: string, user?: AuthUser) {
    const { t, sub } = await this.cargarOrden(ticketId, user);
    // Sin OLT, «aplicar la velocidad» y «autenticar» son literalmente la misma
    // escritura: el perfil del plan en el secret. Las dos puertas van al mismo sitio.
    if (viaDeTecnologia(sub.installTech) === 'MIKROTIK') return this.aplicarPlanEnMikrotik(t, sub, user);
    if (!puedeVelocidad(modoDeOrden(t.type))) {
      throw new BadRequestException(`Las órdenes de tipo "${t.type}" no cambian la velocidad de la ONU.`);
    }
    const olt = await this.oltDeSede(sub.branchId);
    const plan = await this.planDeLaOrden(t, sub.id);
    const mapeo = await this.planProfiles.resolve(plan?.planId, olt?.id);
    const bloqueo = this.motivoDeBloqueo({ modo: 'VELOCIDAD', olt, plan, mapeo, tipo: t.type });
    if (bloqueo) throw new BadRequestException(bloqueo.message);

    const onu = await this.prisma.oltOnu.findFirst({
      where: { subscriberId: sub.id },
      orderBy: { lastSync: 'desc' },
      select: { sn: true, oltId: true },
    });
    if (!onu?.sn) {
      throw new BadRequestException('Este abonado no tiene ninguna ONU vinculada: no hay velocidad que cambiar.');
    }

    if (sentidoDeMegas(t.type) === 'SUBIR') {
      return this.reautenticarConPlan({ t, sub, oltId: onu.oltId ?? olt!.id, olt: olt!, sn: onu.sn, plan, mapeo, user });
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

  /**
   * SUBIR MEGAS = DESAUTENTICAR Y VOLVER A AUTENTICAR con las megas de la orden
   * (pedido por el usuario, 2026-09-14).
   *
   * Se vuelve a dar de alta EXACTAMENTE como estaba —mismo puerto, mismo ONT-ID,
   * mismos line/srv-profile, VLAN y GEM, mismo comentario— y lo único que cambia
   * son las traffic-tables, que salen del plan de la orden. Todo se lee de la OLT
   * justo antes de borrar: el inventario local puede llevar días sin sincronizar.
   *
   * Guardas, porque entre el borrado y el alta el abonado está sin servicio:
   * - Con varios service-ports (internet + TV/voz) no se toca: el alta nueva solo
   *   recrea el de internet y la TV se perdería.
   * - Si el alta nueva falla, se intenta dejar la ONU como estaba (velocidad
   *   vieja) UNA sola vez. No en bucle: re-autenticar seguido es lo que deja
   *   pegadas a las ZTE en `config: failed`.
   */
  private async reautenticarConPlan(x: {
    t: any; sub: any; oltId: string; olt: any; sn: string; plan: any; mapeo: any; user?: AuthUser;
  }) {
    const { t, sub, oltId, olt, sn, plan, mapeo, user } = x;
    const leido = await this.olt.estadoPorSn(oltId, sn);
    const est: any = leido.estado;
    if (!leido.ok || !est) {
      throw new BadRequestException(
        `No se encontró la ONU ${sn} autenticada en la OLT: no hay nada que desautenticar. ${leido.error ?? ''}`.trim());
    }
    const sps: any[] = Array.isArray(est.servicePorts) ? est.servicePorts : [];
    if (sps.length > 1) {
      throw new BadRequestException(
        `La ONU ${sn} tiene ${sps.length} service-ports (internet y TV/voz): desautenticarla le quitaría `
        + 'también la TV. Cambie la velocidad desde Red › OLT.');
    }
    const sp = sps[0] ?? null;
    const num = (v: unknown) => (v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);
    const elegir = (...vs: any[]) => {
      for (const v of vs) if (v !== undefined && v !== null && v !== '') return v;
      return undefined;
    };
    // La sugerencia del puerto solo rellena lo que la propia ONT no dice (el
    // user-vlan no sale en el listado de service-ports).
    const sug = (await this.olt.sugerencia(oltId, est.frame, est.slot, est.port)).sugerencia ?? {};
    const vlan = elegir(num(sp?.vlan), mapeo?.vlan, sug.vlan, olt.defaultVlan);
    const params = {
      frame: est.frame, slot: est.slot, port: est.port, ont_id: est.ont_id, sn,
      lineprofile: elegir(num(est.lineprofile), mapeo?.lineprofile, sug.lineprofile, olt.defaultLineProfile),
      srvprofile: elegir(num(est.srvprofile), mapeo?.srvprofile, sug.srvprofile, olt.defaultSrvProfile),
      vlan,
      gemport: elegir(num(sp?.gemport), mapeo?.gemport, sug.gemport, olt.defaultGemport, 1),
      user_vlan: elegir(mapeo?.userVlan, sug.user_vlan, olt.defaultUserVlan, vlan),
      traffic_in: mapeo?.trafficIn ?? undefined,
      traffic_out: mapeo?.trafficOut ?? undefined,
      desc: est.description?.trim() || this.comentario(sub),
    };
    if (!params.lineprofile || !params.srvprofile || !params.vlan) {
      throw new BadRequestException(
        `No se pudo leer cómo está dada de alta la ONU ${sn} (line-profile, srv-profile o VLAN): `
        + 'no se desautentica sin saber cómo volver a autenticarla.');
    }
    const fsp = `${est.frame}/${est.slot}/${est.port}`;
    const antes = { traffic_in: sp?.rx ?? '—', traffic_out: sp?.tx ?? '—' };

    // 1) Desautenticar (arrastra sus service-ports).
    const baja: any = await this.olt.remove(oltId, { frame: est.frame, slot: est.slot, port: est.port, ont_id: est.ont_id, sn }, user);
    if (!baja.ok) {
      return { ok: false, dryRun: false, error: `No se pudo desautenticar la ONU ${sn} de ${fsp}:${est.ont_id}: ${baja.error}. El cliente sigue como estaba.` };
    }

    // 2) Volver a autenticar con la velocidad del plan de la orden.
    let res: any = await this.olt.provision(oltId, params, user);
    let restaurada: boolean | null = null;
    if (!res.ok && !baja.dryRun) {
      // El abonado está sin alta: se intenta dejarlo como estaba.
      const viejo = { ...params, traffic_in: num(sp?.rx), traffic_out: num(sp?.tx) };
      const r2: any = await this.olt.provision(oltId, viejo, user).catch((e) => ({ ok: false, error: (e as Error).message }));
      restaurada = !!r2.ok;
      this.logger.warn(`Subir megas ${sn}: el alta nueva falló (${res.error}); restaurar con la velocidad anterior → ${r2.ok ? 'ok' : r2.error}`);
    }

    if (!res.dryRun && t.code != null) {
      const avisos: string[] = res.verificacion?.avisos ?? [];
      const msg =
        `SUBIR MEGAS · ONU ${sn} desautenticada y vuelta a autenticar en ${fsp} (ONT-ID ${est.ont_id})`
        + `\nPlan: ${plan?.planName ?? '—'} · traffic-table bajada ${antes.traffic_in} → ${params.traffic_in ?? '—'} / subida ${antes.traffic_out} → ${params.traffic_out ?? '—'}`
        + (res.ok
          ? `\nEstado: ${res.verificacion?.run_state ?? '—'} · config ${res.verificacion?.config_state ?? '—'} · ${res.verificacion?.servicePorts?.length ?? 0} service-port(s)`
          : `\nNO se pudo volver a autenticar: ${res.error}`
            + (restaurada === true ? ' — se restauró el alta con la velocidad anterior.' : ' — TAMPOCO se pudo restaurar: el abonado quedó SIN alta en la OLT, autentíquela desde Red › OLT.'))
        + (avisos.length ? `\nAvisos: ${avisos.join(' | ')}` : '');
      await this.prisma.ticketThread
        .create({ data: { ticketCode: t.code, message: msg, subscriberId: sub.id, employeeId: 0, date: new Date() } })
        .catch((e) => this.logger.warn(`No se pudo anotar la re-autenticación en la orden ${t.code}: ${(e as Error).message}`));
    }
    // `provision` guarda la ONU en el inventario local; el vínculo con el abonado se repone.
    if (!res.dryRun && (res.ok || restaurada)) {
      await this.prisma.oltOnu
        .updateMany({ where: { oltId, sn }, data: { subscriberId: sub.id, clientName: nombreDe(sub) || String(sub.abonado ?? '') } })
        .catch(() => undefined);
    }

    if (!res.ok) {
      return {
        ...res,
        error: `${res.error ?? 'La OLT rechazó el alta nueva.'} `
          + (restaurada ? 'Se restauró la ONU con la velocidad anterior.' : 'No se pudo restaurar: el abonado quedó sin alta en la OLT.'),
        restaurada,
      };
    }
    return {
      ...res,
      commands: [...(baja.commands ?? []), ...(res.commands ?? [])],
      message: res.dryRun
        ? res.message
        : `ONU desautenticada y vuelta a autenticar con ${plan?.planName ?? 'el plan de la orden'}.`,
      reautenticada: true,
      fsp,
      antes,
      despues: { traffic_in: String(params.traffic_in ?? '—'), traffic_out: String(params.traffic_out ?? '—') },
      plan: { id: plan?.planId ?? null, name: plan?.planName ?? null },
    };
  }
}
