import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { scopeDate } from '../common/date-scope';
import {
  aporteEfectivo, esNotaSaldo, notaSaldo, proximoDiaHabil, rangoDia, SQL_NOTA_SALDO,
} from './cierre-legacy';
import { informeCierre } from './cierre-informe';
import { cajasPermitidas, exigirAcceso } from './caja-scope';
import { AuthUser } from '../auth/current-user.decorator';
import { num, round2 } from '../common/money';
import { paginacion } from '../common/pagination-params';


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

@Injectable()
export class TreasuryService {
  constructor(private readonly prisma: PrismaService) {}

  /** Resumen: ingresos vs egresos vigentes + top categorías de egreso. Por defecto AÑO ACTUAL. */
  async stats(params: { from?: string; to?: string; all?: string }) {
    const dateWhere: Prisma.TransactionWhereInput = { status: 'VIGENTE' };
    const period = scopeDate(params.from, params.to, params.all);
    if (period) dateWhere.date = period;
    const [income, expense, anuladas, byCat] = await Promise.all([
      this.prisma.transaction.aggregate({ _sum: { credit: true }, _count: { _all: true }, where: { ...dateWhere, type: 'INCOME' } }),
      this.prisma.transaction.aggregate({ _sum: { debit: true }, _count: { _all: true }, where: { ...dateWhere, type: 'EXPENSE' } }),
      this.prisma.transaction.count({ where: { status: 'ANULADA', ...(period ? { date: period } : {}) } }),
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
   */
  private async exigirAccesoAlMovimiento(id: string, user: AuthUser): Promise<void> {
    const t = await this.prisma.transaction.findUnique({
      where: { id },
      select: { cashAccountId: true },
    });
    if (!t) throw new NotFoundException('Movimiento no encontrado');
    if (t.cashAccountId != null) {
      await exigirAcceso(this.prisma, user, t.cashAccountId);
      return;
    }
    // Sin caja no hay nada contra lo que contrastar: se lo negamos a quien esté
    // acotado y se lo permitimos a quien ve todas. Hoy no hay filas así, pero el
    // schema lo permite y el lado seguro es no enseñar dinero ajeno.
    if ((await cajasPermitidas(this.prisma, user)) !== null) {
      throw new ForbiddenException('No tienes acceso a este movimiento.');
    }
  }

  /** Listado paginado de movimientos. Por defecto AÑO ACTUAL (override con from/to o all=1). */
  async list(params: { search?: string; type?: string; category?: string; status?: string; from?: string; to?: string; all?: string; cashAccountId?: number; page?: number; pageSize?: number }, user: AuthUser) {
    const { page, pageSize } = paginacion(params);
    const search = (params.search || '').trim();

    const where: Prisma.TransactionWhereInput = {};
    if (params.type) where.type = params.type as any;
    if (params.category) where.category = params.category;
    if (params.status) where.status = params.status as any;
    // Movimientos de UNA caja: sin esto solo se podían ver dentro del detalle de un
    // cierre, y solo del día de ese cierre — un día sin cerrar era invisible por caja.
    if (params.cashAccountId) {
      // Pedir una caja concreta es un 403 si no es tuya, no un listado vacío: así el
      // cliente distingue "no hay movimientos" de "no te toca".
      await exigirAcceso(this.prisma, user, Number(params.cashAccountId));
      where.cashAccountId = Number(params.cashAccountId);
    } else {
      // Sin caja explícita, acotar a las que puede ver (null = sin límite).
      const permitidas = await cajasPermitidas(this.prisma, user);
      if (permitidas) where.cashAccountId = { in: permitidas };
    }
    // Por defecto AÑO ACTUAL (aplica también al buscar; usar all=1 para histórico).
    const period = scopeDate(params.from, params.to, params.all);
    if (period) where.date = period;
    if (search) {
      where.OR = [
        { payerName: { contains: search, mode: 'insensitive' } },
        { note: { contains: search, mode: 'insensitive' } },
        { accountName: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [rows, total] = await Promise.all([
      this.prisma.transaction.findMany({
        where, orderBy: { date: 'desc' }, skip: (page - 1) * pageSize, take: pageSize,
        include: { subscriber: { select: SUB_SELECT }, invoice: { select: { tid: true } } },
      }),
      this.prisma.transaction.count({ where }),
    ]);

    return {
      items: rows.map((t) => ({
        id: t.id, date: t.date, type: t.type, category: t.category,
        debit: num(t.debit), credit: num(t.credit),
        amount: t.type === 'EXPENSE' ? num(t.debit) : num(t.credit),
        payer: subName(t.subscriber) ?? t.payerName ?? '—',
        subscriberId: t.subscriber?.id ?? null,
        method: t.method, account: t.accountName, bank: t.bankName,
        invoiceTid: t.invoice?.tid ?? null, status: t.status, note: t.note,
        attach: t.attach, attachName: t.attachName,
      })),
      total, page, pageSize, pages: Math.ceil(total / pageSize),
    };
  }

  /** Adjunta (o reemplaza) el comprobante/evidencia de un movimiento. */
  async attachTransaction(id: string, file: { filename: string; originalname: string }, user: AuthUser) {
    await this.exigirAccesoAlMovimiento(id, user);
    await this.prisma.transaction.update({ where: { id }, data: { attach: file.filename, attachName: file.originalname } });
    return { ok: true, attachName: file.originalname };
  }

  /** Datos del comprobante adjunto de un movimiento (para descargar/previsualizar). */
  async getTransactionAttachment(id: string, user: AuthUser) {
    await this.exigirAccesoAlMovimiento(id, user);
    const t = await this.prisma.transaction.findUnique({ where: { id }, select: { attach: true, attachName: true } });
    if (!t?.attach) throw new NotFoundException('Comprobante no encontrado');
    return { storedName: t.attach, originalName: t.attachName ?? t.attach };
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

    const esArrastre = (t: { note: string | null }) => !!t.note?.startsWith('Saldo ');
    const esBarridoDeHoy = (t: { note: string | null; type: string }) =>
      t.type === 'EXPENSE' && t.note === notaSaldo(d);
    /** ¿Esta fila es efectivo del cajón? Mismo criterio que `whereEfectivo`. */
    const esEfectivo = (t: { method: string | null; type: string; noShow: boolean }) =>
      !t.noShow && (t.method === 'Cash' || t.method === 'cash' || t.type === 'TRANSFER');

    const movimientos = txs.map((t) => ({
      id: t.id, date: t.date, type: t.type, category: t.category,
      transfer: t.type === 'TRANSFER',
      arrastre: esArrastre(t),
      efectivo: esEfectivo(t),
      amount: num(t.type === 'INCOME' ? t.credit : t.debit),
      // Truncado por fila, igual que el `intval` del legacy (ver `aporteEfectivo`).
      firma: aporteEfectivo(t),
      payer: subName(t.subscriber) ?? t.payerName ?? '—',
      subscriberId: t.subscriber?.id ?? null,
      method: t.method, note: t.note,
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

  /** Datos para el PDF de recibo de caja (recibo + transacciones abonadas). */
  async receiptPdfData(id: string) {
    const r = await this.prisma.paymentReceipt.findUnique({
      where: { id },
      include: {
        invoice: { include: { subscriber: { select: { firstName: true, lastName1: true, companyName: true, fullName: true, abonado: true, docNumber: true } } } },
        transactions: { include: { transaction: { include: { invoice: { select: { tid: true } } } } } },
      },
    });
    if (!r) throw new NotFoundException('Recibo no encontrado');
    const s = r.invoice?.subscriber;
    const name = s ? (s.fullName || [s.firstName, s.lastName1].filter(Boolean).join(' ') || s.companyName || '—').trim() : '—';
    const items = r.transactions.map((rt) => ({
      tid: rt.transaction.invoice?.tid ?? null,
      concept: rt.transaction.invoice?.tid ? `Abono a factura #${rt.transaction.invoice.tid}` : (rt.transaction.category || 'Abono'),
      amount: num(rt.transaction.credit),
      method: rt.transaction.method,
    }));
    return {
      number: String(r.legacyId ?? r.fileName ?? r.id.slice(-6)),
      date: r.date,
      cashier: null as string | null,
      method: items[0]?.method ?? null,
      subscriber: s ? { name, abonado: s.abonado, docNumber: s.docNumber } : null,
      items: items.map(({ tid, concept, amount }) => ({ tid, concept, amount })),
      total: items.reduce((sum, i) => sum + i.amount, 0),
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
    const [informe, arqueo] = await Promise.all([
      informeCierre(this.prisma, cashAccountId, d),
      this.arqueo(cashAccountId, d),
    ]);
    return { ...informe, arqueo };
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

  categories() {
    return this.prisma.transactionCategory.findMany({ orderBy: { name: 'asc' }, select: { name: true } });
  }
}
