import { BadRequestException, NotFoundException } from '../core/http/errores';
import * as ExcelJS from 'exceljs';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CobranzasService } from '../treasury/cobranzas.service';
import { ReconexionService } from '../network/reconexion.service';
import { AuthUser } from '../auth/current-user.decorator';
import { num, round2 } from '../common/money';
import { subName } from '../common/subscriber-name';

const dateOnly = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

/** Modos del selector del legacy (`cambiar_fecha`). */
export type ModoCargue = 'pagos' | 'plan';

/** Cuántas filas procesa una tanda cuando el navegador no dice otra cosa. */
const TANDA_POR_DEFECTO = 25;

/** Monto estilo legacy: quita '$' y separadores de miles → entero COP. */
function parseAmount(v: unknown): number {
  if (typeof v === 'number') return round2(v);
  const digits = String(v ?? '').replace(/[^\d-]/g, '');
  const n = parseInt(digits, 10);
  return Number.isFinite(n) ? n : 0;
}

/** Fecha desde una celda de Excel (Date, serial numérico, o texto). */
function parseCellDate(v: unknown): Date | null {
  if (v instanceof Date) return dateOnly(v);
  if (typeof v === 'number' && v > 0) return dateOnly(new Date((v - 25569) * 86400 * 1000));
  if (typeof v === 'string' && v.trim()) { const d = new Date(v); if (!isNaN(d.getTime())) return dateOnly(d); }
  return null;
}

const cellText = (v: unknown): string => {
  if (v == null) return '';
  if (typeof v === 'object' && 'text' in (v as any)) return String((v as any).text).trim();
  if (typeof v === 'object' && 'result' in (v as any)) return String((v as any).result).trim();
  return String(v).trim();
};

/**
 * Clave de comparación de nombres de cuenta: mayúsculas, sin tildes y sin espacios
 * de más. El archivo del corresponsal escribe "Bancolombia TV" o "BANCOLOMBIA  TV"
 * indistintamente y en el legacy eso era un `WHERE holder = …` exacto que fallaba
 * en silencio (la plata quedaba sin cuenta).
 */
const claveCuenta = (s: string) =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();

export class PaymentImportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cobranzas: CobranzasService,
    private readonly reconexion: ReconexionService,
  ) {}

  /**
   * Cuentas de tesorería indexadas por nombre normalizado.
   *
   * La columna D del Excel NO es un "método de pago" libre: en el legacy es el
   * nombre de la cuenta (`accounts.holder`) donde entra la plata —"BANCOLOMBIA
   * TELECOMUNICACIONES", "BANCOLOMBIA TV", "EFECTY"—, y de ahí sale el `acid` del
   * movimiento. Ver `Customers_model::pay_invoices`.
   */
  private async cuentasPorNombre() {
    const cuentas = await this.prisma.cashAccount.findMany({
      where: { legacyId: { not: null } },
      select: { legacyId: true, holder: true },
    });
    const mapa = new Map<string, { legacyId: number; holder: string }>();
    for (const c of cuentas) {
      if (c.legacyId == null || !c.holder) continue;
      mapa.set(claveCuenta(c.holder), { legacyId: c.legacyId, holder: c.holder });
    }
    return mapa;
  }

  /** Fase 1: parsea el archivo y crea el lote + filas en staging (no aplica nada). */
  async upload(
    buffer: Buffer,
    fileName: string,
    dateOverride: string | undefined,
    user?: AuthUser,
    opts?: { mode?: ModoCargue; storedFile?: string | null },
  ) {
    const mode: ModoCargue = opts?.mode === 'plan' ? 'plan' : 'pagos';
    const wb = new ExcelJS.Workbook();
    try { await wb.xlsx.load(buffer as any); } catch { throw new BadRequestException('No se pudo leer el archivo. Debe ser un .xlsx válido.'); }
    const ws = wb.worksheets[0];
    if (!ws) throw new BadRequestException('El archivo no tiene hojas.');

    const override = dateOverride ? parseCellDate(dateOverride) : null;
    const cuentas = await this.cuentasPorNombre();
    const crudas: Array<{
      rowNumber: number; documento: string; amount: number; method: string;
      reference: string | null; date: Date | null;
    }> = [];
    let totalAmount = 0;

    // Fila 1 = encabezado. Columnas (igual que el legacy):
    //   pagos → A fecha · B id/abonado/documento · C monto · D cuenta · E referencia
    //   plan  → A id del cliente · B documento · E código del producto/plan
    ws.eachRow((row, rowNumber) => {
      if (rowNumber < 2) return;
      if (mode === 'plan') {
        const idCliente = cellText(row.getCell(1).value);
        const documento = idCliente || cellText(row.getCell(2).value);
        const codigo = cellText(row.getCell(5).value);
        if (!documento || !codigo) return;
        crudas.push({ rowNumber, documento, amount: 0, method: '', reference: codigo, date: null });
        return;
      }
      const documento = cellText(row.getCell(2).value);
      const amount = parseAmount(row.getCell(3).value);
      if (!documento || amount <= 0) return; // legacy: solo monto>0 y documento>0
      const method = cellText(row.getCell(4).value) || 'EFECTY';
      const reference = cellText(row.getCell(5).value) || null;
      const date = override ?? parseCellDate(row.getCell(1).value);
      totalAmount = round2(totalAmount + amount);
      crudas.push({ rowNumber, documento, amount, method, reference, date });
    });
    if (!crudas.length) {
      throw new BadRequestException(mode === 'plan'
        ? 'El archivo no tiene filas válidas (se esperan el id del cliente en la columna A y el código del plan en la E, desde la fila 2).'
        : 'El archivo no tiene filas válidas (revisa que monto y documento sean > 0, y que los datos empiecen en la fila 2).');
    }

    // Emparejamiento POR ADELANTADO: el legacy solo descubría al cliente inexistente
    // en mitad del proceso, cuando la plata de las filas anteriores ya estaba puesta.
    // Aquí se resuelve al cargar, así que el archivo se revisa antes de aplicarlo.
    const rows: Prisma.PaymentImportRowCreateManyBatchInput[] = [];
    for (const r of crudas) {
      const match = await this.matchSubscriber(r.documento);
      const cuenta = r.method ? cuentas.get(claveCuenta(r.method)) : undefined;
      rows.push({
        rowNumber: r.rowNumber, documento: r.documento, amount: r.amount, method: r.method,
        reference: r.reference, date: r.date,
        status: 'error' in match ? 'Usuario No Existe' : 'Inicial',
        subscriberId: 'error' in match ? null : match.id,
        subscriberName: 'error' in match ? null : match.name,
        cashAccountId: cuenta?.legacyId ?? null,
        message: 'error' in match ? match.error : null,
      });
    }

    const batch = await this.prisma.paymentImportBatch.create({
      data: {
        fileName, storedFile: opts?.storedFile ?? null, mode,
        uploadedById: user?.id ?? null, uploadedByName: user?.name ?? user?.email ?? null,
        status: 'Cargado', totalRows: rows.length, totalAmount,
        rows: { createMany: { data: rows } },
      },
    });
    await this.recount(batch.id);
    return this.detail(batch.id);
  }

  /** Resuelve el cliente por legacyId → abonado → documento (docNumber). */
  private async matchSubscriber(documento: string): Promise<{ id: string; name: string | null } | { error: string }> {
    const select = {
      id: true, firstName: true, secondName: true, lastName1: true, lastName2: true,
      companyName: true, fullName: true,
    } as const;
    const asInt = parseInt(documento.replace(/[^\d]/g, ''), 10);
    if (Number.isFinite(asInt)) {
      const byLegacy = await this.prisma.subscriber.findUnique({ where: { legacyId: asInt }, select });
      if (byLegacy) return { id: byLegacy.id, name: subName(byLegacy) };
      const byAbonado = await this.prisma.subscriber.findMany({ where: { abonado: asInt }, select, take: 2 });
      if (byAbonado.length === 1) return { id: byAbonado[0].id, name: subName(byAbonado[0]) };
      if (byAbonado.length > 1) return { error: 'Múltiples clientes con ese abonado' };
    }
    const byDoc = await this.prisma.subscriber.findMany({ where: { docNumber: documento }, select, take: 2 });
    if (byDoc.length === 1) return { id: byDoc[0].id, name: subName(byDoc[0]) };
    if (byDoc.length > 1) return { error: 'Múltiples clientes con ese documento' };
    return { error: 'Usuario No Existe' };
  }

  /**
   * Fase 2: procesa las filas 'Inicial' del lote y aplica los pagos a cartera.
   *
   * Va POR TANDAS (`limit`) porque la pantalla dibuja el avance como el legacy: el
   * navegador pide tanda tras tanda y va pintando "va en X de Y". Sin `limit` se
   * procesa el lote entero de una sola llamada.
   */
  /**
   * Los cargues que bajaron del legacy son HISTORIA, no trabajo pendiente: su plata
   * ya entró y ya está en Postgres (la trajo `syncTransactions` desde `transactions`).
   * Volver a aplicarlos —o reintentarlos— duplicaría el recaudo del día, así que la
   * puerta se cierra aquí y no sólo en la pantalla.
   */
  private noSiEsDelLegacy(batch: { legacyId: number | null }, motivo: string) {
    if (batch.legacyId != null) {
      throw new BadRequestException(`Este cargue se hizo en el sistema anterior y sólo se puede consultar: ${motivo}`);
    }
  }

  async process(batchId: string, user?: AuthUser, limit?: number) {
    const batch = await this.prisma.paymentImportBatch.findUnique({ where: { id: batchId } });
    if (!batch) throw new NotFoundException('Lote no encontrado');
    this.noSiEsDelLegacy(batch, 'volver a procesarlo duplicaría unos pagos que ya están registrados.');
    const tanda = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.min(Number(limit), 500) : TANDA_POR_DEFECTO;
    const rows = await this.prisma.paymentImportRow.findMany({
      where: { batchId, status: 'Inicial' }, orderBy: { rowNumber: 'asc' }, take: limit === undefined ? undefined : tanda,
    });
    if (!rows.length) throw new BadRequestException('El lote no tiene filas pendientes por procesar.');

    if (batch.mode === 'plan') return this.procesarPlan(batchId, rows, user);

    // Abonados que efectivamente pagaron en este lote: al final se reconectan de
    // una sola pasada (ver más abajo). Es un Set porque el mismo cliente puede
    // venir en varias filas del archivo.
    const pagaron = new Set<string>();

    for (const row of rows) {
      // Idempotencia: no reaplicar un pago ya cargado con la misma referencia.
      if (row.reference) {
        const dup = await this.prisma.paymentImportRow.findFirst({ where: { reference: row.reference, status: 'Cargado', id: { not: row.id } }, select: { id: true } });
        if (dup) { await this.mark(row.id, 'Duplicado', null, `Referencia ${row.reference} ya aplicada`); continue; }
      }
      if (!row.subscriberId) { await this.mark(row.id, 'Usuario No Existe', null, row.message ?? 'Usuario No Existe'); continue; }

      // El resto de la nota (cliente, documento, medio, sede y referencia) lo arma
      // `collect` igual que el legacy; aquí sólo se añade de qué archivo salió.
      const nota = `Cargue ${batch.fileName ?? 'Excel'}`;
      try {
        const res = await this.cobranzas.collect({
          subscriberId: row.subscriberId,
          amount: num(row.amount),
          // El legacy graba SIEMPRE `method='Bank'` y deja el nombre del
          // corresponsal en la cuenta (`account`/`acid`). Se respeta: es lo que
          // distingue banco de caja al contabilizar y al cuadrar el cierre.
          method: 'Bank',
          cashAccountId: row.cashAccountId ?? undefined,
          accountName: row.method || undefined,
          bankName: row.method || undefined,
          date: row.date ? row.date.toISOString().slice(0, 10) : undefined,
          reference: row.reference ?? undefined,
          note: nota,
        } as any, (user ?? { name: 'Cargue', email: null }) as any, { reconectar: false });
        await this.mark(row.id, 'Cargado', res.receiptId, `Aplicado ${res.totalApplied}${row.cashAccountId == null ? ` · OJO: la cuenta «${row.method}» no existe en tesorería` : ''}`);
        pagaron.add(row.subscriberId);
      } catch (e: any) {
        // Cliente al día que paga por adelantado: el legacy lo abonaba a la última
        // factura y le quedaba saldo a favor. Aquí entra como ingreso ligado al
        // cliente (mismo efecto contable) en vez de perderse: la plata está en el
        // banco y tiene que aparecer en algún sitio.
        if (/no tiene facturas pendientes|No hay saldo pendiente/i.test(e?.message ?? '')) {
          try {
            const anticipo = await this.registrarAnticipo(row, batch.fileName, user);
            await this.mark(row.id, 'Cargado', anticipo, 'Sin facturas pendientes: quedó como saldo a favor del cliente');
            pagaron.add(row.subscriberId);
            continue;
          } catch (e2: any) {
            await this.mark(row.id, 'Error', null, e2?.message || 'No se pudo registrar el saldo a favor');
            continue;
          }
        }
        await this.mark(row.id, 'Error', null, e?.message || 'No se pudo aplicar el pago');
      }
    }

    const pendientes = await this.prisma.paymentImportRow.count({ where: { batchId, status: 'Inicial' } });

    // Reconexión de los que pagaron: internet y/o TV, cada uno por su vía y solo al
    // que le corresponda. Va FUERA del bucle y en lote a propósito — reconectar fila
    // por fila abriría una conexión al router (y una sesión SSH a la OLT) por pago,
    // y un archivo de corresponsal trae cientos. Best-effort: si los equipos fallan,
    // el cargue igual queda aplicado y el fallo queda en el log y en la auditoría.
    const reconexion = await this.reconexion.porPagoLote([...pagaron], user);

    return { ...(await this.detail(batchId, true)), pendientes, reconexion };
  }

  /** Ingreso al cliente sin factura contra la que imputar (queda como saldo a favor). */
  private async registrarAnticipo(
    row: { subscriberId: string | null; amount: Prisma.Decimal | number; method: string; reference: string | null; date: Date | null; cashAccountId: number | null },
    fileName: string | null,
    user?: AuthUser,
  ) {
    const res = await this.cobranzas.createIncome({
      amount: num(row.amount), category: 'Sales', method: 'Bank',
      cashAccountId: row.cashAccountId ?? undefined,
      accountName: row.method || undefined,
      bankName: row.method || undefined,
      subscriberId: row.subscriberId ?? undefined,
      date: row.date ? row.date.toISOString().slice(0, 10) : undefined,
      note: `Cargue ${fileName ?? 'Excel'} · saldo a favor · metodo: ${row.method || 'EFECTY'}${row.reference ? ` · referencia: ${row.reference}` : ''}`,
    } as any, (user ?? { name: 'Cargue', email: null }) as any);
    return res.id;
  }

  /**
   * Modo "actualizar paquete": cambia el plan de la ÚLTIMA factura del cliente
   * (legacy `Files_carga_transaccional_model::actualizar_plan`, que sobrescribe
   * `invoices.combo` con el `product_name` del producto cuyo `product_code` viene
   * en la columna E). No mueve plata.
   */
  private async procesarPlan(batchId: string, rows: Array<{ id: string; subscriberId: string | null; reference: string | null; message: string | null }>, user?: AuthUser) {
    for (const row of rows) {
      if (!row.subscriberId) { await this.mark(row.id, 'Usuario No Existe', null, row.message ?? 'Usuario No Existe'); continue; }
      const codigo = (row.reference ?? '').trim();
      if (!codigo) { await this.mark(row.id, 'Error', null, 'Falta el código del plan (columna E)'); continue; }

      const producto = await this.prisma.material.findFirst({ where: { code: codigo }, select: { name: true, tvOrNet: true } });
      const plan = producto ? null : await this.prisma.plan.findFirst({ where: { name: codigo }, select: { name: true, kind: true } });
      if (!producto && !plan) { await this.mark(row.id, 'Error', null, `No existe un producto o plan con el código «${codigo}»`); continue; }

      const nombre = (producto?.name ?? plan?.name ?? '').trim();
      const esTv = producto ? /tv|televi/i.test(producto.tvOrNet ?? '') : plan?.kind === 'TV';

      const factura = await this.prisma.subInvoice.findFirst({
        where: { subscriberId: row.subscriberId },
        orderBy: [{ invoiceDate: 'desc' }, { tid: 'desc' }],
        select: { id: true, tid: true, serviceTv: true, serviceCombo: true },
      });
      if (!factura) { await this.mark(row.id, 'Error', null, 'El cliente no tiene facturas'); continue; }

      const anterior = esTv ? factura.serviceTv : factura.serviceCombo;
      await this.prisma.subInvoice.update({
        where: { id: factura.id },
        data: {
          ...(esTv ? { serviceTv: nombre } : { serviceCombo: nombre }),
          // Sin la marca de edición el sync de ida devuelve el paquete viejo a los
          // 15 minutos. Ver `scripts/sync-legacy-vivo.js`.
          editedAt: new Date(), editedBy: user?.name ?? user?.email ?? 'Cargue', editCount: { increment: 1 },
        },
      });
      await this.mark(row.id, 'Cargado', null, `Factura #${factura.tid}: ${esTv ? 'TV' : 'plan'} «${anterior ?? '—'}» → «${nombre}»`);
    }
    const pendientes = await this.prisma.paymentImportRow.count({ where: { batchId, status: 'Inicial' } });
    return { ...(await this.detail(batchId, true)), pendientes, reconexion: null };
  }

  private async mark(rowId: string, status: string, transactionId: string | null, message: string) {
    await this.prisma.paymentImportRow.update({ where: { id: rowId }, data: { status, transactionId, message } });
  }

  /**
   * Devuelve a 'Inicial' las filas que no se pudieron aplicar, para reintentarlas
   * después de arreglar lo que fallaba (una cuenta que no existía, un cliente que
   * se acababa de crear). Las ya aplicadas no se tocan: reprocesarlas duplicaría
   * la plata.
   */
  async retry(batchId: string) {
    const batch = await this.prisma.paymentImportBatch.findUnique({ where: { id: batchId } });
    if (!batch) throw new NotFoundException('Lote no encontrado');
    this.noSiEsDelLegacy(batch, 'reintentar sus filas duplicaría unos pagos que ya están registrados.');
    const cuentas = await this.cuentasPorNombre();
    const fallidas = await this.prisma.paymentImportRow.findMany({
      where: { batchId, status: { in: ['Error', 'Usuario No Existe', 'Duplicado'] } },
    });
    for (const row of fallidas) {
      // Se vuelve a intentar el emparejamiento y la cuenta: es justo lo que suele
      // haberse arreglado entre un intento y el siguiente.
      const match = await this.matchSubscriber(row.documento);
      const cuenta = row.method ? cuentas.get(claveCuenta(row.method)) : undefined;
      await this.prisma.paymentImportRow.update({
        where: { id: row.id },
        data: {
          status: 'error' in match ? 'Usuario No Existe' : 'Inicial',
          subscriberId: 'error' in match ? null : match.id,
          subscriberName: 'error' in match ? null : match.name,
          cashAccountId: cuenta?.legacyId ?? null,
          message: 'error' in match ? match.error : null,
        },
      });
    }
    return this.detail(batchId, true);
  }

  /** Recalcula contadores del lote desde sus filas. */
  private async recount(batchId: string, finalizar = false) {
    const rows = await this.prisma.paymentImportRow.findMany({ where: { batchId }, select: { status: true, amount: true } });
    const applied = rows.filter((r) => r.status === 'Cargado');
    const pendientes = rows.some((r) => r.status === 'Inicial');
    await this.prisma.paymentImportBatch.update({
      where: { id: batchId },
      data: {
        appliedRows: applied.length,
        errorRows: rows.filter((r) => r.status === 'Error').length,
        notFoundRows: rows.filter((r) => r.status === 'Usuario No Existe').length,
        duplicateRows: rows.filter((r) => r.status === 'Duplicado').length,
        appliedAmount: round2(applied.reduce((s, r) => s + num(r.amount), 0)),
        // Solo se da por cerrado cuando se ha procesado de verdad: si al cargar
        // ninguna fila emparejó, el lote sigue "Cargado" (queda por arreglar), no
        // "Procesado".
        status: pendientes ? 'Cargado' : (finalizar || applied.length ? 'Procesado' : 'Cargado'),
      },
    });
  }

  /**
   * Historial completo de cargues, los de aquí y los que bajaron del legacy (914
   * archivos desde 2023, ~250 al año). El tope es un cinturón, no una paginación:
   * la pantalla los pagina en el navegador.
   */
  async list() {
    const rows = await this.prisma.paymentImportBatch.findMany({ orderBy: { createdAt: 'desc' }, take: 3000 });
    return rows.map((b) => ({
      id: b.id, fileName: b.fileName, status: b.status, date: b.createdAt, mode: b.mode,
      user: b.uploadedByName, hasFile: !!b.storedFile, legacy: b.legacyId != null,
      totalRows: b.totalRows, appliedRows: b.appliedRows, errorRows: b.errorRows, notFoundRows: b.notFoundRows, duplicateRows: b.duplicateRows,
      totalAmount: num(b.totalAmount), appliedAmount: num(b.appliedAmount),
    }));
  }

  async detail(id: string, recount = false) {
    if (recount) await this.recount(id, true);
    const b = await this.prisma.paymentImportBatch.findUnique({ where: { id }, include: { rows: { orderBy: { rowNumber: 'asc' } } } });
    if (!b) throw new NotFoundException('Lote no encontrado');
    // Cuentas que nombra el archivo y no existen en tesorería: se avisa ARRIBA, antes
    // de aplicar nada, porque es el error que en el legacy dejaba la plata sin cuenta.
    const metodos = new Map<string, { method: string; account: string | null; rows: number }>();
    for (const r of b.rows) {
      if (!r.method) continue;
      const e = metodos.get(r.method) ?? { method: r.method, account: null, rows: 0 };
      e.rows++;
      if (r.cashAccountId != null) e.account = r.method;
      metodos.set(r.method, e);
    }
    const cuentas = await this.cuentasPorNombre();
    return {
      id: b.id, fileName: b.fileName, status: b.status, date: b.createdAt, mode: b.mode,
      user: b.uploadedByName, hasFile: !!b.storedFile, legacy: b.legacyId != null,
      totalRows: b.totalRows, appliedRows: b.appliedRows, errorRows: b.errorRows, notFoundRows: b.notFoundRows, duplicateRows: b.duplicateRows,
      totalAmount: num(b.totalAmount), appliedAmount: num(b.appliedAmount),
      pendientes: b.rows.filter((r) => r.status === 'Inicial').length,
      metodos: [...metodos.values()].map((m) => ({
        method: m.method, rows: m.rows,
        account: cuentas.get(claveCuenta(m.method))?.holder ?? null,
      })),
      rows: b.rows.map((r) => ({
        id: r.id, rowNumber: r.rowNumber, documento: r.documento, amount: num(r.amount), method: r.method,
        reference: r.reference, date: r.date ? r.date.toISOString().slice(0, 10) : null,
        status: r.status, subscriberId: r.subscriberId, subscriberName: r.subscriberName, message: r.message,
      })),
    };
  }

  /** Datos del .xlsx original para volver a bajarlo (como el enlace del legacy). */
  async archivo(id: string) {
    const b = await this.prisma.paymentImportBatch.findUnique({ where: { id }, select: { storedFile: true, fileName: true } });
    if (!b?.storedFile) throw new NotFoundException('Este cargue no guardó el archivo original.');
    return { storedName: b.storedFile, originalName: b.fileName ?? b.storedFile };
  }

  async remove(id: string) {
    const b = await this.prisma.paymentImportBatch.findUnique({ where: { id } });
    if (!b) throw new NotFoundException('Lote no encontrado');
    this.noSiEsDelLegacy(b, 'borrarlo aquí no lo borra allá, y la siguiente pasada del sync lo devolvería.');
    await this.prisma.paymentImportBatch.delete({ where: { id } }); // cascade borra filas (no revierte pagos aplicados)
    return { id, deleted: true };
  }
}
