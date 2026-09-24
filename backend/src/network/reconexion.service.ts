import { Logger } from '../core/logger';
import { Prisma, SubscriberStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { conservaEstadoAlReconectar } from './estado-al-reconectar';
import { AuthUser } from '../auth/current-user.decorator';
import { MikrotikService } from './mikrotik.service';
import { GenieacsService } from './genieacs.service';
import { round2 } from '../common/money';
import type { OrdenAbierta, OrdenesAutomaticasService } from '../support/ordenes-automaticas.service';
import { tipoConArrastre } from '../support/order-types';
import type { ProrrateoReconexionService, ResultadoProrrateo } from '../billing/prorrateo-reconexion.service';
import type { EmisorDeEventos } from '../core/eventos';
import { RECONEXION_APLICADA_EVENT, type ReconexionAplicadaEvent } from './network.events';
import { esUsuarioPppUtil } from '../subscribers/conexion-alta';
import { esLineaTv, serviciosContratados, type ServiciosContratados } from '../common/servicios-contratados';

/**
 * Reconexión automática al pagar.
 *
 * Un cliente que paga tiene que volver a tener servicio sin que nadie más toque
 * nada, y "servicio" aquí son DOS cosas distintas que viven en equipos distintos:
 *
 *  · Internet → Mikrotik: sacar la IP de la lista MOROSOS y ponerla en ACTIVOS
 *    (y habilitar el secret si un corte viejo lo dejó deshabilitado).
 *  · TV       → la vía que le corresponda al abonado: TR-069 sobre el CPE
 *    (tag `tv-suspendida` + X_CATVConfiguration.Enable) o, si la ONT no habla
 *    TR-069, el puerto CATV por la OLT.
 *
 * Este servicio es el único que decide QUÉ le corresponde a cada abonado y deja
 * la base de datos contando lo mismo que los equipos. Lo usan todos los caminos
 * por los que entra un pago (caja y cargue de pagos), para que reconectar no
 * dependa de por dónde entró la plata.
 */

/** Estados en los que un pago significa "devuélvele el servicio".
 *
 *  CORTADO es el corte fresco; CARTERA es ese mismo corte dos meses después
 *  (el cron `runCartera` los mueve, y el equipo sigue cortado igual); REPORTADO
 *  es cortado + reportado a centrales. COMPROMISO ya viene de un acuerdo de pago.
 *
 *  Fuera quedan a propósito: SUSPENDIDO (suspensión pedida por el cliente, no se
 *  levanta sola por un abono), RETIRADO / DEPURADO / POR_RETIRAR / INACTIVO
 *  (pagar una deuda vieja no revive un servicio que ya se dio de baja) y
 *  EXONERADO / EVENTO / INSTALAR (no están cortados por plata).
 */
const ESTADOS_RECONECTABLES: SubscriberStatus[] = ['CORTADO', 'CARTERA', 'REPORTADO', 'COMPROMISO'];

/**
 * Estados a los que un pago NO les devuelve el servicio, venga la prueba de donde venga.
 *
 * `ESTADOS_RECONECTABLES` deja fuera estos cinco, pero eso solo frena el camino en el
 * que la prueba del corte ES el estado. Los otros dos —el router lo tiene en MOROSOS,
 * o su última orden es un corte sin reconexión— no miraban el estado para nada, así
 * que la exclusión se colaba por ahí: en la ventana de 30 días del portal salían **3
 * abonados RETIRADOS** a los que se les iba a devolver el internet por pagar una deuda
 * vieja. Un secret deshabilitado en el router es exactamente lo que se le deja a quien
 * se dio de baja, y un retiro también deja su orden de corte; ninguna de las dos cosas
 * es señal de "está cortado por plata" cuando el cliente ya no es cliente.
 *
 * SUSPENDIDO va aquí por lo mismo que en `ESTADOS_RECONECTABLES`: esa suspensión la
 * pidió el cliente y no se levanta con un abono.
 */
const ESTADOS_SIN_RECONEXION: SubscriberStatus[] = [
  'RETIRADO', 'DEPURADO', 'POR_RETIRAR', 'INACTIVO', 'SUSPENDIDO',
];


/**
 * Cuánto espera QUIEN REGISTRA EL PAGO a que terminen los equipos.
 *
 * La reconexión de internet es un par de comandos por API (rápida), pero la TV
 * puede irse a una sesión SSH contra la OLT que relee el puerto hasta 4 veces, o
 * a un connection-request del ACS que espera a que el CPE despierte. La cajera no
 * puede quedarse mirando una pantalla 30 segundos por eso: si se pasa de este
 * tiempo se responde "va en curso" y el trabajo SIGUE corriendo en segundo plano
 * (termina, escribe su auditoría y actualiza el estado igual).
 */
const ESPERA_MAX_MS = 15_000;

/**
 * Lo mismo, en la ventanilla de caja: ahí el recibo se imprime cuando termina esto,
 * y el cliente está esperando el papel. Alcanza para la comprobación contra el
 * router (1-3 s) más una reconexión de internet normal; lo que pase de ahí sigue en
 * segundo plano igual que con el tope largo.
 */
export const ESPERA_VENTANILLA_MS = 5_000;

/**
 * Cuántos días hacia atrás vale una orden de corte como prueba de que el servicio
 * sigue caído. Más allá, el rastro no significa nada: las reconexiones no siempre
 * dejan orden y un corte de hace un año se resolvió por cualquier otra vía.
 */
const DIAS_SENAL_CORTE = 45;

/** Cómo se llama cada servicio cuando hay que contárselo a una persona. */
const NOMBRE_SERVICIO: Record<'INTERNET' | 'TV', string> = { INTERNET: 'el internet', TV: 'la TV' };

/**
 * Qué orden de servicio se abre cuando el equipo no se deja reconectar.
 *
 * Los nombres son los del catálogo del legacy (`support/order-types.ts`) letra por
 * letra —sin tildes— porque `tickets.detalle` es texto y todos los reportes de
 * campo agrupan por él: escribir "Reconexión Televisión" aquí crearía un tipo de
 * orden nuevo que no cuenta en ningún lado.
 */
const TIPO_ORDEN: Record<'INTERNET' | 'TV', string> = {
  INTERNET: 'Reconexion Internet',
  TV: 'Reconexion Television',
};

/**
 * El nombre de la orden dice si la reconexión ARRASTRA mes sin facturar.
 *
 * `Reconexion Internet` = se cortó este mes, su mensualidad ya está cobrada.
 * `Reconexion Internet2` = venía cortado de antes, hay días que nadie facturó y
 * se le cobran (ver `billing/prorrateo-reconexion.service.ts`). No es una etiqueta
 * cosmética: los informes del legacy separan las dos cosas y el "2" es lo que
 * permite mirar más tarde por qué esa factura lleva un renglón partido.
 */
const tipoOrden = (servicio: 'INTERNET' | 'TV', arrastra: boolean) =>
  arrastra ? tipoConArrastre(TIPO_ORDEN[servicio]) : TIPO_ORDEN[servicio];

/**
 * El otro nombre del mismo trabajo. Se le pasa al abridor de órdenes para que no
 * abra una "Reconexion Television2" a quien ya tiene abierta una "Reconexion
 * Television": es la misma visita, y el "2" sólo dice si además hay que cobrar.
 */
const tipoHermano = (servicio: 'INTERNET' | 'TV', arrastra: boolean) =>
  arrastra ? TIPO_ORDEN[servicio] : tipoConArrastre(TIPO_ORDEN[servicio]);

/** ¿El cobro de reconexión tocó este servicio? (la TV arrastra sus puntos). */
const cobroTocaA = (cobro: ResultadoProrrateo | null | undefined, servicio: 'INTERNET' | 'TV') =>
  !!cobro?.lineas.some((l) => (servicio === 'INTERNET' ? l.kind === 'INTERNET' : l.kind === 'TV' || l.kind === 'PUNTOS'));

export type ServicioReconectado = {
  servicio: 'INTERNET' | 'TV';
  ok: boolean;
  dryRun: boolean;
  /** Por dónde se hizo: el router, el ACS o la OLT. */
  via: 'MIKROTIK' | 'TR069' | 'OLT' | null;
  detalle: string;
  /**
   * El equipo contestó que el servicio YA estaba al aire: no había corte que levantar.
   * No deja orden de reconexión ni cobra prorrateo (ver `reconectarInternet`).
   */
  sinCorte?: boolean;
  /**
   * Orden de servicio que quedó abierta porque el equipo no se dejó reconectar.
   * `null` = no hizo falta (salió bien) o no se pudo abrir.
   */
  orden?: (OrdenAbierta & { servicio: 'INTERNET' | 'TV' }) | null;
};

export type ResultadoReconexion = {
  subscriberId: string;
  /** ¿Había algo que reconectar? false = el cliente no estaba cortado. */
  aplica: boolean;
  /** true si todo lo que se intentó salió bien (o si no había nada que hacer). */
  ok: boolean;
  /** Se agotó la espera: los equipos siguen aplicando en segundo plano. */
  enCurso: boolean;
  dryRun: boolean;
  servicios: ServicioReconectado[];
  /**
   * Órdenes de servicio que quedaron abiertas por lo que no se pudo reconectar.
   * Con esto, "falló" deja de ser un aviso que se pierde: es trabajo agendable.
   */
  ordenes: Array<OrdenAbierta & { servicio: 'INTERNET' | 'TV' }>;
  /**
   * Órdenes de constancia de lo que SÍ se reconectó: nacen y se cierran solas, para
   * que el trabajo quede en la ficha del cliente como cuando lo hacía la cajera.
   */
  registros: Array<OrdenAbierta & { servicio: 'INTERNET' | 'TV' }>;
  /**
   * Los días del mes que nadie había facturado, cobrados al devolver el servicio
   * (lo que en el legacy hacen las órdenes terminadas en "2"). `null` = no había
   * nada que cobrar, o el prorrateo está apagado.
   */
  cobro?: ResultadoProrrateo | null;
  mensaje: string;
};

type SubParaReconectar = {
  id: string;
  abonado: number;
  status: SubscriberStatus | null;
  pppUsername: string | null;
  services: { id: string; kind: string; status: string }[];
  /** Su última factura recurrente (ver `tvDeFactura`). Vacío = no tiene ninguna. */
  invoices?: { serviceTv: string | null; estadoTv: string | null; items?: { productName: string | null }[] }[];
  _count: { oltOnus: number };
  /**
   * Qué tiene contratado según sus mensualidades (ver `servicios-contratados.ts`).
   * `undefined` = no se sabe, y la duda no le quita nada.
   */
  contrato?: ServiciosContratados;
};

/** La última factura recurrente viva del abonado (la que manda). */
const ULTIMA_RECURRENTE: Prisma.Subscriber$invoicesArgs = {
  where: { kind: 'RECURRENTE', status: { not: 'CANCELED' } },
  orderBy: [{ invoiceDate: 'desc' }, { tid: 'desc' }],
  take: 1,
  // Las líneas van porque la cabecera no basta: hay facturas hechas en nexus que
  // cobran la TV con `serviceTv` en NULL (ver `tvDeFactura`).
  select: { serviceTv: true, estadoTv: true, items: { select: { productName: true } } },
};

const SELECT_RECONEXION = {
  id: true,
  abonado: true,
  status: true,
  pppUsername: true,
  services: { select: { id: true, kind: true, status: true } },
  /**
   * La ÚLTIMA FACTURA RECURRENTE, que es la otra fuente —y la buena— de "¿este
   * abonado tiene televisión y la tiene cortada?" (ver `tvDeFactura`). Va aquí
   * dentro y no en una consulta aparte para que el camino de lote la traiga
   * también, sin una consulta por abonado.
   */
  invoices: ULTIMA_RECURRENTE,
  _count: { select: { oltOnus: true } },
} as const;

export class ReconexionService {
  private readonly logger = new Logger(ReconexionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mikrotik: MikrotikService,
    private readonly genieacs: GenieacsService,
    /**
     * Opcional a propósito: sin él, el servicio se comporta como antes (avisa y
     * ya). Con él, lo que no se pudo reconectar queda como orden de servicio.
     */
    private readonly ordenes?: OrdenesAutomaticasService,
    /**
     * Opcional por lo mismo que `ordenes`: sin él la reconexión sigue funcionando,
     * sólo que no cobra los días que quedan del mes (que es como estaba hasta
     * 2026-08-25) y las órdenes salen todas sin el "2".
     */
    private readonly prorrateo?: ProrrateoReconexionService,
    /**
     * Opcional: sin él nada cambia de puertas adentro, pero el legacy no se entera de
     * la reconexión hasta la pasada completa del writeback (5 min) y la ida puede
     * llegar antes y deshacerla.
     */
    private readonly events?: EmisorDeEventos,
  ) {}

  // ------------------------------------------------------------------
  // Qué le corresponde a este abonado
  // ------------------------------------------------------------------

  /** ¿El estado del abonado es de los que un pago debe levantar? */
  private estaCortado(sub: { status: SubscriberStatus | null }) {
    return !!sub.status && ESTADOS_RECONECTABLES.includes(sub.status);
  }

  /** ¿Es alguien a quien ya no hay que devolverle nada? (ver `ESTADOS_SIN_RECONEXION`). */
  private sinDerechoAReconexion(sub: { status: SubscriberStatus | null }) {
    return !!sub.status && ESTADOS_SIN_RECONEXION.includes(sub.status);
  }

  /** Servicios de TV del abonado (la TV y los puntos/decos salen por el mismo puerto CATV). */
  private serviciosTv(sub: SubParaReconectar) {
    return sub.services.filter((s) => s.kind === 'TV' || s.kind === 'PUNTOS');
  }

  /**
   * La televisión SEGÚN SU ÚLTIMA FACTURA RECURRENTE: si la tiene contratada y si
   * está caída. Es la segunda fuente —y para media base, la única.
   *
   * `SubscriberService` (las filas de `sub.services`) **está incompleto**: se
   * materializó de una pasada que solo recorrió los ACTIVO, así que 2.350 clientes
   * vivos no tienen ni una fila. Preguntarle solo a él por la TV deja fuera justo
   * a los que más importan aquí, los cortados. Caso real del 08-09-2026: el abonado
   * 56720 venía cortado de junio (combo internet+TV), pagó, y como no tenía filas de
   * servicio la reconexión ni intentó la TV ni abrió su orden — se hizo a mano.
   *
   * La factura sí lo sabe, y es de donde lo leen la ficha y el contrato en PDF:
   * `serviceTv` nombra el plan de televisión ('no'/'-'/vacío = no la tiene) y
   * `estadoTv` sigue la convención del legacy — NULL = al aire, con valor = caída.
   *
   * Si la factura trae LÍNEAS, mandan ellas —es lo que se le cobra—: la cabecera
   * miente en los dos sentidos. ~18 facturas de septiembre hechas en nexus cobran
   * la TV con `serviceTv` en NULL, y la corrida del 01-09 dejó "Television26" en
   * la cabecera de 37 que solo cobran internet (entre ellas 56499 y 57459, que
   * habían suspendido la TV). Sin líneas cargadas, decide la cabecera.
   *
   * `dadaDeBaja`: hay factura y no cobra televisión, o la marca SUSPENDIDA (la
   * suspensión la pide el cliente y no se levanta pagando). Manda sobre todo lo
   * demás (ver `tvDadaDeBaja`). `cortada` es solo el CORTE por plata.
   */
  private tvDeFactura(sub: SubParaReconectar) {
    const f = sub.invoices?.[0];
    const nombre = (f?.serviceTv ?? '').trim().toLowerCase();
    const porCabecera = !!nombre && nombre !== 'no' && nombre !== '-';
    const contratada = f?.items?.length ? f.items.some((l) => esLineaTv(l.productName)) : porCabecera;
    return {
      contratada,
      cortada: contratada && f?.estadoTv === 'CORTADO',
      dadaDeBaja: !!f && (!contratada || f.estadoTv === 'SUSPENDIDO'),
    };
  }

  /**
   * ¿El cliente ya NO tiene televisión? Veto sobre cualquier otra señal.
   *
   * Casos reales (22-09-2026), clientes que suspendieron la TV en agosto y se
   * quedaron con solo internet:
   * - 56993: su factura ya no cobra TV, pero la fila de `SubscriberService` TV
   *   seguía en CORTADO y `necesitaTv` lo leía como corte por plata: cada pago
   *   abría una "Reconexion Television2" (que al cerrarse cobraba la TV otra vez).
   * - 56499: factura con `estadoTv = SUSPENDIDO`, que contaba como "caída": el
   *   pago en línea del 08-09 le encendió el puerto CATV en la OLT.
   * Las filas de servicio se desfasan; la factura es lo que se le cobra.
   */
  private tvDadaDeBaja(sub: SubParaReconectar) {
    return sub.contrato?.tv === false || this.tvDeFactura(sub).dadaDeBaja;
  }

  /**
   * ¿Tiene internet al que volver? Un usuario PPPoE de verdad (no el "0" de relleno
   * del legacy) y el internet cobrado en sus mensualidades.
   *
   * Antes bastaba con que `pppUsername` no estuviera vacío, y 2.834 fichas traen "0":
   * los clientes de SoloTelevision que pagaban (4375, 4410, 8013…) salían con una
   * "Reconexion Internet" pendiente para un técnico, por un servicio que no tienen.
   * Lo mismo el que tiene un usuario viejo en la ficha pero ya sólo paga TV (8173).
   */
  private tieneInternet(sub: SubParaReconectar) {
    return esUsuarioPppUtil(sub.pppUsername) && sub.contrato?.internet !== false;
  }

  /** Carga a los abonados con lo que tienen contratado (una consulta para todos). */
  private async cargar(ids: string[]): Promise<SubParaReconectar[]> {
    const subs = (await this.prisma.subscriber.findMany({
      where: { id: { in: ids } }, select: SELECT_RECONEXION,
    })) as SubParaReconectar[];
    const contratos = await serviciosContratados(this.prisma, subs.map((x) => x.id)).catch((e: Error) => {
      this.logger.warn(`No se pudo leer qué tiene contratado cada abonado: ${e.message}`);
      return new Map<string, ServiciosContratados>();
    });
    for (const x of subs) x.contrato = contratos.get(x.id);
    return subs;
  }

  /** ¿Tiene televisión contratada? (por fila de servicio o, si no la hay, por su factura). */
  private tieneTv(sub: SubParaReconectar) {
    if (this.tvDadaDeBaja(sub)) return false;
    return this.serviciosTv(sub).length > 0 || this.tvDeFactura(sub).contratada;
  }

  /**
   * ¿Hay que devolverle la TV?
   *
   * Sí cuando tiene TV contratada Y (estaba cortado por plata O su servicio de TV
   * está marcado como cortado). Lo segundo cubre al que solo tenía la TV cortada:
   * el corte de TV no cambia el estado del abonado, así que sin esa marca un
   * cliente ACTIVO con la TV suspendida se quedaría sin señal después de pagar.
   *
   * "Contratada" y "marcada como cortada" se preguntan a las dos fuentes: sus filas
   * de servicio y su última factura (ver `tvDeFactura`).
   */
  private necesitaTv(sub: SubParaReconectar) {
    const tv = this.serviciosTv(sub);
    const factura = this.tvDeFactura(sub);
    if (!tv.length && !factura.contratada) return false;
    if (this.tvDadaDeBaja(sub)) return false;
    // Al dado de baja no se le devuelve la señal aunque su servicio de TV siga
    // marcado como cortado: esa marca es justamente lo que dejó el retiro.
    if (this.sinDerechoAReconexion(sub)) return false;
    // Sólo el CORTE cuenta: una TV SUSPENDIDA la pidió el cliente y pagar no la revive.
    return this.estaCortado(sub) || tv.some((s) => s.status === 'CORTADO') || factura.cortada;
  }

  /**
   * ¿Hay PRUEBA de que su televisión está cortada, o solo la sospecha de que podría?
   *
   * Prueba: su servicio de TV está marcado como cortado, o le abrieron un corte de TV
   * hace poco. Sospecha: el abonado está en un estado de corte y tiene TV contratada
   * —el corte por mora puede haber sido solo del internet, que es lo corriente—.
   *
   * La diferencia decide UNA cosa: si al fallar el equipo se le abre una orden de
   * visita. Con prueba sí; con sospecha no, porque abrir "Reconexion Television" a
   * alguien que nunca perdió la señal es mandar a un técnico a mirar un televisor que
   * funciona. Intentar restaurarla igual no cuesta nada y es idempotente.
   *
   * El `estadoTv` de su factura cuenta como prueba: es la misma marca que la ficha
   * pinta en rojo y la que deja el corte hecho en el legacy, que es por donde se
   * cortan casi todos (ver `tvDeFactura`).
   */
  private async tvCortadaConPrueba(sub: SubParaReconectar): Promise<boolean> {
    if (this.tvDadaDeBaja(sub)) return false;
    if (this.serviciosTv(sub).some((s) => s.status === 'CORTADO')) return true;
    if (this.tvDeFactura(sub).cortada) return true;
    return (await this.cortesSegunOrdenes(sub)).tv;
  }

  /** ¿Hay a qué equipo mandarle la orden? (CPE por PPPoE u ONU en la OLT). */
  private hayEquipoTv(sub: SubParaReconectar) {
    return esUsuarioPppUtil(sub.pppUsername) || sub._count.oltOnus > 0;
  }

  private correspondeTv(sub: SubParaReconectar) {
    // Sin equipo identificable no se intenta nada por red: ese cliente necesita una
    // visita, y eso se resuelve con una orden de servicio (ver `porPago`), no
    // inventando un intento contra un equipo que no existe.
    return this.necesitaTv(sub) && this.hayEquipoTv(sub);
  }

  /** ¿Hay que devolverle el internet? Solo si lo tiene (ver `tieneInternet`) y venía cortado. */
  private correspondeInternet(sub: SubParaReconectar) {
    return this.tieneInternet(sub) && this.estaCortado(sub);
  }

  // ------------------------------------------------------------------
  // Cortado de verdad, aunque la ficha diga que no
  // ------------------------------------------------------------------

  /**
   * El estado del abonado NO es prueba de que tenga servicio.
   *
   * El corte masivo por mora lo sigue haciendo el legacy, y allá `customers.usu_estado`
   * se queda en "Activo": lo único que deja es una orden "Corte Internet · Por mora."
   * y el cliente metido en la lista MOROSOS del router. Ese desfase no es una rareza —
   * de los 1.420 abonados que los routers tienen cortados hoy, **221 figuran ACTIVO
   * aquí**—, y hacía que al pagar el sistema concluyera "no estaba cortado: nada que
   * reconectar", sin reconectar ni abrir orden. El cliente pagaba y seguía sin internet.
   *
   * Así que se pregunta por otras dos vías, en este orden de autoridad:
   *
   *  1. **El router** (solo internet, solo en el pago individual): si el abonado está
   *     en MOROSOS o su secret está deshabilitado, está cortado y punto — es la única
   *     fuente que no puede mentir. Si el router no contesta o los gates están en
   *     dry-run, no dice nada y se pasa a la siguiente.
   *  2. **Las órdenes de servicio**: si su último movimiento registrado es un corte y
   *     no hay reconexión posterior, se le trata como cortado. Es barato (una consulta)
   *     y es lo que se usa en el cargue de pagos, donde preguntar router por router a
   *     cientos de abonados no sale a cuenta.
   *
   * Una SUSPENSIÓN no cuenta: esa la pide el cliente y no se levanta con un abono
   * (mismo criterio que `ESTADOS_RECONECTABLES`, que deja fuera SUSPENDIDO).
   */
  private async cortadoAunqueDigaActivo(
    sub: SubParaReconectar,
    opts: { router: boolean },
  ): Promise<{ internet: boolean; tv: boolean; motivo: string | null }> {
    const nada = { internet: false, tv: false, motivo: null };
    // Ni el router ni el rastro de órdenes son prueba de "cortado por plata" cuando el
    // cliente ya no es cliente: al retirado se le deja el secret deshabilitado y su
    // orden de corte abierta, y eso es lo que se estaba leyendo como corte por mora.
    if (this.sinDerechoAReconexion(sub)) return nada;
    try {
      // 1. El router, que es la verdad de campo.
      if (opts.router && this.tieneInternet(sub)) {
        const r = await this.mikrotik.liveStatus(sub.id).catch(() => null);
        const live = r?.live as { inMorosos?: boolean; secretDisabled?: boolean } | undefined;
        if (live && (live.inMorosos || live.secretDisabled)) {
          // Solo internet: que el router lo tenga cortado no dice NADA de su TV, que
          // vive en otro equipo. Mezclarlo fue lo que abrió una orden de TV a un
          // cliente al que solo le habían cortado el internet.
          return {
            internet: true,
            tv: (await this.cortesSegunOrdenes(sub)).tv,
            motivo: live.inMorosos ? 'el router lo tiene en MOROSOS' : 'su secret está deshabilitado en el router',
          };
        }
        // El router contestó y lo tiene bien: no hay corte de internet que levantar,
        // por mucho que quede una orden vieja sin cerrar.
        if (live && Object.keys(live).length) {
          return { internet: false, tv: (await this.cortesSegunOrdenes(sub)).tv, motivo: null };
        }
      }

      // 2. El rastro de órdenes.
      const porOrdenes = await this.cortesSegunOrdenes(sub);
      if (!porOrdenes.internet && !porOrdenes.tv) return nada;
      return { ...porOrdenes, motivo: 'su última orden de servicio es un corte sin reconexión posterior' };
    } catch (e) {
      this.logger.warn(`No se pudo comprobar si el abonado ${sub.abonado} sigue cortado: ${(e as Error).message}`);
      return nada;
    }
  }

  /**
   * Lee las últimas órdenes de corte/reconexión del abonado y decide qué servicio
   * quedó cortado. "Combo" cuenta para los dos.
   *
   * Solo se miran las de los últimos `DIAS_SENAL_CORTE` días, y no es un detalle:
   * al abonado 1338 se le abrió una orden de reconexión de TV por un "Corte
   * Television" de **octubre de 2024** —su reconexión posterior estaba ANULADA, así
   * que el rastro decía que seguía cortado 23 meses después— cuando su televisión
   * llevaba dos años funcionando. Un corte viejo no dice nada del servicio de hoy:
   * o se reconectó sin dejar orden, o el cliente ya no lo tiene.
   */
  private async cortesSegunOrdenes(sub: SubParaReconectar): Promise<{ internet: boolean; tv: boolean }> {
    const desde = new Date(Date.now() - DIAS_SENAL_CORTE * 24 * 60 * 60 * 1000);
    const ordenes = await this.prisma.ticket.findMany({
      where: {
        subscriberId: sub.id,
        status: { not: 'ANULADA' },
        created: { gte: desde },
        OR: [{ type: { startsWith: 'Corte' } }, { type: { startsWith: 'Reconexion' } }, { type: { startsWith: 'Suspension' } }],
      },
      orderBy: [{ created: 'desc' }, { createdAt: 'desc' }],
      take: 20,
      select: { type: true },
    });
    // La primera orden que hable de cada servicio manda: si es un corte, está cortado;
    // si es una reconexión (o una suspensión, que no se levanta pagando), no.
    const ultimo = (servicio: RegExp) => ordenes.find((o) => servicio.test(o.type || ''))?.type ?? '';
    const esCorte = (t: string) => /^corte/i.test(t);
    return {
      internet: esCorte(ultimo(/internet|combo/i)),
      tv: esCorte(ultimo(/television|combo/i)),
    };
  }

  // ------------------------------------------------------------------
  // Lo que no se pudo hacer por red → orden de servicio
  // ------------------------------------------------------------------

  /**
   * Deja pendiente en una orden de servicio lo que no se pudo restablecer.
   *
   * Es la salida honesta al caso más común de la TV: la cobertura TR-069 es
   * minoritaria y la vía OLT necesita la ONU vinculada, así que muchísimos clientes
   * que pagan no se pueden reconectar desde aquí. Antes eso terminaba en un aviso
   * rojo en la pantalla de quien cobró; ahora termina en trabajo que existe, se
   * agenda y se cierra.
   *
   * Devuelve `null` si el servicio se montó sin el abridor de órdenes (o si no se
   * pudo abrir): quien llama sigue viendo el fallo, que es lo que había antes.
   */
  private async ordenPendiente(
    sub: { id: string; abonado: number },
    servicio: 'INTERNET' | 'TV',
    detalle: string,
    ctx?: string,
  ): Promise<(OrdenAbierta & { servicio: 'INTERNET' | 'TV' }) | null> {
    if (!this.ordenes) return null;
    // Aquí NO se cobra: el servicio todavía no existe, va a ir un técnico. Lo único
    // que se decide es el nombre, y con el "2" puesto la cascada de cierre sabrá
    // que al resolverla hay que cobrar los días que queden ESE día.
    const arrastra = (await this.prorrateo?.arrastraMes(sub.id, [servicio])) ?? false;
    const orden = await this.ordenes.abrirSiNoHay({
      subscriberId: sub.id,
      type: tipoOrden(servicio, arrastra),
      tiposEquivalentes: [tipoHermano(servicio, arrastra)],
      subject: 'servicio',
      // Prioridad alta y no media: es un cliente que YA pagó y sigue sin servicio.
      priority: 'Alta',
      problem: `El cliente pagó y no se pudo restablecer ${NOMBRE_SERVICIO[servicio]} por red.`,
      section: [detalle, ctx ? `Origen: ${ctx}.` : null].filter(Boolean).join(' '),
      autor: 'Sistema',
    });
    if (!orden) return null;
    this.logger.log(
      `Abonado ${sub.abonado}: ${NOMBRE_SERVICIO[servicio]} queda pendiente en la orden #${orden.code}` +
      `${orden.nueva ? '' : ' (ya estaba abierta)'}.`,
    );
    return { ...orden, servicio };
  }

  /**
   * Lo mismo que `cortesSegunOrdenes` pero para muchos abonados de una vez: una sola
   * consulta y el reparto en memoria. En el cargue de pagos no se pregunta al router
   * —serían cientos de sesiones—, así que ésta es toda la red de seguridad que hay
   * para los cortes que el legacy no dejó escritos en el estado.
   */
  private async cortesSegunOrdenesLote(subs: SubParaReconectar[]): Promise<Map<string, { internet: boolean; tv: boolean }>> {
    const salida = new Map<string, { internet: boolean; tv: boolean }>();
    if (!subs.length) return salida;
    const ordenes = await this.prisma.ticket.findMany({
      where: {
        subscriberId: { in: subs.map((s) => s.id) },
        status: { not: 'ANULADA' },
        OR: [{ type: { startsWith: 'Corte' } }, { type: { startsWith: 'Reconexion' } }, { type: { startsWith: 'Suspension' } }],
      },
      orderBy: [{ created: 'desc' }, { createdAt: 'desc' }],
      select: { subscriberId: true, type: true },
    });
    const esCorte = (t: string) => /^corte/i.test(t);
    const visto = new Map<string, { internet?: string; tv?: string }>();
    for (const o of ordenes) {
      if (!o.subscriberId) continue;
      const v = visto.get(o.subscriberId) ?? {};
      // Las órdenes llegan de la más nueva a la más vieja: la primera que habla de
      // cada servicio es la que manda, y las siguientes ya no cuentan.
      if (v.internet === undefined && /internet|combo/i.test(o.type || '')) v.internet = o.type || '';
      if (v.tv === undefined && /television|combo/i.test(o.type || '')) v.tv = o.type || '';
      visto.set(o.subscriberId, v);
    }
    for (const [id, v] of visto) {
      salida.set(id, { internet: esCorte(v.internet ?? ''), tv: esCorte(v.tv ?? '') });
    }
    return salida;
  }

  /**
   * Deja la orden de "Reconexion …" ya cerrada del servicio que volvió.
   *
   * Si el cliente tenía una orden abierta de eso mismo (de un intento anterior que
   * falló), se cierra ESA en vez de crear otra: el ciclo se cierra solo y nadie sale
   * a una visita que ya no hace falta.
   */
  private async registrarReconexion(
    sub: { id: string; abonado: number },
    servicio: 'INTERNET' | 'TV',
    detalle: string,
    user?: AuthUser,
    ctx?: string,
    arrastra = false,
  ): Promise<(OrdenAbierta & { servicio: 'INTERNET' | 'TV' }) | null> {
    if (!this.ordenes) return null;
    const orden = await this.ordenes.registrarResuelta({
      subscriberId: sub.id,
      type: tipoOrden(servicio, arrastra),
      tiposEquivalentes: [tipoHermano(servicio, arrastra)],
      subject: 'servicio',
      problem: `Reconexión automática al registrarse el pago: volvió ${NOMBRE_SERVICIO[servicio]}.`,
      section: [detalle, ctx ? `Origen: ${ctx}.` : null].filter(Boolean).join(' '),
      // Quien recaudó queda como autor de la orden, igual que en el legacy: la
      // reconexión la disparó su cobro, aunque la ejecutara el sistema.
      autor: user?.name || user?.email || 'Sistema',
    });
    return orden ? { ...orden, servicio } : null;
  }

  // ------------------------------------------------------------------
  // Pago individual (caja)
  // ------------------------------------------------------------------

  /**
   * Reconecta lo que corresponda tras un pago. NUNCA lanza: un fallo de red no
   * puede tumbar el recaudo, que ya está contabilizado. Lo que sí hace es dejar
   * el fallo bien visible (log a nivel error + el detalle en la respuesta) para
   * que quien recibió la plata sepa en el acto que el cliente sigue cortado.
   *
   * El tope de espera cubre TODO el trabajo, también la comprobación previa contra el
   * router (`cortadoAunqueDigaActivo`), que se hace en cada pago aunque el cliente
   * esté al día y tarda 1-3 s. Antes esa parte iba por fuera del tope y el recibo de
   * caja, que se pide cuando esto responde, se hacía esperar (reporte 2026-09-17).
   *
   * @param ctx  texto corto para la traza (p. ej. el recibo de caja).
   * @param opts.esperaMs  cuánto espera quien llama (por defecto `ESPERA_MAX_MS`).
   */
  async porPago(
    subscriberId: string, user?: AuthUser, ctx?: string, opts: { esperaMs?: number } = {},
  ): Promise<ResultadoReconexion> {
    const terminado = await this.conEspera(this.reconectarPorPago(subscriberId, user, ctx), opts.esperaMs ?? ESPERA_MAX_MS);
    if (terminado.listo) return terminado.valor;
    this.logger.warn(
      `Reconexión por pago del abonado ${subscriberId}${ctx ? ` (${ctx})` : ''}: los equipos se están demorando; sigue en segundo plano.`,
    );
    return {
      subscriberId, aplica: true, ok: true, enCurso: true, dryRun: false,
      servicios: [], ordenes: [], registros: [],
      mensaje: 'La reconexión está en curso en los equipos; puede tardar un momento en verse. Si algún equipo no responde, quedará una orden de servicio.',
    };
  }

  /** El cuerpo de `porPago`, sin tope de espera. */
  private async reconectarPorPago(subscriberId: string, user?: AuthUser, ctx?: string): Promise<ResultadoReconexion> {
    const base: ResultadoReconexion = {
      subscriberId, aplica: false, ok: true, enCurso: false, dryRun: false,
      servicios: [], ordenes: [], registros: [], mensaje: 'El cliente no estaba cortado: no había nada que reconectar.',
    };
    try {
      // Pagó antes de que fueran a cortarle la TV: se anula ese corte (ver el método).
      await this.anularCortesTvSinHacer([subscriberId], user);
      const [sub] = await this.cargar([subscriberId]);
      if (!sub) return base;

      let haceInternet = this.correspondeInternet(sub);
      let necesitaTv = this.necesitaTv(sub);

      // La ficha no dice que esté cortado, pero puede estarlo igual: el corte por mora
      // lo hace el legacy y allá el estado no cambia. Se comprueba contra el router y
      // contra el rastro de órdenes antes de dar el pago por "nada que hacer".
      if (!haceInternet || !necesitaTv) {
        const real = await this.cortadoAunqueDigaActivo(sub, { router: !haceInternet && this.tieneInternet(sub) });
        if (real.internet && !haceInternet && this.tieneInternet(sub)) {
          haceInternet = true;
          this.logger.warn(
            `Abonado ${sub.abonado}: la ficha dice ${sub.status} pero está cortado (${real.motivo}). ` +
            'Se reconecta igual — el desfase viene del corte del legacy, que no toca el estado.',
          );
        }
        if (real.tv && !necesitaTv && !this.tvDadaDeBaja(sub)) necesitaTv = true;
      }

      const haceTv = necesitaTv && this.hayEquipoTv(sub);
      // Solo se abre orden por la TV si se puede demostrar que estaba caída.
      const pruebaTv = necesitaTv ? await this.tvCortadaConPrueba(sub) : false;

      // Tiene TV que devolver pero no hay equipo al que mandarle nada: no se
      // intenta por red, se deja el trabajo abierto para que un técnico lo haga.
      if (!haceTv && necesitaTv && pruebaTv) {
        const orden = await this.ordenPendiente(sub, 'TV', 'No hay equipo identificado para restablecer la TV (ni CPE en el ACS ni ONU vinculada en la OLT).', ctx);
        return {
          ...base, aplica: true, ok: true,
          servicios: [{
            servicio: 'TV', ok: false, dryRun: false, via: null,
            detalle: 'Sin equipo identificado: hay que restablecer la TV en sitio.', orden,
          }],
          ordenes: orden ? [orden] : [], registros: [],
          mensaje: orden
            ? `La TV no se puede restablecer por red: quedó pendiente en la orden #${orden.code}.`
            : 'La TV no se puede restablecer por red y no se pudo abrir la orden: avisa a soporte.',
        };
      }

      if (!haceInternet && !haceTv) return base;

      // Los dos equipos en paralelo: son independientes y el cliente espera por
      // el más lento, no por la suma.
      return await this.ejecutar(sub, haceInternet, haceTv, user, ctx, { ordenSiFallaTv: pruebaTv });
    } catch (e) {
      // Cinturón: aquí no debería llegar nada, pero un recaudo jamás se cae por esto.
      this.logger.error(
        `Reconexión por pago del abonado ${subscriberId}${ctx ? ` (${ctx})` : ''}: ${(e as Error).message}. Puede seguir cortado.`,
      );
      return {
        ...base, aplica: true, ok: false,
        mensaje: `No se pudo reconectar: ${(e as Error).message}. El cliente puede seguir cortado.`,
      };
    }
  }

  /** El trabajo de verdad contra los equipos + el estado en base de datos. */
  private async ejecutar(
    sub: SubParaReconectar, haceInternet: boolean, haceTv: boolean, user?: AuthUser, ctx?: string,
    opts: { ordenSiFallaTv?: boolean } = {},
  ): Promise<ResultadoReconexion> {
    const estadoAntes = sub.status;
    const [internet, tv] = await Promise.all([
      haceInternet ? this.reconectarInternet(sub, user) : Promise.resolve(null),
      haceTv ? this.reconectarTv(sub, user) : Promise.resolve(null),
    ]);

    const servicios = [internet, tv].filter((s): s is ServicioReconectado => !!s);
    // Lo que el equipo encontró ya al aire no es una reconexión: ni orden ni cobro.
    if (servicios.length && servicios.every((s) => s.sinCorte)) {
      return {
        subscriberId: sub.id, aplica: false, ok: true, enCurso: false, dryRun: false,
        servicios, ordenes: [], registros: [],
        mensaje: 'El cliente no estaba cortado: no había nada que reconectar.',
      };
    }
    const ok = servicios.every((s) => s.ok);
    const dryRun = servicios.some((s) => s.dryRun);

    // Lo que el equipo no aceptó no se queda en un aviso: se convierte en una orden
    // de servicio PENDIENTE, que es trabajo que alguien va a ver y agendar. Es el
    // caso corriente de la TV — la cobertura TR-069 es minoritaria y el cliente que
    // paga necesita una visita, no un mensaje rojo en la pantalla de la cajera.
    //
    // En dry-run NO se abre nada: ahí no se tocó ningún equipo a propósito (los
    // gates LIVE están apagados) y llenar la bandeja de soporte con órdenes de una
    // simulación sería peor que el problema.
    const ordenes: Array<OrdenAbierta & { servicio: 'INTERNET' | 'TV' }> = [];
    for (const s of servicios) {
      if (s.ok || s.dryRun) continue;
      // La TV solo genera visita si se pudo probar que estaba cortada (ver
      // `tvCortadaConPrueba`): al abonado que solo perdió el internet no se le manda
      // un técnico a revisar un televisor que nunca dejó de funcionar.
      if (s.servicio === 'TV' && opts.ordenSiFallaTv === false) {
        this.logger.log(
          `Abonado ${sub.abonado}: la TV no respondió (${s.detalle}), pero nada indica que estuviera cortada: no se abre orden.`,
        );
        continue;
      }
      const orden = await this.ordenPendiente(sub, s.servicio, s.detalle, ctx);
      s.orden = orden;
      if (orden) ordenes.push(orden);
    }

    // El estado solo se levanta si algo se aplicó DE VERDAD. En dry-run no se
    // tocó ningún equipo: dejar al cliente en ACTIVO ahí sería mentir en la ficha
    // —seguiría en MOROSOS y sin señal— y taparía que los gates están apagados.
    if (servicios.some((s) => s.ok && !s.dryRun && !s.sinCorte)) await this.marcarActivo(sub, estadoAntes);

    // Los días que quedan del mes, si el servicio venía cortado desde antes de la
    // corrida de facturación. Va DESPUÉS de los equipos y sólo por lo que volvió de
    // verdad: cobrarle a alguien que se quedó sin señal sería peor que no cobrarle.
    // Una sola llamada para los dos servicios, para que un combo salga en una
    // factura y no en dos. Nunca lanza (ver `aplicar`).
    // `porPago: true` es lo que le dice al prorrateo de dónde viene: si lo único que
    // el cliente pagó hoy fue un cargo puntual —el traslado son 30.000 y ya— no se le
    // cobran los días (ver `pagoDeHoyFueSoloUnCargo`).
    const devueltos = [...new Set(servicios.filter((s) => s.ok && !s.dryRun && !s.sinCorte).map((s) => s.servicio))];
    const cobro = devueltos.length && this.prorrateo
      ? await this.prorrateo.aplicar(sub.id, devueltos, { ctx, autor: user?.name || user?.email || 'Sistema', porPago: true })
      : null;

    const detalle = servicios.map((s) => `${s.servicio.toLowerCase()}=${s.ok ? 'ok' : 'FALLÓ'}`).join(' ');
    const linea = `Reconexión por pago del abonado ${sub.abonado}${ctx ? ` (${ctx})` : ''}: ${detalle}${dryRun ? ' [dry-run]' : ''}`;
    if (ok) this.logger.log(linea);
    else {
      this.logger.error(
        `${linea}. Detalle: ${servicios.filter((s) => !s.ok).map((s) => s.detalle).join(' | ')}. ` +
        'Reintentar desde Red (queda auditado en MikrotikActionLog / GenieacsLog / OltActionLog).',
      );
    }

    // Constancia de lo que SÍ volvió. El legacy lo hacía a mano —la cajera abría y
    // cerraba la "Reconexion Internet" del cliente que acababa de pagar— y sin eso el
    // trabajo no existe en ninguna parte: ni en la ficha, ni en los informes, ni para
    // la señal que pregunta "¿este cliente sigue cortado?".
    const registros: Array<OrdenAbierta & { servicio: 'INTERNET' | 'TV' }> = [];
    for (const s of servicios) {
      if (!s.ok || s.dryRun || s.sinCorte) continue;
      const r = await this.registrarReconexion(sub, s.servicio, s.detalle, user, ctx, cobroTocaA(cobro, s.servicio));
      if (r) registros.push(r);
    }

    const pendientes = ordenes.map((o) => `${NOMBRE_SERVICIO[o.servicio]} → orden #${o.code}`).join(', ');
    // El cobro se le dice a quien recaudó, no se le esconde: el cliente que acaba de
    // pagar tiene delante a la cajera y va a preguntar por ese renglón nuevo.
    const conCobro = (m: string) => (cobro?.aplica ? `${m} ${cobro.mensaje}` : m);
    return {
      subscriberId: sub.id, aplica: true, ok, enCurso: false, dryRun, servicios, ordenes, registros, cobro,
      mensaje: ok
        ? (dryRun
          ? `Reconexión simulada (${detalle}): los interruptores LIVE están apagados, no se tocaron los equipos.`
          : conCobro(`Servicio reconectado (${detalle}).`))
        : pendientes
          ? conCobro(`El pago quedó registrado y lo que no se pudo restablecer por red queda pendiente de visita (${pendientes}).`)
          : `La reconexión falló (${detalle}). El cliente PAGÓ pero puede seguir cortado.`,
    };
  }

  private async reconectarInternet(sub: SubParaReconectar, user?: AuthUser): Promise<ServicioReconectado> {
    try {
      const r = await this.mikrotik.reconnect(sub.id, user);
      // El router es la verdad: si no hubo que sacarlo de MOROSOS ni habilitarle el
      // secret, el cliente no estaba cortado. Pasaba con los COMPROMISO (349, 2543,
      // 54205 el 12-09) y con fichas en CORTADO que el router tenía al aire: se les
      // dejaba una "Reconexion Internet" y hasta el prorrateo "…2" sin haber corte.
      if (r.ok && !r.dryRun && r.wasCut === false) {
        return {
          servicio: 'INTERNET', ok: true, dryRun: false, via: 'MIKROTIK', sinCorte: true,
          detalle: 'El router ya lo tenía al aire: no estaba cortado.',
        };
      }
      if (r.ok && !r.dryRun) {
        await this.marcarServicios(sub, ['INTERNET'], 'ACTIVO');
        await this.levantarCorteDeFactura([sub.id], ['INTERNET']);
        this.avisarReconexion([sub.id], ['INTERNET']);
      }
      return {
        servicio: 'INTERNET', ok: !!r.ok, dryRun: !!r.dryRun, via: 'MIKROTIK',
        detalle: r.message || r.error || '',
      };
    } catch (e) {
      return { servicio: 'INTERNET', ok: false, dryRun: false, via: 'MIKROTIK', detalle: (e as Error).message };
    }
  }

  private async reconectarTv(sub: SubParaReconectar, user?: AuthUser): Promise<ServicioReconectado> {
    try {
      const r = await this.genieacs.tvBatchBySubscribers([sub.id], true, user);
      const fila = r.results.find((x) => x.subscriberId === sub.id);
      const ok = !!fila?.ok;
      if (ok && !fila?.dryRun) {
        await this.marcarServicios(sub, ['TV', 'PUNTOS'], 'ACTIVO');
        await this.levantarCorteDeFactura([sub.id], ['TV']);
        this.avisarReconexion([sub.id], ['TV']);
      }
      return {
        servicio: 'TV', ok, dryRun: !!r.dryRun,
        via: (fila?.via as ServicioReconectado['via']) ?? null,
        detalle: fila?.detail ?? 'No se pudo resolver el equipo de TV del cliente.',
      };
    } catch (e) {
      return { servicio: 'TV', ok: false, dryRun: false, via: null, detalle: (e as Error).message };
    }
  }

  // ------------------------------------------------------------------
  // Cargue de pagos (lote)
  // ------------------------------------------------------------------

  /**
   * Igual que `porPago` pero para muchos abonados de una vez: lo usa el cargue de
   * pagos (Efecty / banco / corresponsal), donde reconectar uno por uno abriría
   * una sesión por cliente. Aquí sí se agrupa: el corte/reconexión de Mikrotik va
   * por router (una conexión por router) y la TV en un solo barrido del ACS.
   *
   * Sin tope de espera: es un proceso de lote, no alguien mirando la pantalla.
   */
  /**
   * De un grupo de abonados, a quién le toca qué. SOLO MIRA: no abre una conexión ni
   * escribe nada.
   *
   * Estaba dentro de `porPagoLote`. Se saca aparte porque hay un segundo camino que
   * necesita la MISMA respuesta sin ejecutarla: el puente con el portal de pagos, que
   * enseña en seco a quién reconectaría antes de que alguien lo autorice. Copiar el
   * criterio allí habría creado una segunda verdad sobre "quién está cortado", que es
   * justo lo que este servicio existe para evitar.
   */
  private async repartirLote(todos: SubParaReconectar[]) {
    // Los que ya no tienen a qué volver salen antes de mirar nada: en el lote la
    // prueba del corte es el rastro de órdenes, y un retiro deja el mismo rastro que
    // un corte por mora (ver `ESTADOS_SIN_RECONEXION`).
    const subs = todos.filter((s) => !this.sinDerechoAReconexion(s));
    // Cortes que el estado no refleja (los del legacy): aquí solo por el rastro de
    // órdenes — preguntarle al router por cada fila del archivo no sale a cuenta.
    const porOrdenes = await this.cortesSegunOrdenesLote(subs);
    const cortadoInternet = (s: SubParaReconectar) =>
      this.correspondeInternet(s) || (this.tieneInternet(s) && !!porOrdenes.get(s.id)?.internet);
    // "Tiene TV" se pregunta a las dos fuentes (fila de servicio y última factura):
    // sin lo segundo, los 2.350 clientes sin fila de servicio nunca entran aquí.
    const necesitaTvReal = (s: SubParaReconectar) =>
      this.necesitaTv(s) || (this.tieneTv(s) && !!porOrdenes.get(s.id)?.tv);

    // Misma regla que en el pago individual: la TV solo genera VISITA si se puede
    // probar que estaba cortada (marcada como tal —en su servicio o en su factura—
    // o con un corte reciente). El estado del abonado por sí solo es sospecha, no
    // prueba.
    const pruebaTv = (s: SubParaReconectar) =>
      !this.tvDadaDeBaja(s) && (this.serviciosTv(s).some((x) => x.status === 'CORTADO')
      || this.tvDeFactura(s).cortada
      || !!porOrdenes.get(s.id)?.tv);

    return {
      /** Los que traen PRUEBA de que la TV estaba caída: solo por ellos se abre visita. */
      conPruebaTv: new Set(subs.filter(pruebaTv).map((x) => x.id)),
      conInternet: subs.filter(cortadoInternet),
      conTv: subs.filter((s) => necesitaTvReal(s) && this.hayEquipoTv(s)),
      // Los que necesitan TV pero no tienen equipo al que mandarle nada van derecho a
      // orden de servicio: no hay intento por red que hacer.
      tvSinEquipo: subs.filter((s) => necesitaTvReal(s) && !this.hayEquipoTv(s) && pruebaTv(s)),
    };
  }

  /**
   * ¿A quién de estos le falta servicio? Consulta pura, sin tocar equipos.
   *
   * Responde con el mismo criterio con el que `porPagoLote` decide a quién atender, de
   * modo que lo que se enseñe en una simulación sea exactamente lo que pasará al
   * aplicarla. Lo usa el puente con el portal de pagos en línea.
   */
  async aQuienLeToca(subscriberIds: string[]): Promise<{
    internet: string[]; tv: string[]; tvSinEquipo: string[]; todos: string[];
  }> {
    const ids = [...new Set((subscriberIds || []).filter(Boolean))];
    const vacío = { internet: [], tv: [], tvSinEquipo: [], todos: [] };
    if (!ids.length) return vacío;
    const subs = await this.cargar(ids);
    const { conInternet, conTv, tvSinEquipo } = await this.repartirLote(subs);
    const internet = conInternet.map((s) => s.id);
    const tv = conTv.map((s) => s.id);
    const sinEquipo = tvSinEquipo.map((s) => s.id);
    return { internet, tv, tvSinEquipo: sinEquipo, todos: [...new Set([...internet, ...tv, ...sinEquipo])] };
  }

  async porPagoLote(subscriberIds: string[], user?: AuthUser) {
    const ids = [...new Set((subscriberIds || []).filter(Boolean))];
    const vacío = { total: 0, internet: 0, tv: 0, fallidos: 0, ordenes: 0, registros: 0, cobros: 0, cobrado: 0, dryRun: false };
    if (!ids.length) return vacío;

    // Antes de leer a nadie: a quien pagó con el corte de TV todavía sin hacer se le
    // anula esa orden y la TV queda activa, así ya no entra como "TV cortada".
    await this.anularCortesTvSinHacer(ids, user);

    const subs = await this.cargar(ids);

    const { conInternet, conTv, tvSinEquipo, conPruebaTv } = await this.repartirLote(subs);
    if (!conInternet.length && !conTv.length && !tvSinEquipo.length) return vacío;

    const estadosAntes = new Map(subs.map((s) => [s.id, s.status]));
    let internet = 0, tv = 0, fallidos = 0, dryRun = false;
    const reconectados = new Set<string>();
    // Lo que quede sin restablecer se apunta aquí y sale como orden al final: dentro
    // del bucle de equipos abriríamos una transacción por fila.
    const pendientes: Array<{ sub: SubParaReconectar; servicio: 'INTERNET' | 'TV'; detalle: string }> = [];
    /** Lo que SÍ se reconectó: cada uno deja su orden de constancia, ya cerrada. */
    const hechos: Array<{ sub: SubParaReconectar; servicio: 'INTERNET' | 'TV'; detalle: string }> = [];
    const porId = new Map(subs.map((s) => [s.id, s]));
    for (const sub of tvSinEquipo) {
      pendientes.push({
        sub, servicio: 'TV',
        detalle: 'Sin equipo identificado: ni CPE en el ACS (usuario PPPoE) ni ONU vinculada en la OLT.',
      });
    }

    if (conInternet.length) {
      try {
        const r = await this.mikrotik.reconnectBatch(conInternet.map((s) => s.id), user);
        for (const fila of r.results) {
          // El router lo encontró ya al aire: no estaba cortado, no cuenta ni deja orden.
          if (fila.ok && !fila.dryRun && fila.wasCut === false) continue;
          if (fila.ok) {
            internet++;
            if (!fila.dryRun && fila.subscriberId) {
              reconectados.add(fila.subscriberId);
              const sub = porId.get(fila.subscriberId);
              if (sub) hechos.push({ sub, servicio: 'INTERNET', detalle: (fila as any).message || 'Reconexión aplicada en el router.' });
            }
          }
          else {
            fallidos++;
            const sub = fila.subscriberId ? porId.get(fila.subscriberId) : undefined;
            if (sub && !fila.dryRun) {
              pendientes.push({ sub, servicio: 'INTERNET', detalle: (fila as any).message || (fila as any).error || 'El router no aplicó la reconexión.' });
            }
          }
          if (fila.dryRun) dryRun = true;
        }
        // Igual que en el pago individual: en dry-run no se tocó el router, así que
        // tampoco se toca el estado en base de datos.
        const okIds = new Set(r.results.filter((x) => x.ok && !x.dryRun && x.wasCut !== false).map((x) => x.subscriberId));
        const reconectadosInternet = conInternet.filter((s) => okIds.has(s.id));
        await this.marcarServiciosDe(reconectadosInternet, ['INTERNET'], 'ACTIVO');
        await this.levantarCorteDeFactura(reconectadosInternet.map((s) => s.id), ['INTERNET']);
        this.avisarReconexion(reconectadosInternet.map((s) => s.id), ['INTERNET']);
      } catch (e) {
        fallidos += conInternet.length;
        this.logger.error(`Reconexión de internet en lote: ${(e as Error).message}`);
      }
    }

    if (conTv.length) {
      try {
        const r = await this.genieacs.tvBatchBySubscribers(conTv.map((s) => s.id), true, user);
        if (r.dryRun) dryRun = true;
        for (const fila of r.results) {
          if (fila.ok) {
            tv++;
            if (!fila.dryRun) {
              reconectados.add(fila.subscriberId);
              const sub = porId.get(fila.subscriberId);
              if (sub) hechos.push({ sub, servicio: 'TV', detalle: fila.detail || 'TV restaurada.' });
            }
          }
          else {
            fallidos++;
            const sub = porId.get(fila.subscriberId);
            if (sub && !r.dryRun && conPruebaTv.has(sub.id)) {
              pendientes.push({ sub, servicio: 'TV', detalle: fila.detail || 'El equipo no aplicó la reconexión de TV.' });
            }
          }
        }
        const okIds = new Set(r.results.filter((x) => x.ok && !x.dryRun).map((x) => x.subscriberId));
        const reconectadosTv = conTv.filter((s) => okIds.has(s.id));
        await this.marcarServiciosDe(reconectadosTv, ['TV', 'PUNTOS'], 'ACTIVO');
        await this.levantarCorteDeFactura(reconectadosTv.map((s) => s.id), ['TV']);
        this.avisarReconexion(reconectadosTv.map((s) => s.id), ['TV']);
      } catch (e) {
        fallidos += conTv.length;
        this.logger.error(`Reconexión de TV en lote: ${(e as Error).message}`);
      }
    }

    for (const sub of subs) {
      if (reconectados.has(sub.id)) await this.marcarActivo(sub, estadosAntes.get(sub.id) ?? null);
    }

    // Órdenes por lo que quedó sin restablecer. En serie a propósito: son escrituras
    // cortas y este proceso ya no tiene a nadie esperando delante de la pantalla.
    let ordenes = 0;
    for (const p of pendientes) {
      const orden = await this.ordenPendiente(p.sub, p.servicio, p.detalle, 'cargue de pagos');
      if (orden?.nueva) ordenes++;
    }

    // Y la constancia de lo que sí volvió, igual que en el pago de mostrador — con
    // el cobro de los días que quedan del mes por delante, para que la orden ya
    // salga con el nombre que le corresponde ("…2" si arrastraba mes sin facturar).
    //
    // El cobro se hace UNA vez por abonado, no una por servicio: al del combo se le
    // devuelven internet y TV en el mismo acto y eso es una factura, no dos.
    const porAbonado = new Map<string, typeof hechos>();
    for (const h of hechos) {
      const lista = porAbonado.get(h.sub.id) ?? [];
      lista.push(h);
      porAbonado.set(h.sub.id, lista);
    }
    let registros = 0, cobros = 0, cobrado = 0;
    for (const [, lista] of porAbonado) {
      const sub = lista[0].sub;
      const devueltos = [...new Set(lista.map((h) => h.servicio))];
      const cobro = this.prorrateo
        ? await this.prorrateo.aplicar(sub.id, devueltos, { ctx: 'cargue de pagos', autor: user?.name || user?.email || 'Sistema', porPago: true })
        : null;
      if (cobro?.cobrado) { cobros++; cobrado = round2(cobrado + cobro.total); }
      for (const { servicio, detalle } of lista) {
        const r = await this.registrarReconexion(sub, servicio, detalle, user, 'cargue de pagos', cobroTocaA(cobro, servicio));
        if (r) registros++;
      }
    }

    // `total` = a cuántos había que devolverles algo, no cuántos pagaron: el
    // mensaje que ve el operador cuenta clientes atendidos, no filas del archivo.
    const atendidos = new Set([...conInternet, ...conTv, ...tvSinEquipo].map((s) => s.id)).size;
    this.logger.log(
      `Reconexión por pagos (lote): ${ids.length} pagaron, ${atendidos} estaban cortados → internet=${internet} tv=${tv} fallidos=${fallidos} órdenes=${ordenes} registros=${registros} prorrateos=${cobros} ($${cobrado.toLocaleString('es-CO')})${dryRun ? ' [dry-run]' : ''}`,
    );
    return { total: atendidos, internet, tv, fallidos, ordenes, registros, cobros, cobrado, dryRun };
  }

  // ------------------------------------------------------------------
  // Estado en base de datos
  // ------------------------------------------------------------------

  /**
   * Deja el abonado en ACTIVO y REGISTRA el cambio.
   *
   * El registro no es adorno: los cambios de estado hechos en silencio son los
   * que tienen el historial descuadrado (ver el cron de Cartera), y sin historial
   * no se puede responder cuántos activos había en una fecha.
   */
  private async marcarActivo(sub: { id: string; abonado: number }, estadoAntes: SubscriberStatus | null) {
    if (estadoAntes === 'ACTIVO') return;
    // El acuerdo de pago sobrevive a la reconexión: se le devuelve el servicio, pero
    // sigue siendo un COMPROMISO (ver `estado-al-reconectar.ts`).
    if (conservaEstadoAlReconectar(estadoAntes)) return;
    const ahora = new Date();
    try {
      // `mikrotik.reconnect` ya pudo dejarlo en ACTIVO; este update es idempotente
      // y el historial se escribe una sola vez porque se decide por `estadoAntes`.
      await this.prisma.subscriber.update({
        where: { id: sub.id },
        data: { previousStatus: estadoAntes ?? undefined, status: 'ACTIVO', statusChangedAt: ahora },
      });
      await this.prisma.subscriberStatusHistory.create({
        data: { subscriberId: sub.id, status: 'ACTIVO', date: ahora, note: 'Reconexión automática por pago' },
      });
    } catch (e) {
      this.logger.warn(`No se pudo dejar en ACTIVO al abonado ${sub.abonado}: ${(e as Error).message}`);
    }
  }

  /**
   * Avisa de que el servicio volvió DE VERDAD, para que el legacy se entere en el acto.
   *
   * Nunca lanza ni espera a nadie: esto es un aviso, y un fallo aquí no puede tocar un
   * cobro que ya está hecho.
   */
  private avisarReconexion(subscriberIds: string[], servicios: Array<'INTERNET' | 'TV'>) {
    const ids = [...new Set(subscriberIds.filter(Boolean))];
    if (!ids.length || !this.events) return;
    try {
      this.events.emit(RECONEXION_APLICADA_EVENT, { subscriberIds: ids, servicios } satisfies ReconexionAplicadaEvent);
    } catch (e) {
      this.logger.warn(`No se pudo avisar de la reconexión: ${(e as Error).message}`);
    }
  }

  /**
   * Levanta el corte EN LA FACTURA, que es donde la ficha lo lee.
   *
   * `SubInvoice.estadoCombo` / `estadoTv` son las columnas `estado_combo` /
   * `estado_tv` del legacy, y la convención es la de allá: NULL = el servicio
   * está al aire, con valor = está caído. Es lo que pinta en rojo la ficha del
   * cliente (`SubscribersService.estadoPorServicio`) y el contrato en PDF, y es
   * lo que el corte por mora del legacy escribe. Sin limpiarlas, el abonado que
   * paga vuelve a navegar pero la pantalla lo sigue enseñando cortado — que es
   * justo con lo que llama a reclamar.
   *
   * Se hace lo mismo que hace el legacy cuando cobra su propia cajera
   * (`Transactions.php`, "Reconexion Combo"): estado del servicio a NULL y el
   * `ron` de la factura a Activo. SUSPENDIDO no se toca: esa la pidió el cliente
   * y no se levanta pagando.
   *
   * Sólo RECURRENTES —una FIJA es un cobro puntual y no habla del servicio— y
   * sólo del abonado que se acaba de reconectar de verdad (nunca en dry-run: ahí
   * no se tocó ningún equipo).
   *
   * OJO: esto arregla la mitad de aquí. La otra mitad —que el legacy se entere—
   * la hace `pushReconexiones` en `scripts/writeback-legacy.js`; sin ella la ida
   * del sync devuelve el 'Cortado' en la siguiente pasada (15 min).
   */
  private async levantarCorteDeFactura(subIds: string[], kinds: Array<'INTERNET' | 'TV'>) {
    const ids = [...new Set(subIds.filter(Boolean))];
    if (!ids.length || !kinds.length) return;
    try {
      // SÓLO la factura vigente de cada abonado, que es la que el legacy levanta al
      // cobrar y la única que la ficha mira. Las anteriores que dicen 'Cortado' son el
      // RASTRO de cortes viejos —hay abonados con 22, desde 2021— y reescribirlas
      // sería borrar el historial de la mora de este cliente.
      const vigentes = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT DISTINCT ON (i."subscriberId") i.id
          FROM "SubInvoice" i
         WHERE i."subscriberId" IN (${Prisma.join(ids)})
           AND i.kind = 'RECURRENTE'
         ORDER BY i."subscriberId", i."invoiceDate" DESC NULLS LAST, i.tid DESC`;
      const facturas = vigentes.map((f) => f.id);
      if (!facturas.length) return;

      const data: { estadoCombo?: null; estadoTv?: null; serviceStatusAt?: Date } = {};
      if (kinds.includes('INTERNET')) data.estadoCombo = null;
      if (kinds.includes('TV')) data.estadoTv = null;
      // La marca que hace que esto SOBREVIVA. Sin ella la ida del sync ve que el legacy
      // sigue diciendo 'Cortado' en esas dos columnas y las devuelve en la siguiente
      // pasada —quince minutos—, así que el corte que se acaba de levantar reaparece.
      // Es además de donde `pushEstadoServicio` saca a quién empujar allá (levantar va
      // por el gate de RECONEXIÓN) y se borra sola en cuanto los dos lados coinciden.
      data.serviceStatusAt = new Date();
      const r = await this.prisma.subInvoice.updateMany({
        where: {
          id: { in: facturas },
          OR: [
            ...(kinds.includes('INTERNET') ? [{ estadoCombo: 'CORTADO' as const }] : []),
            ...(kinds.includes('TV') ? [{ estadoTv: 'CORTADO' as const }] : []),
          ],
        },
        data,
      });
      if (!r.count) return;
      // El `ron` es el eje de servicio de la factura y el legacy lo deja en Activo en el
      // mismo acto — pero sólo si en esa factura ya no queda ningún corte en pie (al que
      // se le devolvió sólo el internet le sigue faltando la TV).
      await this.prisma.subInvoice.updateMany({
        where: { id: { in: facturas }, ron: 'CORTADO', estadoCombo: null, estadoTv: null },
        data: { ron: 'ACTIVO' },
      });
      this.logger.log(`Corte levantado en ${r.count} factura(s) de ${ids.length} abonado(s): ${kinds.join('+')}`);
    } catch (e) {
      this.logger.warn(`No se pudo levantar el corte en la factura: ${(e as Error).message}`);
    }
  }

  /** Marca el estado de unos servicios del abonado (la foto por servicio en BD). */
  private marcarServicios(sub: SubParaReconectar, kinds: string[], status: 'ACTIVO' | 'CORTADO') {
    return this.marcarServiciosDe([sub], kinds, status);
  }

  private async marcarServiciosDe(subs: SubParaReconectar[], kinds: string[], status: 'ACTIVO' | 'CORTADO') {
    const ids = subs.flatMap((s) => s.services.filter((x) => kinds.includes(x.kind) && x.status !== status).map((x) => x.id));
    if (!ids.length) return;
    await this.prisma.subscriberService
      .updateMany({ where: { id: { in: ids } }, data: { status: status as any } })
      .catch((e) => this.logger.warn(`No se pudo marcar el estado de los servicios: ${e.message}`));
  }

  /**
   * El cliente pagó ANTES de que fueran a cortarle la TV: se anula la orden de corte
   * que seguía PENDIENTE y la TV vuelve a quedar activa en el sistema.
   *
   * Con el TR-069 en pausa el corte masivo de TV deja una orden PENDIENTE que cierra
   * quien corta en sitio (ver `GenieacsService.registrarCorteDeTv`). Mientras nadie la
   * haya hecho, la señal nunca se cortó: mandar además una «Reconexion Television»
   * sería una visita para devolver algo que no se quitó, y dejar la de corte abierta
   * mandaría a alguien a cortarle a un cliente que ya pagó. Sólo las PENDIENTES: una en
   * REALIZANDO ya tiene a alguien en camino y se deja a su criterio.
   *
   * Devuelve a quiénes se les deshizo. NUNCA lanza.
   */
  private async anularCortesTvSinHacer(subIds: string[], user?: AuthUser): Promise<Set<string>> {
    const hechos = new Set<string>();
    const ids = [...new Set(subIds.filter(Boolean))];
    if (!ids.length) return hechos;
    try {
      const pendientes = await this.prisma.ticket.findMany({
        where: { subscriberId: { in: ids }, type: 'Corte Television', status: 'PENDIENTE' },
        select: { id: true, code: true, subscriberId: true, section: true },
      });
      if (!pendientes.length) return hechos;
      const quien = user?.name || user?.email || 'Sistema';
      const nota = `Anulada por el sistema: el cliente pagó antes de que se hiciera el corte (${quien}).`;
      for (const o of pendientes) {
        await this.prisma.ticket.update({
          where: { id: o.id },
          data: {
            status: 'ANULADA',
            section: [o.section, nota].filter(Boolean).join(' '),
            // La orden pasa a ser nuestra: sin esto la ida del legacy la reabre.
            editedAt: new Date(), editedBy: quien,
          },
        });
        if (o.subscriberId) hechos.add(o.subscriberId);
        this.logger.log(`Orden #${o.code} (Corte Television) anulada: el abonado ${o.subscriberId} pagó antes del corte.`);
      }
      const lista = [...hechos];
      await this.prisma.subscriberService
        .updateMany({ where: { subscriberId: { in: lista }, kind: { in: ['TV', 'PUNTOS'] }, status: 'CORTADO' }, data: { status: 'ACTIVO' } })
        .catch((e) => this.logger.warn(`No se pudo devolver la TV a activa: ${e.message}`));
      await this.levantarCorteDeFactura(lista, ['TV']);
      this.avisarReconexion(lista, ['TV']);
    } catch (e) {
      this.logger.warn(`No se pudieron anular los cortes de TV sin hacer: ${(e as Error).message}`);
    }
    return hechos;
  }

  // ------------------------------------------------------------------

  /**
   * Espera a `p` como mucho `ms`. Si se pasa, devuelve `listo:false` y deja la
   * promesa corriendo (con su propio catch para que no quede sin manejar).
   */
  private conEspera<T>(p: Promise<T>, ms: number): Promise<{ listo: true; valor: T } | { listo: false }> {
    let temporizador: NodeJS.Timeout;
    const vencimiento = new Promise<{ listo: false }>((resolve) => {
      temporizador = setTimeout(() => resolve({ listo: false }), ms);
    });
    p.catch((e) => this.logger.error(`Reconexión en segundo plano: ${(e as Error).message}`));
    return Promise.race([
      p.then((valor) => ({ listo: true as const, valor })).catch(() => ({ listo: false as const })),
      vencimiento,
    ]).finally(() => clearTimeout(temporizador));
  }
}
