import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { moduloDe, normalizarRuta } from './audit-normalize';
import { describir, fraseSinNombres } from '../common/audit/bitacora-descripcion';
import { afiliadoresDisponibles } from '../staff/afiliadores';

/**
 * Reportes de personal: qué hizo cada funcionario con la plata y con el sistema.
 *
 * Van aparte de `performance.service.ts` a propósito: ese mide CALIDAD del
 * trabajo de campo, este mide ACTIVIDAD administrativa. Mezclarlos produciría un
 * "puntaje del empleado" que junta cosas que no se comparan.
 */

/** Rango de fechas por defecto de los reportes de personal. */
const DIAS_POR_DEFECTO = 90;

type RangoResuelto = { desde: Date; hasta: Date };

function rango(from?: string, to?: string): RangoResuelto {
  const hasta = to ? new Date(`${to}T23:59:59.999Z`) : new Date();
  const desde = from ? new Date(`${from}T00:00:00.000Z`) : new Date(hasta.getTime() - DIAS_POR_DEFECTO * 86400_000);
  return { desde, hasta };
}

const num = (v: unknown) => Number(v ?? 0);

export class StaffReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Recaudo por funcionario.
   *
   * `Transaction.issuerUserId` es el `eid` del legacy, que cruza contra
   * `Staff.legacyId` (verificado: los 11 emisores de los últimos 180 días cruzan).
   * Solo cuenta ingresos VIGENTES: sumar una transacción anulada sería contarle
   * a alguien plata que ya no existe.
   */
  async recaudoPorFuncionario(from?: string, to?: string, metodo?: string, cajaId?: string) {
    const { desde, hasta } = rango(from, to);

    // Los funcionarios inhabilitados quedan FUERA del reporte entero, no solo de
    // la tabla: si se les quitara la fila pero su plata siguiera en el total, el
    // reporte no cuadraría consigo mismo. El total, la gráfica diaria y los cortes
    // por método y por caja se calculan todos sobre el mismo universo.
    const inactivos = await this.prisma.staff.findMany({
      where: { banned: true, legacyId: { not: null } },
      select: { legacyId: true },
    });
    const idsInactivos = inactivos.map((s) => s.legacyId!).filter((n) => n != null);

    const where: Prisma.TransactionWhereInput = {
      status: 'VIGENTE',
      type: 'INCOME',
      date: { gte: desde, lte: hasta },
      issuerUserId: idsInactivos.length ? { not: null, notIn: idsInactivos } : { not: null },
    };
    if (metodo) where.method = metodo;
    if (cajaId) where.cashAccountId = Number(cajaId);

    const sinInactivos = idsInactivos.length
      ? Prisma.sql`AND t."issuerUserId" NOT IN (${Prisma.join(idsInactivos)})`
      : Prisma.empty;

    const [porEmisor, staff, porMetodo, porCaja, diario] = await Promise.all([
      this.prisma.transaction.groupBy({
        by: ['issuerUserId'],
        where,
        _count: { _all: true },
        _sum: { credit: true, debit: true },
      }),
      this.prisma.staff.findMany({
        where: { legacyId: { not: null }, banned: false },
        select: { id: true, legacyId: true, name: true },
      }),
      this.prisma.transaction.groupBy({ by: ['method'], where, _count: { _all: true }, _sum: { credit: true } }),
      this.prisma.transaction.groupBy({ by: ['cashAccountId'], where, _count: { _all: true }, _sum: { credit: true } }),
      // Las fechas van como texto con `::date`, no como Date de JS: `Transaction.date`
      // es un `date` de Postgres y atarle un timestamp lo compara convertido a la zona
      // de la sesión (Europe/Berlin aquí), con lo que la gráfica diaria perdía el primer
      // día del rango — y no cuadraba con los totales de arriba, que sí los calcula
      // Prisma con el tipo correcto.
      this.prisma.$queryRaw<{ dia: Date; total: number; movimientos: number }[]>`
        SELECT date_trunc('day', t.date)::date AS dia,
               COALESCE(SUM(t.credit), 0)::float8 AS total,
               COUNT(*)::int AS movimientos
          FROM "Transaction" t
         WHERE t.status = 'VIGENTE' AND t.type = 'INCOME'
           AND t.date BETWEEN ${desde.toISOString().slice(0, 10)}::date
                          AND ${hasta.toISOString().slice(0, 10)}::date
           AND t."issuerUserId" IS NOT NULL
           ${sinInactivos}
         GROUP BY 1 ORDER BY 1`,
    ]);

    const porLegacy = new Map(staff.filter((s) => s.legacyId != null).map((s) => [s.legacyId!, s]));
    const cajas = await this.prisma.cashAccount.findMany({ select: { legacyId: true, holder: true } });
    const nombreCaja = new Map(cajas.filter((c) => c.legacyId != null).map((c) => [c.legacyId!, c.holder]));

    const funcionarios = porEmisor
      .map((r) => {
        const s = r.issuerUserId != null ? porLegacy.get(r.issuerUserId) : undefined;
        const total = num(r._sum.credit);
        return {
          staffId: s?.id ?? null,
          // Sin cruce con Staff se muestra el id crudo en vez de esconder la fila:
          // esa plata la recaudó alguien, y ocultarla descuadra el total.
          nombre: s?.name ?? `Emisor ${r.issuerUserId ?? '—'}`,
          movimientos: r._count._all,
          total,
          promedio: r._count._all ? Math.round(total / r._count._all) : 0,
        };
      })
      .sort((a, b) => b.total - a.total);

    const total = funcionarios.reduce((s, f) => s + f.total, 0);

    return {
      desde,
      hasta,
      total,
      movimientos: funcionarios.reduce((s, f) => s + f.movimientos, 0),
      funcionarios: funcionarios.map((f) => ({ ...f, participacion: total > 0 ? Math.round((1000 * f.total) / total) / 10 : 0 })),
      porMetodo: porMetodo
        .map((r) => ({ metodo: r.method ?? '—', movimientos: r._count._all, total: num(r._sum.credit) }))
        .sort((a, b) => b.total - a.total),
      porCaja: porCaja
        .map((r) => ({
          caja: r.cashAccountId != null ? nombreCaja.get(r.cashAccountId) ?? `Caja ${r.cashAccountId}` : '—',
          movimientos: r._count._all,
          total: num(r._sum.credit),
        }))
        .sort((a, b) => b.total - a.total),
      diario: diario.map((d) => ({ dia: d.dia, total: num(d.total), movimientos: Number(d.movimientos) })),
    };
  }

  /**
   * Anulaciones de transacciones.
   *
   * Se filtra por `Voiding.dateTime` (cuándo se anuló de verdad) y NO por
   * `createdAt`, que en las filas traídas del legacy es la fecha de importación:
   * usarlo hace parecer que hubo miles de anulaciones esta semana.
   *
   * El dato que importa no es cuántas, sino el HUECO entre el cobro y su
   * anulación: anular algo del mismo día es operación normal; anular un recibo
   * de hace tres meses no.
   */
  async anulaciones(from?: string, to?: string, quien?: string, sede?: string) {
    const { desde, hasta } = rango(from, to);
    const where: Prisma.VoidingWhereInput = { dateTime: { gte: desde, lte: hasta } };
    if (quien) where.voidedBy = quien;
    // La anulación no tiene sede: cuelga de la transacción, y esa del abonado. De
    // 4.130 anulaciones, 1.274 son de movimientos SIN abonado (ingresos sueltos,
    // egresos): al filtrar por sede desaparecen, y por eso se declara abajo.
    if (sede) where.transaction = { subscriber: { branchId: sede } };

    const [filas, totalTx] = await Promise.all([
      this.prisma.voiding.findMany({
        where,
        orderBy: { dateTime: 'desc' },
        take: 500,
        select: {
          id: true, dateTime: true, reason: true, detail: true, voidedBy: true,
          transaction: {
            select: {
              id: true, date: true, credit: true, debit: true, type: true, method: true,
              accountName: true, payerName: true,
              subscriber: { select: { id: true, abonado: true, fullName: true } },
            },
          },
        },
      }),
      this.prisma.transaction.count({ where: { date: { gte: desde, lte: hasta } } }),
    ]);

    const casos = filas.map((v) => {
      const monto = num(v.transaction?.credit) + num(v.transaction?.debit);
      const dias =
        v.transaction?.date != null
          ? Math.round((v.dateTime.getTime() - v.transaction.date.getTime()) / 86400_000)
          : null;
      return {
        id: v.id,
        fecha: v.dateTime,
        quien: v.voidedBy,
        motivo: v.reason,
        detalle: v.detail,
        monto,
        transaccionId: v.transaction?.id ?? null,
        fechaTransaccion: v.transaction?.date ?? null,
        /** Días entre el movimiento original y su anulación. */
        diasDespues: dias,
        caja: v.transaction?.accountName ?? null,
        metodo: v.transaction?.method ?? null,
        pagador: v.transaction?.payerName ?? null,
        cliente: v.transaction?.subscriber
          ? { id: v.transaction.subscriber.id, abonado: v.transaction.subscriber.abonado, nombre: v.transaction.subscriber.fullName }
          : null,
      };
    });

    // Agregado por funcionario, calculado sobre los casos ya traídos.
    const porQuien = new Map<string, { quien: string; n: number; monto: number; maxDias: number }>();
    for (const c of casos) {
      const k = c.quien || '—';
      const acc = porQuien.get(k) ?? { quien: k, n: 0, monto: 0, maxDias: 0 };
      acc.n += 1;
      acc.monto += c.monto;
      if (c.diasDespues != null && c.diasDespues > acc.maxDias) acc.maxDias = c.diasDespues;
      porQuien.set(k, acc);
    }

    const monto = casos.reduce((s, c) => s + c.monto, 0);
    // "Tardías" = anuladas más de una semana después del movimiento. Es el
    // subconjunto que amerita mirar de a uno; el resto es corrección del día.
    const tardias = casos.filter((c) => (c.diasDespues ?? 0) > 7);

    const sedeNombre = sede
      ? (await this.prisma.branch.findUnique({ where: { id: sede }, select: { name: true } }))?.name ?? null
      : null;

    return {
      desde,
      hasta,
      sede: sedeNombre,
      notaSede: sede
        ? 'Filtrado por sede: una anulación hereda la sede del ABONADO de su movimiento, así que las anulaciones de ingresos o egresos sueltos (sin abonado) NO aparecen aquí.'
        : null,
      opciones: { sedes: (await this.prisma.branch.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } })).map((b) => ({ id: b.id, nombre: b.name })) },
      total: casos.length,
      monto,
      /** Anulaciones sobre el total de movimientos del periodo. Contexto: sin esto, "62" no dice nada. */
      tasaPct: totalTx > 0 ? Math.round((10000 * casos.length) / totalTx) / 100 : 0,
      movimientosPeriodo: totalTx,
      tardias: { total: tardias.length, monto: tardias.reduce((s, c) => s + c.monto, 0) },
      porQuien: [...porQuien.values()].sort((a, b) => b.monto - a.monto),
      casos,
    };
  }

  /**
   * Actividad en el sistema, desde la bitácora de auditoría.
   *
   * Advertencia honesta: la bitácora solo registra unas pocas entidades, así que
   * esto NO es "todo lo que hizo el equipo". Sirve para rastrear cambios sobre
   * lo que sí se audita, no para medir productividad.
   */
  async actividadSistema(from?: string, to?: string, usuarioId?: string, modulo?: string, accion?: string) {
    const { desde, hasta } = rango(from, to);
    const where: Prisma.AuditLogWhereInput = { createdAt: { gte: desde, lte: hasta } };
    if (usuarioId) where.userId = usuarioId;
    // El módulo es el primer tramo de la ruta, así que filtrarlo es un prefijo.
    if (modulo) where.entity = { startsWith: modulo };

    // Se traen los registros y se agrupa en memoria porque las columnas que se
    // quieren agrupar no existen: hay que derivarlas (ver audit-normalize.ts).
    // Es viable porque la bitácora es pequeña (~500 registros en 90 días); el
    // tope evita que deje de serlo sin avisar.
    const TOPE = 20000;
    const filas = await this.prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: TOPE,
      select: {
        id: true, action: true, entity: true, entityId: true, ipAddress: true, createdAt: true,
        user: { select: { id: true, name: true, email: true } },
      },
    });

    const conDerivados = filas.map((e) => ({
      ...e,
      modulo: moduloDe(e.entity),
      operacion: normalizarRuta(e.action),
    }));
    const visibles = accion ? conDerivados.filter((e) => e.operacion === accion) : conDerivados;

    const contar = <T>(items: T[], clave: (x: T) => string) => {
      const m = new Map<string, number>();
      for (const it of items) m.set(clave(it), (m.get(clave(it)) ?? 0) + 1);
      return [...m.entries()].map(([k, n]) => [k, n] as const).sort((a, b) => b[1] - a[1]);
    };

    // Los eventos del sistema (cron, webhooks) no tienen usuario. Se etiquetan
    // en vez de omitirse: si no, los totales no cuadran.
    const nombreUsuario = (e: (typeof conDerivados)[number]) =>
      e.user ? e.user.name || e.user.email : 'Sistema (automático)';

    const porUsuario = contar(visibles, nombreUsuario).map(([nombre, eventos]) => ({
      nombre,
      eventos,
      userId: visibles.find((e) => nombreUsuario(e) === nombre)?.user?.id ?? null,
    }));

    // El cuerpo de la petición (`after`) sólo se trae para los 300 que se listan:
    // en la consulta grande pesaría de más (hay firmas en base64 de 100 KB).
    const ultimos = visibles.slice(0, 300);
    const cuerpos = ultimos.length
      ? await this.prisma.auditLog.findMany({ where: { id: { in: ultimos.map((e) => e.id) } }, select: { id: true, action: true, entity: true, entityId: true, after: true } })
      : [];
    const descripciones = new Map(cuerpos.map((c) => [c.id, fraseSinNombres(describir(c).frase)]));

    return {
      desde,
      hasta,
      total: visibles.length,
      /** true = se alcanzó el tope y hay eventos que no se están contando. */
      truncado: filas.length >= TOPE,
      porUsuario,
      porModulo: contar(visibles, (e) => e.modulo).map(([modulo, eventos]) => ({ modulo, eventos })),
      porOperacion: contar(visibles, (e) => e.operacion)
        .slice(0, 25)
        .map(([operacion, eventos]) => ({ operacion, eventos })),
      filtros: {
        modulos: [...new Set(conDerivados.map((e) => e.modulo))].sort(),
        acciones: [...new Set(conDerivados.map((e) => e.operacion))].sort(),
        usuarios: [...new Map(conDerivados.filter((e) => e.user).map((e) => [e.user!.id, { id: e.user!.id, nombre: e.user!.name || e.user!.email }])).values()],
      },
      eventos: ultimos.map((e) => ({
        id: e.id,
        fecha: e.createdAt,
        // La ruta cruda sirve para agrupar; la frase es la que se lee.
        operacion: e.operacion,
        descripcion: descripciones.get(e.id) ?? e.operacion,
        modulo: e.modulo,
        entidadId: e.entityId,
        ip: e.ipAddress,
        usuario: nombreUsuario(e),
      })),
    };
  }

  /**
   * Afiliados: qué clientes quedaron a nombre de cada funcionario en el alta.
   *
   * La fecha es la del ALTA (`affiliateAt`), leída en hora de Bogotá: es
   * un timestamp, y cortarlo en UTC pasaría al día siguiente las altas de después de
   * las 7 p. m. La sede es la del cliente. El funcionario inhabilitado SIGUE saliendo:
   * lo que se mide aquí es a quién se le debe cada cliente, y eso no cambia porque la
   * persona se haya ido (ver `solo-funcionarios-activos` para los listados de gente).
   */
  async afiliados(from?: string, to?: string, funcionario?: string, sede?: string) {
    const hasta = to ? new Date(`${to}T23:59:59.999-05:00`) : new Date();
    const desde = from ? new Date(`${from}T00:00:00.000-05:00`) : new Date(hasta.getTime() - DIAS_POR_DEFECTO * 86400_000);

    const where: Prisma.SubscriberWhereInput = {
      affiliateStaffId: funcionario ? funcionario : { not: null },
      affiliateAt: { gte: desde, lte: hasta },
    };
    if (sede) where.branchId = sede;

    const [filas, afiliadores, sedes] = await Promise.all([
      this.prisma.subscriber.findMany({
        where,
        orderBy: { affiliateAt: 'desc' },
        select: {
          id: true, abonado: true, fullName: true, docNumber: true, phone1: true, status: true,
          affiliateAt: true, affiliateBy: true,
          branch: { select: { id: true, name: true } },
          affiliateStaff: { select: { id: true, name: true, banned: true } },
        },
      }),
      afiliadoresDisponibles(this.prisma),
      this.prisma.branch.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    ]);

    const clientes = filas.map((c) => ({
      id: c.id,
      abonado: c.abonado,
      nombre: c.fullName,
      documento: c.docNumber,
      celular: c.phone1,
      estado: c.status,
      sede: c.branch?.name ?? null,
      fecha: c.affiliateAt,
      funcionarioId: c.affiliateStaff?.id ?? null,
      funcionario: c.affiliateStaff?.name ?? null,
      registradoPor: c.affiliateBy,
    }));

    const porFuncionario = new Map<string, { staffId: string; nombre: string; inhabilitado: boolean; clientes: number; activos: number }>();
    for (const c of filas) {
      const f = c.affiliateStaff;
      if (!f) continue;
      const fila = porFuncionario.get(f.id) ?? { staffId: f.id, nombre: f.name, inhabilitado: f.banned, clientes: 0, activos: 0 };
      fila.clientes++;
      if (c.status === 'ACTIVO') fila.activos++;
      porFuncionario.set(f.id, fila);
    }
    const funcionarios = [...porFuncionario.values()].sort((a, b) => b.clientes - a.clientes || a.nombre.localeCompare(b.nombre));

    // El filtro ofrece a todos los que afilian aunque aún no hayan traído a nadie, más
    // los que sí salen en el periodo sin estar ya en la lista (inhabilitados).
    const opcionesFuncionarios = afiliadores.map((s) => ({ id: s.id, nombre: s.name }));
    for (const f of funcionarios) {
      if (!opcionesFuncionarios.some((o) => o.id === f.staffId)) opcionesFuncionarios.push({ id: f.staffId, nombre: f.nombre });
    }

    return {
      desde, hasta,
      total: clientes.length,
      activos: clientes.filter((c) => c.estado === 'ACTIVO').length,
      funcionarios,
      clientes,
      opciones: { funcionarios: opcionesFuncionarios, sedes: sedes.map((b) => ({ id: b.id, nombre: b.name })) },
    };
  }

  /** Cajas y métodos existentes, para poblar los filtros del reporte de recaudo. */
  async filtrosRecaudo() {
    const [metodos, cajas] = await Promise.all([
      this.prisma.transaction.findMany({ distinct: ['method'], select: { method: true }, where: { method: { not: null } } }),
      this.prisma.cashAccount.findMany({ select: { legacyId: true, holder: true }, orderBy: { holder: 'asc' } }),
    ]);
    return {
      metodos: metodos.map((m) => m.method).filter((m): m is string => !!m).sort(),
      cajas: cajas.filter((c) => c.legacyId != null).map((c) => ({ id: c.legacyId, nombre: c.holder })),
    };
  }
}
