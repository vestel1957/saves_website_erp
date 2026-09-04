import { BadRequestException, ForbiddenException, NotFoundException } from '../core/http/errores';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/current-user.decorator';
import { hoyEnColombia } from '../common/fecha-colombia';
import { CARGO_TECNICO } from '../staff/cargos-legacy';
import { esTecnicoDeCampo } from '../common/tecnico-scope';
import { sedesDe } from '../common/sede-scope';
import { variosDeQuery } from '../common/filtros-query';
import { TICKET_ASIGNADO_EVENT, type TicketAsignadoEvent } from './support.events';
import type { EmisorDeEventos } from '../core/eventos';
import { enteroBuscable, rangoPrioridad } from './support.service';
import { ABIERTA, celdaDelDia, ORDEN_AGENDA, origenDelDia, whereDelDia, whereDelRango } from './agenda-dia';
import { esDeMisSedes } from './agenda-sede';
import { tieneAgendaLibre, visitaEnTurno } from './turno';
import { direccionDe, referenciaDe } from '../common/subscriber-address';
import { parsePoint } from '../geo/geo.util';
import type { RoutingService } from '../geo/routing.service';
import { metros, proponerRecorrido, type Parada } from './recorrido.policy';
import { esTrabajoDeCampo } from './field-work.policy';
import { textoPlano } from '../common/texto-legacy';
import { traductorDeTecnicos } from '../staff/nombre-tecnico';

/**
 * Filtros del tablero. Filtran ÓRDENES, no técnicos: la pregunta de la cajera es
 * "dónde está esta orden / qué me queda de este tipo", y esa se responde igual en
 * la bandeja que dentro de la columna de cada técnico.
 */
export type FiltrosAgenda = {
  /** Texto libre: n° de orden, cliente, abonado, dirección, barrio, teléfono, tipo. */
  q?: string;
  /**
   * `Ticket.subject`: servicio / reclamo / incidente.
   *
   * Como el resto de los filtros de la barra, admite VARIOS separados por coma
   * ("reclamo,incidente"): lo que se marca suma. Ver `filtroDeOrdenes`.
   */
  clase?: string;
  /** `Ticket.type`: el detalle concreto ('Corte Internet', 'Instalacion'…). Varios, por coma. */
  tipo?: string;
  /** Varias, por coma. */
  prioridad?: string;
  /** `PENDIENTE` | `REALIZANDO` | `cerradas` (RESUELTO + ANULADA). Varios, por coma. */
  estado?: string;
  /** Solo las que un técnico intentó y no pudo hacer. */
  noAtendidas?: boolean;
  /**
   * `Branch.id` de las sedes que se están mirando (varias, separadas por coma).
   * NO es un filtro más: estrecha el
   * ALCANCE (ver `alcance()`), así que además de esconder órdenes se lleva por
   * delante las columnas de los técnicos de las otras sedes.
   *
   * Es el mismo id (cuid) que usa el filtro de sede de /soporte, para que la pantalla
   * no tenga que manejar dos formas de nombrar una sede.
   */
  sede?: string;
};

/**
 * Un filtro de la agenda, partido en sus dos mitades.
 *
 * No es una separación cosmética: el TABLERO DE LA SEMANA las usa distinto. Los
 * filtros estructurales (clase, tipo, prioridad, estado, no atendidas) esconden
 * órdenes también en la rejilla —quien pide "solo instalaciones" quiere ver solo
 * instalaciones—, pero el TEXTO LIBRE no puede esconder nada ahí: quien escribe
 * "Gómez" está preguntando DÓNDE quedó esa orden, y borrar del tablero todo lo que
 * no coincide deja casillas vacías que no están vacías. Eso se lee como carga libre
 * y es con lo que se reparte de más.
 *
 * Así que en la semana el texto viaja solo a la bandeja (que sí recorta, y tiene que
 * hacerlo en SQL por el tope de 200) y la rejilla lo recibe aparte para ATENUAR.
 */
type FiltroPartido = {
  cond: Prisma.TicketWhereInput[];
  texto: Prisma.TicketWhereInput | null;
};

/** Hasta dónde llega esta consulta, ya con la sede elegida aplicada (ver `alcance()`). */
type AlcanceAgenda = {
  /** Sedes (`Branch.legacyId`) que se miran; `[]` = todas. Ya estrechadas por el filtro. */
  mias: number[];
  /**
   * El alcance del usuario SIN la sede elegida. Sirve para el «12 de 562 coinciden»
   * de la bandeja: la referencia tiene que ser todo lo que hay, o filtrar por sede
   * diría «12 de 12» y no informaría de nada.
   */
  suyas: number[];
  /** Las sedes elegidas (`Branch.id` separados por coma), o `null` si se miran todas. */
  sede: string | null;
  /** Acota un `where` de órdenes a la sede elegida. Sin sede elegida lo deja igual. */
  enSede: (w: Prisma.TicketWhereInput) => Prisma.TicketWhereInput;
  /** Las sedes que se le pueden ofrecer en el desplegable (las suyas). */
  sedes: { id: string; nombre: string }[];
};

/** Estados que se aceptan del cliente; cualquier otra cosa se ignora. */
const ESTADOS_TABLERO = ['PENDIENTE', 'REALIZANDO', 'RESUELTO', 'ANULADA'] as const;

/**
 * Una condición que se cumple con CUALQUIERA de las de la lista.
 *
 * Con una sola se devuelve tal cual y no envuelta en un `OR` de un elemento: el
 * caso corriente —un filtro, un valor— sigue generando exactamente el mismo SQL
 * que antes de que los filtros admitieran varias opciones.
 */
const unaDe = (cond: Prisma.TicketWhereInput[]): Prisma.TicketWhereInput =>
  cond.length === 1 ? cond[0] : { OR: cond };

/**
 * Agendamiento de órdenes de trabajo (2026-07-31).
 *
 * Quien agenda es la CAJERA: reparte el trabajo del día entre los técnicos y decide
 * en qué ORDEN va cada visita. El técnico no arma su agenda, la sigue. Eso es lo que
 * este servicio modela, y por qué las dos piezas nuevas del `Ticket` son una fecha
 * (`scheduledFor`, sin hora — se agenda el día) y una posición (`scheduledSeq`).
 *
 * Tres reglas que conviene tener claras antes de tocar esto:
 *
 * 1. **La posición se renumera entera, siempre.** No se insertan decimales ni se
 *    dejan huecos: cada movimiento reescribe 1..N la columna del técnico ese día. Es
 *    más escritura, pero hace imposible el estado que arruina estas pantallas —dos
 *    órdenes en la posición 3, o una agenda que empieza en 7—.
 * 2. **Agendar ASIGNA.** Poner una orden en la columna de un técnico es asignársela:
 *    no tendría sentido agendarle a alguien trabajo que no es suyo. Por eso se
 *    escriben también `assigned`/`assignedStaffId`/`assignedAt` y se emite el mismo
 *    evento que `assign()`, que es lo que dispara el aviso al cliente.
 * 3. **Desagendar NO desasigna.** Sacar una orden del día la devuelve a "sin
 *    agendar", pero sigue siendo del técnico: quitarle el trabajo de encima por
 *    mover una tarjeta sería una sorpresa desagradable.
 */
export class AgendaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EmisorDeEventos,
    /** Sólo para la matriz de distancias de `recorrido()`. Si OSRM no está, se
     *  ordena en línea recta: nada de esta clase depende de que responda. */
    private readonly routing: RoutingService,
  ) {}

  /**
   * Convierte 'YYYY-MM-DD' al `Date` que Prisma escribe en una columna `date`.
   *
   * Se construye en UTC a mano y NO con `new Date(texto)`: la sesión de Postgres
   * corre en Europe/Berlin y atar un `Date` local contra una columna `date` corre el
   * rango un día entero (el mismo tropiezo documentado en `sql-crudo-fechas-date`).
   */
  private diaDe(fecha?: string): Date {
    if (!fecha?.trim()) return hoyEnColombia();
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fecha.trim());
    if (!m) throw new BadRequestException('La fecha debe venir como YYYY-MM-DD.');
    return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  }

  /**
   * Sedes (`Branch.legacyId`) del usuario; `[]` = sin límite (gerencia/admin).
   *
   * Delega en `common/sede-scope.ts`, que es el alcance por sede de TODO el sistema
   * (clientes, facturas, listado de órdenes). Aquí había una copia propia de esa
   * regla y se había desalineado en lo que más duele: derivaba la sede de la CAJA
   * para cualquiera que tuviese una, sin mirar los permisos. Un superusuario que
   * además atiende ventanilla —hay tres— quedaba acotado a la sede de su caja en la
   * agenda y sólo en la agenda: veía el cliente y su orden en /soporte, pero esa
   * misma orden no le aparecía para agendar. `sedesDe` sólo aplica el rescate por
   * caja a la cajera pura y nunca acota al superusuario, que es lo correcto.
   *
   * Ojo con las dos convenciones: `sedesDe` devuelve `null` para "sin límite" y aquí
   * eso se escribe `[]`.
   */
  private async sedesDelUsuario(user: AuthUser): Promise<number[]> {
    return (await sedesDe(this.prisma, user)) ?? [];
  }

  /**
   * El recorte por sede de las ÓRDENES que se pintan: las del alcance, más las que no
   * tienen sede que asignarles.
   *
   * `mias` vacío = quien mira no está acotado → `null`, sin recorte.
   *
   * Las órdenes SIN abonado no tienen sede y siguen a la vista de todos: es la misma
   * regla de la bandeja (`bandejaBase`) y de `fueraDelTramo`, y sin ella se quedarían
   * huérfanas de todo tablero.
   */
  private static enSedeDe(mias: number[]): Prisma.TicketWhereInput | null {
    if (!mias.length) return null;
    return {
      OR: [{ subscriber: { branch: { legacyId: { in: mias } } } }, { subscriber: { is: null } }],
    };
  }

  /**
   * El alcance por sede de ESTA consulta: el del usuario, estrechado por la sede que
   * haya elegido en la pantalla.
   *
   * Por qué la sede no es un filtro más (2026-08-28, a pedido del usuario: «los
   * superadmin ven la de todas las sedes y es mucho»): los otros filtros esconden
   * ÓRDENES y nunca columnas —el técnico al que hoy no le coincide nada sigue en
   * pantalla, porque es donde hay que poder soltar lo que se encontró—. La sede no:
   * quien elige "Yopal" está pidiendo el tablero de Yopal, y dejarle las columnas de
   * los doce técnicos de la empresa es justo el ruido del que se está quejando. Así
   * que se estrecha el alcance, que es exactamente lo que ya vive una cajera de una
   * sola sede: sus técnicos y sus órdenes.
   *
   * No es una puerta para asomarse a otra sede: sólo se ofrecen —y sólo se aceptan—
   * las sedes que el usuario ya podía ver; pedir otra por la API es un 403.
   *
   * `enSede` recorta SIEMPRE que quien mira esté acotado, elija sede o no (2026-08-31).
   * Antes sólo mordía con una sede puesta a mano, y como sólo la bandeja llevaba el
   * alcance por su cuenta, el resto del tablero salía de la empresa entera: bastaba
   * que un técnico sin sede en la ficha tuviera trabajo puesto para que la cajera de
   * Villanueva viera en su columna clientes de Yopal.
   */
  private async alcance(user: AuthUser, sedeId?: string): Promise<AlcanceAgenda> {
    const suyas = await this.sedesDelUsuario(user);
    const sedes = await this.prisma.branch.findMany({
      // Sin sedes propias (superusuario) van TODAS: `legacyId` es obligatorio en
      // `Branch`, así que no hay un `{ not: null }` que escribir — se quita el filtro.
      where: suyas.length ? { legacyId: { in: suyas } } : {},
      select: { id: true, name: true, legacyId: true },
      orderBy: { name: 'asc' },
    });
    // La sede también admite VARIAS ("mira Yopal y Villanueva a la vez"), separadas
    // por comas como el resto de la barra. Se comprueban UNA A UNA contra las suyas:
    // colar una ajena entre dos propias tiene que seguir siendo un 403, no una
    // rendija por la que asomarse a la agenda de otra sede.
    const pedidas = variosDeQuery(sedeId);
    const elegidas = pedidas.map((id) => {
      const b = sedes.find((s) => s.id === id);
      if (!b) throw new ForbiddenException('No tienes acceso a esa sede.');
      return b;
    });
    // Sin ninguna elegida —o si ninguna de las elegidas tiene `legacyId`, que es por
    // donde se ata la orden a su sede— se mira todo su alcance, como antes.
    const deLasElegidas = elegidas.flatMap((b) => (b.legacyId == null ? [] : [b.legacyId]));
    const mias = deLasElegidas.length ? deLasElegidas : suyas;
    const deSede = AgendaService.enSedeDe(mias);
    return {
      suyas,
      mias,
      sede: elegidas.length ? elegidas.map((b) => b.id).join(',') : null,
      enSede: (w) => (deSede ? { AND: [w, deSede] } : w),
      sedes: sedes.map((b) => ({ id: b.id, nombre: b.name })),
    };
  }

  /**
   * Técnicos que se pintan como columna.
   *
   * Son los del cargo TÉCNICO activos (14 hoy), acotados a la sede de quien agenda:
   * una cajera de Villanueva no reparte el día de los técnicos de Yopal. Se añaden
   * siempre los que YA tengan algo agendado ese día aunque no cumplan el resto del
   * filtro, o una agenda hecha por otra persona desaparecería de la pantalla sin
   * avisar — pero ese rescate también se acota por sede (ver `columnasDe`).
   */
  private async columnas(mias: number[], dia: Date) {
    return this.columnasDe(mias, this.delDia(dia));
  }

  /**
   * Igual que `columnas`, pero para el tramo de agenda que se esté mirando: un día
   * (tablero), una semana o un mes (calendario). Se separó al añadir el calendario
   * —2026-08-26—, porque la regla de qué técnicos se pintan no cambia con el tramo:
   * los de mi sede, más cualquiera que ya tenga trabajo puesto ahí dentro.
   */
  private async columnasDe(mias: number[], where: Prisma.TicketWhereInput) {
    const [tecnicos, yaAgendados] = await Promise.all([
      this.prisma.staff.findMany({
        where: { banned: false, role: CARGO_TECNICO },
        select: { id: true, name: true, username: true, sedeAccede: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.ticket.findMany({
        where: { ...where, assignedStaffId: { not: null } },
        select: { assignedStaff: { select: { id: true, name: true, username: true, sedeAccede: true } } },
        distinct: ['assignedStaffId'],
      }),
    ]);

    const porId = new Map<string, { id: string; name: string; username: string | null }>();
    for (const t of tecnicos) if (esDeMisSedes(t.sedeAccede, mias)) porId.set(t.id, t);
    // El rescate de "ya tiene trabajo puesto" va con la MISMA vara de sede que la
    // lista de arriba, y esto no es un detalle: sin el filtro, cualquier técnico de
    // Yopal con una visita agendada hoy se colaba como columna en el tablero de la
    // cajera de Villanueva —tres de doce el día que se revisó—, y el acotado por sede
    // sólo se cumplía los días en que las otras sedes no tenían agenda. Se filtra por
    // partida doble, y las dos hacen falta: la ficha del técnico (esto) y el `where`,
    // que llega ya acotado a las órdenes que quien mira puede ver, para no sacar una
    // columna vacía por un trabajo que no es suyo. El rescate sigue haciendo lo suyo
    // dentro de la sede: al técnico inhabilitado, o al que le cambiaron la ficha, se
    // le siguen viendo las visitas que ya tenía.
    for (const r of yaAgendados) {
      if (r.assignedStaff && esDeMisSedes(r.assignedStaff.sedeAccede, mias)) {
        porId.set(r.assignedStaff.id, r.assignedStaff);
      }
    }
    return [...porId.values()].sort((a, b) => a.name.localeCompare(b.name, 'es'));
  }

  /**
   * Las órdenes que se pintan en un día: las suyas y, si el día es hoy, lo atrasado.
   *
   * Delega en `agenda-dia.ts` a propósito: la pantalla del técnico, la de la cajera y
   * el calendario tienen que responder lo MISMO. Ver allí por qué el arrastre es de
   * lectura y por qué no se usa al renumerar.
   */
  private delDia(dia: Date): Prisma.TicketWhereInput {
    return whereDelDia(dia, hoyEnColombia());
  }

  /**
   * Puesto de cada visita dentro de la jornada de su técnico: 1..N sobre la columna
   * COMPLETA —sin filtro y con lo atrasado, que va delante— y en el mismo orden en
   * que la va a atender.
   *
   * No se puede usar `scheduledSeq` para pintarlo: numera dentro de UN día, y la
   * columna de hoy trae también lo arrastrado de días anteriores con su propia
   * numeración. Dos visitas distintas salían las dos como "1".
   *
   * Con filtro puesto la numeración se salta huecos (1, 4, 7) a propósito: el técnico
   * va a hacer la 4 en cuarto lugar aunque la cajera solo esté mirando las urgentes.
   */
  private async puestosDelDia(
    dia: Date,
    yaOrdenadas: { id: string; assignedStaffId: string | null }[] | null,
  ): Promise<Map<string, number>> {
    const filas = yaOrdenadas ?? await this.prisma.ticket.findMany({
      where: this.delDia(dia),
      select: { id: true, assignedStaffId: true },
      orderBy: ORDEN_AGENDA,
    });
    const cuantas = new Map<string, number>();
    const puesto = new Map<string, number>();
    for (const f of filas) {
      if (!f.assignedStaffId) continue;
      const p = (cuantas.get(f.assignedStaffId) ?? 0) + 1;
      cuantas.set(f.assignedStaffId, p);
      puesto.set(f.id, p);
    }
    return puesto;
  }

  private static readonly TARJETA = {
    id: true, code: true, subject: true, type: true, priority: true, status: true,
    created: true, problem: true, scheduledFor: true, scheduledSeq: true, scheduledByName: true,
    // La DESCRIPCIÓN de la orden vive casi siempre en `section` ('observación' en la
    // pantalla), no en `problem`: de las 212 agendadas, 204 tienen `section` y 25
    // `problem`. Traer solo `problem` era enseñar la tarjeta —y el Excel— en blanco.
    section: true,
    // De qué día viene arrastrada. Es lo que sostiene la etiqueta "atrasada desde el
    // 27" ahora que la tarea de madrugada le reescribe `scheduledFor` a hoy.
    carriedFrom: true,
    assignedStaffId: true, assigned: true,
    // Para que la bandeja de la cajera distinga una orden que nunca se agendó de
    // una que el técnico fue a hacer y no pudo: son dos trabajos muy distintos.
    skippedAt: true, skippedReason: true, skippedByName: true,
    subscriber: {
      select: {
        id: true, abonado: true, firstName: true, lastName1: true, companyName: true, fullName: true,
        addressLine: true, nomenclature: true, phone1: true, phone2: true, neighborhood: true,
        // La CÉDULA: el técnico la necesita para identificar a quien le abre la
        // puerta (y para que el acta que firma no salga en blanco).
        docType: true, docNumber: true,
        // `legacyId` es la llave con la que se acota por sede en todo el sistema
        // (ver `sede-scope.ts`); el nombre es solo para enseñar.
        branch: { select: { name: true, legacyId: true } },
      },
    },
  } satisfies Prisma.TicketSelect;

  private static nombreAbonado(s: { firstName: string | null; lastName1: string | null; companyName: string | null; fullName: string | null } | null): string | null {
    if (!s) return null;
    if (s.fullName?.trim()) return s.fullName.trim();
    const p = [s.firstName, s.lastName1].map((x) => (x || '').trim()).filter(Boolean).join(' ');
    return p || (s.companyName || '').trim() || null;
  }

  private async tarjeta(t: any, barrios: Map<number, string>, hoy?: number, puesto?: number | null) {
    const nb = Number(t.subscriber?.neighborhood);
    // Arrastrada de un día anterior: la tarjeta tiene que DECIRLO. Si no, el técnico
    // ve una visita más y la cajera cuenta como trabajo de hoy algo que lleva
    // esperando desde el jueves, que es lo que hay que poder mirar de frente.
    //
    // El día que se enseña es el ORIGINAL (`carriedFrom` cuando lo hay): desde que la
    // tarea de madrugada mueve de verdad lo que quedó abierto, `scheduledFor` dice
    // "hoy" en todas y sola ya no distingue la visita nueva de la que lleva cinco
    // días rodando.
    const origen = t.carriedFrom ?? t.scheduledFor;
    const dia = origen ? new Date(origen).getTime() : null;
    return {
      id: t.id, code: t.code, subject: t.subject, type: t.type, priority: t.priority,
      status: t.status, created: t.created,
      // Pasa por `textoPlano`: el legacy editaba esto con un WYSIWYG y lo que hay en
      // la base es '<p>SUSPENDER TV</p>'. Pintarlo como HTML sería XSS almacenado;
      // pintarlo crudo (lo que se hacía) le enseña las etiquetas al técnico.
      problema: textoPlano(t.problem),
      observacion: textoPlano(t.section),
      seq: t.scheduledSeq, agendadaPor: t.scheduledByName,
      // El puesto REAL en la jornada del técnico, contando lo atrasado. `seq` numera
      // dentro de un día y la columna de hoy mezcla días: sin esto se ven dos "1".
      puesto: puesto ?? null,
      agendadaPara: origen ?? null,
      atrasada: dia != null && hoy != null && dia < hoy,
      noAtendida: t.skippedAt
        ? { fecha: t.skippedAt, motivo: t.skippedReason, por: t.skippedByName }
        : null,
      staffId: t.assignedStaffId, tecnico: t.assigned,
      cliente: AgendaService.nombreAbonado(t.subscriber), abonado: t.subscriber?.abonado ?? null,
      subscriberId: t.subscriber?.id ?? null,
      // Armada de las piezas, no de `addressLine` (vacío en 21.656 de 21.867):
      // es la dirección a la que el técnico tiene que llegar.
      direccion: direccionDe(t.subscriber?.nomenclature, t.subscriber?.addressLine),
      // La pista para llegar cuando la placa no basta ('LOTE 183', 'Frente a la
      // Hogareña'). Va aparte de la dirección, pero en el Excel se pega detrás:
      // hay abonados cuya ÚNICA seña es ésta y su celda de dirección salía vacía.
      referencia: referenciaDe(t.subscriber?.nomenclature),
      telefono: t.subscriber?.phone1 ?? null,
      telefono2: t.subscriber?.phone2 ?? null,
      cedula: [t.subscriber?.docType, t.subscriber?.docNumber].filter(Boolean).join(' ') || null,
      sede: t.subscriber?.branch?.name ?? null,
      barrio: Number.isFinite(nb) ? barrios.get(nb) ?? null : null,
      // El ID del barrio, además del nombre: es la clave con la que la pantalla de
      // repartir cruza esta orden contra `zonasDelDia` para decir "Óscar ya tiene 3
      // aquí" al elegir técnico. Por NOMBRE no se puede — hay barrios que se llaman
      // igual en dos municipios.
      barrioId: Number.isFinite(nb) ? String(nb) : null,
    };
  }

  /** Resuelve los nombres de barrio de un lote de tarjetas (el ticket guarda el id legacy). */
  private async barriosDe(filas: { subscriber: { neighborhood: string | null } | null }[]) {
    const ids = [...new Set(filas.map((f) => Number(f.subscriber?.neighborhood)).filter((n) => Number.isFinite(n)))];
    if (!ids.length) return new Map<number, string>();
    const rows = await this.prisma.neighborhood.findMany({ where: { legacyId: { in: ids } }, select: { legacyId: true, name: true } });
    return new Map(rows.flatMap((n) => (n.legacyId == null ? [] : [[n.legacyId, n.name] as [number, string]])));
  }

  /**
   * Traduce los filtros de la pantalla a condiciones de Prisma.
   *
   * Se resuelven EN SQL y no en el navegador por la bandeja: "sin agendar" sale
   * recortada a las 200 más urgentes, así que un filtro aplicado sobre lo ya
   * cargado solo miraría esas 200 y buscar la orden 1234 no la encontraría nunca
   * aunque esté abierta. Filtrando aquí, el corte se hace DESPUÉS del filtro.
   *
   * Devuelve una lista de condiciones para meter en un `AND`: cada filtro es
   * independiente y el texto libre trae su propio `OR` dentro.
   */
  private async filtroDeOrdenes(f?: FiltrosAgenda): Promise<FiltroPartido> {
    const cond: Prisma.TicketWhereInput[] = [];
    if (!f) return { cond, texto: null };

    // Todos los filtros de la barra son de selección MÚLTIPLE y viajan separados por
    // comas ("servicio,reclamo"), igual que en el listado de /soporte. Varias marcadas
    // suman (OR) dentro del filtro y los filtros distintos siguen restando entre sí
    // (AND): "reclamo o incidente, y urgente". Un solo valor se comporta como antes,
    // así que los enlaces guardados no se rompen.
    const clases = variosDeQuery(f.clase);
    if (clases.length) cond.push(unaDe(clases.map((c) => ({ subject: { equals: c, mode: 'insensitive' as const } }))));
    // El tipo (el DETALLE del legacy: 'Corte Internet', 'Instalacion') va exacto: la
    // lista que se ofrece sale de las órdenes que hay, así que lo que llega aquí es
    // uno de esos textos tal cual. Insensible por lo mismo que la prioridad.
    const tipos = variosDeQuery(f.tipo);
    if (tipos.length) cond.push(unaDe(tipos.map((t) => ({ type: { equals: t, mode: 'insensitive' as const } }))));
    // `priority` es texto libre del legacy: "URGENTE" también tiene que caer al
    // filtrar por "Urgente". Con varias elegidas va como OR de iguales y no como
    // `in`, que en Postgres no respeta el `mode`.
    const prioridades = variosDeQuery(f.prioridad);
    if (prioridades.length) cond.push(unaDe(prioridades.map((p) => ({ priority: { equals: p, mode: 'insensitive' as const } }))));

    // "cerradas" no es un estado sino DOS, así que los elegidos se aplanan a la lista
    // de estados reales antes de consultar. Un valor que no se reconozca se ignora,
    // como se ignoraba antes: no vale devolver cero órdenes por un parámetro raro.
    const estados = [
      ...new Set(
        variosDeQuery(f.estado).flatMap((e) =>
          e === 'cerradas'
            ? ['RESUELTO', 'ANULADA']
            : (ESTADOS_TABLERO as readonly string[]).includes(e)
              ? [e]
              : [],
        ),
      ),
    ];
    if (estados.length) cond.push({ status: { in: estados as (typeof ESTADOS_TABLERO)[number][] } });

    if (f.noAtendidas) cond.push({ skippedAt: { not: null } });

    const q = f.q?.trim();
    if (!q) return { cond, texto: null };
    {
      // `null` cuando lo tecleado no cabe en un int de 32 bits: un celular buscado
      // así (3145267065) hacía que Postgres RECHAZARA la consulta entera.
      const n = enteroBuscable(q);
      // El barrio en el abonado es el ID legacy, no el nombre: para poder buscar
      // "Centro" hay que traducir primero el nombre a ids. Es la ruta que arma el
      // día la cajera (todas las de un barrio, seguidas), así que vale la consulta.
      const barrios = await this.prisma.neighborhood.findMany({
        where: { name: { contains: q, mode: 'insensitive' } },
        select: { legacyId: true },
        take: 50,
      });
      const idsBarrio = barrios.flatMap((b) => (b.legacyId == null ? [] : [String(b.legacyId)]));
      return {
        cond,
        texto: {
        OR: [
          { type: { contains: q, mode: 'insensitive' } },
          { subject: { contains: q, mode: 'insensitive' } },
          { problem: { contains: q, mode: 'insensitive' } },
          // Donde de verdad está escrito lo que pasa: sin esto, buscar "sin señal"
          // en la bandeja no encontraba nada.
          { section: { contains: q, mode: 'insensitive' } },
          ...(n != null ? [{ code: n }] : []),
          {
            subscriber: {
              is: {
                OR: [
                  { fullName: { contains: q, mode: 'insensitive' as const } },
                  { firstName: { contains: q, mode: 'insensitive' as const } },
                  { lastName1: { contains: q, mode: 'insensitive' as const } },
                  { companyName: { contains: q, mode: 'insensitive' as const } },
                  { addressLine: { contains: q, mode: 'insensitive' as const } },
                  { phone1: { contains: q } },
                  ...(n != null ? [{ abonado: n }] : []),
                  ...(idsBarrio.length ? [{ neighborhood: { in: idsBarrio } }] : []),
                ],
              },
            },
          },
        ],
        },
      };
    }
  }

  /** Las dos mitades juntas: lo normal en el tablero de un día y en el calendario. */
  private static todas(f: FiltroPartido): Prisma.TicketWhereInput[] {
    return f.texto ? [...f.cond, f.texto] : f.cond;
  }

  /** Cuántas órdenes sin agendar se enseñan de una vez. Más no cabe en pantalla. */
  private static readonly TOPE_BANDEJA = 200;

  /** Cuántas "ya agendadas" se enseñan al buscar algo que no está en la bandeja. */
  private static readonly TOPE_YA_AGENDADAS = 25;

  /**
   * Lo que la BÚSQUEDA encuentra pero ya tiene día, esté donde esté.
   *
   * Tapa un callejón sin salida (2026-09-03, reportado por el usuario): la bandeja
   * sólo contiene órdenes SIN día, así que teclear el abonado de un cliente cuyo
   * trabajo ya se repartió contestaba "Ninguna orden sin agendar coincide con el
   * filtro". El cliente existe, tiene dos órdenes abiertas y las dos con técnico y
   * fecha — y la pantalla decía que no hay nada. Quien busca un abonado quiere saber
   * QUÉ PASA CON ESE CLIENTE, no auditar una bandeja.
   *
   * Sólo se calcula cuando hay TEXTO tecleado. Con los filtros de la barra (tipo,
   * prioridad…) la pregunta es otra —"qué me queda por repartir de esto"— y sacar
   * ahí las 25 ya agendadas sería ruido en la pantalla de trabajo.
   *
   * No se acota al día que se mira: precisamente lo que hay que decir es que está en
   * OTRO día, y cuál.
   */
  private async yaAgendadas(mias: number[], conFiltro: Prisma.TicketWhereInput) {
    const filas = await this.prisma.ticket.findMany({
      where: {
        AND: [
          {
            status: { in: ['PENDIENTE', 'REALIZANDO'] },
            scheduledFor: { not: null },
            ...(mias.length
              ? { OR: [{ subscriber: { branch: { legacyId: { in: mias } } } }, { subscriber: { is: null } }] }
              : {}),
          },
          conFiltro,
        ],
      },
      // La más próxima primero: es a la que la cajera va a querer saltar.
      orderBy: [{ scheduledFor: 'asc' }, { scheduledSeq: 'asc' }],
      take: AgendaService.TOPE_YA_AGENDADAS + 1,
      select: {
        id: true, code: true, type: true, status: true, scheduledFor: true,
        assigned: true, assignedStaffId: true,
        subscriber: { select: { abonado: true, fullName: true, firstName: true, lastName1: true, companyName: true } },
      },
    });
    const hay = filas.slice(0, AgendaService.TOPE_YA_AGENDADAS);
    return {
      lista: hay.map((t) => ({
        id: t.id,
        code: t.code,
        tipo: t.type,
        estado: t.status,
        fecha: t.scheduledFor?.toISOString().slice(0, 10) ?? null,
        tecnico: t.assigned,
        staffId: t.assignedStaffId,
        cliente: AgendaService.nombreAbonado(t.subscriber as any),
        abonado: t.subscriber?.abonado ?? null,
      })),
      // `true` = hay más de las que caben; la pantalla lo dice en vez de mentir.
      hayMas: filas.length > AgendaService.TOPE_YA_AGENDADAS,
    };
  }

  /** Cuántas "ya cerradas que coinciden" se enseñan como último recurso. */
  private static readonly TOPE_CERRADAS = 10;

  /**
   * Última red antes de decir "no hay nada" (2026-09-03, reportado por el usuario:
   * "hay órdenes que no salen en el buscador, ni por nombre ni por código").
   *
   * La agenda es a propósito un tablero de trabajo ABIERTO: de 326.041 órdenes en
   * la base, 326.033 son RESUELTAS o ANULADAS, y mezclarlas con las 468 vivas lo
   * volvería inservible. Pero "no aparece nada" y "esa orden se cerró el 11 de
   * agosto" son dos respuestas muy distintas para quien busca un cliente — y de las
   * 320.128 resueltas, 319.877 NUNCA pasaron por la agenda (nunca tuvieron día), así
   * que ni siquiera `yaAgendadas` las alcanza. Sin esto, buscar el código de una
   * orden ya resuelta era un silencio que se leía como "esto no existe".
   *
   * Por eso es la ÚLTIMA consulta y no una más del `Promise.all`: sólo se dispara
   * cuando ninguna otra respuesta encontró nada, así que en el uso normal —la
   * cajera busca algo que SÍ está vivo— nunca toca esta tabla.
   */
  private async cerradasQueCoinciden(mias: number[], conFiltro: Prisma.TicketWhereInput, codigo: number | null) {
    const alcanceSede: Prisma.TicketWhereInput = mias.length
      ? { OR: [{ subscriber: { branch: { legacyId: { in: mias } } } }, { subscriber: { is: null } }] }
      : {};
    const SEL = {
      id: true, code: true, type: true, status: true, finalDate: true, assigned: true,
      subscriber: { select: { abonado: true, fullName: true, firstName: true, lastName1: true, companyName: true } },
    } as const;

    // El código EXACTO se busca APARTE y primero, sin depender de ningún orden ni
    // tope: "6033" es a la vez un código de orden Y un código de abonado, y ese
    // abonado puede tener muchas más órdenes resueltas que las diez que se enseñan.
    // Meter las dos búsquedas en una sola consulta ordenada apostaba a que la
    // exacta cupiera dentro del `take` — y con casi todo `resolvedAt`/`finalDate`
    // en NULL (el legacy no lo trae), Postgres pone esas filas PRIMERO en un
    // `ORDER BY ... DESC`, así que la fecha real casi siempre perdía la apuesta.
    const exacta = codigo != null
      ? await this.prisma.ticket.findFirst({
          where: { AND: [{ status: { in: ['RESUELTO', 'ANULADA'] } }, { code: codigo }, alcanceSede] },
          select: SEL,
        })
      : null;

    const resto = await this.prisma.ticket.findMany({
      where: {
        AND: [
          { status: { in: ['RESUELTO', 'ANULADA'] } },
          conFiltro,
          alcanceSede,
          ...(exacta ? [{ id: { not: exacta.id } }] : []),
        ],
      },
      // `nulls: 'last'`: sin él, las filas sin fecha (la mayoría) tapan a las que
      // sí la tienen en un DESC — Postgres ordena NULL primero por defecto.
      orderBy: [{ resolvedAt: { sort: 'desc', nulls: 'last' } }, { finalDate: { sort: 'desc', nulls: 'last' } }],
      take: AgendaService.TOPE_CERRADAS - (exacta ? 1 : 0),
      select: SEL,
    });

    return [...(exacta ? [exacta] : []), ...resto].map((t) => ({
      id: t.id,
      code: t.code,
      tipo: t.type,
      estado: t.status,
      fecha: t.finalDate?.toISOString().slice(0, 10) ?? null,
      tecnico: t.assigned,
      cliente: AgendaService.nombreAbonado(t.subscriber as any),
      abonado: t.subscriber?.abonado ?? null,
    }));
  }

  /**
   * La bandeja de "sin agendar": las órdenes ABIERTAS sin día, de mi sede, con lo
   * urgente y lo más viejo delante.
   *
   * Sale de `tablero` a un método aparte porque el calendario (2026-08-26) enseña la
   * misma bandeja al lado de la semana: es de donde se saca el trabajo para repartir,
   * y no depende del día que se esté mirando.
   *
   * Dos cosas que hay que respetar al tocarlo:
   *  · El alcance por sede va en `base` con un `OR` propio, y el filtro entra aparte:
   *    mezclarlos haría que el primer texto tecleado abriera las órdenes de las otras
   *    sedes. Las órdenes sin abonado no tienen sede y se muestran a todos, antes que
   *    dejarlas huérfanas de toda bandeja.
   *  · El orden por prioridad se hace en memoria. `priority` es texto libre y en SQL
   *    sale alfabético (Alta, Baja, Media, Urgente): con el tope de 200, ordenar así
   *    llegaba a dejar las URGENTES fuera de la bandeja.
   */
  private bandejaBase(mias: number[]): Prisma.TicketWhereInput {
    return {
      status: { in: ['PENDIENTE', 'REALIZANDO'] },
      scheduledFor: null,
      ...(mias.length
        ? { OR: [{ subscriber: { branch: { legacyId: { in: mias } } } }, { subscriber: { is: null } }] }
        : {}),
    };
  }

  /** La bandeja entera: el `where` de arriba, ya consultado y recortado al tope. */
  private async bandeja(mias: number[], conFiltro: Prisma.TicketWhereInput) {
    const base = this.bandejaBase(mias);
    const candidatas = await this.prisma.ticket.findMany({
      where: { ...base, ...conFiltro },
      select: { id: true, priority: true, created: true },
    });
    candidatas.sort(
      (a, b) =>
        rangoPrioridad(a.priority) - rangoPrioridad(b.priority) ||
        (a.created?.getTime() ?? 0) - (b.created?.getTime() ?? 0),
    );
    return {
      base,
      ids: candidatas.slice(0, AgendaService.TOPE_BANDEJA).map((c) => c.id),
      total: candidatas.length,
    };
  }

  /**
   * El tablero de un día: la bandeja de "sin agendar" y una columna por técnico.
   *
   * "Sin agendar" son las órdenes ABIERTAS sin fecha, no todas las abiertas: las que
   * ya están puestas en otro día no vuelven a la bandeja, o la cajera las volvería a
   * repartir cada mañana sin saber que ya tenían dueño y día.
   */
  async tablero(user: AuthUser, fecha?: string, filtros?: FiltrosAgenda) {
    const dia = this.diaDe(fecha);
    const { mias, suyas, sede, enSede, sedes } = await this.alcance(user, filtros?.sede);
    const tecnicos = await this.columnasDe(mias, enSede(this.delDia(dia)));
    // Los filtros esconden ÓRDENES, nunca columnas: el técnico que hoy no tiene nada
    // de lo que se busca sigue en pantalla, vacío, porque es justo donde la cajera va
    // a querer soltar lo que encontró. La sede es la excepción y por eso no está
    // aquí: esa sí se lleva las columnas, ver `alcance()`.
    const filtro = AgendaService.todas(await this.filtroDeOrdenes(filtros));
    const conFiltro = filtro.length ? { AND: filtro } : {};
    // Elegir sede cuenta como filtrar: recorta la bandeja y las columnas dejan de ser
    // las completas, así que el puesto de cada visita hay que volver a contarlo.
    const filtrando = filtro.length > 0 || sede != null;

    const { base: bandejaBase, ids: idsBandeja, total: totalBandeja } = await this.bandeja(mias, conFiltro);
    // Sólo con texto tecleado: ver `yaAgendadas` para por qué no con el resto de filtros.
    const conDia = filtros?.q?.trim() ? await this.yaAgendadas(mias, conFiltro) : null;

    const [filasBandeja, agendadas, delDia, sinFiltro, tiposCrudos] = await Promise.all([
      idsBandeja.length
        ? this.prisma.ticket.findMany({ where: { id: { in: idsBandeja } }, select: AgendaService.TARJETA })
        : [],
      this.prisma.ticket.findMany({
        where: { AND: [enSede(this.delDia(dia)), conFiltro] },
        select: AgendaService.TARJETA,
        orderBy: ORDEN_AGENDA,
      }),
      // Las cifras de cada columna van SIN filtro: la carga real del técnico no
      // cambia porque se busque una orden, y un "3 pendientes" que baja a 1 al
      // teclear es exactamente el dato que haría repartir mal el día.
      this.prisma.ticket.groupBy({
        by: ['assignedStaffId', 'status'],
        where: this.delDia(dia),
        _count: { _all: true },
      }),
      filtrando ? this.prisma.ticket.count({ where: bandejaBase }) : Promise.resolve(null),
      // Los tipos que se ofrecen en el desplegable. Salen de las órdenes que HAY
      // —la bandeja entera y lo repartido ese día—, no de una lista escrita a mano:
      // así ninguna opción devuelve vacío y ningún tipo que esté en el tablero queda
      // sin poder elegirse (el legacy tiene decenas de detalles y el bot añade los
      // suyos). Va SIN el filtro puesto, o elegir un tipo dejaría el desplegable con
      // esa única opción y no habría forma de cambiar de idea.
      this.prisma.ticket.groupBy({
        by: ['type', 'subject'],
        where: { OR: [bandejaBase, this.delDia(dia)] },
        _count: { _all: true },
      }),
    ]);
    // `id IN (...)` no garantiza orden: se recompone el del rango.
    const bandejaPorId = new Map(filasBandeja.map((f) => [f.id, f]));
    const sinAgendar = idsBandeja.flatMap((id) => bandejaPorId.get(id) ?? []);

    // Último recurso: sólo si de verdad no hay NADA vivo que enseñar. Ver
    // `cerradasQueCoinciden` para por qué no va en el `Promise.all` de arriba.
    const cerradas =
      filtros?.q?.trim() && !sinAgendar.length && !agendadas.length && !conDia?.lista.length
        ? await this.cerradasQueCoinciden(mias, conFiltro, enteroBuscable(filtros!.q!.trim()))
        : [];

    const barrios = await this.barriosDe([...sinAgendar, ...agendadas]);
    const hoyMs = hoyEnColombia().getTime();
    // Sin filtro, `agendadas` YA es la columna completa en su orden: se numera sobre
    // ella y se ahorra la consulta. Con filtro hay que volver a preguntar, porque el
    // puesto se cuenta sobre lo que hay, no sobre lo que se está mirando.
    // `agendadas` sólo sirve para numerar si es la columna ENTERA: con filtro puesto no
    // lo es, y con alcance por sede tampoco (le faltan las visitas de las otras sedes,
    // que el técnico sí va a atender y ocupan puesto en su día).
    const puestos = await this.puestosDelDia(dia, filtrando || mias.length ? null : agendadas);
    const mapear = (fs: any[]) =>
      Promise.all(fs.map((f) => this.tarjeta(f, barrios, hoyMs, puestos.get(f.id))));

    const porTecnico = new Map<string, any[]>();
    for (const t of agendadas) {
      if (!t.assignedStaffId) continue;
      const lista = porTecnico.get(t.assignedStaffId) ?? [];
      lista.push(t);
      porTecnico.set(t.assignedStaffId, lista);
    }

    // Carga del día por técnico, al margen del filtro.
    const cargas = new Map<string, { total: number; pendientes: number }>();
    for (const g of delDia) {
      if (!g.assignedStaffId) continue;
      const c = cargas.get(g.assignedStaffId) ?? { total: 0, pendientes: 0 };
      const n = g._count._all;
      c.total += n;
      if (g.status === 'PENDIENTE' || g.status === 'REALIZANDO') c.pendientes += n;
      cargas.set(g.assignedStaffId, c);
    }

    // Un mismo tipo puede venir de varias clases: se suman y se queda la clase en la
    // que más se usa, que es con la que el desplegable lo va a agrupar.
    const tipos = AgendaService.tiposDe(tiposCrudos);

    return {
      fecha: dia.toISOString().slice(0, 10),
      hoy: hoyEnColombia().toISOString().slice(0, 10),
      filtrando,
      /**
       * Las sedes que se le pueden ofrecer (las suyas) y cuál está mirando. Van en la
       * respuesta y no en un catálogo aparte porque el alcance ya se resolvió aquí:
       * pedirlas por otro sitio abriría la puerta a ofrecer una sede que este
       * endpoint rechazaría con un 403.
       *
       * Con una sola la pantalla no pinta el desplegable — quien no puede elegir no
       * tiene por qué ver una elección (ver la decisión del 2026-08-03 sobre la
       * cajera acotada).
       */
      sedes,
      sede,
      /** Opciones del filtro por tipo: lo que de verdad hay, con cuántas de cada uno. */
      tipos,
      sinAgendar: await mapear(sinAgendar),
      // Cuántas quedaron fuera del tope de 200: sin decirlo, la bandeja parece
      // completa y la cajera daría por repartido lo que no ha visto.
      sinAgendarTotal: totalBandeja,
      /** Las que hay sin agendar en total, ignorando el filtro (null si no hay filtro). */
      sinAgendarSinFiltro: sinFiltro,
      /**
       * Lo que el TEXTO encuentra pero ya tiene día (con cuál y de quién). `null`
       * cuando no se está buscando nada. Sin esto, buscar el abonado de un cliente
       * cuyo trabajo ya se repartió era un callejón sin salida.
       */
      yaAgendadas: conDia?.lista ?? null,
      yaAgendadasHayMas: conDia?.hayMas ?? false,
      /**
       * Lo que ya está RESUELTO o ANULADO y coincide con la búsqueda. `[]` casi
       * siempre — sólo se calcula cuando nada más encontró nada (ver
       * `cerradasQueCoinciden`). Sin esto, buscar una orden ya cerrada era un
       * silencio que parecía decir "esto no existe".
       */
      cerradas,
      columnas: await Promise.all(
        tecnicos.map(async (t) => {
          const carga = cargas.get(t.id) ?? { total: 0, pendientes: 0 };
          return {
            staffId: t.id,
            nombre: t.name,
            ordenes: await mapear(porTecnico.get(t.id) ?? []),
            total: carga.total,
            pendientes: carga.pendientes,
          };
        }),
      ),
    };
  }

  /** Cuántos días se dejan pedir de una vez. Un mes de calendario cabe en 42 casillas. */
  private static readonly TOPE_DIAS = 62;

  /** El día `n` después de `d`, en la misma escala UTC en la que se guardan las fechas. */
  private static masDias(d: Date, n: number): Date {
    return new Date(d.getTime() + n * 86_400_000);
  }

  /** Los 'YYYY-MM-DD' de un rango, en orden. Es el eje del calendario. */
  private static diasDelRango(desde: Date, hasta: Date): string[] {
    const dias: string[] = [];
    for (let d = desde; d.getTime() <= hasta.getTime(); d = AgendaService.masDias(d, 1)) {
      dias.push(d.toISOString().slice(0, 10));
    }
    return dias;
  }

  /**
   * Las visitas de un tramo, ya repartidas en casillas (técnico × día).
   *
   * Es la pieza común de la semana y del mes: una consulta LIGERA —sin filtro y sin
   * los datos del abonado— que sirve para dos cosas que no pueden salir de lo que se
   * ve en pantalla:
   *
   *  · **El puesto de cada visita** (1..N dentro de su casilla). Se cuenta sobre la
   *    casilla COMPLETA: con un filtro puesto la numeración se salta huecos, y eso es
   *    lo correcto —el técnico hará la 4 en cuarto lugar aunque la cajera solo esté
   *    mirando las urgentes—.
   *  · **La carga real de cada casilla**, que tampoco cambia porque se busque una
   *    orden. Un contador que baja al teclear es justo el dato con el que se reparte
   *    mal la semana.
   *
   * Lo atrasado cae en la casilla de HOY (ver `celdaDelDia`): es el día en que hay que
   * hacerlo, y dejarlo en su día original lo escondería en una semana ya pasada.
   */
  private async casillas(rango: Prisma.TicketWhereInput, hoy: Date) {
    const filas = await this.prisma.ticket.findMany({
      where: rango,
      select: { id: true, assignedStaffId: true, scheduledFor: true, carriedFrom: true, status: true },
      orderBy: ORDEN_AGENDA,
    });
    const puesto = new Map<string, number>();
    const carga = new Map<string, { total: number; pendientes: number; atrasadas: number }>();
    const dia = new Map<string, string>();
    for (const f of filas) {
      if (!f.scheduledFor) continue;
      const celda = celdaDelDia(f.scheduledFor, f.status, hoy);
      dia.set(f.id, celda);
      const clave = `${f.assignedStaffId ?? '—'}|${celda}`;
      const c = carga.get(clave) ?? { total: 0, pendientes: 0, atrasadas: 0 };
      c.total += 1;
      if (f.status === 'PENDIENTE' || f.status === 'REALIZANDO') c.pendientes += 1;
      if (origenDelDia(f) !== celda) c.atrasadas += 1;
      carga.set(clave, c);
      if (f.assignedStaffId) puesto.set(f.id, c.total);
    }
    return { puesto, carga, dia };
  }

  /**
   * La SEMANA: la misma bandeja de siempre y una rejilla de técnicos × días.
   *
   * Por qué existe (2026-08-26, a pedido del usuario): el tablero de un día deja
   * agendar para cualquier fecha, pero para repartir el jueves había que navegar hasta
   * el jueves, y para saber cómo venía la semana, ir día por día. Aquí se ve entera y
   * se arrastra de un día a otro, que es la operación que faltaba.
   *
   * Devuelve tarjetas, no conteos: en la semana todavía se trabaja. La mirada larga
   * —"cómo viene el mes"— es `calendario`, que solo cuenta.
   */
  async semana(user: AuthUser, desde?: string, dias?: number, filtros?: FiltrosAgenda) {
    const inicio = this.diaDe(desde);
    const cuantos = Math.min(Math.max(Number(dias) || 7, 1), 14);
    const fin = AgendaService.masDias(inicio, cuantos - 1);
    const hoy = hoyEnColombia();
    const rango = whereDelRango(inicio, fin, hoy);

    // El recorte por sede va aparte del filtro y sólo sobre las TARJETAS y las
    // columnas: `casillas` sigue viendo el tramo entero, que es lo que hace que el
    // puesto de cada visita y la carga de cada casilla sigan siendo los del técnico y
    // no los de mi sede.
    //
    // Pasa por `alcance()` —y no por `sedesDelUsuario()` a secas— desde el 2026-09-02:
    // así la sede que se elige en la pantalla estrecha también esta vista. Antes el
    // desplegable recortaba "Repartir" y dejaba "Por técnico" con la empresa entera,
    // que es la forma más clara de no creerse ninguna de las dos.
    const { mias, sede, enSede, sedes } = await this.alcance(user, filtros?.sede);
    const tecnicos = await this.columnasDe(mias, enSede(rango));

    /*
     * El filtro va PARTIDO en dos aquí y solo aquí (ver `FiltroPartido`): lo
     * estructural esconde órdenes también en la rejilla, y el texto libre no
     * esconde ninguna — viaja a la bandeja, que sí recorta, y vuelve como `q` para
     * que la pantalla ATENÚE lo que no coincide en vez de borrarlo.
     */
    const partido = await this.filtroDeOrdenes(filtros);
    const q = filtros?.q?.trim() ?? '';
    // Dos cosas distintas: `hayFiltro` es "se está buscando algo" y `filtrando` es
    // "lo que se ve está recortado". Elegir sede recorta —y por eso hay que volver a
    // contar la cola entera—, pero NO es una búsqueda: con `hayFiltro` de por medio,
    // el rescate de "coincide pero cae fuera del tramo" se queda quieto en vez de
    // devolver 25 órdenes cualesquiera de la sede sin que nadie haya buscado nada.
    const hayFiltro = partido.cond.length > 0 || partido.texto != null;
    const filtrando = hayFiltro || sede != null;
    const deRejilla = partido.cond.length ? { AND: partido.cond } : {};
    const deBandeja = hayFiltro ? { AND: AgendaService.todas(partido) } : {};

    const { base: bandejaBase, ids: idsBandeja, total: totalBandeja } = await this.bandeja(mias, deBandeja);
    const [filasBandeja, agendadas, casillas, sinFiltro, tiposCrudos, despuesCrudo, fueraCrudo] = await Promise.all([
      idsBandeja.length
        ? this.prisma.ticket.findMany({ where: { id: { in: idsBandeja } }, select: AgendaService.TARJETA })
        : [],
      this.prisma.ticket.findMany({
        where: { AND: [enSede(rango), deRejilla] },
        select: AgendaService.TARJETA,
        orderBy: ORDEN_AGENDA,
      }),
      this.casillas(rango, hoy),
      filtrando ? this.prisma.ticket.count({ where: bandejaBase }) : Promise.resolve(null),
      this.prisma.ticket.groupBy({
        by: ['type', 'subject'],
        where: { OR: [bandejaBase, rango] },
        _count: { _all: true },
      }),
      /*
       * Lo que cada técnico tiene MÁS ALLÁ del tramo que se está mirando.
       *
       * Una rejilla de siete días esconde por construcción lo que cae fuera, y sin
       * decirlo la fila de un técnico con quince visitas en septiembre se lee como
       * una semana tranquila. No se arrastra a esta semana —no es de esta semana—,
       * pero tampoco puede desaparecer de la cuenta: sale como cifra en su fila,
       * con la primera fecha, y esa fecha es adonde salta el botón.
       */
      this.prisma.ticket.groupBy({
        by: ['assignedStaffId'],
        where: {
          assignedStaffId: { not: null },
          status: { in: ['PENDIENTE', 'REALIZANDO'] },
          scheduledFor: { gt: fin },
        },
        _count: { _all: true },
        _min: { scheduledFor: true },
      }),
      /*
       * «¿Y esta de quién es?» cuando la orden buscada NO está en la semana que se
       * mira. Sin esto, buscar por el apellido del abonado devolvía una rejilla
       * entera atenuada y ninguna respuesta — que es peor que no buscar.
       */
      hayFiltro
        ? this.prisma.ticket.findMany({
            where: this.fueraDelTramo(partido, mias, inicio, fin, hoy),
            select: AgendaService.TARJETA,
            orderBy: { scheduledFor: 'asc' },
            take: AgendaService.TOPE_FUERA,
          })
        : Promise.resolve([]),
    ]);

    const bandejaPorId = new Map(filasBandeja.map((f) => [f.id, f]));
    const sinAgendar = idsBandeja.flatMap((id) => bandejaPorId.get(id) ?? []);

    // Último recurso, igual que en `tablero()`. OJO: aquí NO vale mirar si
    // `agendadas` está vacío —esa lista es la REJILLA ENTERA de la semana, sin
    // filtrar por texto a propósito (es lo que se atenúa, no se recorta), así que
    // casi nunca está vacía y la comprobación diría siempre "ya se encontró algo"
    // aunque el texto no coincidiera con nada. Hace falta preguntar aparte si hay
    // algo ABIERTO que SÍ coincida dentro de la semana que se ve.
    const hayAbiertaEnLaSemana = hayFiltro
      ? (await this.prisma.ticket.count({
          where: { AND: [enSede(rango), deBandeja, { status: { in: ['PENDIENTE', 'REALIZANDO'] } }] },
        })) > 0
      : false;
    const cerradas =
      q && !sinAgendar.length && !fueraCrudo.length && !hayAbiertaEnLaSemana
        ? await this.cerradasQueCoinciden(mias, deBandeja, enteroBuscable(q))
        : [];

    const barrios = await this.barriosDe([...sinAgendar, ...agendadas, ...fueraCrudo]);
    const hoyMs = hoy.getTime();
    const ejeDias = AgendaService.diasDelRango(inicio, fin);

    // Cuántas y desde cuándo, por técnico, más allá del tramo.
    const despues = new Map<string, { cuantas: number; primera: string | null }>();
    for (const g of despuesCrudo) {
      if (!g.assignedStaffId) continue;
      despues.set(g.assignedStaffId, {
        cuantas: g._count._all,
        primera: g._min.scheduledFor?.toISOString().slice(0, 10) ?? null,
      });
    }

    // Las tarjetas de cada casilla, en el orden en que se van a atender.
    const porCasilla = new Map<string, any[]>();
    for (const t of agendadas) {
      if (!t.assignedStaffId || !t.scheduledFor) continue;
      const celda = casillas.dia.get(t.id);
      // Una visita atrasada cuya casilla (hoy) queda fuera del tramo que se mira:
      // se deja pasar en vez de pintarla en un día que no es el suyo.
      if (!celda || !ejeDias.includes(celda)) continue;
      const clave = `${t.assignedStaffId}|${celda}`;
      const lista = porCasilla.get(clave) ?? [];
      lista.push(t);
      porCasilla.set(clave, lista);
    }

    return {
      desde: inicio.toISOString().slice(0, 10),
      hasta: fin.toISOString().slice(0, 10),
      dias: ejeDias,
      hoy: hoy.toISOString().slice(0, 10),
      filtrando,
      /** Las sedes ofrecibles y la elegida. Mismo contrato que `tablero()`. */
      sedes,
      sede,
      /**
       * El texto que se está buscando, devuelto tal cual. La rejilla NO viene
       * recortada por él: la pantalla lo usa para atenuar lo que no coincide, que
       * es lo que deja ver de quién es la orden sin vaciar las casillas de al lado.
       */
      q,
      tipos: AgendaService.tiposDe(tiposCrudos),
      sinAgendar: await Promise.all(sinAgendar.map((f) => this.tarjeta(f, barrios, hoyMs, null))),
      sinAgendarTotal: totalBandeja,
      sinAgendarSinFiltro: sinFiltro,
      /** Las que coinciden pero caen FUERA del tramo: de quién son y para cuándo. */
      fuera: await Promise.all(fueraCrudo.map((f) => this.tarjeta(f, barrios, hoyMs, null))),
      /** Igual que en `tablero()`: lo ya RESUELTO/ANULADO, sólo como último recurso. */
      cerradas,
      columnas: await Promise.all(
        tecnicos.map(async (t) => ({
          staffId: t.id,
          nombre: t.name,
          /** Lo que tiene más allá del tramo, con la primera fecha (adonde salta). */
          despues: despues.get(t.id) ?? { cuantas: 0, primera: null },
          dias: Object.fromEntries(
            await Promise.all(
              ejeDias.map(async (d) => {
                const clave = `${t.id}|${d}`;
                const carga = casillas.carga.get(clave) ?? { total: 0, pendientes: 0, atrasadas: 0 };
                const ordenes = await Promise.all(
                  (porCasilla.get(clave) ?? []).map((f) =>
                    this.tarjeta(f, barrios, hoyMs, casillas.puesto.get(f.id)),
                  ),
                );
                return [d, { ordenes, ...carga }] as const;
              }),
            ),
          ),
        })),
      ),
    };
  }

  /** Cuántas coincidencias de fuera del tramo se devuelven. Es una pista, no un listado. */
  private static readonly TOPE_FUERA = 25;

  /**
   * Las órdenes que coinciden con el filtro pero NO se pintan en el tramo que se
   * está mirando. Contesta la única pregunta que la rejilla no puede contestar:
   * «¿y esta de quién es?» cuando la orden está agendada para otra semana.
   *
   * Qué queda dentro y qué queda fuera, que no es obvio:
   *
   *  · Lo de MÁS ADELANTE (después del último día) siempre queda fuera de la
   *    rejilla, así que siempre entra aquí.
   *  · Lo ATRASADO solo queda fuera si el tramo NO contiene a hoy: cuando sí lo
   *    contiene, `celdaDelDia` ya lo arrastra a la casilla de hoy y la orden se ve
   *    —repetirla aquí sería decir dos veces lo mismo—.
   *  · Se acota a las sedes de quien busca con la MISMA regla que la bandeja (la
   *    sede del abonado, y las órdenes sin abonado a la vista de todos). Sin eso,
   *    teclear un apellido enseñaría dónde quedó una orden de otra sede.
   */
  private fueraDelTramo(
    filtro: FiltroPartido,
    mias: number[],
    inicio: Date,
    fin: Date,
    hoy: Date,
  ): Prisma.TicketWhereInput {
    const hoyDentro = hoy.getTime() >= inicio.getTime() && hoy.getTime() <= fin.getTime();
    return {
      AND: [
        ...AgendaService.todas(filtro),
        { assignedStaffId: { not: null } },
        { status: { in: ['PENDIENTE', 'REALIZANDO'] } },
        hoyDentro
          ? { scheduledFor: { gt: fin } }
          : { OR: [{ scheduledFor: { gt: fin } }, { scheduledFor: { lt: inicio } }] },
        ...(mias.length
          ? [{
              OR: [
                { subscriber: { branch: { legacyId: { in: mias } } } },
                { subscriber: { is: null } },
              ],
            } satisfies Prisma.TicketWhereInput]
          : []),
      ],
    };
  }


  /**
   * Las filas planas del agendamiento para el Excel: de un DÍA o de un RANGO
   * (la semana que se está repartiendo, el mes entero).
   *
   * Por qué existe (2026-08-29, a pedido del usuario: «no sale el cliente, ni
   * dirección de donde es»): el Excel es el papel que se lleva a la calle. Quien lo
   * imprime no necesita el tablero —eso ya lo tiene en pantalla—, necesita A QUIÉN
   * hay que visitar y DÓNDE queda: nombre, abonado, teléfono, dirección, barrio y
   * sede. Por eso la fila no es un resumen de la tarjeta sino la tarjeta ENTERA con
   * los datos del abonado ya resueltos (la dirección se arma de `nomenclature`, que
   * es la que sirve para llegar; `addressLine` está vacío en casi todas).
   *
   * Sale a un método aparte —y no del `tablero`— porque el tablero es de UN día y
   * las otras dos vistas miran tramos: exportar la semana pidiendo siete tableros
   * sería siete veces el mismo trabajo, y el mes cuarenta y dos.
   *
   * Respeta lo mismo que la pantalla: el alcance por sede, los filtros puestos y la
   * regla de lo ATRASADO —lo que quedó abierto de días anteriores se lista en el día
   * en que hay que hacerlo, con su fecha original en "Atrasada desde"—.
   *
   * Al final van las órdenes SIN AGENDAR (la bandeja), porque la pregunta que sigue a
   * "qué hay repartido" es siempre "y qué falta por repartir".
   */
  async filasExport(user: AuthUser, desde?: string, hasta?: string, filtros?: FiltrosAgenda) {
    const inicio = this.diaDe(desde);
    const fin = hasta?.trim() ? this.diaDe(hasta) : inicio;
    if (fin.getTime() < inicio.getTime()) {
      throw new BadRequestException('El rango va al revés: la fecha final es anterior a la inicial.');
    }
    if (AgendaService.diasDelRango(inicio, fin).length > AgendaService.TOPE_DIAS) {
      throw new BadRequestException(`El Excel no puede pedir más de ${AgendaService.TOPE_DIAS} días de una vez.`);
    }

    const hoy = hoyEnColombia();
    const { mias, enSede } = await this.alcance(user, filtros?.sede);
    const filtro = AgendaService.todas(await this.filtroDeOrdenes(filtros));
    const conFiltro = filtro.length ? { AND: filtro } : {};
    // El alcance por sede va FUERA del filtro, igual que en el tablero: mezclarlos
    // dejaría que el primer texto tecleado abriera las órdenes de las otras sedes.
    const rango = enSede(whereDelRango(inicio, fin, hoy));

    const { ids: idsBandeja } = await this.bandeja(mias, conFiltro);
    const [agendadas, filasBandeja, casillas, tecnicos] = await Promise.all([
      this.prisma.ticket.findMany({
        where: { AND: [rango, conFiltro] },
        select: AgendaService.TARJETA,
        orderBy: ORDEN_AGENDA,
      }),
      idsBandeja.length
        ? this.prisma.ticket.findMany({ where: { id: { in: idsBandeja } }, select: AgendaService.TARJETA })
        : [],
      // El puesto de cada visita se cuenta sobre la casilla COMPLETA (sin filtro):
      // el técnico hará la 4 en cuarto lugar aunque el Excel solo lleve las urgentes.
      this.casillas(rango, hoy),
      this.columnasDe(mias, rango),
    ]);

    // `id IN (...)` no garantiza orden: se recompone el de la bandeja (urgente y
    // viejo delante), que es el orden en el que hay que repartirla.
    const porId = new Map(filasBandeja.map((f) => [f.id, f]));
    const sinAgendar = idsBandeja.flatMap((id) => porId.get(id) ?? []);

    const barrios = await this.barriosDe([...agendadas, ...sinAgendar]);
    const hoyMs = hoy.getTime();
    // El nombre del técnico sale de su FICHA, no de `Ticket.assigned` (que guarda el
    // username del legacy: 'OmarTec'). Lo que no cruce con ninguna ficha se traduce,
    // y si tampoco cruza ahí se deja el texto crudo antes que dejar la fila sin dueño.
    const tr = await traductorDeTecnicos(this.prisma);
    const porStaff = new Map(tecnicos.map((t) => [t.id, t.name]));
    const nombreTecnico = (t: any): string =>
      (t.assignedStaffId ? porStaff.get(t.assignedStaffId) : null) ?? tr.nombre(t.assigned) ?? t.assigned ?? '';

    /**
     * Días que lleva abierta la orden. Es la columna "Espera" de la pantalla y la
     * mitad de la decisión al repartir: una de 27 días no espera otro día más.
     * Se cuenta contra HOY y no contra el día exportado — lo que se pregunta es
     * cuánto lleva esperando, no cuánto llevaba entonces.
     */
    const espera = (creada: Date | null | undefined): number | '' =>
      creada ? Math.max(0, Math.round((hoyMs - creada.getTime()) / 86_400_000)) : '';

    const fila = async (t: any, agendada: boolean) => ({
      ...(await this.tarjeta(t, barrios, hoyMs, casillas.puesto.get(t.id))),
      /** El día en que TOCA hacerla (lo atrasado cae en hoy); vacío si está sin agendar. */
      dia: agendada ? casillas.dia.get(t.id) ?? null : null,
      tecnico: nombreTecnico(t),
      espera: espera(t.created),
    });

    /*
     * Qué visitas entran, con la MISMA regla que la pantalla: las de los técnicos que
     * se pintan como columna (`columnasDe` ya resuelve el alcance por sede). Sin este
     * recorte el Excel enseñaría agendas de sedes que en el tablero no se ven, y sería
     * la única puerta del sistema por la que se sale del alcance.
     *
     * Las que tienen día pero NADIE asignado no salen en ninguna columna —agendar
     * asigna, así que vienen del legacy—: se dejan pasar acotadas por la sede del
     * abonado (la regla de la bandeja), porque son trabajo puesto para ese día y
     * callarlas en el papel es justo cómo se pierden.
     */
    const deMiSede = (t: any) =>
      !mias.length || t.subscriber == null || mias.includes(Number(t.subscriber?.branch?.legacyId ?? NaN));
    const visibles = agendadas.filter((t) =>
      t.assignedStaffId ? porStaff.has(t.assignedStaffId) : deMiSede(t),
    );

    const puestas = await Promise.all(visibles.map((t) => fila(t, true)));
    puestas.sort(
      (a, b) =>
        (a.dia ?? '').localeCompare(b.dia ?? '') ||
        a.tecnico.localeCompare(b.tecnico, 'es') ||
        (a.puesto ?? 0) - (b.puesto ?? 0),
    );

    return {
      desde: inicio.toISOString().slice(0, 10),
      hasta: fin.toISOString().slice(0, 10),
      filas: puestas,
      sinAgendar: await Promise.all(sinAgendar.map((t) => fila(t, false))),
    };
  }

  /**
   * El MES: cuántas visitas hay cada día y de quién, sin tarjetas.
   *
   * Es la mirada larga con la que se decide para cuándo agendar —"el martes está
   * cargado, mándalo al miércoles"—, así que lo que importa es el bulto por día y no
   * el detalle de cada visita. Para repartir se entra a la semana o al día.
   */
  async calendario(user: AuthUser, desde?: string, hasta?: string, filtros?: FiltrosAgenda) {
    const inicio = this.diaDe(desde);
    const fin = hasta?.trim() ? this.diaDe(hasta) : AgendaService.masDias(inicio, 41);
    if (fin.getTime() < inicio.getTime()) throw new BadRequestException('El rango va al revés: la fecha final es anterior a la inicial.');
    const dias = AgendaService.diasDelRango(inicio, fin);
    if (dias.length > AgendaService.TOPE_DIAS) {
      throw new BadRequestException(`El calendario no puede pedir más de ${AgendaService.TOPE_DIAS} días de una vez.`);
    }

    const hoy = hoyEnColombia();
    const rango = whereDelRango(inicio, fin, hoy);
    const mias = await this.sedesDelUsuario(user);
    const filtro = AgendaService.todas(await this.filtroDeOrdenes(filtros));
    const filtrando = filtro.length > 0;
    const conFiltro = filtrando ? { AND: filtro } : {};

    const bandejaBase = this.bandejaBase(mias);
    const deSede = AgendaService.enSedeDe(mias);
    const enSede = (w: Prisma.TicketWhereInput) => (deSede ? { AND: [w, deSede] } : w);
    const [tecnicos, filas, sinAgendar, tiposCrudos] = await Promise.all([
      this.columnasDe(mias, enSede(rango)),
      this.prisma.ticket.findMany({
        where: { ...rango, ...conFiltro },
        select: {
          id: true, assignedStaffId: true, scheduledFor: true, carriedFrom: true, status: true,
          // Para saber de qué sede es lo que NO tiene técnico: ver `cuenta` abajo.
          subscriber: { select: { branch: { select: { legacyId: true } } } },
        },
      }),
      this.prisma.ticket.count({ where: bandejaBase }),
      // Los mismos tipos que ofrecen las otras dos vistas: el filtro tiene que
      // comportarse igual se mire el día, la semana o el mes.
      this.prisma.ticket.groupBy({
        by: ['type', 'subject'],
        where: { OR: [bandejaBase, rango] },
        _count: { _all: true },
      }),
    ]);

    const nombres = new Map(tecnicos.map((t) => [t.id, t.name]));
    /*
     * Qué visitas cuenta el mes, con la MISMA regla que el Excel (`filasExport`): las
     * de los técnicos que se pintan como columna, que es donde ya está resuelto el
     * alcance por sede. Sin esto el calendario de la cajera de Villanueva sumaba el
     * trabajo de Yopal en el total de cada día y le sacaba filas '—' de técnicos que
     * no son suyos: los números decidían para cuándo agendar y no eran los suyos.
     *
     * Las que tienen día pero NADIE asignado no salen de ninguna columna (agendar
     * asigna, así que vienen del legacy): se cuentan acotadas por la sede del
     * abonado, que es la regla de la bandeja.
     */
    const deMiSede = (f: { subscriber: { branch: { legacyId: number | null } | null } | null }) =>
      !mias.length || f.subscriber == null || mias.includes(Number(f.subscriber.branch?.legacyId ?? NaN));
    type Cuenta = { total: number; pendientes: number; atrasadas: number; porTecnico: Map<string, number> };
    const porDia = new Map<string, Cuenta>(dias.map((d) => [d, { total: 0, pendientes: 0, atrasadas: 0, porTecnico: new Map() }]));
    for (const f of filas) {
      if (!f.scheduledFor) continue;
      if (f.assignedStaffId ? !nombres.has(f.assignedStaffId) : !deMiSede(f)) continue;
      const celda = celdaDelDia(f.scheduledFor, f.status, hoy);
      const c = porDia.get(celda);
      if (!c) continue; // atrasada cuya casilla (hoy) cae fuera del mes que se mira
      c.total += 1;
      if (f.status === 'PENDIENTE' || f.status === 'REALIZANDO') c.pendientes += 1;
      if (origenDelDia(f) !== celda) c.atrasadas += 1;
      if (f.assignedStaffId) c.porTecnico.set(f.assignedStaffId, (c.porTecnico.get(f.assignedStaffId) ?? 0) + 1);
    }

    return {
      desde: inicio.toISOString().slice(0, 10),
      hasta: fin.toISOString().slice(0, 10),
      hoy: hoy.toISOString().slice(0, 10),
      filtrando,
      sinAgendar,
      tipos: AgendaService.tiposDe(tiposCrudos),
      tecnicos: tecnicos.map((t) => ({ staffId: t.id, nombre: t.name })),
      dias: dias.map((d) => {
        const c = porDia.get(d)!;
        return {
          fecha: d,
          total: c.total,
          pendientes: c.pendientes,
          atrasadas: c.atrasadas,
          // Ordenado por carga: en una casilla de calendario solo caben dos o tres
          // nombres, y los que hay que ver son los que llevan más encima.
          porTecnico: [...c.porTecnico.entries()]
            .map(([staffId, n]) => ({ staffId, nombre: nombres.get(staffId) ?? '—', total: n }))
            .sort((a, b) => b.total - a.total || a.nombre.localeCompare(b.nombre, 'es')),
        };
      }),
    };
  }

  /**
   * Los tipos que se ofrecen en el filtro: los que de verdad hay, con cuántos de cada
   * uno. Salen de las órdenes existentes y no de una lista escrita a mano —el legacy
   * tiene decenas de detalles y el bot inventa los suyos—, así que ninguna opción
   * devuelve vacío.
   */
  private static tiposDe(crudos: { type: string; subject: string; _count: { _all: number } }[]) {
    const porTipo = new Map<string, { tipo: string; clase: string; total: number; suClase: number }>();
    for (const g of crudos) {
      const tipo = (g.type || '').trim();
      if (!tipo) continue;
      const n = g._count._all;
      const y = porTipo.get(tipo.toLowerCase());
      if (!y) porTipo.set(tipo.toLowerCase(), { tipo, clase: g.subject, total: n, suClase: n });
      else {
        y.total += n;
        if (n > y.suClase) { y.suClase = n; y.clase = g.subject; }
      }
    }
    return [...porTipo.values()]
      .map(({ tipo, clase, total }) => ({ tipo, clase, total }))
      .sort((a, b) => b.total - a.total || a.tipo.localeCompare(b.tipo, 'es'));
  }

  /**
   * Nadie agenda fuera de su sede.
   *
   * La pantalla ya sólo ofrece las columnas del alcance (`columnasDe`), pero la
   * pantalla no es el candado: `mover` recibe un `staffId` suelto y sin esto una
   * cajera de Villanueva podía cargarle el día a un técnico de Yopal llamando a la
   * API a mano. Se comprueba con la misma vara que pinta las columnas, para que lo
   * que se puede guardar sea exactamente lo que se puede ver.
   */
  private async puedeAgendarA(user: AuthUser, staff: { sedeAccede: string | null }) {
    const mias = await this.sedesDelUsuario(user);
    if (!esDeMisSedes(staff.sedeAccede, mias)) {
      throw new ForbiddenException('Ese técnico no es de tu sede.');
    }
  }

  /**
   * Mueve una orden dentro de la agenda: a la columna de un técnico en una posición,
   * o de vuelta a "sin agendar".
   *
   * Es UNA sola operación para todos los arrastres posibles (de la bandeja a un
   * técnico, entre técnicos, dentro de la misma columna, de vuelta a la bandeja)
   * porque el destino lo describe entero: quién, qué día y en qué puesto. Va en
   * transacción y renumera las columnas afectadas, que es lo que garantiza que dos
   * personas agendando a la vez no dejen la agenda con posiciones repetidas.
   */
  async mover(
    user: AuthUser,
    dto: {
      ticketId: string; staffId?: string | null; fecha?: string | null;
      antesDe?: string | null; despuesDe?: string | null; posicion?: number;
    },
  ) {
    if (esTecnicoDeCampo(user)) {
      throw new ForbiddenException('No puedes agendar órdenes: tú atiendes las que te agendan.');
    }
    const t = await this.prisma.ticket.findUnique({
      where: { id: dto.ticketId },
      select: { id: true, code: true, type: true, subscriberId: true, col: true, assignedStaffId: true, scheduledFor: true },
    });
    if (!t) throw new NotFoundException('Orden no encontrada');

    const desagendar = !dto.staffId || !dto.fecha;
    const destinoDia = desagendar ? null : this.diaDe(dto.fecha!);
    const staff = desagendar
      ? null
      : await this.prisma.staff.findUnique({ where: { id: dto.staffId! }, select: { id: true, name: true, username: true, banned: true, sedeAccede: true } });
    if (!desagendar && (!staff || staff.banned)) {
      throw new BadRequestException('Ese técnico no existe o ya no trabaja aquí.');
    }
    if (staff) await this.puedeAgendarA(user, staff);

    // Columnas que hay que renumerar: la de origen (si estaba agendada) y la de
    // destino. Se guardan ANTES de tocar nada, porque el update las cambia.
    const origen = t.scheduledFor && t.assignedStaffId ? { dia: t.scheduledFor, staffId: t.assignedStaffId } : null;

    await this.prisma.$transaction(async (tx) => {
      if (desagendar) {
        await tx.ticket.update({
          where: { id: t.id },
          // `carriedFrom` se limpia en todas las ramas: en cuanto una PERSONA la
          // mueve o la saca del día hay una decisión nueva detrás y deja de ser
          // arrastre. Si no, una orden reagendada para el jueves seguiría saliendo
          // "atrasada desde el 27" toda su vida.
          data: { scheduledFor: null, scheduledSeq: null, carriedFrom: null, scheduledById: null, scheduledByName: null, scheduledAt: null },
        });
      } else {
        // Agendar ASIGNA (ver la cabecera). `assignedAt` sólo se sella si cambia de
        // técnico: reordenar su propia agenda no le reinicia el reloj.
        const cambiaDeTecnico = t.assignedStaffId !== staff!.id;
        await tx.ticket.update({
          where: { id: t.id },
          data: {
            scheduledFor: destinoDia,
            carriedFrom: null,
            scheduledById: user.id,
            scheduledByName: user.name,
            scheduledAt: new Date(),
            assignedStaffId: staff!.id,
            assigned: staff!.name,
            // Cambiar de técnico ASIGNA, y `asignado` es columna del legacy: la orden
            // pasa a mandarla este sistema para que la ida no le devuelva el técnico
            // viejo (ver `Ticket.editedAt`). Reordenar y desagendar NO sellan: la
            // posición es de aquí, y sellar de más congela la orden frente al legacy
            // para siempre a cambio de nada.
            ...(cambiaDeTecnico
              ? { assignedAt: new Date(), editedAt: new Date(), editedBy: user.name }
              : {}),
            // Sin posición todavía: la pone `renumerar` de abajo insertándola donde
            // toca. Un número provisional aquí sería adivinar contra qué escala se
            // va a comparar, y ahí es donde se rompió la primera versión: "posición
            // 1" se escribía como 5 y la orden acababa tercera.
            scheduledSeq: null,
          },
        });
      }

      /**
       * Reescribe 1..N la columna (día + técnico). Si se pasa `meter`, la saca de la
       * lista y la vuelve a insertar en `enPos` — así "ponla de primera" es una
       * inserción de verdad y no una carrera entre números.
       */
      const renumerar = async (dia: Date, staffId: string, meter?: string, enPos?: number) => {
        const filas = await tx.ticket.findMany({
          where: { scheduledFor: dia, assignedStaffId: staffId, ...(meter ? { id: { not: meter } } : {}) },
          select: { id: true },
          orderBy: [{ scheduledSeq: 'asc' }, { created: 'asc' }],
        });
        const ids = filas.map((f) => f.id);
        if (meter) {
          const pos = Math.min(Math.max(1, enPos ?? ids.length + 1), ids.length + 1);
          ids.splice(pos - 1, 0, meter);
        }
        for (let i = 0; i < ids.length; i++) {
          await tx.ticket.update({ where: { id: ids[i] }, data: { scheduledSeq: i + 1 } });
        }
      };

      /**
       * Traduce la vecina (`antesDe` / `despuesDe`) al puesto que le toca DENTRO del
       * día destino.
       *
       * Sólo cuentan las del día destino. Desde que `agenda-arrastre` mueve de verdad
       * lo que quedó abierto, lo arrastrado YA es del día —tiene su fecha y su puesto
       * en la columna—, así que entra en la cuenta como cualquier otra y se puede
       * reordenar igual. Lo que queda fuera es lo que todavía conserva un día
       * anterior (las horas en que la tarea aún no ha corrido): ahí "ponla antes de
       * una atrasada" es, en lo que se puede, ponerla de primera de hoy — no hay forma
       * de meterla entre dos días sin cambiarle el día a alguna, y eso es una decisión
       * de la cajera, no un efecto de arrastrar una tarjeta.
       *
       * Se resuelve contra la columna COMPLETA, no contra lo que se ve: con un filtro
       * puesto la pantalla se salta visitas, y la vecina sigue siendo la de al lado
       * en pantalla.
       */
      const puestoDeVecina = async (dia: Date, staffId: string) => {
        const vecina = dto.antesDe || dto.despuesDe;
        if (!vecina || vecina === t.id) return dto.posicion;
        const filas = await tx.ticket.findMany({
          where: { ...whereDelDia(dia, hoyEnColombia()), assignedStaffId: staffId },
          select: { id: true, scheduledFor: true },
          orderBy: ORDEN_AGENDA,
        });
        const i = filas.findIndex((f) => f.id === vecina);
        if (i < 0) return dto.posicion;
        const hasta = filas.slice(0, dto.despuesDe ? i + 1 : i);
        const delDia = hasta.filter(
          (f) => f.id !== t.id && f.scheduledFor?.getTime() === dia.getTime(),
        );
        return delDia.length + 1;
      };

      if (destinoDia && staff) {
        await renumerar(destinoDia, staff.id, t.id, await puestoDeVecina(destinoDia, staff.id));
      }
      if (origen && !(destinoDia && staff && origen.staffId === staff.id && origen.dia.getTime() === destinoDia.getTime())) {
        await renumerar(origen.dia, origen.staffId);
      }
    });

    // El aviso al cliente ("tu caso ya tiene técnico") sólo cuando de verdad cambia
    // de manos, y fuera de la transacción: notificar no puede tumbar el agendamiento.
    if (staff && t.assignedStaffId !== staff.id) {
      this.events.emit(TICKET_ASIGNADO_EVENT, {
        ticketId: t.id, code: t.code, type: t.type, subscriberId: t.subscriberId,
        tecnico: staff.name, abiertaPor: t.col,
      } satisfies TicketAsignadoEvent);
    }

    return { id: t.id, agendada: !desagendar, fecha: destinoDia?.toISOString().slice(0, 10) ?? null };
  }

  /**
   * Cuántas órdenes se aceptan de una tacada.
   *
   * La bandeja nunca enseña más de 200, así que el tope no recorta nada de lo que la
   * cajera puede tener delante; está para que un cliente equivocado no mande media
   * base de datos en un POST.
   */
  private static readonly TOPE_LOTE = 200;

  /**
   * Agenda VARIAS órdenes al mismo técnico y día, de una sola vez (2026-08-14).
   *
   * Por qué existe: la bandeja de sin agendar trae del orden de 120 órdenes y
   * repartirlas era abrir el desplegable de cada tarjeta, una por una. La cajera
   * reparte por tandas —todo lo del barrio Centro, todas las instalaciones— y esa
   * tanda ya la sabe describir con los filtros que hay arriba; lo único que faltaba
   * era poder decir "estas, a él".
   *
   * Se reusa aquí y no se llama N veces a `mover` a propósito: cada `mover` abre su
   * transacción y renumera la columna entera, así que 40 órdenes eran 40 renumerados
   * del mismo día. Aquí es UNA transacción y UN renumerado al final.
   *
   * Las seleccionadas entran al FINAL de la columna del técnico y en el orden en que
   * las mandó la pantalla: es lo que la cajera está mirando, y respetarlo evita el
   * "las agendé y me salieron en otro orden". Lo de dentro de la columna no se toca.
   */
  async moverLote(
    user: AuthUser,
    dto: { ticketIds: string[]; staffId: string; fecha?: string | null },
  ) {
    if (esTecnicoDeCampo(user)) {
      throw new ForbiddenException('No puedes agendar órdenes: tú atiendes las que te agendan.');
    }
    // Se conserva el orden de llegada y se quitan los repetidos: la pantalla manda
    // lo que la cajera marcó, en el orden en que lo ve.
    const ids = [...new Set(dto.ticketIds ?? [])].filter((id) => typeof id === 'string' && id.trim());
    if (!ids.length) throw new BadRequestException('No hay órdenes seleccionadas.');
    if (ids.length > AgendaService.TOPE_LOTE) {
      throw new BadRequestException(`Son demasiadas de una vez: el máximo es ${AgendaService.TOPE_LOTE}.`);
    }

    const dia = this.diaDe(dto.fecha ?? undefined);
    const staff = await this.prisma.staff.findUnique({
      where: { id: dto.staffId },
      select: { id: true, name: true, banned: true, sedeAccede: true },
    });
    if (!staff || staff.banned) throw new BadRequestException('Ese técnico no existe o ya no trabaja aquí.');
    await this.puedeAgendarA(user, staff);

    const filas = await this.prisma.ticket.findMany({
      where: { id: { in: ids } },
      select: { id: true, code: true, type: true, subscriberId: true, col: true, assignedStaffId: true, scheduledFor: true },
    });
    const porId = new Map(filas.map((f) => [f.id, f]));
    const enOrden = ids.flatMap((id) => porId.get(id) ?? []);
    if (!enOrden.length) throw new NotFoundException('Ninguna de esas órdenes existe ya.');

    // Columnas de las que salen: si alguna venía agendada con otro técnico (o en otro
    // día), esa columna queda con un hueco en la numeración y hay que rehacerla.
    const origenes = new Map<string, { dia: Date; staffId: string }>();
    for (const t of enOrden) {
      if (t.scheduledFor && t.assignedStaffId) {
        origenes.set(`${t.assignedStaffId}|${t.scheduledFor.getTime()}`, { dia: t.scheduledFor, staffId: t.assignedStaffId });
      }
    }

    const ahora = new Date();
    await this.prisma.$transaction(async (tx) => {
      for (let i = 0; i < enOrden.length; i++) {
        const t = enOrden[i];
        const cambiaDeTecnico = t.assignedStaffId !== staff.id;
        await tx.ticket.update({
          where: { id: t.id },
          data: {
            scheduledFor: dia,
            carriedFrom: null,
            scheduledById: user.id,
            scheduledByName: user.name,
            scheduledAt: ahora,
            assignedStaffId: staff.id,
            assigned: staff.name,
            // Posición provisional MUY alta y en el orden de la selección: el
            // renumerado de abajo las deja 1..N detrás de las que ya estaban, sin
            // tener que saber aquí cuántas eran ni en qué puesto van.
            scheduledSeq: 1_000_000 + i,
            ...(cambiaDeTecnico ? { assignedAt: ahora, editedAt: ahora, editedBy: user.name } : {}),
          },
        });
      }

      const renumerar = async (d: Date, staffId: string) => {
        const filas = await tx.ticket.findMany({
          where: { scheduledFor: d, assignedStaffId: staffId },
          select: { id: true },
          orderBy: [{ scheduledSeq: 'asc' }, { created: 'asc' }],
        });
        for (let i = 0; i < filas.length; i++) {
          await tx.ticket.update({ where: { id: filas[i].id }, data: { scheduledSeq: i + 1 } });
        }
      };

      await renumerar(dia, staff.id);
      for (const o of origenes.values()) {
        if (o.staffId === staff.id && o.dia.getTime() === dia.getTime()) continue;
        await renumerar(o.dia, o.staffId);
      }
    });

    // Igual que en `mover`: el aviso al cliente sólo si de verdad cambia de manos, y
    // fuera de la transacción.
    for (const t of enOrden) {
      if (t.assignedStaffId === staff.id) continue;
      this.events.emit(TICKET_ASIGNADO_EVENT, {
        ticketId: t.id, code: t.code, type: t.type, subscriberId: t.subscriberId,
        tecnico: staff.name, abiertaPor: t.col,
      } satisfies TicketAsignadoEvent);
    }

    return {
      agendadas: enOrden.length,
      // Las que ya no existían: la pantalla lo dice en vez de callarse una diferencia
      // entre lo que marcó y lo que se agendó.
      omitidas: ids.length - enOrden.length,
      tecnico: staff.name,
      fecha: dia.toISOString().slice(0, 10),
    };
  }


  /**
   * ¿En qué orden le conviene hacer el día a este técnico? (2026-09-03)
   *
   * Nace de una pregunta directa del usuario: "que la IA recomiende las órdenes
   * más cercanas entre sí, para que el recorrido sea algo controlado". Esto es
   * esa recomendación, y conviene decir qué la calcula: **no un modelo de
   * lenguaje**, sino `recorrido.policy.ts` — vecino más cercano + 2-opt sobre las
   * distancias reales de OSRM. Determinista, instantáneo y siempre el mismo
   * resultado para la misma agenda, que es imprescindible cuando lo que se
   * propone acaba siendo el orden que el técnico está OBLIGADO a seguir
   * (`turno.ts`).
   *
   * **Propone, no aplica.** Devuelve la lista con el orden sugerido y los metros
   * que ahorra; escribir es otra llamada (`aplicarRecorrido`) que hace la
   * persona. Reordenarle el día a un técnico a espaldas de la cajera sería
   * cambiarle el trabajo a alguien que ya salió a la calle.
   *
   * De dónde sale cada punto, por orden:
   *  1. El GPS del abonado, cuando lo tiene (61 de 242 órdenes de campo abiertas).
   *  2. El CENTROIDE DE SU BARRIO, que es lo que sube la cobertura al 85%. Es
   *     bueno para decidir "esta queda de camino y esta no" y NO vale para nada
   *     más: la propuesta se marca `aproximado` y la pantalla tiene que decirlo.
   *  3. Nada: la orden va al final de la lista, dicha por su nombre.
   */
  async recorrido(user: AuthUser, staffId: string, fecha?: string) {
    if (esTecnicoDeCampo(user)) {
      throw new ForbiddenException('No puedes reordenar agendas: tú atiendes las que te agendan.');
    }
    const staff = await this.prisma.staff.findUnique({
      where: { id: staffId },
      select: { id: true, name: true, sedeAccede: true },
    });
    if (!staff) throw new NotFoundException('Ese técnico no existe.');
    await this.puedeAgendarA(user, staff);

    const dia = this.diaDe(fecha);
    // Sólo las de ESE día, sin el arrastre de lectura de `delDia`: lo que se va a
    // reescribir es `scheduledSeq`, que numera dentro de un día. Meter aquí lo
    // atrasado de otros días sería renumerar agendas pasadas (ver `agenda-dia.ts`).
    const filas = await this.prisma.ticket.findMany({
      where: { scheduledFor: dia, assignedStaffId: staff.id },
      orderBy: [{ scheduledSeq: 'asc' }, { created: 'asc' }],
      select: {
        id: true, code: true, type: true, subject: true, status: true, priority: true,
        scheduledSeq: true,
        subscriber: {
          select: {
            id: true, abonado: true, fullName: true, companyName: true, firstName: true, lastName1: true,
            gpsLat: true, gpsLng: true, neighborhood: true, nomenclature: true, addressLine: true,
          },
        },
      },
    });
    if (!filas.length) {
      return { tecnico: staff.name, fecha: dia.toISOString().slice(0, 10), visitas: [], sinCambios: true, motivo: 'Ese día no tiene visitas agendadas.' };
    }

    const centroides = await this.centroidesDeBarrio(filas.map((f) => f.subscriber?.neighborhood ?? null));

    const paradas: Parada[] = filas.map((f) => {
      // Sólo el TRABAJO DE CAMPO entra en el recorrido. Un 'Cambio de clave' o un
      // 'Subir megas' se hacen desde la oficina, sin moverse: meterlos en la ruta
      // es inventar un viaje que nadie hace y desordenar por él los que sí. Se
      // vio en la primera prueba real —una jornada con seis visitas de las que
      // tres eran administrativas— y salían 500 km de recorrido.
      const campo = esTrabajoDeCampo(f.type);
      const exacta = campo ? parsePoint(f.subscriber?.gpsLat, f.subscriber?.gpsLng) : null;
      const barrio = campo && f.subscriber?.neighborhood
        ? centroides.get(String(f.subscriber.neighborhood).trim())
        : null;
      return {
        id: f.id,
        punto: exacta ?? barrio?.punto ?? null,
        exacto: Boolean(exacta),
        // Lo que ya está en marcha o cerrado no se toca: el técnico ya salió
        // hacia ello y reordenarlo sería reescribir un recorrido que ya ocurrió.
        fija: f.status !== 'PENDIENTE',
      };
    });

    // Sin al menos dos visitas PENDIENTES y ubicadas no hay recorrido que
    // proponer, y decirlo es mejor que devolver "ya estaban en el mejor orden":
    // son dos situaciones distintas y la segunda suena a que se calculó algo.
    const movibles = paradas.filter((p) => !p.fija && p.punto);
    if (movibles.length < 2) {
      const pendientes = filas.filter((f) => f.status === 'PENDIENTE');
      const deCampo = pendientes.filter((f) => esTrabajoDeCampo(f.type)).length;
      return {
        tecnico: staff.name,
        fecha: dia.toISOString().slice(0, 10),
        visitas: [],
        sinCambios: true,
        motivo:
          deCampo < 2
            ? 'Ese día no le quedan dos visitas de campo pendientes: no hay recorrido que ordenar.'
            : 'No se pudo ubicar suficientes visitas de ese día: ni los abonados tienen GPS ni sus barrios tienen punto.',
      };
    }

    const inicio = await this.dondeArranca(staff.id, dia);
    const { dist, porCarretera } = await this.distanciaEntre(inicio, paradas);
    const r = proponerRecorrido(inicio, paradas, dist);

    const porId = new Map(filas.map((f) => [f.id, f]));
    const barrioNombre = new Map([...centroides].map(([k, v]) => [k, v.nombre]));
    const puestoActual = new Map(filas.map((f, i) => [f.id, i + 1]));

    return {
      tecnico: staff.name,
      fecha: dia.toISOString().slice(0, 10),
      /** `true` = ya estaban en el mejor orden que se sabe calcular. */
      sinCambios: r.orden.every((id, i) => filas[i]?.id === id),
      metrosAntes: r.metrosAntes,
      metrosDespues: r.metrosDespues,
      /** Metros que se ahorra. Nunca negativo: la propuesta no empeora. */
      ahorroM: Math.max(0, r.metrosAntes - r.metrosDespues),
      /** `true` = distancias reales por carretera; `false` = línea recta (OSRM no respondió). */
      porCarretera,
      /** `true` = alguna visita se ubicó por el centroide de su barrio, no por su casa. */
      aproximado: r.aproximado,
      visitas: r.orden.map((id, i) => {
        const f = porId.get(id)!;
        const p = paradas.find((x) => x.id === id)!;
        const nb = f.subscriber?.neighborhood ? String(f.subscriber.neighborhood).trim() : '';
        return {
          id: f.id,
          code: f.code,
          tipo: f.type,
          estado: f.status,
          prioridad: f.priority,
          cliente: AgendaService.nombreAbonado(f.subscriber as any),
          abonado: f.subscriber?.abonado ?? null,
          direccion: f.subscriber ? direccionDe(f.subscriber as any) : null,
          barrio: barrioNombre.get(nb) ?? null,
          puestoActual: puestoActual.get(id) ?? null,
          puestoPropuesto: i + 1,
          fija: Boolean(p.fija),
          /**
           * `exacto` = GPS de la casa · `barrio` = centroide del barrio ·
           * `remota` = no es trabajo de campo, se hace sin salir · `null` = es de
           * campo pero no se pudo ubicar.
           */
          ubicacion: p.punto
            ? (p.exacto ? 'exacto' : 'barrio')
            : (esTrabajoDeCampo(f.type) ? null : 'remota'),
        };
      }),
    };
  }

  /**
   * Escribe el orden propuesto. Es la otra mitad de `recorrido()`: allí se mira,
   * aquí se guarda, y las dos cosas las decide una persona.
   *
   * Exige la lista COMPLETA del día y comprueba que sea exactamente la que hay en
   * la base. Si alguien agendó otra visita mientras la cajera miraba la
   * propuesta, aplicar "las que yo tenía" dejaría la columna con huecos o con dos
   * en el mismo puesto — justo el estado que el renumerado entero existe para
   * hacer imposible. Vale más un mensaje que decir "se aplicó" y mentir.
   */
  async aplicarRecorrido(
    user: AuthUser,
    dto: { staffId: string; fecha?: string | null; ticketIds: string[] },
  ) {
    if (esTecnicoDeCampo(user)) {
      throw new ForbiddenException('No puedes reordenar agendas: tú atiendes las que te agendan.');
    }
    const staff = await this.prisma.staff.findUnique({
      where: { id: dto.staffId },
      select: { id: true, name: true, sedeAccede: true },
    });
    if (!staff) throw new NotFoundException('Ese técnico no existe.');
    await this.puedeAgendarA(user, staff);

    const dia = this.diaDe(dto.fecha ?? undefined);
    const ids = [...new Set(dto.ticketIds ?? [])].filter((id) => typeof id === 'string' && id.trim());
    if (!ids.length) throw new BadRequestException('No hay visitas que reordenar.');

    const filas = await this.prisma.ticket.findMany({
      where: { scheduledFor: dia, assignedStaffId: staff.id },
      select: { id: true },
    });
    const enBase = new Set(filas.map((f) => f.id));
    const mismas = ids.length === enBase.size && ids.every((id) => enBase.has(id));
    if (!mismas) {
      throw new BadRequestException(
        'La agenda de ese día cambió mientras mirabas la propuesta. Vuelve a calcularla.',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      for (let i = 0; i < ids.length; i++) {
        await tx.ticket.update({ where: { id: ids[i] }, data: { scheduledSeq: i + 1 } });
      }
    });

    return { reordenadas: ids.length, tecnico: staff.name, fecha: dia.toISOString().slice(0, 10) };
  }

  /**
   * Quién tiene ya trabajo en cada barrio ese día.
   *
   * Es la OTRA recomendación, y la más barata de las dos: al repartir, saber que
   * "Óscar ya tiene 3 en Villa Sofía el jueves" evita el viaje antes de crearlo.
   * Ordenar bien un día que se repartió mal sólo puede recortar el zigzag; no
   * mandar a dos técnicos al mismo barrio ahorra el desplazamiento entero.
   */
  async zonasDelDia(user: AuthUser, fecha?: string) {
    const mias = await this.sedesDelUsuario(user);
    const dia = this.diaDe(fecha);
    const filas = await this.prisma.ticket.findMany({
      where: {
        ...this.delDia(dia),
        assignedStaffId: { not: null },
        status: { in: [...ABIERTA] },
      },
      select: { assignedStaffId: true, subscriber: { select: { neighborhood: true } } },
    });

    const porTecnico: Record<string, Record<string, number>> = {};
    const barrios = new Set<string>();
    for (const f of filas) {
      const nb = f.subscriber?.neighborhood ? String(f.subscriber.neighborhood).trim() : '';
      if (!nb || !f.assignedStaffId) continue;
      barrios.add(nb);
      const m = (porTecnico[f.assignedStaffId] ??= {});
      m[nb] = (m[nb] ?? 0) + 1;
    }

    const nombres = await this.centroidesDeBarrio([...barrios]);
    return {
      fecha: dia.toISOString().slice(0, 10),
      /** `{ staffId: { barrioLegacyId: cuántas } }` */
      porTecnico,
      /** `{ barrioLegacyId: nombre }`, para que la pantalla no vuelva a preguntar. */
      barrios: Object.fromEntries([...nombres].map(([k, v]) => [k, v.nombre])),
      // El alcance por sede va implícito: `delDia` no lo aplica, pero la pantalla
      // sólo pregunta por técnicos que ya vio en `columnasDe`, que sí lo aplica.
      sedes: mias.length,
    };
  }

  /** Centroide y nombre de cada barrio pedido, indexados por su id legacy en texto. */
  private async centroidesDeBarrio(claves: (string | null)[]) {
    const ids = [...new Set(claves.map((c) => (c ? String(c).trim() : '')).filter(Boolean))];
    const numericos = ids.map(Number).filter((n) => Number.isFinite(n));
    if (!numericos.length) return new Map<string, { punto: { lat: number; lng: number } | null; nombre: string }>();
    const filas = await this.prisma.neighborhood.findMany({
      where: { legacyId: { in: numericos } },
      select: { legacyId: true, name: true, lat: true, lng: true },
    });
    return new Map(
      filas.map((b) => [
        String(b.legacyId),
        {
          punto: b.lat != null && b.lng != null ? { lat: b.lat, lng: b.lng } : null,
          nombre: b.name,
        },
      ]),
    );
  }

  /**
   * De dónde sale el técnico. Sólo para HOY y sólo si el rastro es reciente: un
   * punto de ayer no dice dónde está esta mañana, y arrancar la ruta desde ahí
   * sería peor que no arrancarla de ningún sitio (sin punto de partida, la
   * heurística prueba todas las salidas y se queda con la mejor).
   */
  private async dondeArranca(staffId: string, dia: Date) {
    if (dia.getTime() !== hoyEnColombia().getTime()) return null;
    const desde = new Date(Date.now() - 4 * 60 * 60 * 1000);
    const ping = await this.prisma.geoPing.findFirst({
      where: { staffId, createdAt: { gte: desde } },
      orderBy: { createdAt: 'desc' },
      select: { lat: true, lng: true },
    });
    return ping ? { lat: ping.lat, lng: ping.lng } : null;
  }

  /**
   * La función de distancia con la que se ordena: metros REALES por carretera si
   * OSRM responde, línea recta si no.
   *
   * La diferencia no es cosmética. En una ciudad con un río, una vía o sentidos
   * únicos, dos visitas a 300 m en línea recta pueden estar a 2 km de recorrido,
   * y el orden que se le propone al técnico cambia. Pero tampoco se depende de
   * OSRM: si no está, se ordena en recta —que agrupa por zonas igual de bien— y
   * la respuesta lo dice con `porCarretera:false` para que nadie discuta unos
   * metros que son aproximados.
   */
  private async distanciaEntre(inicio: { lat: number; lng: number } | null, paradas: Parada[]) {
    const clave = (p: { lat: number; lng: number }) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
    // Se deduplican: varias visitas del mismo barrio comparten centroide, y sin
    // esto una jornada de 8 en dos barrios gastaba 8 puntos de matriz en vez de 2.
    const unicos = new Map<string, { lat: number; lng: number }>();
    if (inicio) unicos.set(clave(inicio), inicio);
    for (const p of paradas) if (p.punto) unicos.set(clave(p.punto), p.punto);

    const puntos = [...unicos.values()];
    const matriz = await this.routing.matriz(puntos);
    if (!matriz) return { dist: metros, porCarretera: false };

    const indice = new Map([...unicos.keys()].map((k, i) => [k, i]));
    const dist = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
      const i = indice.get(clave(a));
      const j = indice.get(clave(b));
      return i != null && j != null ? matriz[i][j] : metros(a, b);
    };
    return { dist, porCarretera: true };
  }

  /**
   * "Llegué y no se pudo": aparta una visita del día y la devuelve a la cajera.
   *
   * NO cierra la orden ni la desasigna. La orden sigue PENDIENTE y sigue siendo del
   * técnico; lo único que cambia es que sale del día y vuelve a la bandeja de la
   * cajera con el motivo escrito, para que ella decida cuándo repetirla. Cerrar aquí
   * sería mentir en la estadística de campo — una visita que no ocurrió contaría
   * como atendida y le ensuciaría al técnico su propio indicador de re-visita.
   *
   * Sólo se aparta la que está EN TURNO (2026-09-02, con el turno de vuelta). Si se
   * pudiera apartar cualquiera, el técnico volvería a elegir el orden por la puerta
   * de atrás: apartaría las que no le apetecen hasta destapar la que quiere.
   */
  async noSePudoAtender(user: AuthUser, ticketId: string, motivo: string) {
    const razon = motivo?.trim();
    if (!razon) throw new BadRequestException('Escribe por qué no se pudo atender la visita.');
    if (razon.length > 300) throw new BadRequestException('El motivo es demasiado largo.');

    const staff = await this.staffDelUsuario(user);
    if (!staff) throw new ForbiddenException('Tu usuario no está ligado a una ficha de empleado.');

    const t = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      select: { id: true, assignedStaffId: true, scheduledFor: true, status: true },
    });
    if (!t) throw new NotFoundException('Orden no encontrada');
    if (t.assignedStaffId !== staff.id) throw new ForbiddenException('Esa orden no es tuya.');
    if (!t.scheduledFor) throw new BadRequestException('Esa visita no está agendada.');
    // Una visita ya cerrada no se aparta: sacarla del día le borraría a la cajera el
    // día en que de verdad se hizo, y al técnico su propio trabajo del tablero.
    if (!(ABIERTA as readonly string[]).includes(t.status)) {
      throw new BadRequestException('Esa visita ya está cerrada.');
    }
    // La que toca, y sólo esa: apartar es la salida cuando se llegó y no se pudo, no
    // un botón para saltarse el orden de la cajera. Al técnico exento del turno no se
    // le pide eso: si puede elegir qué visita hace, puede devolver la que no se pudo.
    if (!(await tieneAgendaLibre(this.prisma, staff.id))) {
      const turno = await visitaEnTurno(this.prisma, staff.id, hoyEnColombia());
      if (turno && turno !== t.id) {
        throw new ForbiddenException('Sólo puedes apartar la visita que tienes en turno.');
      }
    }

    const dia = t.scheduledFor;
    await this.prisma.$transaction(async (tx) => {
      await tx.ticket.update({
        where: { id: t.id },
        data: {
          scheduledFor: null,
          scheduledSeq: null,
          // Vuelve a la bandeja de la cajera: ya no está arrastrándose por los días,
          // está esperando a que alguien decida cuándo se repite.
          carriedFrom: null,
          skippedAt: new Date(),
          skippedReason: razon,
          skippedById: user.id,
          skippedByName: user.name,
        },
      });
      // El resto del día se renumera 1..N: dejar un hueco donde estaba haría que el
      // técnico viera "visita 2 de 5" con solo cuatro tarjetas y creyera que perdió una.
      const filas = await tx.ticket.findMany({
        where: { scheduledFor: dia, assignedStaffId: staff.id },
        select: { id: true },
        orderBy: [{ scheduledSeq: 'asc' }, { created: 'asc' }],
      });
      for (let i = 0; i < filas.length; i++) {
        await tx.ticket.update({ where: { id: filas[i].id }, data: { scheduledSeq: i + 1 } });
      }
    });

    return { ok: true };
  }

  /** La ficha de empleado del usuario. Mismo criterio (correo, o nombre de respaldo). */
  private staffDelUsuario(user: AuthUser) {
    return this.prisma.staff.findFirst({
      where: { banned: false, OR: [{ email: { equals: user.email, mode: 'insensitive' } }, { name: { equals: user.name, mode: 'insensitive' } }] },
      select: { id: true, name: true },
    });
  }

  /**
   * La agenda del técnico logueado para un día: sus órdenes en el orden que le puso
   * la cajera. Sin parámetros de alcance a propósito — quién es lo dice la sesión.
   *
   * Devuelve además `enTurno`: la única que puede abrir ahora mismo (2026-09-02, ver
   * `turno.ts`). Va calculada por la MISMA función que usa el candado del backend y
   * no por "la primera pendiente de esta lista": duplicar la regla es exactamente lo
   * que produce una pantalla que ofrece una visita y una API que la rechaza.
   */
  async miAgenda(user: AuthUser, fecha?: string) {
    const dia = this.diaDe(fecha);
    const staff = await this.staffDelUsuario(user);
    const vacia = { resolved: false, fecha: dia.toISOString().slice(0, 10), hoy: hoyEnColombia().toISOString().slice(0, 10), ordenes: [] as any[], proximas: 0, enTurno: null as string | null, turnoLibre: false };
    if (!staff) return vacia;
    // Exento del turno (`Staff.agendaLibre`): ve su jornada entera. Viaja como dato
    // propio y no como "enTurno = null" a secas, porque la pantalla necesita
    // distinguirlo de "ya no le queda nada abierto" — con null a secas pintaría el
    // cartel de día terminado teniendo seis visitas por hacer.
    const libre = await tieneAgendaLibre(this.prisma, staff.id);

    const [filas, proximas] = await Promise.all([
      this.prisma.ticket.findMany({
        where: { ...this.delDia(dia), assignedStaffId: staff.id },
        select: AgendaService.TARJETA,
        orderBy: ORDEN_AGENDA,
      }),
      // Lo que ya le agendaron para días siguientes: se cuenta, no se lista. Saber
      // que mañana hay trabajo puesto es útil; adelantarlo hoy, no.
      this.prisma.ticket.count({ where: { assignedStaffId: staff.id, scheduledFor: { gt: dia }, status: { in: ['PENDIENTE', 'REALIZANDO'] } } }),
    ]);
    const barrios = await this.barriosDe(filas);
    const hoyMs = hoyEnColombia().getTime();
    return {
      resolved: true,
      fecha: dia.toISOString().slice(0, 10),
      hoy: hoyEnColombia().toISOString().slice(0, 10),
      tecnico: staff.name,
      // Aquí `filas` ya es la jornada entera del técnico en su orden: el puesto es la
      // posición en la lista, no `scheduledSeq` (ver `puestosDelDia`).
      ordenes: await Promise.all(filas.map((f, i) => this.tarjeta(f, barrios, hoyMs, i + 1))),
      proximas,
      // Sólo para HOY. Consultar un día pasado es mirar el historial, y ahí no hay
      // turno que valga: si se devolviera el de hoy, la pantalla de otro día pintaría
      // como "tu visita ahora" una que no está en ella.
      enTurno:
        !libre && dia.getTime() === hoyEnColombia().getTime()
          ? await visitaEnTurno(this.prisma, staff.id, dia)
          : null,
      turnoLibre: libre,
    };
  }

  /**
   * "Lo que viene": las visitas que el técnico ya tiene agendadas para los PRÓXIMOS
   * días (2026-08-26, a pedido del usuario, junto con el calendario).
   *
   * Es un RESUMEN y empieza en mañana. Lo que resuelve es que el técnico pueda
   * organizarse —llevar material, saber que mañana le toca al otro lado del pueblo—
   * sin tener que llamar a la oficina a preguntar.
   *
   * No se lista lo de hoy: eso ya lo tiene delante, entero, en su agenda.
   */
  async misProximas(user: AuthUser, dias?: number) {
    const cuantos = Math.min(Math.max(Number(dias) || 7, 1), 30);
    const hoy = hoyEnColombia();
    const desde = AgendaService.masDias(hoy, 1);
    const hasta = AgendaService.masDias(hoy, cuantos);
    const staff = await this.staffDelUsuario(user);
    const vacia = { resolved: false, desde: desde.toISOString().slice(0, 10), hasta: hasta.toISOString().slice(0, 10), total: 0, dias: [] as any[] };
    if (!staff) return vacia;

    const filas = await this.prisma.ticket.findMany({
      where: {
        assignedStaffId: staff.id,
        scheduledFor: { gte: desde, lte: hasta },
        status: { in: ['PENDIENTE', 'REALIZANDO'] },
      },
      select: AgendaService.TARJETA,
      orderBy: ORDEN_AGENDA,
    });
    const barrios = await this.barriosDe(filas);

    const porDia = new Map<string, any[]>();
    for (const f of filas) {
      if (!f.scheduledFor) continue;
      const d = f.scheduledFor.toISOString().slice(0, 10);
      const lista = porDia.get(d) ?? [];
      lista.push(f);
      porDia.set(d, lista);
    }

    return {
      resolved: true,
      desde: desde.toISOString().slice(0, 10),
      hasta: hasta.toISOString().slice(0, 10),
      tecnico: staff.name,
      total: filas.length,
      // Solo los días que traen algo: una lista de siete días, cinco de ellos vacíos,
      // esconde los dos que importan.
      dias: await Promise.all(
        [...porDia.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(async ([fecha, fs]) => ({
            fecha,
            // El puesto es el de ESE día: aquí no hay arrastre de atrasadas que valga
            // —son días que todavía no han llegado—.
            ordenes: await Promise.all(fs.map((f, i) => this.tarjeta(f, barrios, hoy.getTime(), i + 1))),
          })),
      ),
    };
  }
}
