import { ReportsService } from './reports.service';
import { PerformanceService } from './performance.service';
import { StaffReportsService } from './staff-reports.service';
import { MetricsService, METRICAS, ETIQUETA, NO_RECONSTRUIBLES, NO_SUMABLES } from './metrics.service';
import { IspReportsService } from './isp-reports.service';

/** Reportes (recaudo, cartera, ventas, órdenes) — migrado de saves-vestel. */
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly performance: PerformanceService,
    private readonly staffReports: StaffReportsService,
    private readonly metrics: MetricsService,
    private readonly isp: IspReportsService,
  ) {}

  recaudo(from?: string, to?: string, sede?: string) { return this.reports.recaudo(from, to, sede); }
  ventasSede(from?: string, to?: string) { return this.reports.ventasSede(from, to); }
  ingresosEgresos() { return this.reports.ingresosEgresos(); }
  ordenes(
    from?: string,
    to?: string,
    sede?: string,
  ) {
    return this.reports.ordenes(from, to, sede);
  }
  topDeudores(sede?: string) { return this.reports.topDeudores(sede); }
  estadisticasServicios() { return this.reports.estadisticasServicios(); }
  cortesActivaciones(from?: string, to?: string, sede?: string) { return this.reports.cortesActivaciones(from, to, sede); }
  movimientos(from?: string, to?: string, sede?: string) { return this.reports.movimientos(from, to, sede); }

  /**
   * Rendimiento de los técnicos de campo. Sin `from`/`to` toma los últimos 90 días.
   * Ojo: solo mide órdenes de campo atribuidas — ver performance.service.ts.
   */
  tecnicos(
    from?: string,
    to?: string,
    sede?: string,
    tipo?: string,
    prioridad?: string,
  ) {
    return this.performance.tecnicos(from, to, { sede, tipo, prioridad });
  }

  /** Detalle de un técnico, con las órdenes que sí trajeron queja del cliente. */
  tecnico(
    staffId: string,
    from?: string,
    to?: string,
    sede?: string,
    tipo?: string,
    prioridad?: string,
  ) {
    return this.performance.tecnico(staffId, from, to, { sede, tipo, prioridad });
  }

  /** Recaudo por funcionario (ingresos vigentes con emisor identificado). */
  recaudoFuncionario(
    from?: string,
    to?: string,
    metodo?: string,
    caja?: string,
  ) {
    return this.staffReports.recaudoPorFuncionario(from, to, metodo, caja);
  }

  /** Opciones de filtro (métodos y cajas) del reporte de recaudo por funcionario. */
  recaudoFuncionarioFiltros() {
    return this.staffReports.filtrosRecaudo();
  }

  /** Anulaciones de transacciones: quién, cuánto y cuánto después del cobro. */
  anulaciones(
    from?: string,
    to?: string,
    quien?: string,
    sede?: string,
  ) {
    return this.staffReports.anulaciones(from, to, quien, sede);
  }

  /** Actividad en el sistema, desde la bitácora de auditoría. */
  actividad(
    from?: string,
    to?: string,
    usuario?: string,
    entidad?: string,
    accion?: string,
  ) {
    return this.staffReports.actividadSistema(from, to, usuario, entidad, accion);
  }

  // ── Propios de un ISP ───────────────────────────────────────────────────────

  /** De lo que se factura, cuánto entra. Puede pasar del 100%: ver el servicio. */
  indiceRecaudo(from?: string, to?: string, sede?: string) {
    return this.isp.indiceRecaudo(from, to, sede);
  }

  /** Ingreso medio por abonado, mes a mes. */
  arpu(from?: string, to?: string, sede?: string) {
    return this.isp.arpu(from, to, sede);
  }

  /** Puertos libres y ocupados por NAP: dónde se puede conectar sin obra. */
  capacidadRed(sede?: string) {
    return this.isp.capacidadRed(sede);
  }

  /** Clientes en ciclo de corte y reconexión. */
  reincidencia(from?: string, to?: string, sede?: string) {
    return this.isp.reincidencia(from, to, sede);
  }

  /** Cuántos siguen de los que entraron cada año, y antigüedad de los activos. */
  permanencia(sede?: string) {
    return this.isp.permanencia(sede);
  }

  // ── Tendencias e histórico ──────────────────────────────────────────────────
  // Es la sección que contesta "cuántos teníamos y cuántos tenemos", y la única que
  // lee de `MetricPoint` en vez de calcular sobre las tablas vivas.

  /** Catálogo de métricas disponibles y desde cuándo hay datos de cada una. */
  metricasDisponibles() {
    return this.metrics.cobertura();
  }

  /**
   * Evolución de una métrica, con la comparación contra el periodo anterior de la
   * MISMA duración ya calculada. Va en la misma respuesta a propósito: un reporte de
   * tendencia sin el "contra qué" obliga a hacer la resta mentalmente, que es justo
   * lo que se viene a evitar.
   */
  async tendencia(
    metrica?: string,
    from?: string,
    to?: string,
    sede?: string,
    agrupar?: string,
  ) {
    const hoy = new Date().toISOString().slice(0, 10);
    const m = metrica || METRICAS.RECAUDO;
    const desde = from || `${hoy.slice(0, 4)}-01-01`;
    const hasta = to || hoy;

    // Periodo anterior: mismo número de días, pegado justo antes.
    const dias = Math.max(1, Math.round((new Date(hasta).getTime() - new Date(desde).getTime()) / 86400_000) + 1);
    const finPrevio = new Date(new Date(desde).getTime() - 86400_000).toISOString().slice(0, 10);
    const iniPrevio = new Date(new Date(finPrevio).getTime() - (dias - 1) * 86400_000).toISOString().slice(0, 10);

    const [serie, comparacion, cobertura] = await Promise.all([
      this.metrics.serie(m, desde, hasta, { sede, agrupar: agrupar === 'dia' ? 'dia' : 'mes' }),
      this.metrics.comparar(m, { desde: iniPrevio, hasta: finPrevio }, { desde, hasta }, sede),
      this.metrics.cobertura(),
    ]);

    return {
      metrica: m,
      etiqueta: ETIQUETA[m] ?? m,
      reconstruible: !NO_RECONSTRUIBLES.includes(m),
      noSumable: NO_SUMABLES.includes(m),
      serie,
      comparacion,
      // Las opciones viajan en la respuesta, como en el resto de reportes: el selector
      // de métrica nunca ofrece una que no tenga ni un dato.
      opciones: {
        metricas: cobertura.map((c) => ({ id: c.metrica, nombre: c.etiqueta })),
        sedes: (await this.reports.ordenes(hasta, hasta)).opciones.sedes,
      },
      cobertura,
    };
  }

  /** Compara dos periodos de la misma métrica. */
  comparar(
    metrica: string,
    aDesde: string,
    aHasta: string,
    bDesde: string,
    bHasta: string,
    sede?: string,
  ) {
    return this.metrics.comparar(
      metrica ?? METRICAS.RECAUDO,
      { desde: aDesde, hasta: aHasta },
      { desde: bDesde, hasta: bHasta },
      sede,
    );
  }

  /**
   * Reporte de IVA. `tipo` = ventas (por defecto) | compras.
   * El export a PDF/Excel lo arma el frontend con la infraestructura común de reportes.
   */
  iva(
    tipo?: string,
    from?: string,
    to?: string,
    sede?: string,
  ) {
    return this.reports.iva(tipo ?? 'ventas', from, to, sede);
  }
}
