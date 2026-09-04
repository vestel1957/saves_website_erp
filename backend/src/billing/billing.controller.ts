import type { Response } from 'express';
import { BillingService } from './billing.service';
import { invoicePdf } from './billing-pdf';
import { reciboRolloPdf } from '../common/pdf/recibo-rollo';
import { FacturasService } from './facturas.service';
import { RecurringService } from './recurring.service';
import { CatalogoService } from './catalogo.service';
import { AsignarServicioDto, CreateInvoiceDto, CreateNoteDto, CreateNotesBulkDto, GenerateInvoicesDto, UpdateInvoiceDto, VoidInvoiceDto } from './dto/facturas.dto';
import { CreateRecurringDto } from './dto/recurring.dto';
import { AuthUser } from '../auth/current-user.decorator';

/** Facturación y cartera (vertical migrado de saves-vestel). */
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly facturas: FacturasService,
    private readonly recurring: RecurringService,
    private readonly catalogo: CatalogoService,
  ) {}

  /** Catálogo facturable (planes + productos del legacy) para el selector de ítems. */
  catalog(search?: string, limit?: string) {
    return this.catalogo.buscar(search, limit ? Number(limit) : undefined);
  }

  /**
   * PDF de la factura. `?formato=rollo` la saca en papel de 80 mm — el recibo chico
   * que imprime la caja, que es lo que hacía el "Imprimir" del legacy.
   */
  async invoicePdf(
    id: string,
    res: Response,
    formato?: string,
    user?: AuthUser,
  ) {
    // El PDF va por el mismo `detail`, así que hereda el acotado por sede: sin pasar
    // el usuario, descargar el PDF sería la puerta trasera del filtro.
    if (formato === 'rollo') {
      const d = await this.billing.reciboRolloData(id, user);
      d.cashier = user?.name ?? null;
      d.cashierRole = user?.roles?.[0] ?? null;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="recibo-${d.number}.pdf"`);
      reciboRolloPdf(res, d);
      return;
    }
    const inv = await this.billing.detail(id, user);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="factura-${inv.tid}.pdf"`);
    invoicePdf(res, inv as any);
  }

  stats(from?: string, to?: string, all?: string) {
    return this.billing.stats({ from, to, all });
  }

  aging() {
    return this.billing.aging();
  }

  list(
    search?: string,
    status?: string,
    ron?: string,
    branchId?: string,
    from?: string,
    to?: string,
    all?: string,
    overdue?: string,
    page?: string,
    pageSize?: string,
    sortBy?: string,
    sortDir?: string,
    user?: AuthUser,
  ) {
    return this.billing.list({ search, status, ron, branchId, from, to, all, overdue, page: Number(page), pageSize: Number(pageSize), sortBy, sortDir }, user);
  }

  /** Envía la factura por WhatsApp (PDF adjunto) al cliente. */
  sendWhatsapp(id: string) {
    return this.billing.sendWhatsapp(id);
  }

  /** Envía la factura por correo (PDF adjunto) al cliente. */
  sendEmail(id: string) {
    return this.billing.sendEmail(id);
  }

  detail(id: string, user: AuthUser) {
    return this.billing.detail(id, user);
  }

  // --- Escritura (Cobranza) ---
  // Cada escritura lleva su propio @RequireArea('contabilidad'): el de la clase
  // incluye 'caja' para que la cajera CONSULTE facturas e imprima el recibo, y su
  // perfil sigue siendo de solo lectura sobre las facturas YA emitidas — no las
  // edita, no las anula y no emite notas. Sin el override, el botón oculto de la
  // UI era la única barrera y un POST a mano anulaba facturas.
  //
  // La ÚNICA escritura que sí se le abrió (2026-08-27) es `create`: cobrar en
  // ventanilla algo que todavía no está facturado —instalación, traslado, venta de
  // equipo, reconexión— exigía que contabilidad emitiera la factura primero, y eso
  // dejaba al cliente esperando en el mostrador. La factura que crea queda acotada
  // a los clientes de SU sede (`exigirSedeSuscriptor` en `createInvoice`).

  /** Última factura del cliente (para clonar en "Nueva factura"). */
  lastInvoice(id: string) {
    return this.facturas.lastInvoice(id);
  }

  /** Facturas del cliente para elegir en "Nueva nota" (pendientes; `scope=all` trae el histórico). */
  subscriberInvoices(id: string, scope: string | undefined, user: AuthUser) {
    return this.facturas.subscriberInvoices(id, scope, user);
  }

  /** Crear una factura. */
  create(dto: CreateInvoiceDto, user: AuthUser) {
    return this.facturas.createInvoice(dto, user);
  }

  /**
   * Editar una factura emitida: reemplaza sus conceptos y recalcula los totales
   * (paridad legacy `Invoices::editaction`). No toca sus notas crédito/débito.
   */
  update(id: string, dto: UpdateInvoiceDto, user: AuthUser) {
    return this.facturas.updateInvoice(id, dto, user);
  }

  /** Qué se le hizo a esta factura, quién y por qué (auditoría + notas + emisión). */
  historial(id: string, user: AuthUser) {
    return this.facturas.historial(id, user);
  }

  /**
   * Qué plan tiene asignado el abonado de esta factura para la próxima facturación,
   * y cuál es la factura de la que lo lee el legacy.
   */
  servicioAsignado(id: string, user: AuthUser) {
    return this.facturas.servicioAsignado(id, user);
  }

  /**
   * "Asignar servicio" (el `ASIGNAR SERVICIO` del legacy): fija el plan que se le
   * cobrará al abonado desde la próxima facturación. No reprecia esta factura.
   */
  asignarServicio(id: string, dto: AsignarServicioDto, user: AuthUser) {
    return this.facturas.asignarServicio(id, dto, user);
  }

  /** Generar facturas recurrentes en lote. */
  generate(dto: GenerateInvoicesDto, user: AuthUser) {
    return this.facturas.generate(dto, user);
  }

  /** Listado de notas crédito/débito (filtros: tipo, sede, fechas, autor, monto). */
  listNotes(
    page?: string,
    pageSize?: string,
    search?: string,
    type?: string,
    branchId?: string,
    from?: string,
    to?: string,
    authorId?: string,
    montoMin?: string,
    montoMax?: string,
    sortBy?: string,
    sortDir?: string,
    user?: AuthUser,
  ) {
    return this.facturas.listNotes(
      { page: Number(page), pageSize: Number(pageSize), search, type, branchId, from, to, authorId, montoMin, montoMax, sortBy, sortDir },
      user,
    );
  }

  /** Crear nota crédito/débito sobre una factura. */
  createNote(id: string, dto: CreateNoteDto, user: AuthUser) {
    return this.facturas.createNote(id, dto, user);
  }

  /**
   * Crear la MISMA nota sobre VARIAS facturas de un cliente (depuración de cartera).
   * El monto de cada factura viaja en `items`; todo el lote va en una transacción.
   */
  createNotes(dto: CreateNotesBulkDto, user: AuthUser) {
    return this.facturas.createNotes(dto, user);
  }

  /** Anular una factura de venta (motivo obligatorio). */
  voidInvoice(id: string, dto: VoidInvoiceDto, user: AuthUser) {
    return this.facturas.voidInvoice(id, dto, user);
  }

  // --- Reciclaje de ventas (plantillas recurrentes) ---

  recStats() {
    return this.recurring.stats();
  }

  recList(search?: string, page?: string, pageSize?: string, sortBy?: string, sortDir?: string) {
    return this.recurring.list({ search, page: Number(page), pageSize: Number(pageSize), sortBy, sortDir });
  }

  recDetail(id: string) {
    return this.recurring.detail(id);
  }

  recCreate(dto: CreateRecurringDto, user: AuthUser) {
    return this.recurring.create(dto, user);
  }

  /** Generar una factura real a partir de la plantilla. */
  recRun(id: string, user: AuthUser) {
    return this.recurring.run(id, user);
  }

  /** Activar/desactivar plantilla. */
  recToggle(id: string, body: { active: boolean }) {
    return this.recurring.toggle(id, !!body.active);
  }

  recRemove(id: string) {
    return this.recurring.remove(id);
  }
}
