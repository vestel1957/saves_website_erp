import { BadRequestException } from '../core/http/errores';
import { diskStorage } from 'multer';
import { existsSync, mkdirSync } from 'node:fs';
import { extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import * as ExcelJS from 'exceljs';
import { TreasuryService } from './treasury.service';
import { cashClosePdf, receiptPdf } from '../common/pdf/pdf-docs';
import { reciboRolloPdf } from '../common/pdf/recibo-rollo';
import { CobranzasService } from './cobranzas.service';
import { FacturasService } from '../billing/facturas.service';
import { ESPERA_VENTANILLA_MS } from '../network/reconexion.service';
import { EjecutarPagoFijoDto, PagoFijoDto, PagosFijosService, UpdatePagoFijoDto } from './pagos-fijos.service';
import {
  BeneficiaryDto, CashAccountDto, CashCloseDto, CashOpenDto, CollectDto, EditTxDto, ExpenseDto,
  IncomeDto, TransferDto, TxCategoryDto, VoidTxDto,
} from './dto/cobranzas.dto';
import { ListTxQueryDto } from './dto/movimientos.dto';
import { AuthUser } from '../auth/current-user.decorator';
import { enviarAdjuntoSeguro, mimeAceptado, nombreEnDisco } from '../common/uploads';
// Una sola definición de dónde viven los comprobantes: la comparte con el servicio,
// que además sabe resolver los que están en el legacy.
export { TREASURY_ROOT } from './comprobante-legacy';
import { TREASURY_ROOT } from './comprobante-legacy';
type MulterFile = { originalname: string; filename: string; mimetype: string; size: number };

/** Tesorería: movimientos, cajas y cierres (migrado de saves-vestel). */
export class TreasuryController {
  constructor(
    private readonly treasury: TreasuryService,
    private readonly cobranzas: CobranzasService,
    private readonly pagosFijos: PagosFijosService,
    private readonly facturas: FacturasService,
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
    sede?: string,
    user?: AuthUser,
  ) {
    // Con usuario: acotado a sus cajas, igual que el listado que resume.
    return this.treasury.stats({ from, to, all, sede }, user);
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
   * Los pagos por WOMPI del día, uno a uno (cliente, medio, facturas, referencia), de
   * los clientes de la sede de la caja. El informe sólo trae la fila con el total.
   */
  cashCloseWompi(
    cashAccountId: string,
    date: string,
    user: AuthUser,
  ) {
    return this.treasury.cashCloseWompi(Number(cashAccountId), date, user);
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

  /**
   * Listado de movimientos. Los filtros llegan como UN objeto validado
   * (`ListTxQueryDto`) en vez de doce argumentos posicionales: añadir un filtro nuevo
   * era tocar controlador + router + contrato en el mismo orden exacto, y equivocarse
   * de posición cambiaba en silencio el significado de una consulta de dinero.
   */
  list(q: ListTxQueryDto, user: AuthUser) {
    return this.treasury.list(q, user);
  }

  /**
   * Excel del listado de movimientos (Ingresos, Egresos, Anulaciones) con los MISMOS
   * filtros que la tabla — todas las páginas, no la que se ve.
   */
  async exportXlsx(q: ListTxQueryDto, res: Response, user: AuthUser) {
    const rows = await this.treasury.exportRows(q, user);
    const titulo = q.status === 'ANULADA' ? 'Anulaciones'
      : q.type === 'EXPENSE' ? 'Egresos'
      : q.type === 'INCOME' ? 'Ingresos'
      : 'Movimientos';
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Vestel';
    const ws = wb.addWorksheet(titulo, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = [
      { header: 'Código', key: 'codigo', width: 10 },
      // `date` es @db.Date (medianoche UTC): Excel lo pinta como el mismo día.
      { header: 'Fecha', key: 'date', width: 12, style: { numFmt: 'dd/mm/yyyy' } },
      { header: 'Hora', key: 'hora', width: 8 },
      { header: 'Tipo', key: 'tipo', width: 10 },
      { header: 'Cuenta', key: 'account', width: 24 },
      { header: q.type === 'EXPENSE' ? 'Beneficiario' : q.type === 'INCOME' ? 'Pagador' : 'Pagador / Beneficiario', key: 'payer', width: 34 },
      { header: 'Abonado', key: 'abonado', width: 10 },
      { header: 'Nota', key: 'note', width: 48 },
      { header: 'Emitido por', key: 'emisor', width: 24 },
      { header: 'Categoría', key: 'category', width: 20 },
      { header: 'Factura', key: 'invoiceTid', width: 10 },
      { header: 'Método', key: 'method', width: 12 },
      { header: 'Monto', key: 'amount', width: 16, style: { numFmt: '#,##0' } },
      { header: 'Estado', key: 'estado', width: 10 },
      { header: 'Comprobante', key: 'comprobante', width: 12 },
    ];
    ws.getRow(1).font = { bold: true };
    const TIPO: Record<string, string> = { INCOME: 'Ingreso', EXPENSE: 'Egreso', TRANSFER: 'Traslado' };
    for (const r of rows) {
      ws.addRow({
        ...r,
        tipo: TIPO[r.type] ?? r.type,
        estado: r.status === 'ANULADA' ? 'Anulada' : 'Vigente',
        comprobante: r.comprobante ? 'Sí' : 'No',
      });
    }
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columns.length } };
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${titulo.toLowerCase()}-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.send(buffer);
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
    return enviarAdjuntoSeguro(res, a.ruta, a.originalName);
  }

  /**
   * Comprobante por nombre de archivo, SIN sesión: es el enlace que se le entrega al
   * legacy dentro de la nota del movimiento, y quien lo abre está allá, no aquí.
   */
  async comprobantePublico(archivo: string, res: Response) {
    const a = await this.treasury.getAttachmentByFile(archivo);
    return enviarAdjuntoSeguro(res, a.ruta, a.originalName);
  }

  // --- Cobranzas (escritura) ---

  /** Cajas disponibles (para selectores de recaudo/egreso/cierre). */
  cashAccounts(user: AuthUser, from?: string, to?: string) {
    // Acotada a lo que este usuario puede ver: la cajera sólo su caja + los bancos.
    // Con `from`/`to`, cada caja trae además lo que se movió en ese rango.
    return this.cobranzas.cashAccounts(user, { from, to });
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

  /** Directorio de beneficiarios (proveedores y terceros) para el desplegable del movimiento. */
  beneficiaries(search?: string, category?: string) {
    return this.cobranzas.beneficiaries({ search, category });
  }

  /**
   * Alta rápida de un beneficiario desde el movimiento (por defecto, tercero).
   *
   * La cajera también puede: es quien más egresos de ventanilla registra y sin
   * esto el pago al señor que vino a pintar se quedaba con el nombre suelto. Lo
   * que NO puede es tocar el catálogo de PROVEEDORES: sea cual sea la categoría
   * que mande, la suya entra siempre como TERCERO (3). Dar de alta un proveedor
   * sigue siendo de contabilidad, en su pantalla.
   */
  createBeneficiary(dto: BeneficiaryDto, user?: AuthUser) {
    const permisos = user?.permissions ?? [];
    const catalogo = permisos.some((p) =>
      p === 'system.admin' || p === 'area.contabilidad' || p === 'area.administracion');
    return this.cobranzas.createBeneficiary(catalogo ? dto : { ...dto, category: 3 });
  }

  /** Facturas pendientes de un cliente (para el modal de recaudo). */
  subscriberDebt(id: string) {
    return this.cobranzas.subscriberDebt(id);
  }

  /** Registrar un recaudo/pago (multipago en cascada + recibo). */
  async collect(dto: CollectDto, user: AuthUser) {
    // `cajaPropiaSiFalta`: la pantalla sólo le enseña el selector de caja al
    // superusuario, así que el resto recauda contra la caja que tenga asignada.
    // `esperaReconexionMs`: el recibo se imprime cuando esto responde; la cajera no
    // puede tener al cliente esperando el papel por un equipo lento (ver
    // `ESPERA_VENTANILLA_MS`). La reconexión sigue sola si se pasa.
    const res = await this.cobranzas.collect(dto, user, {
      cajaPropiaSiFalta: true, fechaDeVentanilla: true, esperaReconexionMs: ESPERA_VENTANILLA_MS,
    });
    // "Pagar también <mes>": la factura de ese mes se emite ya y queda pagada con el
    // anticipo (ver `FacturasService.emitirMesesAdelantados`). Va después del recaudo
    // confirmado; si no se puede, el anticipo queda abierto para la corrida del día 1.
    const fechas = res.adelanto?.fechas ?? [];
    const facturasAdelantadas = fechas.length
      ? await this.facturas.emitirMesesAdelantados(dto.subscriberId, fechas, user)
      : null;
    return { ...res, facturasAdelantadas };
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
