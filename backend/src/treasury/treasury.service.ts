import { join } from 'path';
import { BadRequestException, NotFoundException } from '../core/http/errores';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { scopeDate } from '../common/date-scope';
import {
  aporteEfectivo, esNotaSaldo, notaSaldo, proximoDiaHabil, rangoDia, SQL_NOTA_SALDO,
} from './cierre-legacy';
import { informeCierre, WOMPI_ID } from './cierre-informe';
import { alcanceDe, cajasPermitidas, esCajera, exigirAcceso, exigirAccesoAlMovimiento } from './caja-scope';
import { hoyEnColombia, inicioDelDiaColombia } from '../common/fecha-colombia';
import { AuthUser } from '../auth/current-user.decorator';
import { num, round2 } from '../common/money';
import { conceptoFactura, conceptoMesAdelantado } from '../common/concepto-factura';
import { mesesCubiertos } from '../billing/anticipos';
import { terminoDePago } from '../common/terminos-pago';
import { orden, paginacion } from '../common/pagination-params';
import { ListTxQueryDto } from './dto/movimientos.dto';
import { comprobanteDe, rutaDeComprobanteLegacy, TREASURY_ROOT } from './comprobante-legacy';


function subName(s: {
  firstName: string | null; secondName: string | null; lastName1: string | null;
  lastName2: string | null; companyName: string | null; fullName: string | null;
} | null): string | null {
  if (!s) return null;
  if (s.fullName && s.fullName.trim()) return s.fullName.trim();
  const person = [s.firstName, s.secondName, s.lastName1, s.lastName2].map((p) => (p || '').trim()).filter(Boolean).join(' ');
  return person || (s.companyName || '').trim() || null;
}
const SUB_SELECT = { firstName: true, secondName: true, lastName1: true, lastName2: true, companyName: true, fullName: true, id: true, abonado: true } as const;


export class TreasuryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resumen: ingresos vs egresos vigentes + top categorías de egreso. Por defecto AÑO ACTUAL.
   *
   * Acotado a las cajas del usuario (igual que `list`): la cifra que corona la
   * pantalla de Movimientos era la de TODA la empresa aunque la tabla de abajo
   * viniera filtrada a la caja de la cajera, así que el total de otras sedes se
   * leía en la primera línea. Sin `user` (procesos internos) no se acota.
   */
  async stats(params: { from?: string; to?: string; all?: string }, user?: AuthUser) {
    // Mismo alcance que `list`: a la cajera la cifra le habla de SU caja y de HOY,
    // no de los bancos de la empresa ni del año entero.
    const cajera = user ? esCajera(user) : false;
    let cajaWhere: Prisma.TransactionWhereInput = {};
    if (cajera) {
      const a = await alcanceDe(this.prisma, user!);
      cajaWhere = { cashAccountId: a.caja != null ? a.caja : { in: [] } };
    } else {
      const permitidas = user ? await cajasPermitidas(this.prisma, user) : null;
      if (permitidas) cajaWhere = { cashAccountId: { in: permitidas } };
    }
    const dateWhere: Prisma.TransactionWhereInput = { status: 'VIGENTE', ...cajaWhere };
    const period = cajera && !params.from && !params.to && params.all !== '1'
      ? rangoDia(hoyEnColombia())
      : scopeDate(params.from, params.to, params.all);
    if (period) dateWhere.date = period;
    const [income, expense, anuladas, byCat] = await Promise.all([
      this.prisma.transaction.aggregate({ _sum: { credit: true }, _count: { _all: true }, where: { ...dateWhere, type: 'INCOME' } }),
      this.prisma.transaction.aggregate({ _sum: { debit: true }, _count: { _all: true }, where: { ...dateWhere, type: 'EXPENSE' } }),
      this.prisma.transaction.count({ where: { status: 'ANULADA', ...cajaWhere, ...(period ? { date: period } : {}) } }),
      this.prisma.transaction.groupBy({ by: ['category'], _sum: { debit: true }, where: { ...dateWhere, type: 'EXPENSE' }, orderBy: { _sum: { debit: 'desc' } }, take: 8 }),
    ]);
    const ingresos = num(income._sum.credit);
    const egresos = num(expense._sum.debit);
    return {
      ingresos, egresos, balance: ingresos - egresos,
      nIngresos: income._count._all, nEgresos: expense._count._all, anuladas,
      topEgresos: byCat.map((c) => ({ category: c.category, total: num(c._sum.debit) })),
    };
  }

  /**
   * Exige que el usuario pueda ver la caja de ESTE movimiento, o 403.
   * Puerta común de `detail`/`attachTransaction`/`getTransactionAttachment`: todos
   * reciben un id del cliente y antes lo servían sin comprobar nada, así que una
   * cajera podía leer (y adjuntar comprobantes a) movimientos de otra sede.
   * La lógica vive en `caja-scope.ts` porque cobranzas la necesita igual para
   * editar y anular.
   */
  private exigirAccesoAlMovimiento(id: string, user: AuthUser): Promise<void> {
    return exigirAccesoAlMovimiento(this.prisma, user, id);
  }

  /**
   * Traduce los `issuerUserId` de un lote de movimientos al NOMBRE del funcionario.
   *
   * `issuerUserId` es el `eid` del legacy —quien registró el movimiento—, que cruza
   * contra `Staff.legacyId` (mismo criterio que los reportes de personal). Se resuelve
   * en UNA consulta por página, no una por fila.
   *
   * Los que no casan (604 egresos: usuarios borrados del legacy) se quedan sin nombre
   * y la pantalla pinta un guión — inventar "Emisor 37" no le sirve a nadie.
   */
  private async nombresDeEmisor(ids: (number | null)[]): Promise<Map<number, string>> {
    const unicos = [...new Set(ids.filter((x): x is number => x != null))];
    if (!unicos.length) return new Map();
    const staff = await this.prisma.staff.findMany({
      where: { legacyId: { in: unicos } },
      select: { legacyId: true, name: true },
    });
    return new Map(staff.map((s) => [s.legacyId as number, s.name]));
  }

  /** Listado paginado de movimientos. Por defecto AÑO ACTUAL (override con from/to o all=1). */
  /**
   * Columnas ordenables de la tabla de movimientos de caja.
   *
   * Fuera quedan dos por no poder ordenarlas como se muestran:
   * `amount` (monto) es debit en los egresos y credit en los ingresos — un CASE
   * que Prisma no expresa; y `payer` sale del nombre del suscriptor o, si no
   * hay, de `payerName`, así que ordenar por uno solo apelotonaría las filas
   * del otro tipo. Para el monto están los filtros de tipo + los totales.
   */
  private static readonly ORDEN_MOVIMIENTOS = {
    // Dentro del mismo día, por la hora en que se registró (`date` no tiene hora).
    date: (dir: 'asc' | 'desc') => [{ date: dir }, { createdAt: dir }],
    type: 'type',
    cat: 'category',
    fact: 'invoice.tid',
    method: 'method',
    status: 'status',
    // Las tres que el legacy sí enseñaba en su lista de egresos/ingresos: su
    // consecutivo (`tid` allá, `legacyId` aquí) y la cuenta del movimiento.
    codigo: 'legacyId',
    cuenta: 'accountName',
  };

  /**
   * Las notas EXACTAS con las que el cierre escribe el arrastre ('Saldo YYYY-MM-DD').
   *
   * Hacen falta para poder dejarlas fuera de un total, y la regex que las define no se
   * puede expresar en un filtro de Prisma (ver `SQL_NOTA_SALDO`). Son 311 valores
   * distintos —uno por cierre—, así que se traen una vez y se meten en un `notIn`.
   *
   * Un `startsWith: 'Saldo '` NO sirve: hay gastos reales llamados "Saldo de nómina…",
   * "Saldo arriendo…" (1.045 filas) que se irían del total sin que nadie lo notara.
   */
  private arrastres: { notas: string[]; hasta: number } | null = null;
  private async notasDeArrastre(): Promise<string[]> {
    if (this.arrastres && this.arrastres.hasta > Date.now()) return this.arrastres.notas;
    const filas = await this.prisma.$queryRaw<{ note: string }[]>`
      SELECT DISTINCT note FROM "Transaction" WHERE ${SQL_NOTA_SALDO}
    `;
    const notas = filas.map((f) => f.note);
    // Sólo crece cuando se cierra una caja: media hora de caché no envejece nada.
    this.arrastres = { notas, hasta: Date.now() + 30 * 60_000 };
    return notas;
  }

  async list(params: ListTxQueryDto, user: AuthUser) {
    const { page, pageSize } = paginacion(params);
    const where = await this.filtroMovimientos(params, user);

    // El arrastre de caja NO es plata que entre ni salga: son las dos patas con las que
    // el cierre pasa el saldo al día siguiente. En el mes en curso son el 46% de los
    // "ingresos" (238 de 512 millones), así que un total que las sumara diría casi el
    // doble de lo que de verdad se movió. Se quedan en la LISTA (existen y hay que poder
    // verlas) pero fuera del total, y la pantalla lo dice.
    const notasArrastre = await this.notasDeArrastre();
    const sinArrastre: Prisma.TransactionWhereInput = {
      ...where,
      // Las anuladas no suman... salvo que sea justo lo que se pidió ver: en la pantalla
      // de Anulaciones (`status=ANULADA`) forzar VIGENTE dejaba el total en cero, que es
      // la única cifra que allí no le sirve a nadie.
      ...(params.status ? {} : { status: 'VIGENTE' as const }),
      AND: [
        ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
        // `notIn` a secas se comería los movimientos SIN nota: en SQL, `note NOT IN (…)`
        // con note NULL no es cierto, es desconocido, y la fila se cae del total. Hoy no
        // hay ninguna nota nula, pero el schema las permite y un egreso puede nacer sin
        // nota — el día que pase, la plata desaparecería de la suma sin avisar.
        { OR: [{ note: null }, { note: { notIn: notasArrastre } }] },
      ],
    };
    const [rows, total, sumas, arrastres] = await Promise.all([
      this.prisma.transaction.findMany({
        where, orderBy: orden(params, TreasuryService.ORDEN_MOVIMIENTOS, [{ date: 'desc' }, { createdAt: 'desc' }]), skip: (page - 1) * pageSize, take: pageSize,
        include: {
          subscriber: { select: SUB_SELECT }, invoice: { select: { tid: true } },
          // El recibo de caja del movimiento, para poder REIMPRIMIR el voucher desde
          // la lista: si la impresora se atasca o el navegador se come la ventana, la
          // cajera no tenía ningún camino de vuelta al papel.
          receiptLinks: { select: { receiptId: true }, take: 1 },
        },
      }),
      this.prisma.transaction.count({ where }),
      // Totales de LO FILTRADO, no del periodo: la pregunta que se hace quien filtra
      // ("¿cuánto suma esto?") se contestaba sacando las filas a mano. Las anuladas
      // se dejan fuera de la suma aunque estén en la lista — sumarlas mentiría.
      this.prisma.transaction.aggregate({ _sum: { credit: true, debit: true }, where: sinArrastre }),
      // Cuántas patas de arrastre se quedaron fuera del total, para poder decirlo.
      this.prisma.transaction.count({ where: { ...where, note: { in: notasArrastre } } }),
    ]);

    const emisores = await this.nombresDeEmisor(rows.map((t) => t.issuerUserId));

    return {
      items: rows.map((t) => ({
        id: t.id, date: t.date, type: t.type, category: t.category,
        // La hora real del movimiento: `date` es sólo el día contable.
        createdAt: t.createdAt,
        // Quién EMITIÓ el movimiento (la cajera o el funcionario que lo registró),
        // no a quién se le pagó: son dos personas distintas y en la lista sólo se
        // veía la segunda.
        emisor: t.issuerUserId != null ? (emisores.get(t.issuerUserId) ?? null) : null,
        // El consecutivo con el que el movimiento se conoce en el legacy: es el
        // número por el que pregunta contabilidad cuando cuadra las dos listas.
        codigo: t.legacyId,
        debit: num(t.debit), credit: num(t.credit),
        amount: t.type === 'EXPENSE' ? num(t.debit) : num(t.credit),
        payer: subName(t.subscriber) ?? t.payerName ?? '—',
        subscriberId: t.subscriber?.id ?? null,
        method: t.method, account: t.accountName, bank: t.bankName,
        invoiceTid: t.invoice?.tid ?? null, status: t.status, note: t.note,
        ...comprobanteDe(t),
        receiptId: t.receiptLinks[0]?.receiptId ?? null,
      })),
      total, page, pageSize, pages: Math.ceil(total / pageSize),
      totales: {
        ingresos: num(sumas._sum.credit),
        egresos: num(sumas._sum.debit),
        balance: round2(num(sumas._sum.credit) - num(sumas._sum.debit)),
        /** Movimientos de la lista que NO entran en el total (arrastre de caja). */
        arrastres,
      },
    };
  }

  /**
   * El `where` del listado de movimientos: los filtros de la pantalla cruzados con las
   * cajas que puede ver quien pregunta. Lo comparten la tabla y el Excel, para que el
   * archivo traiga exactamente lo que se ve en pantalla — y nunca más de lo que a cada
   * uno le toca ver.
   */
  private async filtroMovimientos(params: ListTxQueryDto, user: AuthUser): Promise<Prisma.TransactionWhereInput> {
    const search = (params.search || '').trim();

    const where: Prisma.TransactionWhereInput = {};
    if (params.type) where.type = params.type as any;
    if (params.category) where.category = params.category;
    if (params.status) where.status = params.status as any;
    if (params.method) where.method = params.method;
    // Con / sin comprobante adjunto: la pregunta de contabilidad al revisar egresos
    // ("¿cuáles salieron sin soporte?") no tenía forma de hacerse en la pantalla.
    // Cuenta igual el subido aquí que el del legacy: para contabilidad la pregunta
    // es "¿este gasto tiene soporte?", no en qué sistema se cargó.
    // Las condiciones que no son un campo suelto se acumulan aquí en vez de escribirse
    // en `where.OR` / `where.AND`: el filtro de comprobante, la búsqueda y el rango de
    // monto usaban los MISMOS dos huecos y el último en ejecutarse borraba al anterior
    // (buscar con "sin comprobante" marcado ignoraba el comprobante, por ejemplo).
    const ands: Prisma.TransactionWhereInput[] = [];
    if (params.attach === '1') ands.push({ OR: [{ attach: { not: null } }, { legacyAttach: { not: null } }] });
    else if (params.attach === '0') { where.attach = null; where.legacyAttach = null; }

    // ── A qué cajas puede mirar esta consulta ──────────────────────────────────
    // Se resuelve como UNA lista (null = sin límite) en vez de escribir
    // `where.cashAccountId` en cada rama: el filtro de sede tiene que CRUZARSE con
    // el alcance del usuario, y con la forma anterior el segundo pisaba al primero.
    let cajas: number[] | null;
    if (params.cashAccountId != null) {
      // Pedir una caja concreta es un 403 si no es tuya, no un listado vacío: así el
      // cliente distingue "no hay movimientos" de "no te toca".
      await exigirAcceso(this.prisma, user, Number(params.cashAccountId));
      cajas = [Number(params.cashAccountId)];
    } else if (esCajera(user)) {
      // La cajera consulta SU ventanilla. Los bancos compartidos son para que el
      // CIERRE cuadre (esa regla sigue intacta en `cajasPermitidas`); en el listado
      // libre le enseñaban los movimientos bancarios de toda la empresa.
      const a = await alcanceDe(this.prisma, user);
      cajas = a.caja != null ? [a.caja] : [];
    } else {
      // Sin caja explícita, acotar a las que puede ver (null = sin límite).
      cajas = await cajasPermitidas(this.prisma, user);
    }
    // Sede: no es una columna del movimiento, vive en la caja (`CashAccount.branchLegacy`,
    // 0 = banco). Se traduce a las cajas de esa sede y se INTERSECA con lo permitido —
    // pedir una sede nunca puede ampliar lo que se ve.
    if (params.sede != null) {
      const deSede = (await this.prisma.cashAccount.findMany({
        where: { branchLegacy: Number(params.sede) }, select: { legacyId: true },
      })).map((c) => c.legacyId).filter((id): id is number => id != null);
      cajas = cajas === null ? deSede : cajas.filter((id) => deSede.includes(id));
    }
    if (cajas !== null) where.cashAccountId = { in: cajas };
    // Por defecto AÑO ACTUAL (aplica también al buscar; usar all=1 para histórico).
    // Para la cajera el defecto es HOY: su pregunta es "qué ha pasado en mi turno",
    // y puede pedir otro periodo con los filtros de fecha.
    const period = esCajera(user) && !params.from && !params.to && params.all !== '1'
      ? rangoDia(hoyEnColombia())
      : scopeDate(params.from, params.to, params.all);
    if (period) where.date = period;
    // Hora del REGISTRO. `date` es el día contable, sin hora; la hora real de cada
    // movimiento está en `createdAt` (la misma del recibo). La ventana va del día
    // `from` a `horaDesde` al día `to` a `horaHasta`, en hora de Colombia, y se suma
    // al filtro por día — no lo reemplaza.
    if (params.horaDesde || params.horaHasta) {
      const hoy = hoyEnColombia().toISOString().slice(0, 10);
      const instante = (dia: string, hora: string, finDelMinuto: boolean) => {
        const inicio = inicioDelDiaColombia(dia);
        if (!inicio) return undefined;
        const [h, m] = hora.split(':').map(Number);
        return new Date(inicio.getTime() + (h * 60 + m) * 60_000 + (finDelMinuto ? 59_999 : 0));
      };
      const gte = instante(params.from ?? params.to ?? hoy, params.horaDesde || '00:00', false);
      const lte = instante(params.to ?? params.from ?? hoy, params.horaHasta || '23:59', true);
      if (gte || lte) ands.push({ createdAt: { ...(gte ? { gte } : {}), ...(lte ? { lte } : {}) } });
    }
    if (search) {
      // El nombre que se VE en la columna "Pagador" sale del abonado (`subName`), no de
      // `payerName`: de los 469.094 movimientos con cliente, el legacy dejó en `payerName`
      // sólo el PRIMER nombre ("LUZ", "JOHN"), así que buscar un apellido o el nombre
      // completo no encontraba nada. Se busca contra las dos fuentes, y el nombre del
      // abonado por PALABRAS (sus apellidos viven en columnas distintas: "JOHN CASTELLANOS"
      // no está entero en ninguna).
      const palabras = search.split(/\s+/).filter(Boolean);
      const enElAbonado: Prisma.SubscriberWhereInput = {
        AND: palabras.map((t) => ({
          OR: [
            { fullName: { contains: t, mode: 'insensitive' as const } },
            { firstName: { contains: t, mode: 'insensitive' as const } },
            { secondName: { contains: t, mode: 'insensitive' as const } },
            { lastName1: { contains: t, mode: 'insensitive' as const } },
            { lastName2: { contains: t, mode: 'insensitive' as const } },
            { companyName: { contains: t, mode: 'insensitive' as const } },
          ],
        })),
      };
      // Un número puede ser el CÓDIGO del movimiento (primera columna, el consecutivo del
      // legacy) o el nº de FACTURA: las dos columnas por las que pregunta contabilidad al
      // cuadrar las listas, y ninguna de las dos se podía buscar.
      const numero = /^\d{1,9}$/.test(search) ? Number(search) : null;
      where.OR = [
        { payerName: { contains: search, mode: 'insensitive' } },
        { note: { contains: search, mode: 'insensitive' } },
        { accountName: { contains: search, mode: 'insensitive' } },
        { subscriber: enElAbonado },
        ...(numero != null ? [{ legacyId: numero }, { invoice: { tid: numero } }] : []),
      ];
    }
    // Rango de monto. "Monto" es lo que se ve en la lista, y esa columna es `credit`
    // en los ingresos y `debit` en los egresos: por eso el campo depende del tipo, y
    // sin tipo se pregunta por los dos (un ingreso trae debit=0, así que un `debit >= min`
    // a secas lo dejaría fuera). Va en AND para no pisar el OR de la búsqueda.
    const rangoMonto: Prisma.DecimalFilter = {};
    if (params.min != null) rangoMonto.gte = params.min;
    if (params.max != null) rangoMonto.lte = params.max;
    if (Object.keys(rangoMonto).length) {
      ands.push(
        params.type === 'EXPENSE' ? { debit: rangoMonto }
        : params.type === 'INCOME' ? { credit: rangoMonto }
        : { OR: [{ credit: rangoMonto }, { debit: rangoMonto }] },
      );
    }
    if (ands.length) where.AND = ands;
    return where;
  }

  /**
   * Tope del Excel. Un año de ingresos de todas las sedes pasa de 60.000 filas: se arma
   * entero en memoria, así que por encima de esto se pide acotar en vez de tumbar la API.
   */
  static readonly MAX_EXPORT = 50_000;

  /**
   * Filas del Excel de movimientos: los MISMOS filtros y el mismo orden que la tabla
   * (`filtroMovimientos`), pero todas las páginas. La cajera sigue saliendo acotada a
   * su caja y a hoy — eso lo decide el filtro, no la pantalla.
   */
  async exportRows(params: ListTxQueryDto, user: AuthUser) {
    const where = await this.filtroMovimientos(params, user);
    const total = await this.prisma.transaction.count({ where });
    if (total > TreasuryService.MAX_EXPORT) {
      throw new BadRequestException(
        `El filtro trae ${total.toLocaleString('es-CO')} movimientos y el Excel admite hasta ${TreasuryService.MAX_EXPORT.toLocaleString('es-CO')}. Acota el periodo o la sede.`,
      );
    }
    const rows = await this.prisma.transaction.findMany({
      where, orderBy: orden(params, TreasuryService.ORDEN_MOVIMIENTOS, [{ date: 'desc' }, { createdAt: 'desc' }]),
      include: { subscriber: { select: SUB_SELECT }, invoice: { select: { tid: true } } },
    });
    const emisores = await this.nombresDeEmisor(rows.map((t) => t.issuerUserId));
    return rows.map((t) => ({
      codigo: t.legacyId,
      date: t.date,
      // Hora del registro como texto de Colombia: una celda de fecha de Excel no tiene zona.
      hora: t.createdAt.toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hour12: false }),
      type: t.type,
      account: t.accountName ?? t.bankName ?? null,
      payer: subName(t.subscriber) ?? t.payerName ?? '',
      abonado: t.subscriber?.abonado ?? null,
      note: t.note,
      emisor: t.issuerUserId != null ? (emisores.get(t.issuerUserId) ?? null) : null,
      category: t.category,
      invoiceTid: t.invoice?.tid ?? null,
      method: t.method,
      amount: t.type === 'EXPENSE' ? num(t.debit) : num(t.credit),
      status: t.status,
      comprobante: comprobanteDe(t).attach != null,
    }));
  }

  /** Adjunta (o reemplaza) el comprobante/evidencia de un movimiento. */
  async attachTransaction(id: string, file: { filename: string; originalname: string }, user: AuthUser) {
    await this.exigirAccesoAlMovimiento(id, user);
    await this.prisma.transaction.update({ where: { id }, data: { attach: file.filename, attachName: file.originalname } });
    return { ok: true, attachName: file.originalname };
  }

  /**
   * Fichero del comprobante de un movimiento (para descargar/previsualizar).
   *
   * Devuelve una RUTA ABSOLUTA y no un nombre porque las dos fuentes viven en carpetas
   * distintas: lo subido aquí en `uploads/treasury`, y lo subido en el legacy en su
   * `userfiles/attach/` (ver `rutaDeComprobanteLegacy`). Lo de aquí manda: si alguien
   * sube un soporte nuevo sobre un movimiento que ya traía el del legacy, se enseña el
   * nuevo.
   */
  async getTransactionAttachment(id: string, user: AuthUser) {
    await this.exigirAccesoAlMovimiento(id, user);
    const t = await this.prisma.transaction.findUnique({
      where: { id }, select: { attach: true, attachName: true, legacyAttach: true },
    });
    if (t?.attach) return { ruta: join(TREASURY_ROOT, t.attach), originalName: t.attachName ?? t.attach };
    if (t?.legacyAttach) return { ruta: await rutaDeComprobanteLegacy(t.legacyAttach), originalName: t.legacyAttach };
    throw new NotFoundException('Comprobante no encontrado');
  }

  /**
   * Comprobante servido por su NOMBRE DE ARCHIVO, sin sesión.
   *
   * Es el enlace que viaja al legacy dentro de la nota del movimiento (ver
   * `notaConComprobante` en scripts/lib/vestel-map.js): allá no hay columna de
   * adjunto ni pantalla que lo muestre, y quien abre el enlace está trabajando en el
   * legacy, sin sesión aquí. El nombre en disco es un UUID v4 sorteado al subir, así
   * que la URL no se adivina; y sólo abre mientras siga atada a un movimiento —
   * quitar el adjunto cierra el enlace.
   *
   * La ruta del fichero se arma con lo que dice la BD, NUNCA con el texto que llega
   * por la URL: así un `..%2F..%2Fetc/passwd` no puede salirse de uploads/treasury.
   */
  async getAttachmentByFile(archivo: string) {
    const t = await this.prisma.transaction.findFirst({
      where: { attach: archivo },
      select: { attach: true, attachName: true },
    });
    if (!t?.attach) throw new NotFoundException('Comprobante no encontrado');
    return { ruta: join(TREASURY_ROOT, t.attach), originalName: t.attachName ?? t.attach };
  }

  /** Detalle de un movimiento (con anulación y recibos ligados). */
  async detail(id: string, user: AuthUser) {
    await this.exigirAccesoAlMovimiento(id, user);
    const t = await this.prisma.transaction.findUnique({
      where: { id },
      include: {
        subscriber: { select: SUB_SELECT }, invoice: { select: { id: true, tid: true } },
        voiding: true, receiptLinks: { include: { receipt: { select: { id: true, fileName: true, date: true } } } },
      },
    });
    if (!t) throw new NotFoundException('Movimiento no encontrado');
    return {
      id: t.id, date: t.date, type: t.type, category: t.category,
      debit: num(t.debit), credit: num(t.credit),
      payer: subName(t.subscriber) ?? t.payerName, subscriberId: t.subscriber?.id ?? null,
      method: t.method, account: t.accountName, bank: t.bankName, note: t.note, status: t.status,
      invoice: t.invoice ? { id: t.invoice.id, tid: t.invoice.tid } : null,
      voiding: t.voiding ? { date: t.voiding.dateTime, reason: t.voiding.reason, by: t.voiding.voidedBy } : null,
      receipts: t.receiptLinks.map((l) => ({ id: l.receipt.id, fileName: l.receipt.fileName, date: l.receipt.date })),
    };
  }

  /**
   * Detalle de un cierre. El "id" de un cierre es el id de la transacción EXPENSE
   * `Saldo <fecha>` que lo materializa: en el modelo del legacy el cierre ES esa fila.
   */
  async cashCloseDetail(id: string, user: AuthUser) {
    const barrido = await this.prisma.transaction.findUnique({
      where: { id },
      select: { cashAccountId: true, date: true, note: true, type: true },
    });
    // `esNotaSaldo` (no `startsWith`): un gasto llamado "Saldo de mano de obra..." no es
    // un cierre y no debe abrir un arqueo.
    if (barrido?.cashAccountId == null || barrido.type !== 'EXPENSE' || !esNotaSaldo(barrido.note)) {
      throw new NotFoundException('Cierre no encontrado');
    }
    await exigirAcceso(this.prisma, user, barrido.cashAccountId);
    return this.arqueo(barrido.cashAccountId, barrido.date);
  }

  /**
   * El MISMO arqueo, de un día que todavía no se ha cerrado. Sin escribir nada.
   *
   * Existe porque el modal de cierre era ciego: se elegía caja y fecha y el arqueo solo
   * aparecía DESPUÉS de guardarlo. Un arqueo es contar el cajón y compararlo con lo que
   * dice el sistema — comprometerse primero y mirar después es justo al revés. Comparte
   * el cálculo con `cashCloseDetail`, así que lo que se previsualiza es lo que se guarda.
   */
  async cashClosePreview(cashAccountId: number, date: string, user: AuthUser) {
    await exigirAcceso(this.prisma, user, cashAccountId);
    const d = new Date(`${date}T00:00:00.000Z`);
    if (Number.isNaN(d.getTime())) throw new NotFoundException('Fecha inválida');
    return this.arqueo(cashAccountId, d);
  }

  /**
   * Arqueo de una caja en un día: el efectivo del cajón y los movimientos que lo componen.
   *
   * Réplica del legacy: el excedente ES el efectivo (base cero, barrido total), y el
   * arrastre del día anterior ya viene dentro como la transacción `Saldo <fecha>` de tipo
   * INCOME. Por eso no se suma ningún arrastre aparte — ver `cierre-legacy.ts`.
   */
  private async arqueo(cashAccountId: number, d: Date) {
    const [account, txs, cerrado] = await Promise.all([
      this.prisma.cashAccount.findUnique({
        where: { legacyId: cashAccountId },
        select: { holder: true, accountNumber: true },
      }),
      this.prisma.transaction.findMany({
        where: { cashAccountId, status: 'VIGENTE', date: rangoDia(d) },
        include: { subscriber: { select: SUB_SELECT }, invoice: { select: { id: true, tid: true } } },
        orderBy: { id: 'asc' },
      }),
      // La pata EXPENSE del arrastre = la marca de que este día ya se cerró.
      this.prisma.transaction.findFirst({
        where: {
          cashAccountId, date: rangoDia(d), type: 'EXPENSE',
          note: notaSaldo(d), status: 'VIGENTE',
        },
        select: { id: true, debit: true, payerName: true, createdAt: true, legacyId: true },
      }),
    ]);

    /**
     * Horas de apertura y cierre.
     *
     * El legacy las saca de `aauth_users.hinicial`/`hcierre`, que son de la SESIÓN DEL
     * USUARIO QUE MIRA, no de la caja: abrir un cierre de marzo enseña las horas de hoy
     * de quien lo abrió. Aquí se derivan por caja+fecha, que es lo que de verdad
     * significan: cuándo se movió esa caja por primera vez y cuándo se barrió.
     *
     * Sólo sirve para lo creado EN NEXUS (`legacyId = null`): en lo migrado, `createdAt`
     * es la hora de la ETL (idéntica en las 498.897 filas), así que ahí se devuelve null
     * y la pantalla pone "—". Mentir con la hora de una migración sería peor que no saber.
     */
    const primera = await this.prisma.transaction.findFirst({
      where: { cashAccountId, date: rangoDia(d), status: 'VIGENTE', legacyId: null },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    });
    const horaApertura = primera?.createdAt ?? null;
    const horaCierre = cerrado && cerrado.legacyId == null ? cerrado.createdAt : null;

    // Criterio canónico (`Saldo YYYY-MM-DD` exacto) y no "empieza por Saldo": el
    // prefijo suelto se traga cualquier movimiento cuya nota empiece igual —un
    // "Saldo a favor…" del mostrador, por ejemplo— y lo saca del arqueo como si fuera
    // arrastre, o sea plata que entró y deja de contarse. Es el impostor que ya avisaba
    // el comentario de `whereArrastre`.
    const esArrastre = (t: { note: string | null }) => esNotaSaldo(t.note);
    const esBarridoDeHoy = (t: { note: string | null; type: string }) =>
      t.type === 'EXPENSE' && t.note === notaSaldo(d);
    /** ¿Esta fila es efectivo del cajón? Mismo criterio que `whereEfectivo`. */
    const esEfectivo = (t: { method: string | null; type: string; noShow: boolean }) =>
      !t.noShow && (t.method === 'Cash' || t.method === 'cash' || t.type === 'TRANSFER');

    const movimientos = txs.map((t) => ({
      id: t.id, date: t.date, type: t.type, category: t.category,
      // El consecutivo del legacy: es el número por el que se busca el movimiento para
      // anularlo (la lista de /tesoreria abre por él). Sin este dato, del cierre había
      // que salir a buscar el pago por nombre y monto uno a uno. Null = nacido aquí y
      // todavía sin viajar al legacy.
      codigo: t.legacyId,
      transfer: t.type === 'TRANSFER',
      arrastre: esArrastre(t),
      efectivo: esEfectivo(t),
      amount: num(t.type === 'INCOME' ? t.credit : t.debit),
      // Truncado por fila, igual que el `intval` del legacy (ver `aporteEfectivo`).
      firma: aporteEfectivo(t),
      payer: subName(t.subscriber) ?? t.payerName ?? '—',
      subscriberId: t.subscriber?.id ?? null,
      method: t.method, note: t.note,
      // El comprobante viaja con el movimiento: el cierre es donde se revisa el gasto
      // uno a uno, y hasta ahora había que salirse a /tesoreria/egresos para verlo.
      ...comprobanteDe(t),
      invoice: t.invoice ? { id: t.invoice.id, tid: t.invoice.tid } : null,
    }));

    const suma = (f: (m: (typeof movimientos)[number]) => boolean) =>
      round2(movimientos.filter(f).reduce((s, m) => s + m.amount, 0));

    // El efectivo del cajón ANTES de barrerlo: excluye la pata EXPENSE del cierre de hoy
    // (si ya se cerró), que es justo lo que se llevó.
    const efectivo = round2(
      movimientos
        .filter((m) => m.efectivo && !esBarridoDeHoy({ note: m.note, type: m.type }))
        .reduce((s, m) => s + m.firma, 0),
    );

    // Desglose informativo (el excedente NO se calcula con estas líneas: es el efectivo).
    const arrastreEntrada = suma((m) => m.arrastre && m.type === 'INCOME');
    const desglose = {
      arrastre: arrastreEntrada,
      ventas: suma((m) => m.type === 'INCOME' && m.efectivo && !m.arrastre),
      egresos: suma((m) => m.type === 'EXPENSE' && m.efectivo && !m.arrastre),
      transferencias: round2(
        movimientos.filter((m) => m.type === 'TRANSFER').reduce((s, m) => s + m.firma, 0),
      ),
      noEfectivo: suma((m) => !m.efectivo && m.type === 'INCOME'),
    };

    // Desglose por categoría: responde "¿de dónde salió esta plata?" sin leer 400 filas.
    const porCategoria = new Map<string, { category: string; type: string; n: number; total: number }>();
    for (const m of movimientos) {
      const k = `${m.type}|${m.category ?? '—'}`;
      const prevCat = porCategoria.get(k);
      porCategoria.set(k, {
        category: m.category ?? '—', type: m.type,
        n: (prevCat?.n ?? 0) + 1, total: round2((prevCat?.total ?? 0) + m.amount),
      });
    }

    const excedenteGuardado = cerrado ? round2(num(cerrado.debit)) : null;
    return {
      id: cerrado?.id ?? null,
      date: d,
      cashAccountId,
      account: account ? { holder: account.holder, accountNumber: account.accountNumber } : null,
      yaCerrado: !!cerrado,
      /**
       * true = este día no tiene NINGÚN movimiento propio: lo que hay en el cajón es
       * sólo el arrastre que dejó el cierre anterior. La pantalla no debe ofrecer
       * cerrar (el backend además lo rechaza con `motivo: 'sin-actividad'`): cerrar un
       * día en blanco lo deja marcado como cerrado y le quita a la cajera el botón de
       * abrir la caja, sin manera de volver atrás.
       */
      sinActividad: movimientos.filter((m) => !m.arrastre).length === 0,
      cajero: cerrado?.payerName ?? null,
      cerradoEl: cerrado?.createdAt ?? null,
      /** null = no se sabe (cierre migrado: el legacy no guardaba la hora por caja). */
      horaApertura,
      horaCierre,
      /** true = este cierre viene del legacy, así que no tiene horas reales. */
      migrado: !!cerrado && cerrado.legacyId != null,
      /** A dónde se arrastra (o se arrastró) el excedente. */
      proximoDiaHabil: proximoDiaHabil(d),
      /** El excedente que se barrió, si ya se cerró. */
      guardado: excedenteGuardado,
      /** Lo que daría con los movimientos vigentes ahora mismo. */
      efectivo,
      excedente: efectivo,
      desglose,
      /** true = el cierre guardado ya no cuadra con el libro (algo cambió tras cerrar). */
      descuadrado: excedenteGuardado != null && Math.abs(efectivo - excedenteGuardado) > 0.5,
      porCategoria: [...porCategoria.values()].sort((a, b) => b.total - a.total),
      movimientos,
    };
  }

  /**
   * Datos para el recibo de caja (el papel de 80 mm que sale al cobrar).
   *
   * Réplica de lo que armaba `Invoices::printinvoice()` en el legacy: el renglón NO
   * dice "Abono a factura #123", dice el MES facturado y el número de cuenta
   * (`julio CTA:123456`) —nunca el plan ni el servicio—, y debajo van las facturas
   * que el cliente sigue debiendo. Eso es lo que la cajera le lee al
   * cliente cuando pregunta "¿y entonces qué me falta?".
   */
  async receiptPdfData(id: string) {
    const r = await this.prisma.paymentReceipt.findUnique({
      where: { id },
      include: {
        invoice: {
          select: {
            id: true, tid: true, status: true, discount: true, branchRef: true, subscriberId: true, term: true,
            subscriber: {
              select: {
                ...SUB_SELECT, legacyId: true, docType: true, docNumber: true, email: true,
              },
            },
          },
        },
        transactions: {
          include: {
            transaction: {
              select: {
                credit: true, method: true, category: true, invoiceId: true,
                // Un recaudo puede traer un renglón SIN factura: el excedente que quedó
                // como saldo a favor. En el recibo tiene que decirlo con esas palabras
                // —es lo que el cliente se lleva a casa—, no "Sales".
                // `monthlyNet` es lo que valió cada mes adelantado YA REBAJADO: sin él
                // el papel partiría el adelanto al precio de lista y saldría un renglón
                // de más con el resto suelto.
                advance: { select: { id: true, monthlyNet: true } },
                // De los `items` sólo se mira si el cargo es una AFILIACIÓN, que es el
                // único renglón que NO se rotula por mes (ver `conceptoFactura`); el
                // plan de una mensualidad sigue sin salir en el papel.
                invoice: {
                  select: { tid: true, invoiceDate: true, items: { select: { productName: true } } },
                },
                // Cuando el recaudo es SÓLO anticipo el recibo no cuelga de ninguna
                // factura, así que el cliente y la sede del papel salen de aquí.
                subscriberId: true,
                subscriber: {
                  select: {
                    ...SUB_SELECT, legacyId: true, docType: true, docNumber: true, email: true,
                    branch: { select: { name: true } },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!r) throw new NotFoundException('Recibo no encontrado');

    // El cliente: de la factura principal si la hay, y si no —recibo de puro anticipo—
    // del movimiento, que siempre lo lleva.
    const desdeMovimiento = r.transactions.map((rt) => rt.transaction).find((t) => t.subscriber);
    const s = r.invoice?.subscriber ?? desdeMovimiento?.subscriber ?? null;
    const subscriberId = r.invoice?.subscriberId ?? desdeMovimiento?.subscriberId ?? null;
    // Los renglones del papel. El pago adelantado no es UNO: se abre en un renglón por
    // cada mes que la plata alcanza a cubrir —`septiembre CTA:474366`—, que es lo que el
    // cliente necesita leerse cuando pregunta "¿hasta cuándo estoy pagado?". Esas
    // facturas todavía no existen (nacen el día 1 y ya pagadas): el legacy hace lo mismo
    // y lo dice sin rodeos, "calculo de facturas SIN CREAR al hacer pagos adelantados"
    // (`Invoices_model::calculo_de_facturas_adelantadas`, impreso en
    // `view-print-ltr2.php:286`). Ver `mesesCubiertos`.
    const items: { tid: number | null; concept: string; amount: number; method: string | null }[] = [];
    for (const rt of r.transactions) {
      const t = rt.transaction;
      const amount = num(t.credit);
      if (t.invoice) {
        items.push({ tid: t.invoice.tid, concept: conceptoFactura(t.invoice), amount, method: t.method });
        continue;
      }
      if (t.advance && t.subscriberId) {
        const meses = await mesesCubiertos(this.prisma, t.subscriberId, amount, {
          mensualidad: t.advance.monthlyNet != null ? num(t.advance.monthlyNet) : undefined,
        });
        if (meses.length) {
          // El `tid` es el de la factura del recibo, igual que el legacy: es el número
          // de cuenta del cliente, no el de una factura que aún no se ha emitido.
          for (const m of meses) {
            items.push({
              tid: r.invoice?.tid ?? null,
              concept: conceptoMesAdelantado(m.fecha, r.invoice?.tid ?? null),
              amount: m.monto,
              method: t.method,
            });
          }
          continue;
        }
      }
      items.push({
        tid: null,
        // Respaldo cuando no se puede saber qué meses cubre (cliente sin facturas, o sin
        // servicios de los que sacar la mensualidad): al menos que el papel diga qué es.
        concept: t.advance ? 'Saldo a favor (pago adelantado)' : t.category || 'Abono',
        amount,
        method: t.method,
      });
    }
    const paid = round2(items.reduce((sum, i) => sum + i.amount, 0));

    // Lo que le queda debiendo. El saldo suma TODAS las pendientes (incluida la que
    // este recibo dejó a medias); el listado excluye las del recibo, que ya salieron
    // arriba — mismo criterio que el `lista_a_excluir` del legacy.
    const pagadas = new Set(
      r.transactions.map((t) => t.transaction.invoiceId).filter((x): x is string => !!x),
    );
    const pendientes = subscriberId
      ? await this.prisma.subInvoice.findMany({
          where: { subscriberId, status: { in: ['DUE', 'PARTIAL'] } },
          // El bloque de pendientes se rotula por MES, salvo la afiliación: los
          // `items` viajan sólo para reconocerla (ver `conceptoFactura`).
          select: {
            id: true, tid: true, invoiceDate: true, total: true, paidAmount: true,
            items: { select: { productName: true } },
          },
          orderBy: { invoiceDate: 'asc' },
        })
      : [];
    const saldoDe = (i: { total: Prisma.Decimal; paidAmount: Prisma.Decimal }) =>
      Math.max(0, round2(num(i.total) - num(i.paidAmount)));
    const balance = round2(pendientes.reduce((sum, i) => sum + saldoDe(i), 0));

    return {
      number: String(r.legacyId ?? r.fileName ?? r.id.slice(-6)),
      date: r.date,
      createdAt: r.createdAt,
      branch: r.invoice?.branchRef ?? desdeMovimiento?.subscriber?.branch?.name ?? null,
      cashier: null as string | null,
      cashierRole: null as string | null,
      method: items[0]?.method ?? null,
      subscriber: s
        ? {
            name: subName(s) ?? '—',
            abonado: s.abonado,
            docType: s.docType,
            docNumber: s.docNumber,
            email: s.email,
            codigo: s.legacyId,
          }
        : null,
      items: items.map(({ tid, concept, amount }) => ({ tid, concept, amount })),
      pending: pendientes
        .filter((i) => !pagadas.has(i.id))
        .map((i) => ({ tid: i.tid, concept: conceptoFactura(i), amount: saldoDe(i) })),
      total: round2(paid + balance),
      paid,
      discount: num(r.invoice?.discount ?? 0),
      balance,
      status: r.invoice?.status ?? null,
      // Condición de pago (`billing_terms.title` del legacy). La tabla no se importó
      // —allá solo queda viva la 2, "Consignacion", en el 99,9% de las facturas—, así
      // que se traduce el id aquí en vez de arrastrar un catálogo de una fila.
      terms: terminoDePago(r.invoice?.term),
    };
  }

  /** Datos para el PDF de cierre de caja (resuelve el nombre de la caja). */
  /**
   * Informe del cierre (los bloques del legacy: cobranza, bancos, servicios, meses,
   * forma de pago, anulaciones, egresos) de una caja en una fecha.
   */
  async cashCloseReport(cashAccountId: number, date: string, user: AuthUser) {
    await exigirAcceso(this.prisma, user, cashAccountId);
    const d = new Date(`${date}T00:00:00.000Z`);
    if (Number.isNaN(d.getTime())) throw new NotFoundException('Fecha inválida');
    // Va con el arqueo pegado para que la pantalla se pinte con UNA sola llamada: la
    // cabecera del legacy (horas, cajero, efectivo) sale del arqueo y los bloques del
    // informe, y ambos deben ser del mismo instante o se contradicen entre sí.
    //
    // `soloCaja` es el MISMO informe recalculado sin la pasarela en línea: es lo que
    // pintan las gráficas del panel de la cajera, porque esa plata nunca pasa por su
    // ventanilla y sumársela le enseña un recaudo que no es suyo (llegó a ser el 46% de
    // un día). El informe de arriba se queda como está —tablas y PDF son el documento
    // del legacy y tienen que cuadrar con el sistema viejo—, así que la pantalla tiene
    // las dos cifras y usa cada una donde toca.
    const [informe, soloCaja, arqueo] = await Promise.all([
      informeCierre(this.prisma, cashAccountId, d),
      informeCierre(this.prisma, cashAccountId, d, { excluirBancos: [WOMPI_ID] }),
      this.arqueo(cashAccountId, d),
    ]);
    return {
      ...informe,
      arqueo,
      soloCaja: {
        cobranza: soloCaja.cobranza,
        formaPago: soloCaja.formaPago,
        servicios: soloCaja.servicios,
        tipoServicio: soloCaja.tipoServicio,
        meses: soloCaja.meses,
      },
    };
  }

  async cashClosePdfData(id: string, user: AuthUser) {
    const a = await this.cashCloseDetail(id, user);
    const informe = await informeCierre(this.prisma, a.cashAccountId, a.date);
    return {
      informe,
      cashAccountName: a.account?.holder ?? `Caja #${a.cashAccountId}`,
      date: a.date,
      userName: a.cajero ?? '—',
      proximoDiaHabil: a.proximoDiaHabil,
      arrastre: a.desglose.arrastre,
      ventas: a.desglose.ventas,
      egresos: a.desglose.egresos,
      transferencias: a.desglose.transferencias,
      noEfectivo: a.desglose.noEfectivo,
      excedente: a.guardado ?? a.excedente,
      descuadrado: a.descuadrado,
      efectivoHoy: a.efectivo,
      porCategoria: a.porCategoria,
      movimientos: a.movimientos.map((m) => ({
        date: m.date, note: m.note, payer: m.payer, category: m.category,
        method: m.method, type: m.type, amount: m.amount, firma: m.firma,
        codigo: m.codigo,
      })),
    };
  }

  /**
   * Filtro común de cierres. Un cierre ES la transacción EXPENSE `Saldo <fecha>`: en el
   * modelo del legacy no hay tabla de cierres, el libro es la única fuente de verdad.
   *
   * Va en SQL crudo (y no con `findMany`) porque el criterio que separa un cierre de un
   * gasto corriente llamado "Saldo de ..." es una REGEX sobre la nota, y Prisma no tiene
   * filtro de regex. Hacerlo en JS rompería la paginación y el conteo.
   */
  private cashCloseWhereSql(
    params: { from?: string; to?: string; all?: string; cashAccountId?: number },
    permitidas: number[] | null,
  ): Prisma.Sql {
    const conds: Prisma.Sql[] = [
      Prisma.sql`type = 'EXPENSE'`,
      Prisma.sql`status = 'VIGENTE'`,
      Prisma.sql`"invoiceId" IS NULL`, // legacy `tid = -1`
      SQL_NOTA_SALDO,
    ];
    const period = scopeDate(params.from, params.to, params.all);
    if (period?.gte) conds.push(Prisma.sql`"date" >= ${period.gte}`);
    if (period?.lte) conds.push(Prisma.sql`"date" <= ${period.lte}`);
    if (params.cashAccountId) conds.push(Prisma.sql`"cashAccountId" = ${Number(params.cashAccountId)}`);
    // Acota a las cajas que el usuario puede ver. `null` = sin límite.
    // Lista vacía -> `IN (NULL)` no filtraría nada, así que se fuerza a falso.
    if (permitidas) {
      conds.push(
        permitidas.length
          ? Prisma.sql`"cashAccountId" IN (${Prisma.join(permitidas)})`
          : Prisma.sql`false`,
      );
    }
    return Prisma.sql`WHERE ${Prisma.join(conds, ' AND ')}`;
  }

  /** Listado paginado de cierres + totales del conjunto filtrado. Por defecto AÑO ACTUAL. */
  async cashCloses(params: { from?: string; to?: string; all?: string; cashAccountId?: number; page?: number; pageSize?: number }, user: AuthUser) {
    const { page, pageSize } = paginacion(params);
    if (params.cashAccountId) await exigirAcceso(this.prisma, user, Number(params.cashAccountId));
    const whereSql = this.cashCloseWhereSql(params, await cajasPermitidas(this.prisma, user));

    const [rows, [agg]] = await Promise.all([
      this.prisma.$queryRaw<
        { id: string; cashAccountId: number; accountName: string | null; date: Date; debit: string; payerName: string | null }[]
      >(Prisma.sql`
        SELECT id, "cashAccountId", "accountName", "date", debit, "payerName"
        FROM "Transaction"
        ${whereSql}
        ORDER BY "date" DESC, "accountName" ASC
        LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
      `),
      this.prisma.$queryRaw<{ total: number; surplus: string | null }[]>(Prisma.sql`
        SELECT COUNT(*)::int AS total, SUM(debit) AS surplus
        FROM "Transaction"
        ${whereSql}
      `),
    ]);
    const total = Number(agg?.total ?? 0);

    return {
      items: rows.map((c) => ({
        id: c.id,
        cashAccountId: c.cashAccountId,
        account: c.accountName,
        date: c.date,
        cajero: c.payerName,
        /** Lo que se barrió del cajón y se arrastró al próximo día hábil. */
        surplus: Number(c.debit),
        proximoDiaHabil: proximoDiaHabil(c.date),
      })),
      totals: { count: total, surplus: Number(agg?.surplus ?? 0) },
      total, page, pageSize, pages: Math.ceil(total / pageSize),
    };
  }

  /** Cierres agregados por período (día/semana/mes) para la vista consolidada. */
  async cashClosesSummary(params: { group?: string; from?: string; to?: string; all?: string; cashAccountId?: number }, user: AuthUser) {
    const group = params.group === 'week' || params.group === 'month' ? params.group : 'day';
    if (params.cashAccountId) await exigirAcceso(this.prisma, user, Number(params.cashAccountId));
    const whereSql = this.cashCloseWhereSql(params, await cajasPermitidas(this.prisma, user));
    const rows = await this.prisma.$queryRaw<{ period: Date; count: number; surplus: string }[]>(Prisma.sql`
      SELECT date_trunc(${group}::text, "date")::date AS period,
             COUNT(*)::int AS count,
             SUM(debit) AS surplus
      FROM "Transaction"
      ${whereSql}
      GROUP BY 1
      ORDER BY 1 DESC
    `);
    return {
      group,
      items: rows.map((r) => ({
        period: r.period, count: Number(r.count), surplus: Number(r.surplus ?? 0),
      })),
    };
  }

  /**
   * Serie diaria de una caja: ingresos, egresos y nº de pagos por día, terminando en
   * `date`. Es lo que le da forma de tendencia al panel de la cajera — hasta ahora
   * cada pantalla sólo sabía mirar UN día, así que no había manera de ver si hoy va
   * flojo o normal sin abrir el cierre de ayer a mano.
   *
   * Deja fuera las dos patas del arrastre ('Saldo <fecha>'): son el mismo dinero
   * pasando de un día al siguiente, y contarlas inflaría a la vez ingresos y egresos.
   */
  async cashDaily(cashAccountId: number, date: string, days: number, user: AuthUser) {
    await exigirAcceso(this.prisma, user, cashAccountId);
    const hasta = new Date(`${date}T00:00:00.000Z`);
    if (Number.isNaN(hasta.getTime())) throw new NotFoundException('Fecha inválida');
    const n = Math.min(Math.max(Math.trunc(days) || 14, 2), 90);
    const desde = new Date(hasta.getTime() - (n - 1) * 86_400_000);
    const desdeStr = desde.toISOString().slice(0, 10);
    const hastaStr = hasta.toISOString().slice(0, 10);

    // OJO con el `note IS NULL`: en SQL `NOT (NULL ~ '...')` es NULL, no true, así que
    // sin esa rama se caerían del informe todos los movimientos sin nota — que son la
    // mayoría.
    //
    // Y OJO con las fechas: `Transaction.date` es un `date` de Postgres, y atarle un
    // Date de JS lo compara como timestamptz — o sea, convertido a la zona de la SESIÓN
    // (aquí Europe/Berlin), con lo que el rango se corre un día y el primero se pierde.
    // Por eso van como texto con `::date`: una fecha sin hora no tiene zona horaria.
    const filas = await this.prisma.$queryRaw<
      { dia: Date; ingresos: Prisma.Decimal | null; egresos: Prisma.Decimal | null; pagos: number }[]
    >(Prisma.sql`
      SELECT "date"::date AS dia,
             SUM(CASE WHEN "type" = 'INCOME'  THEN credit ELSE 0 END) AS ingresos,
             SUM(CASE WHEN "type" = 'EXPENSE' THEN debit  ELSE 0 END) AS egresos,
             COUNT(*) FILTER (WHERE "type" = 'INCOME')::int AS pagos
      FROM "Transaction"
      WHERE "cashAccountId" = ${cashAccountId}
        AND status = 'VIGENTE'
        AND "date" BETWEEN ${desdeStr}::date AND ${hastaStr}::date
        AND (note IS NULL OR NOT (${SQL_NOTA_SALDO}))
      GROUP BY 1
      ORDER BY 1
    `);

    // Los días sin movimiento no vienen en el GROUP BY, pero en una gráfica tienen que
    // existir: un hueco y un cero no dicen lo mismo.
    const porDia = new Map(filas.map((f) => [f.dia.toISOString().slice(0, 10), f]));
    const items = Array.from({ length: n }, (_, i) => {
      const d = new Date(desde.getTime() + i * 86_400_000);
      const key = d.toISOString().slice(0, 10);
      const f = porDia.get(key);
      return {
        date: key,
        ingresos: round2(num(f?.ingresos ?? 0)),
        egresos: round2(num(f?.egresos ?? 0)),
        pagos: Number(f?.pagos ?? 0),
      };
    });
    return { cashAccountId, desde: desde.toISOString().slice(0, 10), hasta: date, items };
  }

  categories() {
    return this.prisma.transactionCategory.findMany({ orderBy: { name: 'asc' }, select: { name: true } });
  }
}
