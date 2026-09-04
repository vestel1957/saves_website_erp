import { Logger } from '../core/logger';
import type { ToolContext } from '@s4gk/wa-agent';
import { SubscribersService } from '../subscribers/subscribers.service';
import { BillingService } from '../billing/billing.service';
import { SupportService } from '../support/support.service';
import { TreasuryService } from '../treasury/treasury.service';
import { OrdersService } from '../orders/orders.service';
import { ReportsService } from '../reports/reports.service';
import { PerformanceService } from '../reports/performance.service';
import { StaffReportsService } from '../reports/staff-reports.service';
import { IspReportsService } from '../reports/isp-reports.service';
import { MetricsService, METRICAS, ETIQUETA, NO_RECONSTRUIBLES, NO_SUMABLES } from '../reports/metrics.service';
import { DashboardService } from '../dashboard/dashboard.service';
import { invoicePdfBuffer } from '../billing/billing-pdf';
import { pazYSalvoPdf, statementPdf } from '../subscribers/subscriber-pdf';
import { cashClosePdf, purchaseOrderPdf, serviceOrderPdf } from '../common/pdf/pdf-docs';
import { ContractsService } from '../contracts/contracts.service';
import { renderContratoLegacy } from '../contracts/contrato-legacy.render';
import {
  actividadReporte, anulacionesReporte, arpuReporte, capacidadRedReporte, cortesReporte, deudoresReporte, facturacionReporte,
  indiceRecaudoReporte, ingresosEgresosReporte, ivaReporte, movimientosReporte, ordenesReporte,
  periodoLabel, permanenciaReporte, reincidenciaReporte,
  recaudoFuncionarioReporte, recaudoReporte, reportPdf, resumenNegocioReporte, serviciosReporte,
  tecnicoDetalleReporte, tecnicosReporte, tendenciaReporte, ventasSedeReporte,
  type ReporteData,
} from '../reports/reports-pdf';
import { pdfToBuffer } from '../common/pdf/pdf-buffer';
import type { AuthUser } from '../auth/current-user.decorator';

/**
 * Los reportes que se pueden pedir en PDF por chat, y de dónde sale cada uno.
 *
 * Son LOS MISMOS 14 de la sección /reportes del ERP (ver `frontend/src/lib/reportes.ts`),
 * más el resumen del negocio (el dashboard) y el detalle de un técnico, que en la web
 * es el drill-down del reporte de rendimiento. Si se agrega un reporte a la web y no
 * se agrega aquí, por WhatsApp sencillamente no existe.
 *
 * La clave es lo que el modelo escribe en el `enum` de la herramienta: cambiarla
 * rompe el contrato con el LLM, así que se añaden claves nuevas, no se renombran.
 */
export const REPORTES_PDF = {
  // Gerencia: la plata.
  facturacion: 'Resumen de facturación',
  recaudo: 'Recaudo',
  ventas_sede: 'Ventas por sede',
  ingresos_egresos: 'Ingresos y egresos',
  deudores: 'Cartera / deudores',
  iva: 'Reporte de IVA',
  // Operación: el servicio.
  ordenes: 'Órdenes de servicio',
  cortes: 'Cortes y activaciones',
  servicios: 'Estado de clientes',
  movimientos: 'Altas y retiros',
  // Personal: la gente.
  tecnicos: 'Rendimiento de técnicos',
  tecnico_detalle: 'Detalle de un técnico',
  recaudo_funcionario: 'Recaudo por funcionario',
  anulaciones: 'Anulaciones (control)',
  actividad: 'Actividad en el sistema',
  // Propios de un ISP.
  indice_recaudo: 'Índice de recaudo',
  arpu: 'ARPU (ingreso por abonado)',
  capacidad_red: 'Capacidad de red (NAPs)',
  reincidencia: 'Reincidencia de cortes',
  permanencia: 'Antigüedad y permanencia',
  // Dirección.
  resumen: 'Resumen del negocio',
  tendencias: 'Tendencias e histórico',
} as const;

export type ReportePdfKind = keyof typeof REPORTES_PDF;

export const esReportePdf = (s: string): s is ReportePdfKind =>
  Object.prototype.hasOwnProperty.call(REPORTES_PDF, s);

/** Un PDF listo para adjuntar al chat. */
export type ChatDoc = { data: Buffer; fileName: string; caption: string };

const logger = new Logger('ChatbotDocs');

const cop = (n: number | null | undefined) =>
  new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(Number(n) || 0);

/** Nombre de archivo seguro: sin tildes, espacios ni nada que rompa un adjunto. */
const slug = (s: string) =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '').toLowerCase() || 'documento';

/**
 * Adjunta el PDF a la conversación y traduce el resultado a algo que el modelo pueda
 * decirle a la persona.
 *
 * El envío puede fallar del lado de Kapso (archivo muy grande, ventana de 24 h cerrada,
 * credenciales) y el motor ignora ese booleano: sin esto el bot anunciaría "te mandé el
 * documento" y al otro lado no llegaría nada.
 */
export async function enviarDoc(ctx: ToolContext, doc: ChatDoc, exito?: string): Promise<string> {
  const ok = await ctx.sendDocument({
    data: doc.data,
    fileName: doc.fileName,
    mimetype: 'application/pdf',
    caption: doc.caption,
  });
  if (!ok) {
    logger.warn(`No se pudo enviar ${doc.fileName} a ${ctx.convKey}`);
    return 'No pude enviar el PDF en este momento. Dile que lo intente en unos minutos, sin prometer nada más.';
  }
  // `exito` permite dictar la confirmación desde quien conoce el documento. Lo usan
  // los reportes para EXIGIR que se nombre el reporte enviado: una regla en el
  // prompt queda demasiado lejos del momento de redactar y el modelo la ignora, pero
  // el resultado de la herramienta llega justo cuando está componiendo la respuesta.
  return exito ?? `Listo: el PDF (${doc.fileName}) ya quedó enviado en este chat. Confírmaselo en una línea y no repitas el contenido del documento.`;
}

/**
 * Fábrica de PDF para el chatbot.
 *
 * Todo lo que se manda por WhatsApp sale de los MISMOS servicios y los MISMOS
 * generadores que usa la web: un documento pedido por chat es idéntico al que se
 * imprime desde el ERP, y el acotado por sede/permiso viaja en el `AuthUser` que cada
 * método recibe (los servicios lo exigen, no es decoración). Aquí no se consulta la BD
 * directamente ni se dibuja nada nuevo.
 */
export class ChatbotDocsService {
  constructor(
    private readonly subscribers: SubscribersService,
    private readonly contracts: ContractsService,
    private readonly billing: BillingService,
    private readonly support: SupportService,
    private readonly treasury: TreasuryService,
    private readonly orders: OrdersService,
    private readonly reports: ReportsService,
    private readonly performance: PerformanceService,
    private readonly staffReports: StaffReportsService,
    private readonly isp: IspReportsService,
    private readonly metrics: MetricsService,
    private readonly dashboard: DashboardService,
  ) {}

  /**
   * Un reporte de gerencia como PDF, listo para adjuntar.
   *
   * Sale de los MISMOS servicios que alimentan los tableros de /reportes: el PDF y
   * la pantalla no pueden dar cifras distintas. Aquí solo se elige el traductor y
   * se le pone nombre al archivo.
   */
  async reporte(
    kind: ReportePdfKind,
    opts: {
      desde?: string; hasta?: string; quien?: string;
      /** Solo IVA: ventas (por defecto) o compras. */
      tipo?: string;
      /** Solo el detalle de técnico: `Staff.id` ya resuelto, y su nombre para el título. */
      staffId?: string;
      staffNombre?: string;
      /** `Branch.id` ya resuelto. Lo aceptan los reportes que cuelgan del abonado. */
      sedeId?: string;
      /** Solo tendencias: qué indicador graficar. */
      metrica?: string;
    } = {},
  ): Promise<ChatDoc> {
    const { desde, hasta } = opts;
    const periodo = periodoLabel(desde, hasta);

    const data: ReporteData = await (async () => {
      switch (kind) {
        case 'facturacion': return facturacionReporte(await this.billing.stats({ from: desde, to: hasta }), periodo);
        case 'recaudo': return recaudoReporte(await this.reports.recaudo(desde, hasta, opts.sedeId), periodo);
        case 'ventas_sede': return ventasSedeReporte(await this.reports.ventasSede(desde, hasta), periodo);
        case 'ingresos_egresos': return ingresosEgresosReporte(await this.reports.ingresosEgresos());
        case 'deudores': return deudoresReporte(await this.reports.topDeudores(opts.sedeId));
        case 'iva': return ivaReporte(await this.reports.iva(opts.tipo ?? 'ventas', desde, hasta, opts.sedeId), periodo);
        case 'ordenes': return ordenesReporte(await this.reports.ordenes(desde, hasta, opts.sedeId), periodo);
        case 'cortes': return cortesReporte(await this.reports.cortesActivaciones(desde, hasta, opts.sedeId), periodo);
        case 'servicios': return serviciosReporte(await this.reports.estadisticasServicios());
        case 'movimientos': return movimientosReporte(await this.reports.movimientos(desde, hasta, opts.sedeId), periodo);
        case 'tecnicos': return tecnicosReporte(await this.performance.tecnicos(desde, hasta));
        case 'tecnico_detalle': {
          // Quién es se resuelve ANTES de llamar aquí (ver el toolset): esta capa no
          // adivina nombres, y sin id no hay reporte que valga.
          if (!opts.staffId) throw new Error('Falta indicar de qué técnico es el detalle.');
          const d = await this.performance.tecnico(opts.staffId, desde, hasta);
          return tecnicoDetalleReporte(d, opts.staffNombre ?? d.resumen?.nombre ?? 'Técnico');
        }
        case 'recaudo_funcionario': return recaudoFuncionarioReporte(await this.staffReports.recaudoPorFuncionario(desde, hasta));
        case 'anulaciones': return anulacionesReporte(await this.staffReports.anulaciones(desde, hasta, undefined, opts.sedeId));
        case 'actividad': return actividadReporte(await this.staffReports.actividadSistema(desde, hasta));
        case 'indice_recaudo': return indiceRecaudoReporte(await this.isp.indiceRecaudo(desde, hasta, opts.sedeId), periodo);
        case 'arpu': return arpuReporte(await this.isp.arpu(desde, hasta, opts.sedeId), periodo);
        case 'capacidad_red': return capacidadRedReporte(await this.isp.capacidadRed(opts.sedeId));
        case 'reincidencia': return reincidenciaReporte(await this.isp.reincidencia(desde, hasta, opts.sedeId), periodo);
        case 'permanencia': return permanenciaReporte(await this.isp.permanencia(opts.sedeId));
        case 'tendencias': {
          const m = opts.metrica || METRICAS.RECAUDO;
          const hoy = new Date().toISOString().slice(0, 10);
          const d1 = desde ?? `${hoy.slice(0, 4)}-01-01`;
          const d2 = hasta ?? hoy;
          const dias = Math.max(1, Math.round((new Date(d2).getTime() - new Date(d1).getTime()) / 86400_000) + 1);
          const finPrev = new Date(new Date(d1).getTime() - 86400_000).toISOString().slice(0, 10);
          const iniPrev = new Date(new Date(finPrev).getTime() - (dias - 1) * 86400_000).toISOString().slice(0, 10);
          const [serie, comparacion, cobertura] = await Promise.all([
            this.metrics.serie(m, d1, d2, { sede: opts.sedeId, agrupar: 'mes' }),
            this.metrics.comparar(m, { desde: iniPrev, hasta: finPrev }, { desde: d1, hasta: d2 }, opts.sedeId),
            this.metrics.cobertura(),
          ]);
          return tendenciaReporte({
            metrica: m, etiqueta: ETIQUETA[m] ?? m,
            reconstruible: !NO_RECONSTRUIBLES.includes(m),
            noSumable: NO_SUMABLES.includes(m),
            serie, comparacion, cobertura,
          }, periodo);
        }
        case 'resumen': return resumenNegocioReporte(await this.dashboard.summary());
      }
    })();

    const pdf = await pdfToBuffer((res) => reportPdf(res, { ...data, generadoPor: opts.quien }));
    // El periodo va en el nombre del archivo a propósito: en el celular quedan
    // varios "reporte-recaudo.pdf" y sin fechas no hay forma de saber cuál es cuál.
    const rango = desde || hasta ? `-${slug(periodo)}` : '';
    // Lo que distingue a dos PDF del MISMO reporte va también en el nombre: dos
    // "reporte-iva.pdf" en el celular no se distinguen hasta abrirlos.
    const matiz = kind === 'iva' ? `-${slug(opts.tipo ?? 'ventas')}`
      : kind === 'tecnico_detalle' && opts.staffNombre ? `-${slug(opts.staffNombre)}`
        : data.titulo.includes('·') ? `-${slug(data.titulo.split('·').pop()!)}`
          : '';
    return {
      data: pdf,
      fileName: `reporte-${slug(kind)}${matiz}${rango}.pdf`,
      // El pie sale del TÍTULO del reporte, no de la etiqueta genérica: el traductor
      // ya le metió ahí lo que distingue este archivo de otro del mismo tipo (la
      // sede, la persona). Con la etiqueta a secas, dos PDF de sedes distintas
      // llegaban al chat con exactamente el mismo pie.
      caption: `${data.titulo} · ${data.periodo ?? periodo}`,
    };
  }

  /** Factura de venta. */
  async factura(invoiceId: string, user?: AuthUser): Promise<ChatDoc> {
    const inv: any = await this.billing.detail(invoiceId, user);
    const data = await invoicePdfBuffer(inv);
    return {
      data,
      fileName: `factura-${inv.tid}.pdf`,
      caption: `Factura N° ${inv.tid} · Total ${cop(inv.total)}` +
        (inv.balance > 0 ? ` · Pendiente ${cop(inv.balance)}` : ' · Pagada. ¡Gracias!'),
    };
  }

  /** Estado de cuenta detallado (cargos, abonos y saldo corrido). */
  async estadoCuenta(subscriberId: string, user?: AuthUser): Promise<ChatDoc> {
    const st: any = await this.subscribers.statement(subscriberId, user);
    const data = await pdfToBuffer((res) => statementPdf(res, st));
    return {
      data,
      fileName: `estado-cuenta-${st.subscriber.abonado}.pdf`,
      caption: `Estado de cuenta · ${st.subscriber.name} (abonado ${st.subscriber.abonado}) · ` +
        (st.balance > 0 ? `saldo ${cop(st.balance)}` : 'sin saldo pendiente'),
    };
  }

  /**
   * Certificado de paz y salvo.
   *
   * Puede NO haber documento: el certificado exige los cuatro requisitos —al día,
   * equipo devuelto, carta de retiro o suspensión entregada y esa orden ya cerrada
   * (ver `SubscribersService.statement`)—. En ese caso no se arma ningún PDF y
   * se devuelven los motivos para que quien llamó se lo explique con palabras — antes
   * el generador redactaba el certificado en negativo y se acababa mandando por
   * WhatsApp un papel con membrete diciendo que el cliente debe.
   */
  async pazYSalvo(subscriberId: string, user?: AuthUser): Promise<
    | { puedeEmitir: false; motivos: string[]; motivosTexto: string; alDia: boolean; saldo: number; equipos: number }
    | (ChatDoc & { puedeEmitir: true; motivos: string[]; motivosTexto: string; alDia: boolean; saldo: number; equipos: number })
  > {
    const st: any = await this.subscribers.statement(subscriberId, user);
    const base = {
      motivos: (st.motivosPazYSalvo ?? []) as string[],
      motivosTexto: (st.motivosPazYSalvoTexto ?? '') as string,
      alDia: !!st.alDia,
      saldo: Number(st.balance) || 0,
      equipos: (st.equiposPendientes ?? []).length as number,
    };
    if (!st.puedeEmitirPazYSalvo) return { puedeEmitir: false, ...base };
    return {
      puedeEmitir: true,
      ...base,
      data: await pdfToBuffer((res) => pazYSalvoPdf(res, st)),
      fileName: `paz-y-salvo-${st.subscriber.abonado}.pdf`,
      caption: `Paz y salvo · ${st.subscriber.name} (abonado ${st.subscriber.abonado})`,
    };
  }

  /** Contrato de prestación de servicios. */
  async contrato(subscriberId: string, user?: AuthUser): Promise<ChatDoc> {
    const d = await this.contracts.datosContratoLegacy(subscriberId, user);
    const data = await renderContratoLegacy('contrato', d);
    const nombre = [d.details.name, d.details.unoapellido].filter(Boolean).join(' ').trim();
    return {
      data,
      fileName: `contrato-${d.abonado}.pdf`,
      caption: `Contrato de servicios · ${nombre} (abonado ${d.abonado})`,
    };
  }

  /** Orden / acta de servicio técnico de un ticket. */
  async ordenServicio(ticketId: string, user?: AuthUser): Promise<ChatDoc> {
    const d = await this.support.serviceOrderPdfData(ticketId, user);
    const data = await pdfToBuffer((res) => serviceOrderPdf(res, d as any));
    return {
      data,
      fileName: `orden-servicio-${slug(d.code)}.pdf`,
      caption: `Orden de servicio N° ${d.code} · ${d.subject || d.type} · ${d.status}` +
        (d.subscriber ? ` · ${d.subscriber.name}` : ''),
    };
  }

  /** Orden de compra/servicio a proveedor, con su cuadro de firmas. */
  async ordenCompra(orderId: string): Promise<ChatDoc> {
    const d: any = await this.orders.pdfData(orderId);
    // Mismo mapeo que `OrdersController.pdf`: el PDF impreso y el que llega por
    // WhatsApp no pueden diferir en nada.
    const data = await pdfToBuffer((res) => purchaseOrderPdf(res, {
      tid: d.tid, kind: d.kind, status: d.status, date: d.date, dueDate: d.dueDate,
      branchRef: d.branchRef, categoryRef: undefined, notes: d.notes,
      supplier: d.supplier ? { name: d.supplier.name, nit: d.supplier.nit, phone: d.supplier.phone } : null,
      items: (d.items ?? []).map((it: any) => ({ ...it, product: it.product ?? '—' })),
      noteLines: (d.noteLines ?? []).map((n: any) => ({ ...n, type: n.type ?? 'Nota' })),
      subtotal: d.subtotal, tax: d.tax, total: d.total, paid: d.paid, balance: d.balance,
      createdByName: d.approval?.createdByName ?? null,
      firstBy: d.approval?.firstBy ?? null,
      secondBy: d.approval?.secondBy ?? null,
    }));
    return {
      data,
      fileName: `orden-${d.tid}.pdf`,
      caption: `Orden de ${d.kind === 'servicio' ? 'servicio' : 'compra'} N° ${d.tid} [${d.status}] · ` +
        `${d.supplier?.name ?? 'sin proveedor'} · ${cop(d.total)}`,
    };
  }

  /** Comprobante de cierre de caja. */
  async cierreCaja(closeId: string, user: AuthUser): Promise<ChatDoc> {
    const d = await this.treasury.cashClosePdfData(closeId, user);
    const data = await pdfToBuffer((res) => cashClosePdf(res, d as any));
    const fecha = new Date(d.date).toISOString().slice(0, 10);
    return {
      data,
      fileName: `cierre-${slug(d.cashAccountName)}-${fecha}.pdf`,
      caption: `Cierre de caja · ${d.cashAccountName} · ${fecha} · barrido ${cop(d.excedente)}` +
        (d.descuadrado ? ' · OJO: ya no cuadra con el libro' : ''),
    };
  }
}
