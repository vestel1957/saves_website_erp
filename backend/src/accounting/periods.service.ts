import { BadRequestException, NotFoundException } from '../core/http/errores';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePeriodDto } from './dto/accounting.dto';
import { num, round2 } from '../common/money';
import { nextTid, TID_SEQ } from '../common/tid';

/**
 * Periodos contables y ARRASTRE DE SALDOS DE FIN DE MES.
 *
 * La idea es la misma del arrastre diario de caja (`treasury/cierre-legacy.ts`), subida
 * de escala: cerrar deja escrito con cuánto se queda cada cuenta, y con eso arranca el
 * mes siguiente. Las dos diferencias con el de caja salen de que aquí el libro es de
 * partida doble:
 *
 * 1. **Las cuentas de balance (activo, pasivo, patrimonio) NO se barren.** Su saldo
 *    sigue vivo por naturaleza: el banco no se vacía porque cambie el mes. El arrastre
 *    de esas cuentas se GUARDA (`FiscalPeriodBalance`), pero no se mueve.
 * 2. **Las de resultado (ingresos, costos, gastos) SÍ se barren**, contra `Utilidad del
 *    ejercicio` (PUC 360505), con un asiento de cierre de verdad. Ese sí es el gemelo
 *    del barrido del cajón: el mes siguiente empieza en cero y lo ganado queda en
 *    patrimonio, que es cuenta de balance y por tanto se arrastra sola.
 *
 * Barrer TAMBIÉN las de balance —copiar el arrastre diario al pie de la letra— llenaría
 * el mayor del banco de salidas y entradas ficticias cada 30 días y haría ilegible
 * cualquier extracto. De ahí la asimetría.
 */
export class PeriodsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Cuenta a la que se lleva el resultado del mes al cerrar (PUC Colombia). */
  static readonly CUENTA_RESULTADO = '360505';

  /** ¿Es cuenta de resultado? Son las que el cierre barre. */
  static esResultado(tipo: string) {
    return tipo === 'INCOME' || tipo === 'COST' || tipo === 'EXPENSE';
  }

  list() {
    return this.prisma.fiscalPeriod.findMany({ orderBy: [{ year: 'desc' }, { month: 'desc' }] });
  }

  async create(dto: CreatePeriodDto) {
    const isMonth = dto.month != null;
    const month = isMonth ? dto.month! : null;
    const dup = await this.prisma.fiscalPeriod.findUnique({ where: { year_month: { year: dto.year, month: month as any } } });
    if (dup) throw new BadRequestException('El periodo ya existe');

    const start = isMonth ? new Date(Date.UTC(dto.year, month! - 1, 1)) : new Date(Date.UTC(dto.year, 0, 1));
    // último día del rango a las 23:59:59.999 para que las fechas de ese día queden dentro
    const end = isMonth
      ? new Date(Date.UTC(dto.year, month!, 0, 23, 59, 59, 999))
      : new Date(Date.UTC(dto.year, 11, 31, 23, 59, 59, 999));
    const name = isMonth
      ? `${dto.year}-${String(month).padStart(2, '0')}`
      : `Año ${dto.year}`;

    return this.prisma.fiscalPeriod.create({
      data: { name, type: isMonth ? 'MONTH' : 'YEAR', year: dto.year, month, startDate: start, endDate: end },
    });
  }

  private async get(id: string) {
    const p = await this.prisma.fiscalPeriod.findUnique({ where: { id } });
    if (!p) throw new NotFoundException('Periodo no encontrado');
    return p;
  }

  /**
   * Saldos de todas las cuentas ANTES de una fecha: débito − crédito de lo
   * contabilizado hasta ahí.
   *
   * Es el saldo de apertura del periodo, y se calcula sobre el LIBRO y no sobre el
   * arrastre guardado a propósito: así vale igual para el primer mes (que no tiene
   * anterior) que para uno cuyo anterior nunca se cerró.
   */
  private async saldosHasta(corte: Date): Promise<Map<string, number>> {
    const filas = await this.prisma.journalLine.groupBy({
      by: ['accountId'],
      where: { entry: { status: 'POSTED', date: { lt: corte } } },
      _sum: { debit: true, credit: true },
    });
    return new Map(filas.map((f) => [f.accountId, round2(num(f._sum.debit) - num(f._sum.credit))]));
  }

  /** Movimiento (débitos y créditos) de cada cuenta dentro del periodo. */
  private async movimientosDe(p: { startDate: Date; endDate: Date }) {
    const filas = await this.prisma.journalLine.groupBy({
      by: ['accountId'],
      where: { entry: { status: 'POSTED', date: { gte: p.startDate, lte: p.endDate } } },
      _sum: { debit: true, credit: true },
    });
    return new Map(
      filas.map((f) => [f.accountId, { debit: round2(num(f._sum.debit)), credit: round2(num(f._sum.credit)) }]),
    );
  }

  /** El periodo mensual inmediatamente anterior, si existe. */
  private periodoAnterior(p: { startDate: Date; id: string }) {
    return this.prisma.fiscalPeriod.findFirst({
      where: { type: 'MONTH', endDate: { lt: p.startDate }, id: { not: p.id } },
      orderBy: { endDate: 'desc' },
      select: { id: true, name: true, status: true },
    });
  }

  /**
   * Vista previa del cierre: qué arrastre quedaría guardado y qué asiento se
   * escribiría, sin tocar nada.
   *
   * Existe por lo mismo que el arqueo se enseña antes de cerrar la caja: cerrar un mes
   * bloquea los asientos de esas fechas, y enterarse después de lo que se cerró es
   * tarde.
   */
  async preview(id: string) {
    return this.calcularCierre(await this.get(id));
  }

  /**
   * El cálculo entero del cierre, sin escribir. Lo comparten la vista previa y el
   * cierre de verdad, así que lo que se previsualiza es exactamente lo que se guarda.
   */
  private async calcularCierre(p: { id: string; name: string; startDate: Date; endDate: Date }) {
    const [aperturas, movimientos, cuentas, anterior] = await Promise.all([
      this.saldosHasta(p.startDate),
      this.movimientosDe(p),
      this.prisma.account.findMany({
        select: { id: true, code: true, name: true, type: true },
        orderBy: { code: 'asc' },
      }),
      this.periodoAnterior(p),
    ]);

    const resultado = cuentas.find((c) => c.code === PeriodsService.CUENTA_RESULTADO) ?? null;

    // Una fila por cuenta con algo que decir: saldo de entrada, movimiento, o ambos.
    const filas = cuentas
      .map((c) => {
        const opening = aperturas.get(c.id) ?? 0;
        const mov = movimientos.get(c.id) ?? { debit: 0, credit: 0 };
        const barre = PeriodsService.esResultado(c.type);
        const saldo = round2(opening + mov.debit - mov.credit);
        return {
          accountId: c.id, code: c.code, name: c.name, type: c.type,
          opening, debit: mov.debit, credit: mov.credit,
          /** Saldo antes del asiento de cierre. */
          saldo,
          /** Lo que se arrastra al mes siguiente: las de resultado quedan en cero. */
          closing: barre ? 0 : saldo,
        };
      })
      .filter((f) => f.opening !== 0 || f.debit !== 0 || f.credit !== 0);

    // Líneas del asiento de cierre: cada cuenta de resultado con saldo se cancela por
    // el lado contrario, y la contrapartida neta va a Utilidad del ejercicio.
    const aCancelar = filas.filter((f) => PeriodsService.esResultado(f.type) && f.saldo !== 0);
    // Ingresos dejan saldo acreedor (negativo en esta convención) y costos/gastos
    // deudor: la utilidad es el neto cambiado de signo.
    const utilidad = round2(aCancelar.reduce((s, f) => s - f.saldo, 0));
    const lineas = aCancelar.map((f) => ({
      accountId: f.accountId, code: f.code, name: f.name,
      debit: f.saldo < 0 ? round2(-f.saldo) : 0,
      credit: f.saldo > 0 ? f.saldo : 0,
    }));

    return {
      periodo: { id: p.id, name: p.name, startDate: p.startDate, endDate: p.endDate },
      anterior: anterior ?? null,
      filas,
      cierre: {
        cuentaResultado: resultado,
        lineas,
        /** Positivo = utilidad; negativo = pérdida. */
        utilidad,
      },
      totales: {
        opening: round2(filas.reduce((s, f) => s + f.opening, 0)),
        debit: round2(filas.reduce((s, f) => s + f.debit, 0)),
        credit: round2(filas.reduce((s, f) => s + f.credit, 0)),
        closing: round2(filas.reduce((s, f) => s + f.closing, 0)),
      },
    };
  }

  /**
   * Cierra el periodo: escribe el asiento de cierre, guarda el arrastre y bloquea la
   * fecha para asientos nuevos.
   *
   * El ORDEN no es intercambiable: el asiento lleva fecha del último día del periodo,
   * así que se escribe ANTES de marcarlo cerrado — después, la propia guarda de
   * `assertOpenForDate` lo rechazaría.
   */
  async close(id: string, closedBy?: string | null) {
    const p = await this.get(id);
    if (p.status === 'LOCKED') throw new BadRequestException('El periodo está bloqueado');
    if (p.status === 'CLOSED') throw new BadRequestException(`El periodo ${p.name} ya está cerrado`);

    // Cerrar un mes con el anterior abierto arrastraría un saldo de entrada que todavía
    // puede cambiar. En caja pasa igual: la apertura de mañana sale del cierre de hoy.
    const anterior = await this.periodoAnterior(p);
    if (anterior && anterior.status === 'OPEN') {
      throw new BadRequestException(
        `Cierra primero ${anterior.name}: el saldo con el que arranca ${p.name} sale de ese cierre.`,
      );
    }

    const calculo = await this.calcularCierre(p);
    const { lineas, cuentaResultado, utilidad } = calculo.cierre;
    if (lineas.length && !cuentaResultado) {
      throw new BadRequestException(
        `No existe la cuenta ${PeriodsService.CUENTA_RESULTADO} (Utilidad del ejercicio); sin ella no se puede cerrar el resultado del mes.`,
      );
    }

    const asientoLineas = lineas.map((l, i) => ({
      accountId: l.accountId,
      debit: l.debit, credit: l.credit,
      description: `Cierre ${p.name} — ${l.code} ${l.name}`,
      lineOrder: i,
    }));
    if (asientoLineas.length) {
      // Contrapartida: una sola línea a Utilidad del ejercicio por el neto.
      asientoLineas.push({
        accountId: cuentaResultado!.id,
        debit: utilidad < 0 ? round2(-utilidad) : 0,
        credit: utilidad > 0 ? utilidad : 0,
        description: utilidad >= 0 ? `Utilidad del periodo ${p.name}` : `Pérdida del periodo ${p.name}`,
        lineOrder: asientoLineas.length,
      });
    }

    const hecho = await this.prisma.$transaction(async (tx) => {
      let asiento: { id: string; number: number } | null = null;
      if (asientoLineas.length) {
        // Numeración por secuencia, igual que `JournalService.post`: dos cierres a la
        // vez leerían el mismo "último + 1" y `number` es único.
        const number = await nextTid(tx, TID_SEQ.journalEntry);
        asiento = await tx.journalEntry.create({
          data: {
            number,
            // Último instante del periodo: el cierre es el último asiento del mes.
            date: p.endDate,
            periodId: p.id,
            type: 'CLOSING',
            status: 'POSTED',
            description: `Cierre contable ${p.name}`,
            // Idempotencia por el índice único (sourceType, sourceId): un periodo, un
            // asiento de cierre. Reabrir lo borra, así que volver a cerrar lo rehace.
            sourceType: 'CLOSING',
            sourceId: p.id,
            createdBy: closedBy ?? null,
            lines: { create: asientoLineas },
          },
          select: { id: true, number: true },
        });
      }

      // El arrastre: una fila por cuenta, ya con el cierre aplicado (`closing` deja en
      // cero las de resultado). Es lo que el mes siguiente lee como saldo de entrada
      // sin tener que recorrer el libro entero.
      await tx.fiscalPeriodBalance.deleteMany({ where: { periodId: p.id } });
      if (calculo.filas.length) {
        await tx.fiscalPeriodBalance.createMany({
          data: calculo.filas.map((f) => ({
            periodId: p.id, accountId: f.accountId,
            opening: f.opening, debit: f.debit, credit: f.credit, closing: f.closing,
          })),
        });
      }

      const upd = await tx.fiscalPeriod.update({
        where: { id: p.id },
        data: { status: 'CLOSED', closedAt: new Date(), closedBy: closedBy ?? null },
      });
      return { periodo: upd, asiento };
    });

    return {
      ...hecho.periodo,
      asientoCierre: hecho.asiento,
      utilidad,
      cuentasArrastradas: calculo.filas.length,
    };
  }

  /**
   * Reabre el periodo: borra el asiento de cierre y el arrastre guardado.
   *
   * Se BORRA en vez de reversar, que es lo que el resto del módulo hace con los
   * asientos. Tres razones: el de cierre no es un hecho del negocio sino una
   * consecuencia calculada de los demás —volver a cerrar lo rehace igual—; el índice
   * único (sourceType, sourceId) impediría escribir el nuevo mientras viviera el viejo,
   * o sea que un reverso dejaría el periodo imposible de cerrar otra vez; y un reverso
   * llevaría fecha de HOY, metiéndole el resultado del mes pasado al mes en curso.
   */
  async reopen(id: string) {
    const p = await this.get(id);
    if (p.status === 'LOCKED') throw new BadRequestException('El periodo está bloqueado y no puede reabrirse');
    if (p.status === 'OPEN') return p;

    // No se reabre un mes si el siguiente ya está cerrado: su arrastre salió de este, y
    // tocarlo dejaría al siguiente arrancando con un saldo que ya no es.
    const siguiente = await this.prisma.fiscalPeriod.findFirst({
      where: { type: 'MONTH', startDate: { gt: p.startDate }, status: { in: ['CLOSED', 'LOCKED'] } },
      orderBy: { startDate: 'asc' },
      select: { name: true },
    });
    if (siguiente) {
      throw new BadRequestException(`Reabre primero ${siguiente.name}: arrastra el saldo que dejó ${p.name}.`);
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.journalEntry.deleteMany({ where: { sourceType: 'CLOSING', sourceId: p.id } });
      await tx.fiscalPeriodBalance.deleteMany({ where: { periodId: p.id } });
      return tx.fiscalPeriod.update({
        where: { id: p.id },
        data: { status: 'OPEN', closedAt: null, closedBy: null },
      });
    });
  }

  /**
   * El arrastre guardado de un periodo: con cuánto entró cada cuenta, qué se movió y
   * con cuánto sale hacia el mes siguiente.
   *
   * Si el periodo sigue abierto no hay nada guardado todavía, así que se devuelve el
   * cálculo en vivo — la misma cifra que se guardará al cerrar, marcada como preliminar.
   */
  async balances(id: string) {
    const p = await this.get(id);
    const [filas, asiento] = await Promise.all([
      this.prisma.fiscalPeriodBalance.findMany({
        where: { periodId: p.id },
        include: { account: { select: { code: true, name: true, type: true } } },
      }),
      this.prisma.journalEntry.findUnique({
        where: { sourceType_sourceId: { sourceType: 'CLOSING', sourceId: p.id } },
        select: { id: true, number: true, date: true, description: true },
      }),
    ]);

    const items = filas.length
      ? filas
          .map((f) => ({
            accountId: f.accountId, code: f.account.code, name: f.account.name, type: f.account.type,
            opening: num(f.opening), debit: num(f.debit), credit: num(f.credit), closing: num(f.closing),
          }))
          .sort((a, b) => a.code.localeCompare(b.code))
      : (await this.calcularCierre(p)).filas.map((f) => ({
          accountId: f.accountId, code: f.code, name: f.name, type: f.type,
          opening: f.opening, debit: f.debit, credit: f.credit, closing: f.closing,
        }));

    return {
      periodo: {
        id: p.id, name: p.name, status: p.status, startDate: p.startDate, endDate: p.endDate,
        closedAt: p.closedAt, closedBy: p.closedBy,
      },
      /** false = el periodo sigue abierto y estas cifras aún se mueven. */
      guardado: filas.length > 0,
      asientoCierre: asiento,
      items,
      totales: {
        opening: round2(items.reduce((s, i) => s + i.opening, 0)),
        debit: round2(items.reduce((s, i) => s + i.debit, 0)),
        credit: round2(items.reduce((s, i) => s + i.credit, 0)),
        closing: round2(items.reduce((s, i) => s + i.closing, 0)),
      },
    };
  }

  /**
   * Devuelve el periodo mensual que contiene la fecha y valida que esté abierto.
   * Si no existe periodo para esa fecha, se permite (no hay cierre definido aún).
   */
  async assertOpenForDate(date: Date) {
    const period = await this.prisma.fiscalPeriod.findFirst({
      where: { type: 'MONTH', startDate: { lte: date }, endDate: { gte: date } },
    });
    if (period && period.status !== 'OPEN') {
      throw new BadRequestException(`El periodo ${period.name} está cerrado; no se pueden registrar asientos en esa fecha`);
    }
    return period;
  }
}
