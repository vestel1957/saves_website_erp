import { ForbiddenException, NotFoundException } from '../core/http/errores';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { scopeDate } from '../common/date-scope';
import { AuthUser } from '../auth/current-user.decorator';
import { sedesDe, whereSedePorSuscriptor, exigirSedeSuscriptor } from '../common/sede-scope';
import { clavesDe, esTecnicoDeCampo, fichaDelUsuario } from '../common/tecnico-scope';
import { hoyEnColombia } from '../common/fecha-colombia';
import { textoPlano } from '../common/texto-legacy';
import { orden, paginacion } from '../common/pagination-params';
import { variosDeQuery } from '../common/filtros-query';
import { traductorDeTecnicos } from '../staff/nombre-tecnico';
import { formasDeSerial } from './onu-provision.service';
import { esTrabajoDeCampo } from './field-work.policy';
import { OrderScoreService } from './order-score.service';
import { direccionDe, referenciaDe } from '../common/subscriber-address';
import { ORDEN_CRONOLOGICO, porFecha } from './orden-cronologico';
import { DIAS_REZAGO, whereTrabajoDelDia } from './agenda-dia';
import { GeofenceService } from './geofence.service';
import { esOrdenDeCampo } from './geofence.policy';
import { faltaDocumentar } from './documentacion-cierre.policy';
import { esIpRemotaUtil, faltaLaIpRemota } from './ip-remota.policy';
import { esUsuarioPppUtil } from '../subscribers/conexion-alta';
import { esOrdenDeServicio, esReconexion } from './order-types';
import { mixPorAbonado } from '../common/servicios-del-abonado';
import { whereDeServicios } from './servicio-orden.filtro';

/**
 * Días tras los cuales una orden abierta se marca como vencida en el panel del
 * técnico. Es el mismo umbral que usa el tablero de rendimiento
 * (`reports/performance.service.ts`): si allí una orden de 8 días cuenta como
 * vencida, aquí tiene que verse roja, o el técnico se enteraría de su propio
 * atraso leyendo un informe de gerencia.
 */
const DIAS_VENCIMIENTO = 7;

/** Una orden tal como la ve el técnico en su panel. */
export type OrdenDeJornada = {
  id: string; code: number | null; subject: string; type: string; status: string;
  priority: string | null; problema: string | null; created: Date | null;
  diasAbierta: number | null; vencida: boolean; campo: boolean;
  client: string | null; subscriberId: string | null; abonado: number | null;
  address: string | null; phone: string | null; phone2: string | null; sede: string | null;
  gps: { lat: number; lng: number } | null;
};

/** Orden de atención de la prioridad. El campo es texto libre del legacy. */
const PRIORIDADES = ['urgente', 'alta', 'media', 'baja'];
export function rangoPrioridad(p: string | null | undefined): number {
  const i = PRIORIDADES.indexOf((p || '').trim().toLowerCase());
  return i < 0 ? PRIORIDADES.length : i; // lo que no reconozco va al final, no al principio
}

/**
 * El texto buscado leído como número, o `null` si no sirve para comparar contra una
 * columna numérica.
 *
 * El tope no es un capricho: `code` y `abonado` son `int` de 32 bits y Postgres
 * RECHAZA la consulta —500, no "sin resultados"— cuando se le manda un valor mayor.
 * Con eso basta un celular tecleado en el buscador (3145267065) para tumbar la
 * pantalla, que es exactamente como apareció. Se acepta '#5552' porque es como el
 * número de orden se lee en la tarjeta.
 */
export function enteroBuscable(texto: string): number | null {
  const limpio = texto.trim().replace(/^#/, '').trim();
  if (!/^\d+$/.test(limpio)) return null;
  const n = Number(limpio);
  return Number.isSafeInteger(n) && n <= 2147483647 ? n : null;
}

function subName(s: {
  firstName: string | null; secondName: string | null; lastName1: string | null;
  lastName2: string | null; companyName: string | null; fullName: string | null;
} | null): string | null {
  if (!s) return null;
  if (s.fullName && s.fullName.trim()) return s.fullName.trim();
  const p = [s.firstName, s.secondName, s.lastName1, s.lastName2].map((x) => (x || '').trim()).filter(Boolean).join(' ');
  return p || (s.companyName || '').trim() || null;
}
const SUB = { firstName: true, secondName: true, lastName1: true, lastName2: true, companyName: true, fullName: true, id: true, abonado: true } as const;

export class SupportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly puntajes: OrderScoreService,
    /**
     * Sólo para saber QUÉ TIPOS son de campo al decir en la ficha lo que hace falta
     * para cerrar la orden (`requisitosCierre`). Se lee de la misma fuente que usan
     * los candados del cierre —el ajuste `tickets.geofence.fieldTypes`— y no de una
     * lista propia: dos listas acabarían diciendo cosas distintas, y el síntoma
     * sería una pantalla que promete un cierre que la API rechaza.
     */
    private readonly geofence: GeofenceService,
  ) {}

  /**
   * Filtro "sólo mis órdenes" para un técnico de campo, o `null` si no hay que
   * acotar a nadie (2026-07-31: el técnico ve únicamente lo suyo).
   *
   * La asignación vive en DOS campos —el FK `assignedStaffId` y el texto libre
   * `assigned` heredado del legacy— y se buscan los dos, por lo mismo que explica
   * `miJornada`: mirar sólo el FK le esconde casi la mitad de su trabajo.
   *
   * Un técnico SIN ficha de empleado recibe un filtro imposible, no la lista
   * completa: si no se puede saber qué es suyo, no se le enseña lo de los demás.
   */
  private async soloMisOrdenes(user?: AuthUser, todoSuHistorial = false): Promise<Prisma.TicketWhereInput | null> {
    if (!esTecnicoDeCampo(user)) return null;
    const ficha = await fichaDelUsuario(this.prisma, user!);
    if (!ficha) return { id: '—sin-ficha-de-empleado—' };
    const claves = clavesDe(ficha);
    const suyas: Prisma.TicketWhereInput = {
      OR: [{ assignedStaffId: ficha.id }, ...(claves.length ? [{ assigned: { in: claves } }] : [])],
    };
    // Y de lo suyo, sólo el DÍA DE HOY (2026-09-10). Ver `whereTrabajoDelDia`: es la
    // misma definición de "hoy" que usa su agenda, más lo que cerró hoy. Lo de días
    // anteriores no se pierde — lo enseña su historial (`/mi-agenda/historial`), que
    // pasa `todoSuHistorial` porque justamente va a buscar lo de otros días.
    if (todoSuHistorial) return suyas;
    return { AND: [suyas, whereTrabajoDelDia(hoyEnColombia())] };
  }

  async stats(user?: AuthUser) {
    // Los contadores de la cabecera y el selector de técnicos hablan de lo que la
    // tabla de abajo va a mostrar: si la lista va acotada, esto también.
    const mias = await this.soloMisOrdenes(user);
    const suyas: Prisma.TicketWhereInput = mias ?? {};
    const [byStatus, byType, byTech, todos] = await Promise.all([
      this.prisma.ticket.groupBy({ by: ['status'], _count: { _all: true }, where: suyas }),
      this.prisma.ticket.groupBy({ by: ['type'], _count: { _all: true }, where: suyas, orderBy: { _count: { type: 'desc' } }, take: 10 }),
      this.prisma.ticket.groupBy({ by: ['assigned'], _count: { _all: true }, where: { AND: [suyas, { assigned: { not: null } }] }, orderBy: { _count: { assigned: 'desc' } }, take: 50 }),
      this.prisma.todoTask.count({ where: { status: { in: ['DUE', 'PROGRESS'] } } }),
    ]);
    const status: Record<string, number> = {};
    for (const r of byStatus) status[r.status] = r._count._all;
    // `assigned` guarda el username del legacy ('NaimeSistemas'): el selector de
    // técnico muestra el nombre de la persona. Se agrupa DESPUÉS de traducir,
    // porque un mismo técnico puede aparecer con su username en las órdenes viejas
    // y con su nombre en las nuevas, y son la misma persona.
    const tr = await traductorDeTecnicos(this.prisma);
    const porTecnico = new Map<string, number>();
    for (const t of byTech) {
      const nombre = tr.nombre(t.assigned);
      if (nombre) porTecnico.set(nombre, (porTecnico.get(nombre) ?? 0) + t._count._all);
    }
    return {
      total: Object.values(status).reduce((a, b) => a + b, 0),
      pendientes: (status['PENDIENTE'] ?? 0) + (status['REALIZANDO'] ?? 0),
      resueltos: status['RESUELTO'] ?? 0,
      anuladas: status['ANULADA'] ?? 0,
      status,
      topTypes: byType.map((t) => ({ type: t.type, count: t._count._all })),
      topTechs: [...porTecnico.entries()]
        .map(([tec, count]) => ({ tec, count }))
        .sort((a, b) => b.count - a.count),
      todosPending: todos,
    };
  }

  /**
   * Opciones para los selectores de filtro: sedes y tipos de orden (detalle).
   *
   * Las sedes van acotadas a las del usuario: a quien sólo llega a una sede no se le
   * ofrecen las demás en el desplegable (el listado ya viene filtrado por
   * `whereSedePorSuscriptor`, esto es que la pantalla no le mienta).
   */
  async filterOptions(user?: AuthUser) {
    const mias = await sedesDe(this.prisma, user);
    const [sedes, byType] = await Promise.all([
      this.prisma.branch.findMany({
        where: mias ? { legacyId: { in: mias } } : undefined,
        orderBy: { name: 'asc' },
        select: { id: true, name: true },
      }),
      this.prisma.ticket.groupBy({ by: ['type'], orderBy: { type: 'asc' } }),
    ]);
    return { sedes, types: byType.map((t) => t.type).filter((t) => t && t.trim()) };
  }

  /**
   * Columnas ordenables de la tabla de tickets.
   *
   * `barrio` no está: en la fila se muestra el nombre del barrio, pero el
   * ticket solo guarda el id legacy del barrio de su suscriptor y el nombre se
   * resuelve después con un mapa. Ordenar por el id daría un orden que no se
   * parece al alfabético que el usuario ve.
   */
  private static readonly ORDEN_TICKETS = {
    code: 'code',
    priority: 'priority',
    orden: (dir: 'asc' | 'desc') => [{ subject: dir }, { type: dir }],
    // Por la columna que de verdad se lee: `description` enseña `section` (la
    // observación) y sólo cae en `problem` cuando no hay ninguna — ordenar por
    // `problem` dejaba el 97% de las filas empatadas en vacío.
    description: 'section',
    client: (dir: 'asc' | 'desc') => [
      { subscriber: { firstName: dir } },
      { subscriber: { lastName1: dir } },
      { subscriber: { companyName: dir } },
    ],
    sede: 'subscriber.branch.name',
    tec: 'assigned',
    // Ordenar por fecha necesita desempate: `created` no tiene hora y todas las del
    // mismo día quedaban a merced del `{ id: 'asc' }` por defecto de `orden()`, que
    // es un cuid —o sea, al azar—. Ver `orden-cronologico.ts`.
    created: porFecha,
    status: 'status',
  };

  async tickets(params: { search?: string; status?: string; type?: string; servicio?: string; tec?: string; priority?: string; sede?: string; subscriberId?: string; from?: string; to?: string; all?: string; page?: number; pageSize?: number; sortBy?: string; sortDir?: string }, user?: AuthUser) {
    const { page, pageSize } = paginacion(params);
    const where: Prisma.TicketWhereInput = {};
    // Acceso por sede: el ticket la hereda de su suscriptor. Un ticket SIN suscriptor
    // (interno) no lo ve un usuario acotado, por el mismo criterio conservador que
    // aplica el resto del alcance.
    // Un técnico de campo ve SOLO sus órdenes. Va en `AND` y no en la raíz porque
    // `where.OR` ya está reservado para la búsqueda de más abajo: puesto ahí, el
    // primer texto tecleado borraría la restricción.
    const mias = await this.soloMisOrdenes(user);
    // Todo lo que restringe se acumula aquí y se cuelga de `where.AND` al final:
    // `where.OR` está reservado para la búsqueda de texto y escribir un filtro en la
    // raíz pisaba al de al lado (así se escapaba el alcance por sede, más abajo).
    const and: Prisma.TicketWhereInput[] = [];
    if (mias) and.push(mias);
    // "Es mía" gana sobre "es de mi sede": una orden asignada a él es suya aunque el
    // cliente esté en otra sede (a Miguel le tapaba 38 de sus 966, y su pantalla no
    // tiene filtro de sede con el que enterarse de que le faltaban).
    if (!mias) Object.assign(where, whereSedePorSuscriptor(await sedesDe(this.prisma, user)));
    // Los filtros de la barra son de selección MÚLTIPLE: viajan separados por comas
    // ("PENDIENTE,REALIZANDO"). Un solo valor sigue siendo el caso corriente y se
    // comporta igual que antes, así que los enlaces guardados no se rompen.
    const estados = variosDeQuery(params.status);
    if (estados.length) where.status = { in: estados as any };
    const detalles = variosDeQuery(params.type);
    if (detalles.length) where.type = { in: detalles };
    // QUÉ TIENE CONTRATADO EL CLIENTE (solo TV, solo internet, combo). Es el filtro
    // hermano del cartel que lleva cada fila: quien reparte el trabajo puede así
    // sacar de un golpe las órdenes de servicio de los abonados de solo televisión
    // —a los que no hay que tocarles el internet— sin ir abriéndolas una por una.
    // Ver `servicio-orden.filtro.ts`.
    const porServicio = await whereDeServicios(this.prisma, variosDeQuery(params.servicio));
    if (porServicio) and.push(porServicio);
    // Insensible a mayúsculas: `priority` es texto libre del legacy y "URGENTE"
    // también tiene que caer cuando se filtra por "Urgente". Con varias elegidas va
    // como OR de iguales y no como `in`, que en Postgres no respeta el `mode`.
    const prioridades = variosDeQuery(params.priority);
    if (prioridades.length) {
      and.push({ OR: prioridades.map((p) => ({ priority: { equals: p, mode: 'insensitive' as const } })) });
    }
    // El filtro viaja con el NOMBRE del técnico, pero las órdenes lo tienen escrito
    // con su username del legacy: se buscan todas las formas en que puede estar.
    const tr = await traductorDeTecnicos(this.prisma);
    const tecnicos = variosDeQuery(params.tec);
    if (tecnicos.length) {
      const clausulas: Prisma.TicketWhereInput[] = tecnicos.map((tec) =>
        tec === '__none__'
          // "Sin asignar" tiene que atrapar las dos formas en que viene del legacy:
          // NULL y cadena vacía — y que tampoco tenga técnico por la FK nueva.
          ? { assignedStaffId: null, OR: [{ assigned: null }, { assigned: '' }] }
          : { assigned: { in: tr.claves(tec) } },
      );
      and.push(clausulas.length === 1 ? clausulas[0] : { OR: clausulas });
    }
    // En `AND` y no en la raíz: puesto en `where.subscriber` machacaba el alcance por
    // sede que dejó `whereSedePorSuscriptor`, y quien está acotado a una sede podía
    // ver las de otra mandando su id a mano en la URL.
    const sedes = variosDeQuery(params.sede);
    if (sedes.length) and.push({ subscriber: { is: { branchId: { in: sedes } } } });
    // Filtro por cliente concreto. Lo usa el aviso de "este cliente ya tiene
    // órdenes abiertas" del formulario de orden nueva. Va en `AND` por lo mismo
    // que los de arriba: en la raíz pisaría el alcance por sede.
    if (params.subscriberId?.trim()) and.push({ subscriberId: params.subscriberId.trim() });
    if (and.length) where.AND = and;
    // Por defecto AÑO ACTUAL (aplica también al buscar; usar all=1 para histórico).
    // El corte existe porque la vista general barre 314.000 órdenes. Las de UNA
    // persona caben enteras, así que a un técnico no se le recorta su historia salvo
    // que pida un periodo: su pantalla no tiene filtro de fechas con el que darse
    // cuenta de que le faltan las del año pasado.
    const period = mias && !params.from && !params.to
      ? null
      : scopeDate(params.from, params.to, params.all);
    if (period) where.created = period;
    if (params.search?.trim()) {
      const s = params.search.trim();
      const n = enteroBuscable(s);
      const claves = tr.clavesPorTexto(s);
      where.OR = [
        { subject: { contains: s, mode: 'insensitive' } },
        { assigned: { contains: s, mode: 'insensitive' } },
        // Buscar por el apellido del técnico tiene que encontrar sus órdenes viejas,
        // donde lo que está escrito es el username y no el nombre.
        ...(claves.length ? [{ assigned: { in: claves } }] : []),
        ...(n != null ? [{ code: n }, { legacyId: n }] : []),
        { subscriber: { is: { OR: [{ firstName: { contains: s, mode: 'insensitive' as const } }, { lastName1: { contains: s, mode: 'insensitive' as const } }, ...(n != null ? [{ abonado: n }] : [])] } } },
      ];
    }
    // Con quién y a dónde: la cédula, los teléfonos y las piezas de la dirección.
    // No es adorno del listado — es lo que hace utilizable el EXCEL (`exportRows`
    // sale de aquí), que se imprime y se sale con él a la calle.
    const include = {
      subscriber: {
        select: {
          ...SUB, neighborhood: true, docType: true, docNumber: true,
          phone1: true, phone2: true, nomenclature: true, addressLine: true,
          branch: { select: { name: true } },
        },
      },
    };
    // Ordenar por prioridad no puede ir al SQL directo: es texto libre y el
    // abecedario pone "Urgente" de último. Va por baldes (ver el método).
    const [rows, total] = (params.sortBy || '').trim() === 'priority'
      ? await this.paginaPorPrioridad(where, params.sortDir === 'desc' ? 'desc' : 'asc', page, pageSize, include)
      : await Promise.all([
          this.prisma.ticket.findMany({ where, orderBy: orden(params, SupportService.ORDEN_TICKETS, ORDEN_CRONOLOGICO), skip: (page - 1) * pageSize, take: pageSize, include }),
          this.prisma.ticket.count({ where }),
        ]);
    // Resolver barrio: subscriber.neighborhood guarda el id legacy → Neighborhood.name.
    const nbLegacyIds = [...new Set(rows.map((t) => Number(t.subscriber?.neighborhood)).filter((n) => Number.isFinite(n)))];
    const nbs = nbLegacyIds.length ? await this.prisma.neighborhood.findMany({ where: { legacyId: { in: nbLegacyIds } }, select: { legacyId: true, name: true } }) : [];
    const barrioByLegacy = new Map(nbs.map((n) => [n.legacyId, n.name]));
    const barrioOf = (nb: string | null | undefined) => {
      const n = Number(nb);
      return Number.isFinite(n) ? (barrioByLegacy.get(n) ?? null) : null;
    };
    // EL CARTEL DE SERVICIO de cada fila: qué tiene contratado el CLIENTE —solo TV,
    // solo internet, combo—, resuelto de una vez para los cien abonados de la
    // página. No es lo que la orden nombra: 33 de las 38 'Reconexion Television2'
    // abiertas el 2026-09-10 son de clientes que también tienen internet, y
    // marcarlas "TV" era mandar a abrirlas una por una. Ver
    // `common/servicios-del-abonado.ts`.
    const mix = await mixPorAbonado(this.prisma, [...new Set(rows.map((t) => t.subscriberId).filter((id): id is string => !!id))]);
    // Sólo lo llevan las órdenes que van de un servicio (`esOrdenDeServicio`): en
    // una 'Instalacion' o un 'Cambio de equipo' el cartel sería ruido.
    const cartelDe = (t: { type: string | null; subscriberId: string | null }) =>
      (esOrdenDeServicio(t.type) && t.subscriberId ? mix.get(t.subscriberId) : null) ?? null;
    return {
      // `generadaPor` sale traducido por lo mismo que `assigned`: en las órdenes del
      // legacy lo que hay escrito es el username de quien la abrió ('SoniaCajera'),
      // no su nombre. Ver `generadaPorDe`.
      //
      // LO QUE DICE LA ORDEN son DOS campos, no uno (2026-09-07): `problem` es la
      // falla en una línea y `section` la observación larga. La columna
      // "Descripción" —pantalla, tarjeta móvil y Excel— leía sólo `problem`, y en
      // 2026 lo tienen 1.349 órdenes de 49.248 contra las 47.622 que tienen
      // `section`: el 97% del listado salía en blanco y el Excel llegaba sin las
      // observaciones. Es el mismo reparto que ya hace la agenda (ver
      // `AgendaService.TARJETA`), y por eso van los dos por separado.
      //
      // Los dos pasan por `textoPlano`: el legacy los editaba con un WYSIWYG y en la
      // base hay '<p>SUSPENDER TV</p>'. Pintarlo como HTML sería XSS almacenado;
      // crudo, le enseña las etiquetas a la cajera y las mete en la celda del Excel.
      items: rows.map((t) => ({ id: t.id, code: t.code, legacyId: t.legacyId, subject: t.subject, type: t.type, servicio: cartelDe(t), problema: textoPlano(t.problem), observacion: textoPlano(t.section), description: textoPlano(t.section) ?? textoPlano(t.problem), priority: t.priority, created: t.created, status: t.status, assigned: tr.nombre(t.assigned), generadaPor: tr.nombre(t.createdByName ?? t.col), client: subName(t.subscriber), subscriberId: t.subscriber?.id ?? null, abonado: t.subscriber?.abonado ?? null, cedula: [t.subscriber?.docType, t.subscriber?.docNumber].filter(Boolean).join(' ') || null, telefono: t.subscriber?.phone1 ?? null, telefono2: t.subscriber?.phone2 ?? null, direccion: direccionDe(t.subscriber?.nomenclature, t.subscriber?.addressLine), referencia: referenciaDe(t.subscriber?.nomenclature), sede: t.subscriber?.branch?.name ?? null, barrio: barrioOf(t.subscriber?.neighborhood), finalDate: t.finalDate })),
      total, page, pageSize, pages: Math.ceil(total / pageSize),
    };
  }

  /** Filas planas para exportar a Excel (respeta los mismos filtros del listado). */
  async exportRows(params: Parameters<SupportService['tickets']>[0], user?: AuthUser) {
    const r = await this.tickets({ ...params, page: 1, pageSize: 100 }, user);
    // Se recorren todas las páginas (tope sano de 20k filas), igual que en `orders`.
    const all = [...r.items];
    for (let p = 2; p <= Math.min(r.pages, 200); p++) {
      all.push(...(await this.tickets({ ...params, page: p, pageSize: 100 }, user)).items);
    }
    return all;
  }

  /**
   * Página del listado ordenada por prioridad DE ATENCIÓN, no alfabética.
   *
   * `priority` es texto libre y a Postgres solo se le puede pedir el abecedario,
   * que ordena Alta → Baja → Media → Urgente: el clic en la columna "Prioridad"
   * mostraba lo urgente de último. Como los valores son un vocabulario de cuatro
   * palabras, se pagina por BALDES: se cuenta cuánto hay de cada prioridad (con el
   * índice priority+created eso es barato) y la página se arma juntando el pedazo
   * que le toca a cada balde, cada uno ordenado por fecha. `asc` = urgente primero;
   * lo que no se reconoce (basura del legacy) va siempre al final.
   */
  private async paginaPorPrioridad(
    where: Prisma.TicketWhereInput,
    dir: 'asc' | 'desc',
    page: number,
    pageSize: number,
    include: Prisma.TicketInclude,
  ): Promise<[any[], number]> {
    const porValor = await this.prisma.ticket.groupBy({ by: ['priority'], where, _count: { _all: true } });
    const cuenta = new Map<string, number>(); // 'urgente'…'baja' | '' = no reconocida
    for (const g of porValor) {
      const crudo = (g.priority ?? '').toLowerCase();
      const balde = PRIORIDADES.includes(crudo) ? crudo : '';
      cuenta.set(balde, (cuenta.get(balde) ?? 0) + g._count._all);
    }
    const baldes = dir === 'asc' ? [...PRIORIDADES, ''] : ['', ...[...PRIORIDADES].reverse()];

    const filas: any[] = [];
    let saltar = (page - 1) * pageSize;
    let faltan = pageSize;
    for (const balde of baldes) {
      if (faltan <= 0) break;
      const n = cuenta.get(balde) ?? 0;
      if (saltar >= n) { saltar -= n; continue; }
      const whereBalde: Prisma.TicketWhereInput = balde
        ? { AND: [where, { priority: { equals: balde, mode: 'insensitive' } }] }
        : {
            // El balde "resto": texto que no es ninguna de las cuatro (la columna
            // no admite NULL, tiene default 'Media').
            AND: [where, ...PRIORIDADES.map((p) => ({ NOT: { priority: { equals: p, mode: 'insensitive' as const } } }))],
          };
      const trozo = await this.prisma.ticket.findMany({
        where: whereBalde,
        orderBy: { created: 'desc' },
        skip: saltar,
        take: faltan,
        include,
      });
      filas.push(...trozo);
      faltan -= trozo.length;
      saltar = 0;
    }
    return [filas, [...cuenta.values()].reduce((s, n) => s + n, 0)];
  }

  /** Resuelve el nombre del barrio a partir del id legacy guardado en subscriber.neighborhood. */
  private async resolveBarrio(neighborhood: string | null | undefined): Promise<string | null> {
    if (!neighborhood) return null;
    const n = Number(neighborhood);
    if (!Number.isFinite(n)) return null;
    const nb = await this.prisma.neighborhood.findFirst({ where: { legacyId: n }, select: { name: true } });
    return nb?.name ?? null;
  }

  async ticketDetail(id: string, user?: AuthUser) {
    const dueno = await this.prisma.ticket.findUnique({ where: { id }, select: { subscriberId: true } });
    // La lista ya va acotada, pero la ficha se abre por URL: sin esta puerta bastaba
    // con teclear un id para leer (y cerrar) la orden de otro técnico.
    //
    // Aquí el alcance es TODAS las suyas y no sólo las de hoy (`todoSuHistorial`): la
    // lista se le recortó al día (2026-09-10), pero su historial —el de `/mi-agenda/
    // historial`, que se le conserva— enlaza al detalle de lo que hizo días atrás, y
    // acotar también esta puerta lo mandaría a un 403 desde su propia pantalla.
    const mias = await this.soloMisOrdenes(user, true);
    if (mias) {
      if (!(await this.prisma.ticket.findFirst({ where: { AND: [{ id }, mias] }, select: { id: true } }))) {
        throw new ForbiddenException('Esta orden no está asignada a ti.');
      }
      // Ser suya basta para el alcance: no se le pide además que el cliente sea de su
      // sede (mismo criterio que la lista, o no podría abrir las 38 que le salen ahí).
    } else if (dueno?.subscriberId) {
      await exigirSedeSuscriptor(this.prisma, user, dueno.subscriberId);
    }
    // Aquí NO hay candado de "una orden a la vez" (2026-09-10). Lo hubo durante un día
    // —abrir la ficha de una segunda orden daba 403— y se quitó al mirar el legacy: allá
    // la regla vive sólo en el momento de EMPEZAR (`update_status` con `Realizando`) y
    // ver una orden nunca se bloquea. Consultar no es trabajar dos cosas a la vez, y
    // taparlo dejaba al técnico sin poder mirar la siguiente visita para llamar al
    // cliente. El candado, entero, está en `SupportWriteService.updateStatus`.
    const t = await this.prisma.ticket.findUnique({
      where: { id },
      include: {
        subscriber: {
          select: {
            ...SUB, docNumber: true, phone1: true, phone2: true, addressLine: true, nomenclature: true,
            neighborhood: true, gpsLat: true, gpsLng: true, pppProfile: true, macEquipo: true,
            // Los dos que mira el candado de la IP remota al cerrar (ver `requisitosCierre`).
            pppUsername: true, ipRemote: true,
            branch: { select: { name: true } },
          },
        },
      },
    });
    if (!t) throw new NotFoundException('Orden no encontrada');

    const sub = t.subscriber;
    const threads = t.code
      ? await this.prisma.ticketThread.findMany({ where: { ticketCode: t.code }, orderBy: { date: 'asc' } })
      : [];
    // `megas` del servicio es un snapshot que en los abonados heredados del
    // legacy viene vacío; el catálogo sí lo tiene, así que se cae a él.
    const services = sub ? await this.prisma.subscriberService.findMany({ where: { subscriberId: sub.id }, select: { kind: true, planName: true, price: true, status: true, megas: true, plan: { select: { megas: true } } } }) : [];
    // El plan de internet vigente: el ACTIVO manda si hay varios.
    const internetes = services.filter((s) => s.kind === 'INTERNET');
    const internet = internetes.find((s) => s.status === 'ACTIVO') ?? internetes[0] ?? null;
    const equipment = sub ? await this.prisma.equipment.findMany({ where: { subscriberId: sub.id }, select: { code: true, mac: true, serial: true, installType: true, port: true, vlan: true, nat: true, status: true, reservedTicketId: true, warehouse: { select: { name: true } } } }) : [];
    // ONUs del abonado en la OLT: sirve para señalar CUÁL de sus equipos es el
    // que está autenticado y con qué plan quedó, sin abrir otra pantalla.
    const onus = sub ? await this.prisma.oltOnu.findMany({ where: { subscriberId: sub.id }, select: { sn: true, runState: true } }) : [];
    const debtRows = sub ? await this.prisma.subInvoice.findMany({ where: { subscriberId: sub.id, status: { in: ['DUE', 'PARTIAL'] } }, select: { total: true, paidAmount: true } }) : [];
    const materials = await this.prisma.ticketMaterial.findMany({ where: { ticketId: t.id }, orderBy: { createdAt: 'asc' } });
    const barrio = await this.resolveBarrio(sub?.neighborhood);
    // Quién escribió cada renglón del hilo. Manda `authorName` —el nombre que se
    // sella al documentar desde aquí—, y para lo heredado del legacy se cruza
    // `TicketThread.employeeId` (el id de `aauth_users`, que es el mismo
    // `Staff.legacyId`): sin ese cruce la ficha enseñaba "empleado #68", que no le
    // dice nada a nadie.
    const autores = new Map<number, string>();
    const eids = [...new Set(threads.map((h) => h.employeeId).filter((n) => n != null))];
    if (eids.length) {
      const fichas = await this.prisma.staff.findMany({ where: { legacyId: { in: eids } }, select: { legacyId: true, name: true } });
      for (const f of fichas) if (f.legacyId != null) autores.set(f.legacyId, f.name.trim());
    }

    const debt = debtRows.reduce((s, i) => s + Math.max(0, Number(i.total) - Number(i.paidAmount)), 0);
    const nomen = (sub?.nomenclature ?? null) as Record<string, unknown> | null;
    const strOf = (k: string) => (nomen && typeof nomen[k] === 'string' ? (nomen[k] as string) : null);

    /**
     * QUÉ HACE FALTA para poder cerrar esta orden (2026-09-10). Lo dice el servidor
     * porque son SUS reglas: la geo-cerca (`geofence.policy.ts`) y el registro
     * fotográfico (`foto-cierre.policy.ts`). La pantalla sólo lo pinta.
     *
     * Sin esto el técnico se enteraba de los dos requisitos chocando con ellos, con
     * la visita ya terminada y el cliente en la puerta — que es el peor momento para
     * descubrir que hay que volver a sacar el teléfono.
     *
     * `fotos` cuenta las que ya lleva el hilo: son las mismas que cuenta el candado
     * (`TicketThread.attach`, por número de orden).
     */
    const deCampo = esOrdenDeCampo(t.type, await this.geofence.tiposCampo());
    const requisitosCierre = {
      deCampo,
      // La FIRMA de quien recibe no es nueva —la exige `updateStatus` desde el port
      // del legacy— pero no se anunciaba en ninguna parte: se descubría al intentar
      // cerrar. Puesta aquí, los tres requisitos se leen juntos y de una vez, que es
      // lo que evita el "y ahora esto otro" con el cliente en la puerta.
      firma: process.env.TICKET_REQUIRE_SIGNATURE !== 'false' && !esReconexion(t.type) && !t.signatureName,
      // El modo puede estar en `observar` u `off`: entonces la ubicación se manda
      // igual, pero no frena el cierre y no hay por qué anunciarla como requisito.
      ubicacion: deCampo && (await this.geofence.modo()) === 'exigir',
      foto: deCampo && process.env.TICKET_REQUIRE_PHOTO !== 'false',
      fotos: threads.filter((h) => h.attach).length,
      /**
       * IP remota del cliente (2026-09-10). Se calcula con la MISMA función que
       * frena el cierre (`faltaLaIpRemota`) y con los mismos datos, para que la
       * pantalla no prometa un cierre que la API va a rechazar.
       *
       * `ipRemotaValor` viaja para poder decir cuál es cuando ya está: el técnico
       * que ve la dirección sabe que ahí se puede entrar, y sistemas la lee sin
       * abrir otra pantalla.
       */
      ipRemota: faltaLaIpRemota({
        activo: process.env.TICKET_REQUIRE_REMOTE_IP !== 'false',
        tipoOrden: t.type,
        tiposCampo: await this.geofence.tiposCampo(),
        permisosUsuario: user?.permissions,
        hayUsuario: Boolean(user?.id),
        hayCliente: Boolean(sub?.id),
        tieneInternet: esUsuarioPppUtil(sub?.pppUsername),
        ipRemota: sub?.ipRemote ?? null,
      }),
      ipRemotaValor: esIpRemotaUtil(sub?.ipRemote) ? sub!.ipRemote!.trim() : null,
      /** Sólo a quien tiene internet se le puede activar: el de sólo TV no tiene secret. */
      tieneInternet: esUsuarioPppUtil(sub?.pppUsername),
      /**
       * Lo que le falta documentar a QUIEN MIRA la orden para poder cerrarla
       * (2026-09-17): con la misma función que frena el cierre. `null` = nada (o no
       * le aplica: no es técnico, o la orden no tiene número).
       */
      documentacion: faltaDocumentar({
        activo: process.env.TICKET_REQUIRE_DOCUMENTATION !== 'false',
        esTecnico: esTecnicoDeCampo(user),
        userId: user?.id ?? null,
        tieneNumero: t.code != null,
        renglones: threads,
      }),
    };

    return {
      requisitosCierre,
      id: t.id, code: t.code, subject: t.subject, type: t.type, created: t.created, finalDate: t.finalDate,
      // `problem` y `section` vienen del WYSIWYG del legacy: salen ya en texto plano.
      status: t.status, priority: t.priority, problem: textoPlano(t.problem), section: textoPlano(t.section),
      graceDays: t.graceDays,
      /**
       * "No se pudo atender": el viaje que el técnico hizo y no pudo resolver.
       * Se documenta al apartar la visita (`AgendaService.noSePudoAtender`) y
       * hasta ahora solo se veía en la bandeja de la agenda: quien abría la
       * orden por su ficha la encontraba PENDIENTE y sin rastro del intento, y
       * creía que no se había documentado nada.
       */
      noAtendida: t.skippedAt
        ? { fecha: t.skippedAt, motivo: t.skippedReason, por: t.skippedByName }
        : null,
      /**
       * El TRASLADO que porta la orden: de dónde a dónde se mudó el cliente y con
       * qué factura se le cobró. `null` en todo lo demás (y en los traslados
       * abiertos antes de 2026-08-27, que no llevaban destino).
       */
      traslado: t.moveToText
        ? { desde: t.moveFromText, hasta: t.moveToText, aplicado: t.moveAppliedAt, factura: t.moveInvoiceTid }
        : null,
      /**
       * A CUÁNTAS MEGAS pasa la orden al cliente: de cuánto venía, a cuánto va y si
       * el plan se le llegó a cambiar (`aplicado`). `null` en todo lo que no sea una
       * orden de megas — y en las que nacieron sin decirlas: las que abre el chatbot
       * con el plan por confirmar y las del legacy que dejaron en blanco la casilla
       * de su tabla `temporales` (el plan de las otras 2.723 ya lo trae el sync; ver
       * `syncPlanDeMegas`).
       */
      megas: t.planToName || t.planToMegas != null
        ? {
            /** `Plan.id` del destino: es lo que marca el desplegable al corregirla. */
            planId: t.planToId,
            plan: t.planToName,
            a: t.planToMegas,
            planAnterior: t.planFromName,
            de: t.planFromMegas,
            aplicado: t.planAppliedAt,
          }
        : null,
      /**
       * EL CARGO que se le facturó por abrir la orden, cuando su tipo lleva uno
       * (traslado, agregar internet — ver `billing/cargos-orden.ts`). `null` en el
       * resto y en las que no llegaron a cobrarse.
       *
       * Va aparte del bloque de arriba porque el traslado no es el único que cobra
       * y porque la pregunta que responde es otra: la de arriba es "a dónde se
       * mudó", ésta es "¿esto ya se le facturó o hay que cobrarlo en ventanilla?".
       */
      cargo: t.chargeInvoiceTid || t.chargeConcept
        ? { concepto: t.chargeConcept, factura: t.chargeInvoiceTid }
        : null,
      // Nombre completo, no el username con el que el legacy escribió la orden.
      assigned: (await traductorDeTecnicos(this.prisma)).nombre(t.assigned),
      /**
       * QUIÉN GENERÓ la orden. Una orden es una instrucción de trabajo: hasta ahora
       * la ficha decía quién la iba a hacer pero no quién la mandó, y eso se
       * preguntaba por teléfono. `origen` distingue a la persona del proceso: una
       * "Reconexion Internet" que abrió el sistema al recibir el pago no se le
       * reclama a nadie. Ver `Ticket.createdBySource`.
       */
      generadaPor: await this.generadaPorDe(t),
      signature: t.signatureName ? { name: t.signatureName, cc: t.signatureCc, rel: t.signatureRel, hasImage: !!t.signatureImage } : null,
      /**
       * Puntaje del trabajo. Van los dos números a propósito:
       * `score` es lo que YA se selló al cerrar (null si sigue abierta o si se
       * cerró antes de que existiera el puntaje), y `puntajeVigente` lo que vale
       * hoy su tipo — que es lo que el técnico necesita ver ANTES de hacerla.
       */
      score: t.score,
      scoredAt: t.scoredAt,
      puntajeVigente: await this.puntajes.puntajeDe(t.type),
      subscriber: sub
        ? {
            id: sub.id, name: subName(sub), abonado: sub.abonado, doc: sub.docNumber,
            // La dirección se arma de las piezas de `nomenclature`, no de
            // `addressLine`: ese campo está vacío en 21.656 de 21.867 abonados y
            // lo poco que trae es basura ('0', 'example.png', un pedazo de
            // coordenada). Es la dirección con la que el técnico sale a la calle.
            phone: sub.phone1, phone2: sub.phone2, address: direccionDe(sub.nomenclature, sub.addressLine),
            referencia: strOf('referencia'), residencia: strOf('residencia'),
            barrio, branch: sub.branch?.name ?? null,
            gpsLat: sub.gpsLat, gpsLng: sub.gpsLng, profile: sub.pppProfile, macEquipo: sub.macEquipo,
            debt,
            services: services.map((s) => ({ kind: s.kind, plan: s.planName, price: s.price != null ? Number(s.price) : null, status: s.status })),
          }
        : null,
      equipment: equipment.map((e) => {
        // Un equipo es "la ONU" si su serial casa con alguno de los SN que la OLT
        // tiene a nombre del abonado (normalizando y traduciendo el prefijo ASCII
        // de la etiqueta: GPON120278E5 ↔ 47504F4E120278E5).
        const formas = new Set(formasDeSerial(e.serial));
        const onu = onus.find((o) => formasDeSerial(o.sn).some((f) => formas.has(f))) ?? null;
        return {
          code: e.code, mac: e.mac, serial: e.serial, installType: e.installType,
          port: e.port, vlan: e.vlan, nat: e.nat, status: e.status,
          // Apartado en bodega PARA ESTA orden al abrirla: el técnico tiene que
          // saber cuál llevarse (ver `EquipoReservaService`).
          reservado: e.reservedTicketId === t.id,
          bodega: e.warehouse?.name ?? null,
          // Plan y velocidad con los que quedó autenticado, en la propia línea
          // del equipo: al reabrir la orden se ve de un vistazo.
          esOnu: !!onu,
          onuEstado: onu?.runState ?? null,
          plan: onu ? (internet?.planName ?? null) : null,
          megas: onu ? (internet?.megas ?? internet?.plan?.megas ?? null) : null,
        };
      }),
      materials: materials.map((m) => ({ id: m.id, name: m.materialName, qty: m.qty, price: Number(m.price), total: Number(m.price) * m.qty, warehouse: m.warehouseName, employee: m.employeeName, date: m.createdAt })),
      threads: threads.map((h) => ({
        id: h.id, message: textoPlano(h.message), date: h.date, employeeId: h.employeeId,
        author: h.authorName ?? autores.get(h.employeeId) ?? null,
        attach: h.attach, attachName: h.attachName, geoLat: h.geoLat, geoLng: h.geoLng,
      })),
    };
  }

  /**
   * Quién generó la orden, ya legible.
   *
   * Tres fuentes, en orden: el nombre que se sella al crearla (`createdByName`), y
   * para todo lo heredado, `col` —el username con el que la escribió el legacy—, que
   * se traduce a nombre completo con el mismo censo que `assigned`. Si no hay ninguno
   * de los dos (135.153 órdenes viejas nacieron con `col` vacío) devuelve `null`: no
   * se sabe, y decir "Sistema" ahí sería inventarlo.
   */
  private async generadaPorDe(t: { createdByName: string | null; createdById: string | null; createdBySource: string | null; col: string | null; legacyId: number | null; createdAt: Date }) {
    const nombre = (await traductorDeTecnicos(this.prisma)).nombre(t.createdByName ?? t.col);
    if (!nombre) return null;
    return {
      nombre,
      usuarioId: t.createdById,
      origen: t.createdBySource ?? (t.legacyId != null ? 'LEGACY' : 'USUARIO'),
      fecha: t.createdAt,
    };
  }

  /**
   * Arma los datos para el PDF de la orden de servicio (acta técnica).
   *
   * El `user` viaja hasta `ticketDetail`, que es quien exige la sede del suscriptor:
   * sin él, pedir el acta por chat sería la puerta de atrás del acotado por sede.
   */
  async serviceOrderPdfData(id: string, user?: AuthUser) {
    const t = await this.ticketDetail(id, user);
    const s = t.subscriber;
    return {
      code: t.code != null ? String(t.code) : '—',
      type: t.type, subject: t.subject, status: t.status, priority: t.priority,
      created: t.created, finalDate: t.finalDate, technician: t.assigned,
      generadaPor: t.generadaPor?.nombre ?? null,
      problem: t.problem, section: t.section,
      // Plazo pactado en una "Reconexión Combo por dias". Viaja siempre (null en
      // el resto) para que la ficha pueda decir por cuántos días se reconectó.
      graceDays: t.graceDays ?? null,
      // A dónde se muda, en la orden que el técnico se lleva impresa: es la
      // dirección a la que tiene que ir a montar el servicio.
      traslado: t.traslado ? { desde: t.traslado.desde, hasta: t.traslado.hasta } : null,
      // Y a cuántas megas hay que dejarlo, en la orden que se lleva impresa: el
      // plan ya está cambiado en la ficha, pero la velocidad la tiene que dejar
      // puesta él en la red.
      megas: t.megas ? { de: t.megas.de, a: t.megas.a, plan: t.megas.plan } : null,
      subscriber: s
        ? {
            name: s.name ?? '—', doc: s.doc, abonado: s.abonado, phone: [s.phone, s.phone2].filter(Boolean).join(' · ') || null,
            address: s.address, barrio: s.barrio, branch: s.branch,
            services: s.services?.length ? s.services.map((x) => `${x.kind}: ${x.plan ?? '—'}`).join(' · ') : null,
            debt: s.debt,
          }
        : null,
      equipment: t.equipment.map((e) => ({ mac: e.mac, installType: e.installType, port: e.port, vlan: e.vlan, nat: e.nat, serial: e.serial })),
      materials: t.materials.map((m) => ({ name: m.name, qty: m.qty, price: m.price, total: m.total })),
      threads: t.threads.map((h) => ({ message: h.message, date: h.date, hasPhoto: !!h.attach, author: h.author })),
      signature: t.signature,
    };
  }

  /**
   * El técnico del usuario logueado. No hay FK User→Staff, así que se resuelve por
   * email y, si no hay, por nombre exacto. Público porque el panel del técnico
   * necesita el mismo `staffId` para pedirle el rendimiento a Reportes.
   *
   * Devuelve null cuando no se puede resolver, y quien llame TIENE que tratar ese
   * caso: sin técnico no hay "mis órdenes", y responder con las de todos disfrazadas
   * de propias es peor que responder vacío.
   */
  async staffDelUsuario(user: AuthUser) {
    return fichaDelUsuario(this.prisma, user);
  }

  /**
   * "Mi jornada": las órdenes que tiene encima el técnico logueado, ordenadas por
   * lo que debería atender primero, más los contadores de su día.
   *
   * Dos cosas que conviene saber antes de leer el código:
   *
   * 1. NO existe una fecha de agendamiento. `Ticket` solo tiene `created` (fecha, sin
   *    hora) y `finalDate`; `CalendarEvent.orderNo` y `TodoTask.orderId` son restos del
   *    legacy que no se alimentan desde el stack nuevo. Así que "lo agendado para hoy"
   *    es, con los datos que hay, SU COLA ABIERTA: lo que sigue pendiente le toca hoy.
   *    El orden es la única forma honesta de decir "empieza por aquí": lo que ya
   *    empezó (REALIZANDO), luego por prioridad, y a igual prioridad lo más viejo
   *    primero — que es lo que más lleva esperando el cliente.
   *
   * 2. La asignación vive en DOS campos: el FK `assignedStaffId` (131.063 órdenes) y el
   *    texto libre `assigned` heredado del legacy (139.473). Se buscan los dos: filtrar
   *    solo por el FK le esconde al técnico casi la mitad de su trabajo.
   */
  async miJornada(user: AuthUser) {
    const staff = await this.staffDelUsuario(user);
    if (!staff) {
      // Mismo contrato que la respuesta buena, en ceros: quien consume esto no tiene
      // que saber que hay dos formas de responder.
      return {
        resolved: false, tech: null, hoy: hoyEnColombia().toISOString().slice(0, 10),
        contadores: { pendiente: 0, realizando: 0, resueltoHoy: 0, resueltas7d: 0, vencidas: 0, rezagadas: 0, campo: 0 },
        agenda: [] as OrdenDeJornada[], rezagadas: [] as OrdenDeJornada[],
        diasVencimiento: DIAS_VENCIMIENTO, diasRezago: DIAS_REZAGO,
      };
    }

    // Suyas = por FK, por su nombre (las nuevas) o por el username con el que el
    // legacy escribió las viejas. Las dos formas cuentan: son la misma persona.
    const claves = [staff.name, staff.username].filter((c): c is string => !!c?.trim());
    const mias: Prisma.TicketWhereInput = { OR: [{ assignedStaffId: staff.id }, ...(claves.length ? [{ assigned: { in: claves } }] : [])] };
    const hoy = hoyEnColombia();
    const hace7 = new Date(hoy.getTime() - 7 * 86400_000);
    // `created` es columna `date`: los cortes se comparan contra la fecha de Colombia
    // a medianoche UTC, que es como Prisma lee y escribe esas columnas.
    const corteVencidas = new Date(hoy.getTime() - DIAS_VENCIMIENTO * 86400_000);
    const corteRezago = new Date(hoy.getTime() - DIAS_REZAGO * 86400_000);
    const abiertas: Prisma.TicketWhereInput = { ...mias, status: { in: ['PENDIENTE', 'REALIZANDO'] } };
    const activas: Prisma.TicketWhereInput = { ...abiertas, created: { gte: corteRezago } };
    const rezagadas: Prisma.TicketWhereInput = { ...abiertas, created: { lt: corteRezago } };

    const conAbonado = {
      subscriber: {
        select: {
          ...SUB, addressLine: true, nomenclature: true, neighborhood: true, phone1: true, phone2: true,
          gpsLat: true, gpsLng: true, branch: { select: { name: true } },
        },
      },
    };

    const [pendiente, realizando, resueltoHoy, resueltas7d, vencidas, nRezagadas, cola, viejas] = await Promise.all([
      this.prisma.ticket.count({ where: { ...mias, status: 'PENDIENTE' } }),
      this.prisma.ticket.count({ where: { ...mias, status: 'REALIZANDO' } }),
      this.prisma.ticket.count({ where: { ...mias, status: 'RESUELTO', finalDate: { gte: hoy } } }),
      this.prisma.ticket.count({ where: { ...mias, status: 'RESUELTO', finalDate: { gte: hace7 } } }),
      // Vencidas se cuenta SOLO sobre las activas: si incluyera el rezago, el aviso
      // diría "tienes 28 vencidas" todos los días de la vida y dejaría de leerse.
      // Las dos condiciones van en el MISMO `created`: en objetos aparte, la segunda
      // pisa a la primera y vuelve a colarse el rezago (que es justo lo que se separó).
      this.prisma.ticket.count({ where: { ...abiertas, created: { gte: corteRezago, lt: corteVencidas } } }),
      this.prisma.ticket.count({ where: rezagadas }),
      this.prisma.ticket.findMany({
        where: activas,
        // Se traen hasta 60 y el orden fino se hace en memoria: la prioridad es texto
        // ("Urgente"/"Alta"/...) y ordenarla en SQL daría el alfabético, que pone
        // "Alta" antes que "Urgente". 60 es techo de sobra — el que más carga tiene
        // en toda la empresa lleva 28 órdenes abiertas.
        orderBy: [{ created: 'asc' }], take: 60,
        include: conAbonado,
      }),
      // Del rezago se muestran las 20 más recientes: son las que todavía tienen algo
      // que ver con la realidad. Las de 2021 se cuentan, pero no se listan.
      this.prisma.ticket.findMany({ where: rezagadas, orderBy: [{ created: 'desc' }], take: 20, include: conAbonado }),
    ]);

    const dia = 86400_000;
    const aOrden = (t: (typeof cola)[number]): OrdenDeJornada => {
      const creada = t.created ? new Date(t.created) : null;
      const diasAbierta = creada ? Math.max(0, Math.floor((hoy.getTime() - creada.getTime()) / dia)) : null;
      const lat = Number(t.subscriber?.gpsLat), lng = Number(t.subscriber?.gpsLng);
      return {
        id: t.id, code: t.code, subject: t.subject, type: t.type, status: t.status, priority: t.priority,
        problema: t.problem, created: t.created, diasAbierta,
        vencida: diasAbierta != null && diasAbierta > DIAS_VENCIMIENTO,
        campo: esTrabajoDeCampo(t.type),
        client: subName(t.subscriber), subscriberId: t.subscriber?.id ?? null, abonado: t.subscriber?.abonado ?? null,
        address: direccionDe(t.subscriber?.nomenclature, t.subscriber?.addressLine), phone: t.subscriber?.phone1 ?? null, phone2: t.subscriber?.phone2 ?? null,
        sede: t.subscriber?.branch?.name ?? null,
        // Solo 1 de cada 4 abonados tiene GPS: se manda null en vez de un punto
        // inventado para que la UI no ofrezca un "navegar" que lleva a la nada.
        gps: Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0 ? { lat, lng } : null,
      };
    };

    const agenda = cola.map(aOrden).sort(
      (a, b) =>
        (a.status === 'REALIZANDO' ? 0 : 1) - (b.status === 'REALIZANDO' ? 0 : 1) ||
        rangoPrioridad(a.priority) - rangoPrioridad(b.priority) ||
        (a.created?.getTime() ?? 0) - (b.created?.getTime() ?? 0),
    );

    return {
      resolved: true,
      tech: { id: staff.id, name: staff.name, username: staff.username },
      hoy: hoy.toISOString().slice(0, 10),
      contadores: {
        pendiente, realizando, resueltoHoy, resueltas7d, vencidas,
        rezagadas: nRezagadas,
        campo: agenda.filter((o) => o.campo).length,
      },
      agenda,
      rezagadas: viejas.map(aOrden),
      diasVencimiento: DIAS_VENCIMIENTO,
      diasRezago: DIAS_REZAGO,
    };
  }

  /** Datos del archivo adjunto de una entrada del hilo (para descargar/previsualizar). */
  async getThreadAttachment(threadId: string) {
    const th = await this.prisma.ticketThread.findUnique({ where: { id: threadId }, select: { attach: true, attachName: true } });
    if (!th?.attach) throw new NotFoundException('Adjunto no encontrado');
    return { storedName: th.attach, originalName: th.attachName ?? th.attach };
  }

}
