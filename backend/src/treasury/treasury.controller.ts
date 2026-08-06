import { BadRequestException } from '../core/http/errores';
import { diskStorage } from 'multer';
import { existsSync, mkdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { TreasuryService } from './treasury.service';
import { cashClosePdf, receiptPdf } from '../common/pdf/pdf-docs';
import { reciboRolloPdf } from '../common/pdf/recibo-rollo';
import { CobranzasService } from './cobranzas.service';
import { EjecutarPagoFijoDto, PagoFijoDto, PagosFijosService, UpdatePagoFijoDto } from './pagos-fijos.service';
import {
  CashAccountDto, CashCloseDto, CashOpenDto, CollectDto, EditTxDto, ExpenseDto,
  IncomeDto, TransferDto, TxCategoryDto, VoidTxDto,
} from './dto/cobranzas.dto';
import { AuthUser } from '../auth/current-user.decorator';
import { enviarAdjuntoSeguro, mimeAceptado, nombreEnDisco } from '../common/uploads';

/** Carpeta de comprobantes/evidencia de los movimientos de tesorería. */
export const TREASURY_ROOT = join(process.cwd(), 'uploads', 'treasury');
type MulterFile = { originalname: string; filename: string; mimetype: string; size: number };

/** Tesorería: movimientos, cajas y cierres (migrado de saves-vestel). */
export class TreasuryController {
  constructor(
    private readonly treasury: TreasuryService,
    private readonly cobranzas: CobranzasService,
    private readonly pagosFijos: PagosFijosService,
  ) {}

  // ── Pagos fijos programados (2026-07-31) ──────────────────────────────────
  // Contabilidad DEFINE el pago (qué, cuánto, de qué caja, qué día); la cajera de
  // esa caja REGISTRA la ejecución (egreso en efectivo que cae a su cierre, con
  // comprobante adjunto en la transacción).
  pagosFijosList(user: AuthUser) {
    return this.pagosFijos.list(user);
  }

  pagosFijosRuns(id: string) {
    return this.pagosFijos.runs(id);
  }

  pagosFijosCreate(dto: PagoFijoDto, user: AuthUser) {
    return this.pagosFijos.create(dto, user);
  }

  pagosFijosUpdate(id: string, dto: UpdatePagoFijoDto) {
    return this.pagosFijos.update(id, dto);
  }

  pagosFijosRemove(id: string) {
    return this.pagosFijos.remove(id);
  }

  /** Registrar la ejecución del pago (la cajera, sobre su caja). */
  pagosFijosEjecutar(id: string, dto: EjecutarPagoFijoDto, user: AuthUser) {
    return this.pagosFijos.ejecutar(id, dto, user);
  }

  stats(
    from?: string,
    to?: string,
    all?: string,
    user?: AuthUser,
  ) {
    // Con usuario: acotado a sus cajas, igual que el listado que resume.
    return this.treasury.stats({ from, to, all }, user);
  }

  categories() {
    return this.treasury.categories();
  }

  cashCloses(
    page?: string,
    pageSize?: string,
    from?: string,
    to?: string,
    all?: string,
    cashAccountId?: string,
    user?: AuthUser,
  ) {
    return this.treasury.cashCloses({
      page: Number(page), pageSize: Number(pageSize), from, to, all,
      cashAccountId: cashAccountId ? Number(cashAccountId) : undefined,
    }, user!);
  }

  /** Cierres agregados por día/semana/mes (vista consolidada). */
  cashClosesSummary(
    group?: string,
    from?: string,
    to?: string,
    all?: string,
    cashAccountId?: string,
    user?: AuthUser,
  ) {
    return this.treasury.cashClosesSummary({
      group, from, to, all,
      cashAccountId: cashAccountId ? Number(cashAccountId) : undefined,
    }, user!);
  }

  /**
   * Arqueo de una caja en un día que aún no se ha cerrado, SIN escribir nada.
   * Lo consume el modal de cierre para que el cajero compare contra el cajón antes de
   * cerrar, en vez de descubrir el arqueo después de guardarlo.
   */
  cashClosePreview(
    cashAccountId: string,
    date: string,
    user: AuthUser,
  ) {
    return this.treasury.cashClosePreview(Number(cashAccountId), date, user);
  }

  /**
   * Detalle de un cierre: sus cifras y los movimientos que lo componen.
   * Va declarada DESPUÉS de `cash-closes/summary`: si no, 'summary' entraría por `:id`.
   */
  cashCloseDetail(id: string, user: AuthUser) {
    return this.treasury.cashCloseDetail(id, user);
  }

  /**
   * Informe del cierre (cobranza, bancos, servicios, meses, forma de pago, anulaciones,
   * egresos) de una caja en una fecha, sin necesidad de que esté cerrada.
   */
  cashCloseReport(
    cashAccountId: string,
    date: string,
    user: AuthUser,
  ) {
    return this.treasury.cashCloseReport(Number(cashAccountId), date, user);
  }

  /**
   * Serie diaria de una caja (ingresos/egresos/pagos por día) terminando en `date`.
   * Es la tendencia que pinta el panel de la cajera.
   */
  cashDaily(
    cashAccountId: string,
    date: string,
    days: string | undefined,
    user: AuthUser,
  ) {
    return this.treasury.cashDaily(Number(cashAccountId), date, Number(days ?? 14), user);
  }

  /** PDF del cierre de caja (arqueo). */
  async cashClosePdf(id: string, res: Response, user?: AuthUser) {
    const d = await this.treasury.cashClosePdfData(id, user!);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="cierre-caja.pdf"`);
    cashClosePdf(res, d);
  }

  /**
   * PDF del recibo de caja (comprobante de pago).
   *
   * Por defecto sale en ROLLO de 80 mm, que es lo que imprime la caja y lo que hacía
   * el legacy (mPDF con `format => [80, 250]`). `?formato=carta` devuelve la versión
   * en hoja completa, para archivar o mandar por correo.
   *
   * El cajero que se estampa es QUIEN IMPRIME, igual que el legacy: el recibo no
   * guarda quién recaudó, y firmarlo con otro nombre sería peor que no firmarlo.
   */
  async receiptPdf(
    id: string,
    res: Response,
    formato?: string,
    user?: AuthUser,
  ) {
    const d = await this.treasury.receiptPdfData(id);
    d.cashier = user?.name ?? null;
    d.cashierRole = user?.roles?.[0] ?? null;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="recibo-${d.number}.pdf"`);
    // En hoja el bloque de totales dice "Total recibido": ahí va lo abonado, no el
    // "Cantidad total" del rollo (que es lo abonado + lo que sigue debiendo).
    if (formato === 'carta') receiptPdf(res, { ...d, total: d.paid });
    else reciboRolloPdf(res, d);
  }

  list(
    search?: string,
    type?: string,
    category?: string,
    status?: string,
    from?: string,
    to?: string,
    all?: string,
    cashAccountId?: string,
    page?: string,
    pageSize?: string,
    sortBy?: string,
    sortDir?: string,
    user?: AuthUser,
  ) {
    return this.treasury.list({
      search, type, category, status, from, to, all,
      cashAccountId: cashAccountId ? Number(cashAccountId) : undefined,
      page: Number(page), pageSize: Number(pageSize), sortBy, sortDir,
    }, user as AuthUser);
  }

  detail(id: string, user: AuthUser) {
    return this.treasury.detail(id, user);
  }

  /** Adjuntar el comprobante/evidencia de un movimiento (imagen o PDF). */
  attach(id: string, file: MulterFile, user: AuthUser) {
    if (!file) throw new BadRequestException('Sube una imagen o PDF en el campo "file".');
    return this.treasury.attachTransaction(id, file, user);
  }

  /** Sirve el comprobante adjunto de un movimiento (inline, para preview autenticado). */
  async attachment(id: string, res: Response, user: AuthUser) {
    const a = await this.treasury.getTransactionAttachment(id, user);
    return enviarAdjuntoSeguro(res, join(TREASURY_ROOT, a.storedName), a.originalName);
  }

  // --- Cobranzas (escritura) ---

  /** Cajas disponibles (para selectores de recaudo/egreso/cierre). */
  cashAccounts(user: AuthUser) {
    // Acotada a lo que este usuario puede ver: la cajera sólo su caja + los bancos.
    return this.cobranzas.cashAccounts(user);
  }

  /**
   * Qué caja puede ver quien pregunta. La pantalla lo usa para fijarle la suya a la
   * cajera (y no dejarla cambiar de caja) en vez de ofrecerle "todas".
   */
  miCaja(user: AuthUser) {
    return this.cobranzas.miCaja(user);
  }

  // Las cajas (con su fondo fijo) y las categorías son la CONFIGURACIÓN del dinero,
  // no su operación: quien recauda no define de qué caja sale ni cuánto arrastra.
  // Se cierran a contabilidad/administración (2026-08-03), que son las áreas de la
  // pantalla que las edita (`/tesoreria/cajas`). Sin esto el endpoint quedaba abierto
  // al área caja por el @RequireArea de la clase, aunque la cajera no viera la
  // pantalla: el menú no es una frontera, esto sí.

  /** Crear una caja o banco. */
  createCashAccount(dto: CashAccountDto, user: AuthUser) {
    return this.cobranzas.createCashAccount(dto, user);
  }

  /** Editar una caja (por su id legacy). */
  updateCashAccount(id: string, dto: CashAccountDto, user: AuthUser) {
    return this.cobranzas.updateCashAccount(Number(id), dto, user);
  }

  /** Eliminar una caja (bloquea si tiene movimientos). */
  deleteCashAccount(id: string) {
    return this.cobranzas.deleteCashAccount(Number(id));
  }

  /** Recalcular el saldo persistente de una caja desde sus movimientos. */
  recomputeCashAccount(id: string) {
    return this.cobranzas.recomputeCashAccount(Number(id));
  }

  /** Crear una categoría de transacción. */
  createCategory(dto: TxCategoryDto) {
    return this.cobranzas.createCategory(dto);
  }

  /** Renombrar una categoría (propaga a las transacciones). */
  updateCategory(id: string, dto: TxCategoryDto) {
    return this.cobranzas.updateCategory(id, dto);
  }

  /** Eliminar una categoría (bloquea si está en uso). */
  deleteCategory(id: string) {
    return this.cobranzas.deleteCategory(id);
  }

  /** Facturas pendientes de un cliente (para el modal de recaudo). */
  subscriberDebt(id: string) {
    return this.cobranzas.subscriberDebt(id);
  }

  /** Registrar un recaudo/pago (multipago en cascada + recibo). */
  collect(dto: CollectDto, user: AuthUser) {
    // `cajaPropiaSiFalta`: la pantalla sólo le enseña el selector de caja al
    // superusuario, así que el resto recauda contra la caja que tenga asignada.
    return this.cobranzas.collect(dto, user, { cajaPropiaSiFalta: true });
  }

  /** Registrar un egreso/gasto de caja. */
  expense(dto: ExpenseDto, user: AuthUser) {
    return this.cobranzas.createExpense(dto, user);
  }

  /** Registrar un ingreso manual libre (no ligado a factura). */
  income(dto: IncomeDto, user: AuthUser) {
    return this.cobranzas.createIncome(dto, user);
  }

  /**
   * Editar un movimiento (campos seguros; monto solo en no-ventas).
   *
   * FUERA DEL PERFIL DE CAJA (2026-08-03, decisión del usuario): la cajera REGISTRA
   * plata —recauda, saca un egreso, transfiere, cierra su caja— pero no vuelve sobre
   * lo ya registrado. Editar aquí cambia el monto de un egreso, su fecha o la caja a
   * la que cae, y eso mueve un cierre que ya cuadró sin dejar rastro de anulación.
   * Si se equivoca, contabilidad lo corrige (o se anula y se registra de nuevo).
   *
   * Mismas áreas que la pantalla desde donde se hace (`/tesoreria`, Movimientos).
   */
  editTx(id: string, dto: EditTxDto, user: AuthUser) {
    return this.cobranzas.editTransaction(id, dto, user);
  }

  /** Transferir dinero entre dos cajas. */
  transfer(dto: TransferDto, user: AuthUser) {
    return this.cobranzas.createTransfer(dto, user);
  }

  /**
   * Anular una transacción (soft-delete + reversa de saldo).
   *
   * También fuera del perfil de caja (2026-08-03): anular revierte el saldo de la
   * caja Y el `paidAmount` de la factura, y borra el recibo. Es la corrección de un
   * error de recaudo, y quien lo cometió no debería ser quien lo borra: por eso
   * `/tesoreria/anulaciones` es el control que mira contabilidad desde fuera.
   *
   * Ojo: `voidTransactionTx` (la variante interna) NO pasa por aquí — la usa
   * `FacturasService.voidInvoice` para reversar los pagos de una factura anulada, y
   * su autorización es la de anular la factura, que ya es de contabilidad.
   */
  voidTx(id: string, dto: VoidTxDto, user: AuthUser) {
    return this.cobranzas.voidTransaction(id, dto, user);
  }

  /** Cierre de caja (arqueo) de una caja en una fecha. */
  cashClose(dto: CashCloseDto, user: AuthUser) {
    return this.cobranzas.createCashClose(dto, user);
  }

  /** Apertura de caja (base inicial). */
  /**
   * Abrir la caja del día. Sin base en el body: la calcula el servidor con el fondo
   * fijo de la caja + el arrastre del cierre anterior.
   */
  cashOpen(dto: CashOpenDto, user: AuthUser) {
    return this.cobranzas.openCash(dto, user);
  }

  /** Estado de apertura: con cuánto abriría esa caja ese día, y si ya está abierta. */
  cashOpenSuggest(
    cashAccountId: string,
    date: string,
    user: AuthUser,
  ) {
    return this.cobranzas.cashOpenSuggest(Number(cashAccountId), date, user);
  }
}
