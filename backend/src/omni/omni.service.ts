import { BadRequestException, NotFoundException } from '../core/http/errores';
import { orden, paginacion, type Direccion } from '../common/pagination-params';
import { rangoDeDiasColombia } from '../common/fecha-colombia';
import { Type } from 'class-transformer';
import { IsArray, IsIn, IsInt, IsNumber, IsOptional, IsString, Min, MinLength, ValidateNested } from 'class-validator';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/current-user.decorator';
import { PostingService } from '../accounting/posting.service';
import { num, round2 } from '../common/money';
import { nextTid, TID_SEQ } from '../common/tid';

const dOnly = (s?: string) => { const d = s ? new Date(s) : new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); };

export class QuoteItemDto {
  @IsString() @MinLength(1) product!: string;
  @IsInt() @Min(1) qty!: number;
  @IsNumber() @Min(0) price!: number;
  @IsOptional() @IsNumber() @Min(0) taxRate?: number;
}
export class CreateQuoteDto {
  @IsOptional() @IsString() subscriberId?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsString() proposal?: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => QuoteItemDto) items!: QuoteItemDto[];
}

/** Crear/editar un evento de agenda. */
export class EventDto {
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() color?: string;
  @IsString() start!: string;
  @IsOptional() @IsString() end?: string;
  @IsOptional() allDay?: boolean;
  @IsOptional() @IsInt() orderNo?: number;
  // Mismo vocabulario que la prioridad de las órdenes de soporte.
  @IsOptional() @IsIn(['Baja', 'Media', 'Alta', 'Urgente']) priority?: string;
}
export class UpdateEventDto {
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() color?: string;
  @IsOptional() @IsString() start?: string;
  @IsOptional() @IsString() end?: string;
  @IsOptional() allDay?: boolean;
  @IsOptional() @IsIn(['Baja', 'Media', 'Alta', 'Urgente']) priority?: string;
}
export class QuoteStatusDto {
  @IsString() @IsIn(['draft', 'pending', 'sent', 'accepted', 'rejected', 'converted']) status!: string;
}

export class OmniService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posting: PostingService,
  ) {}

  // --- Eventos / agenda ---
  /**
   * Columnas ordenables de la tabla de la agenda, con los nulos SIEMPRE al final.
   *
   * Sin lo de los nulos, la agenda abría con 45 filas sin fecha arriba del todo
   * (Postgres pone NULLS FIRST en `DESC`): la primera pantalla era una columna
   * "Inicio" llena de guiones y parecía que la vista no cargaba.
   *
   * "Asignó" NO está y no es un olvido: la columna guarda el id legacy del
   * funcionario ('20', '165'), no su nombre; el nombre se resuelve al salir. Ordenar
   * por ella daba el orden de unos números que el usuario no ve —y como es texto, ni
   * siquiera el numérico: '100' antes que '20'—. Para eso está el filtro "Asignó",
   * que sí ofrece a la gente por nombre.
   */
  private static readonly ORDEN_EVENTOS: Record<string, (dir: Direccion) => unknown> = {
    title: (dir) => ({ title: { sort: dir, nulls: 'last' } }),
    start: (dir) => ({ start: { sort: dir, nulls: 'last' } }),
    end: (dir) => ({ end: { sort: dir, nulls: 'last' } }),
    description: (dir) => ({ description: { sort: dir, nulls: 'last' } }),
    orderNo: (dir) => ({ orderNo: { sort: dir, nulls: 'last' } }),
  };

  private static readonly PRIORIDADES = ['Baja', 'Media', 'Alta', 'Urgente'];

  /** Filtros de la agenda; los comparten el listado y las cifras de arriba. */
  private static filtroEventos(f: {
    search?: string; from?: string; to?: string; priority?: string; assignedBy?: string;
  }): Prisma.CalendarEventWhereInput {
    const and: Prisma.CalendarEventWhereInput[] = [];

    // Rango por DÍAS de Colombia, con el "hasta" inclusive. Ver `rangoDeDiasColombia`:
    // esto es lo que estaba roto —un `lte` a la medianoche UTC del propio día, que
    // dejaba fuera el día entero salvo el evento imposible de las 00:00 en punto—.
    const rango = rangoDeDiasColombia(f.from, f.to);
    if (rango === null) {
      throw new BadRequestException('El rango de fechas no es válido: revisa "Desde" y "Hasta".');
    }
    if (rango.gte || rango.lt) and.push({ start: rango });

    const texto = (f.search ?? '').trim();
    if (texto) {
      // El número se busca como ORDEN además de como texto: en la tabla la columna
      // se pinta '#3408', así que se escribe con almohadilla tan a menudo como sin ella.
      const n = Number(texto.replace(/^#/, ''));
      const o: Prisma.CalendarEventWhereInput[] = [
        { title: { contains: texto, mode: 'insensitive' } },
        { description: { contains: texto, mode: 'insensitive' } },
      ];
      if (Number.isInteger(n) && n > 0) o.push({ orderNo: n });
      and.push({ OR: o });
    }

    const prioridad = (f.priority ?? '').trim();
    if (prioridad) {
      if (!OmniService.PRIORIDADES.some((p) => p.toLowerCase() === prioridad.toLowerCase())) {
        throw new BadRequestException('Esa prioridad no existe.');
      }
      and.push({ priority: { equals: prioridad, mode: 'insensitive' } });
    }

    const asigno = (f.assignedBy ?? '').trim();
    // `sin` = los que el legacy importó sin responsable (564). Sin esta opción no
    // había forma de llegar a ellos desde la pantalla.
    if (asigno === 'sin') and.push({ OR: [{ assignedBy: null }, { assignedBy: '' }] });
    else if (asigno) and.push({ assignedBy: asigno });

    return and.length ? { AND: and } : {};
  }

  /**
   * `Staff.legacyId` → nombre, para las filas de una página.
   *
   * `CalendarEvent.assignedBy` es el `asigno` del legacy: un id numérico guardado
   * como texto. Sin traducir, la columna "Asignó" mostraba '20' y '165'.
   */
  private async nombresDeAsignadores(ids: (string | null)[]): Promise<Map<string, string>> {
    const numeros = [...new Set(ids.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0))];
    if (!numeros.length) return new Map();
    const filas = await this.prisma.staff.findMany({
      where: { legacyId: { in: numeros } },
      select: { legacyId: true, name: true },
    });
    return new Map(filas.flatMap((s) => (s.legacyId == null ? [] : [[String(s.legacyId), s.name.trim()] as [string, string]])));
  }

  /**
   * Cómo se escribe un `assignedBy` en pantalla.
   *
   * 17 de los 70 ids que aparecen en los eventos (6.398 filas) no cruzan con
   * ninguna ficha: son cuentas que el propio legacy ya había borrado cuando se
   * migró, así que no hay nombre que poner y no lo va a haber. Se etiquetan como
   * "Funcionario #105" y no con el número pelado, que en la columna "Asignó" se
   * lee como un dato corrupto en vez de como lo que es: alguien que ya no está.
   */
  private static etiquetaAsignador(id: string, nombres: Map<string, string>): string {
    return nombres.get(id) ?? (/^\d+$/.test(id) ? `Funcionario #${id}` : id);
  }

  async events(params: {
    search?: string; from?: string; to?: string; priority?: string; assignedBy?: string;
    page?: string; pageSize?: string; sortBy?: string; sortDir?: string;
  }) {
    const { page, pageSize, skip, take } = paginacion(params, { porDefecto: 50, maxPageSize: 200 });
    const where = OmniService.filtroEventos(params);
    const [rows, total] = await Promise.all([
      this.prisma.calendarEvent.findMany({
        where,
        orderBy: orden(params, OmniService.ORDEN_EVENTOS, [{ start: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }]),
        skip, take,
      }),
      this.prisma.calendarEvent.count({ where }),
    ]);
    const nombres = await this.nombresDeAsignadores(rows.map((e) => e.assignedBy));
    return {
      items: rows.map((e) => ({
        id: e.id, orderNo: e.orderNo, title: e.title, description: e.description, color: e.color,
        start: e.start, end: e.end, allDay: e.allDay, priority: e.priority,
        assignedBy: e.assignedBy ? OmniService.etiquetaAsignador(e.assignedBy, nombres) : null,
      })),
      total, page, pageSize, pages: Math.ceil(total / pageSize),
    };
  }

  /**
   * Las cifras de arriba, SOBRE LOS MISMOS FILTROS que la tabla.
   *
   * Antes no recibían nada: la tarjeta decía "131.913 eventos" mientras la tabla
   * mostraba doce. Una cifra que contradice lo que hay debajo es exactamente lo que
   * hace dudar de si el filtro está aplicándose.
   */
  async eventsStats(params: { search?: string; from?: string; to?: string; priority?: string; assignedBy?: string } = {}) {
    const where = OmniService.filtroEventos(params);
    const conFecha: Prisma.CalendarEventWhereInput = { AND: [where, { start: { not: null } }] };
    const [total, conOrden, primero, ultimo] = await Promise.all([
      this.prisma.calendarEvent.count({ where }),
      this.prisma.calendarEvent.count({ where: { AND: [where, { orderNo: { not: null } }] } }),
      this.prisma.calendarEvent.findFirst({ where: conFecha, orderBy: { start: 'asc' }, select: { start: true } }),
      this.prisma.calendarEvent.findFirst({ where: conFecha, orderBy: { start: 'desc' }, select: { start: true } }),
    ]);
    return { total, conOrden, primero: primero?.start ?? null, ultimo: ultimo?.start ?? null };
  }

  /**
   * Qué se puede elegir en los desplegables del filtro.
   *
   * La lista de "Asignó" sale de los eventos QUE HAY (70 personas), no del censo de
   * funcionarios: un desplegable con los 199 empleados, 129 de ellos sin un solo
   * evento, obliga a probar opciones que no devuelven nada.
   */
  async eventFilters() {
    const grupos = await this.prisma.calendarEvent.groupBy({ by: ['assignedBy'], _count: { _all: true } });
    const nombres = await this.nombresDeAsignadores(grupos.map((g) => g.assignedBy));
    const asignadores = grupos
      .filter((g) => !!g.assignedBy)
      .map((g) => ({
        id: g.assignedBy!,
        nombre: OmniService.etiquetaAsignador(g.assignedBy!, nombres),
        // Los que ya no tienen ficha van al final del desplegable: son 17 de 70 y
        // arriba (ordenan por dígito antes que por letra) tapaban a la gente real.
        sinFicha: !nombres.has(g.assignedBy!),
        total: g._count._all,
      }))
      .sort((a, b) => Number(a.sinFicha) - Number(b.sinFicha) || a.nombre.localeCompare(b.nombre, 'es'));
    const sin = grupos.filter((g) => !g.assignedBy).reduce((s, g) => s + g._count._all, 0);
    return { asignadores, sinAsignar: sin, prioridades: OmniService.PRIORIDADES };
  }

  /**
   * Tope de eventos que devuelve el calendario en UNA carga.
   *
   * La agenda arrastra 131.913 eventos del legacy, así que un tope tiene que haber:
   * sin él, la ventana de seis semanas del mes devuelve decenas de miles de filas
   * para pintar cuadraditos de 14 px.
   *
   * EL NÚMERO SALE DE MEDIR, NO DE ELEGIRLO REDONDO. Estaba en 2.000, y con eso se
   * recortaban TODOS los meses: contadas las ventanas de verdad, un mes va de 2.208
   * (junio 2026) a 4.808 (diciembre 2025) eventos. Un tope que salta siempre no es un
   * tope, es un techo — y además de mentir en cada mes, entrena a la gente a ignorar
   * el aviso justo antes del mes en que sí importa. 6.000 deja el peor mes medido
   * entero y sigue cortando lo patológico.
   */
  private static readonly TOPE_CALENDARIO = 6000;

  /**
   * Los eventos que CRUZAN una ventana de días, para pintarlos en el calendario.
   *
   * No vale reutilizar el listado (`events`): aquél filtra por `start` dentro del
   * rango, que es lo correcto para una tabla —una fila, un evento, ordenados por
   * cuándo empiezan— y lo incorrecto para una rejilla. Un evento del 28 de marzo al
   * 2 de abril tiene que salir pintado en el 1 de abril, y con el filtro del listado
   * la primera semana de abril lo perdería: no empieza ahí.
   *
   * La condición de SOLAPE es la de dos intervalos: empieza antes de que la ventana
   * acabe y acaba después de que la ventana empiece. El caso del evento sin `end` va
   * aparte porque no es un intervalo sino un instante: cae dentro si su `start` cae
   * dentro, y en SQL `end >= desde` con `end` nulo no es falso — es NULL, y descarta
   * la fila entera sin decirlo. Ese es justo el evento más común de la tabla (la cita
   * puntual), así que el descuido se llevaría por delante media agenda.
   */
  async eventsCalendar(params: {
    from?: string; to?: string; search?: string; priority?: string; assignedBy?: string;
  }) {
    const ventana = rangoDeDiasColombia(params.from, params.to);
    if (ventana === null || !ventana.gte || !ventana.lt) {
      throw new BadRequestException('El calendario necesita un rango de días válido ("desde" y "hasta").');
    }
    const { gte: desde, lt: hasta } = ventana;

    // Los filtros de texto/prioridad/persona son los MISMOS que los de la tabla, para
    // que cambiar de vista no cambie lo que se está mirando. El de fechas no: aquí lo
    // pone la ventana del calendario, así que se le pasa sin `from`/`to`.
    const comunes = OmniService.filtroEventos({
      search: params.search, priority: params.priority, assignedBy: params.assignedBy,
    });

    const where: Prisma.CalendarEventWhereInput = {
      AND: [
        comunes,
        { start: { not: null, lt: hasta } },
        { OR: [{ end: { gte: desde } }, { AND: [{ end: null }, { start: { gte: desde } }] }] },
      ],
    };

    const rows = await this.prisma.calendarEvent.findMany({
      where,
      orderBy: [{ start: 'asc' }, { id: 'asc' }],
      take: OmniService.TOPE_CALENDARIO + 1,
    });
    const truncado = rows.length > OmniService.TOPE_CALENDARIO;
    const pagina = truncado ? rows.slice(0, OmniService.TOPE_CALENDARIO) : rows;
    // Desde qué instante deja de ser completo lo que se devuelve: es el `start` del
    // primer evento que NO cupo. Sin este dato el aviso sólo puede decir «falta algo»,
    // y quien mira no sabe si el hueco del día 24 es que no hay nada o que se cortó.
    const cortadoDesde = truncado ? rows[OmniService.TOPE_CALENDARIO].start : null;

    const nombres = await this.nombresDeAsignadores(pagina.map((e) => e.assignedBy));
    return {
      items: pagina.map((e) => ({
        id: e.id, orderNo: e.orderNo, title: e.title, description: e.description, color: e.color,
        start: e.start, end: e.end, allDay: e.allDay, priority: e.priority,
        assignedBy: e.assignedBy ? OmniService.etiquetaAsignador(e.assignedBy, nombres) : null,
      })),
      // Con `truncado`, la pantalla avisa en vez de mentir por omisión: un calendario
      // al que le faltan eventos y no lo dice es peor que uno que no carga.
      truncado,
      cortadoDesde,
      tope: OmniService.TOPE_CALENDARIO,
    };
  }

  async createEvent(dto: EventDto, user: AuthUser) {
    const e = await this.prisma.calendarEvent.create({
      data: {
        title: dto.title ?? null, description: dto.description ?? null, color: dto.color ?? null,
        start: new Date(dto.start), end: dto.end ? new Date(dto.end) : null,
        allDay: dto.allDay ?? false, orderNo: dto.orderNo ?? null, assignedBy: user?.name ?? user?.email ?? null,
        ...(dto.priority ? { priority: dto.priority } : {}),
      },
    });
    return { id: e.id };
  }

  async updateEvent(id: string, dto: UpdateEventDto) {
    const e = await this.prisma.calendarEvent.findUnique({ where: { id } });
    if (!e) throw new NotFoundException('Evento no encontrado');
    const data: Prisma.CalendarEventUpdateInput = {};
    if (dto.title !== undefined) data.title = dto.title;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.color !== undefined) data.color = dto.color;
    if (dto.start !== undefined) data.start = new Date(dto.start);
    if (dto.end !== undefined) data.end = dto.end ? new Date(dto.end) : null;
    if (dto.allDay !== undefined) data.allDay = dto.allDay;
    if (dto.priority !== undefined) data.priority = dto.priority;
    await this.prisma.calendarEvent.update({ where: { id }, data });
    return { id, ok: true };
  }

  async deleteEvent(id: string) {
    await this.prisma.calendarEvent.delete({ where: { id } });
    return { id, deleted: true };
  }

  async quoteDetail(id: string) {
    const q = await this.prisma.quote.findUnique({ where: { id }, include: { items: { orderBy: { id: 'asc' } } } });
    if (!q) throw new NotFoundException('Cotización no encontrada');
    let client: string | null = null;
    if (q.subscriberId) {
      const s = await this.prisma.subscriber.findUnique({ where: { id: q.subscriberId }, select: { firstName: true, lastName1: true, companyName: true, fullName: true } });
      client = s ? ((s.fullName?.trim()) || [s.firstName, s.lastName1].filter(Boolean).join(' ').trim() || s.companyName || null) : null;
    }
    return {
      id: q.id, tid: q.tid, subscriberId: q.subscriberId, client, date: q.invoiceDate, status: q.status,
      subtotal: num(q.subtotal), tax: num(q.tax), total: num(q.total), notes: q.notes, proposal: q.proposal,
      items: q.items.map((it) => ({ id: it.id, product: it.product, qty: it.qty, price: num(it.price), taxRate: num(it.taxRate), subtotal: num(it.subtotal), taxTotal: num(it.taxTotal) })),
    };
  }

  async updateQuoteStatus(id: string, status: string) {
    const q = await this.prisma.quote.findUnique({ where: { id } });
    if (!q) throw new NotFoundException('Cotización no encontrada');
    await this.prisma.quote.update({ where: { id }, data: { status } });
    return { id, status };
  }

  /** Convierte una cotización aceptada en factura de venta (SubInvoice). */
  async convertQuoteToInvoice(id: string, user: AuthUser) {
    const q = await this.prisma.quote.findUnique({ where: { id }, include: { items: true } });
    if (!q) throw new NotFoundException('Cotización no encontrada');
    if (!q.subscriberId) throw new BadRequestException('La cotización no tiene cliente; asígnalo antes de convertir.');
    if (q.status === 'converted') throw new BadRequestException('La cotización ya fue convertida en factura.');
    const today = dOnly();
    const sub = await this.prisma.subscriber.findUnique({ where: { id: q.subscriberId }, select: { eInvoice: true } });
    const result = await this.prisma.$transaction(async (tx) => {
      // MISMA secuencia que usa `FacturasService`: calcular aquí un MAX(tid)+1 propio
      // insertaba una factura sin avanzar la secuencia, así que el siguiente
      // `nextval()` habría devuelto un número ya usado (P2002).
      const tid = await nextTid(tx, TID_SEQ.subInvoice);
      const due = new Date(today.getTime() + 30 * 24 * 3600 * 1000);
      const inv = await tx.subInvoice.create({
        data: {
          tid, subscriberId: q.subscriberId!, invoiceDate: today, dueDate: due,
          subtotal: num(q.subtotal), tax: num(q.tax), total: num(q.total), status: 'DUE',
          eInvoiceFlag: sub?.eInvoice ? 'Crear Factura Electronica' : null,
          items: { create: q.items.map((it) => ({ productName: it.product ?? null, qty: it.qty, price: num(it.price), taxRate: num(it.taxRate), subtotal: num(it.subtotal), taxTotal: num(it.taxTotal) })) },
        },
      });
      await tx.quote.update({ where: { id }, data: { status: 'converted' } });
      return { ok: true, invoiceId: inv.id, tid: inv.tid };
    });
    // Contabilización automática de la factura resultante (idempotente; no rompe el flujo).
    await this.posting.postSalesInvoice({
      sourceId: result.invoiceId, date: today, number: result.tid,
      subtotal: num(q.subtotal), tax: num(q.tax), createdBy: user?.name ?? user?.email ?? null,
    });
    return result;
  }

  // --- Cotizaciones ---
  /**
   * Columnas ordenables de la tabla de cotizaciones. `client` no está: el
   * nombre del cliente se resuelve después de la consulta (ver abajo), no es
   * un campo de `Quote`.
   */
  private static readonly ORDEN_COTIZACIONES = {
    tid: 'tid', total: 'total', status: 'status', date: 'createdAt',
  };

  async quotes(params: { search?: string; page?: number; pageSize?: number; sortBy?: string; sortDir?: string }) {
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(params.pageSize) || 25));
    const where: Prisma.QuoteWhereInput = {};
    const search = (params.search || '').trim();
    if (search) { const n = Number(search); if (Number.isFinite(n)) where.tid = n; }
    const [rows, total] = await Promise.all([
      this.prisma.quote.findMany({ where, orderBy: orden(params, OmniService.ORDEN_COTIZACIONES, { createdAt: 'desc' }), skip: (page - 1) * pageSize, take: pageSize }),
      this.prisma.quote.count({ where }),
    ]);
    // Resolver nombres de cliente
    const subIds = rows.map((r) => r.subscriberId).filter((x): x is string => !!x);
    const subs = subIds.length ? await this.prisma.subscriber.findMany({ where: { id: { in: subIds } }, select: { id: true, firstName: true, lastName1: true, companyName: true, fullName: true } }) : [];
    const nameById = new Map(subs.map((s) => [s.id, (s.fullName?.trim()) || [s.firstName, s.lastName1].filter(Boolean).join(' ').trim() || s.companyName || '—']));
    return {
      items: rows.map((q) => ({ id: q.id, tid: q.tid, client: q.subscriberId ? nameById.get(q.subscriberId) ?? '—' : '—', subscriberId: q.subscriberId, date: q.invoiceDate, total: num(q.total), status: q.status, itemsCount: q.itemsCount })),
      total, page, pageSize, pages: Math.ceil(total / pageSize),
    };
  }

  async createQuote(dto: CreateQuoteDto, user: AuthUser) {
    if (!dto.items?.length) throw new BadRequestException('La cotización no tiene ítems');
    const rows = dto.items.map((it) => {
      const qty = Math.max(0, Math.round(it.qty)); const price = round2(it.price); const taxRate = round2(it.taxRate ?? 0);
      const subtotal = round2(qty * price); const taxTotal = round2((subtotal * taxRate) / 100);
      return { ...it, qty, price, taxRate, subtotal, taxTotal };
    });
    const subtotal = round2(rows.reduce((s, r) => s + r.subtotal, 0));
    const tax = round2(rows.reduce((s, r) => s + r.taxTotal, 0));
    const total = round2(subtotal + tax);
    return this.prisma.$transaction(async (tx) => {
      const tid = await nextTid(tx, TID_SEQ.quote);
      const q = await tx.quote.create({
        data: {
          tid, subscriberId: dto.subscriberId ?? null, invoiceDate: dOnly(), subtotal, tax, total, status: 'pending',
          notes: dto.notes ?? null, proposal: dto.proposal ?? null, itemsCount: rows.length,
          items: { create: rows.map((r) => ({ product: r.product, qty: r.qty, price: r.price, taxRate: r.taxRate, subtotal: r.subtotal, taxTotal: r.taxTotal })) },
        },
      });
      return { id: q.id, tid: q.tid, total };
    });
  }
}
