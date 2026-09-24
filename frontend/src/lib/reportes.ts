import type { ReportDoc } from "./report-export";

export const nfmt = (n: number) => (n ?? 0).toLocaleString("es-CO");

export const MONTHS = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];

export const monthLabel = (m: string) => {
  const [y, mm] = (m || "-").split("-");
  return `${MONTHS[Number(mm) - 1] ?? mm} ${(y || "").slice(2)}`;
};

/** Grupos del menú de reportes: a quién le sirve cada uno. */
export type ReportGroup = "gerencia" | "operacion" | "personal";

/**
 * Un filtro extra de un reporte, más allá del rango de fechas.
 *
 * Las opciones se leen de la PROPIA respuesta del reporte (`from`) en vez de
 * pedirlas por separado: el backend ya sabe qué sedes tienen órdenes o qué cajas
 * movieron plata, y así el filtro nunca ofrece un valor que daría cero.
 */
export type ReportFilter = {
  /** Nombre del parámetro en la query. */
  param: string;
  label: string;
  /** De dónde salen las opciones dentro de la respuesta. */
  from: (data: any) => { value: string; label: string }[];
  /** Texto de la opción vacía. Por defecto "Todos". */
  todos?: string;
};

export type ReportMeta = {
  key: string;
  label: string;
  icon: string;
  dated: boolean;
  group: ReportGroup;
  /** Qué contesta el reporte, en una línea. Se muestra bajo el título y en el índice. */
  desc: string;
  /** Endpoint del backend. Por defecto `/reports/<key>`. */
  endpoint?: string;
  filters?: ReportFilter[];
};

const opciones = (get: (d: any) => any[], value: (x: any) => string, label: (x: any) => string): ReportFilter["from"] =>
  (d: any) => (get(d) ?? []).map((x: any) => ({ value: value(x), label: label(x) }));

export const REPORTS: ReportMeta[] = [
  // ── Gerencia: la plata ────────────────────────────────────────────────────
  // Tendencias va primero: es el único reporte con MEMORIA (lee las fotos diarias
  // de MetricPoint en vez de calcular sobre las tablas vivas), y por tanto el único
  // que contesta "cuántos teníamos y cuántos tenemos".
  { key: "tendencias", label: "Tendencias e histórico", icon: "trending-up", dated: true, group: "gerencia",
    desc: "Evolución de cualquier indicador y comparación contra el periodo anterior",
    filters: [
      { param: "metrica", label: "Indicador", from: opciones((d) => d?.opciones?.metricas, (x) => x.id, (x) => x.nombre) },
      { param: "agrupar", label: "Agrupar", from: () => [{ value: "mes", label: "Por mes" }, { value: "dia", label: "Por día" }] },
      { param: "sede", label: "Sede", from: opciones((d) => d?.opciones?.sedes, (x) => x.id, (x) => x.nombre) },
    ] },
  { key: "facturacion", label: "Resumen de facturación", icon: "receipt", dated: false, group: "gerencia",
    desc: "Cuánto se facturó, cuánto se pagó y cuánta cartera quedó", endpoint: "/billing/stats" },
  { key: "recaudo", label: "Recaudo", icon: "banknote", dated: true, group: "gerencia",
    desc: "Ingresos vigentes por caja y por método de pago",
    filters: [{ param: "sede", label: "Sede", from: opciones((d) => d?.opciones?.sedes, (x) => x.id, (x) => x.nombre) }] },
  { key: "ventas-sede", label: "Ventas por sede", icon: "landmark", dated: true, group: "gerencia",
    desc: "Facturación de cada sede en el periodo" },
  { key: "ingresos-egresos", label: "Ingresos y egresos", icon: "trending-up", dated: false, group: "gerencia",
    desc: "Balance mensual: qué entró, qué salió y qué quedó" },
  { key: "cartera", label: "Cartera / deudores", icon: "alert-triangle", dated: false, group: "gerencia",
    desc: "Los clientes que más deben y cuántas facturas tienen en mora", endpoint: "/reports/top-deudores",
    filters: [{ param: "sede", label: "Sede", from: opciones((d) => d?.opciones?.sedes, (x) => x.id, (x) => x.nombre) }] },
  { key: "cartera-seguimiento", label: "Seguimiento de cartera", icon: "hand-coins", dated: false, group: "gerencia",
    desc: "Cuánto de la cartera del día 1 se recuperó en el mes, qué pasó con cada usuario (se reactivó, se retiró, abonó, no pagó) y si la cartera baja o sube mes a mes",
    filters: [
      { param: "mes", label: "Mes", todos: "Último mes", from: (d) => d?.opciones?.meses ?? [] },
      { param: "sede", label: "Sede", from: opciones((d) => d?.opciones?.sedes, (x) => x.id, (x) => x.nombre) },
    ] },
  { key: "iva", label: "Reporte de IVA", icon: "calculator", dated: true, group: "gerencia",
    desc: "Base gravable, exenta e IVA por documento, para la declaración",
    filters: [
      { param: "tipo", label: "Tipo", from: () => [{ value: "ventas", label: "Ventas" }, { value: "compras", label: "Compras" }] },
      // Solo recorta las VENTAS: una compra es a un proveedor y no tiene sede.
      { param: "sede", label: "Sede", from: opciones((d) => d?.opciones?.sedes, (x) => x.id, (x) => x.nombre) },
    ] },

  // Propios de un ISP: no describen el ERP, describen el negocio de vender internet.
  { key: "indice-recaudo", label: "Índice de recaudo", icon: "percent", dated: true, group: "gerencia",
    desc: "De lo que se factura, cuánto entra de verdad",
    filters: [{ param: "sede", label: "Sede", from: opciones((d) => d?.opciones?.sedes, (x) => x.id, (x) => x.nombre) }] },
  { key: "arpu", label: "ARPU por abonado", icon: "banknote", dated: true, group: "gerencia",
    desc: "Cuánto deja cada cliente al mes, facturado y recaudado",
    filters: [{ param: "sede", label: "Sede", from: opciones((d) => d?.opciones?.sedes, (x) => x.id, (x) => x.nombre) }] },
  { key: "permanencia", label: "Antigüedad y permanencia", icon: "history", dated: false, group: "gerencia",
    desc: "De los que entraron cada año, cuántos siguen",
    filters: [{ param: "sede", label: "Sede", from: opciones((d) => d?.opciones?.sedes, (x) => x.id, (x) => x.nombre) }] },

  // ── Operación: el servicio ────────────────────────────────────────────────
  { key: "capacidad-red", label: "Capacidad de red (NAPs)", icon: "plug", dated: false, group: "operacion",
    desc: "Puertos libres y ocupados por NAP: dónde se puede instalar sin obra",
    filters: [{ param: "sede", label: "Sede", from: opciones((d) => d?.opciones?.sedes, (x) => x.id, (x) => x.nombre) }] },
  { key: "reincidencia", label: "Reincidencia de cortes", icon: "refresh-cw", dated: true, group: "operacion",
    desc: "Clientes que entran en ciclo de corte y reconexión",
    filters: [{ param: "sede", label: "Sede", from: opciones((d) => d?.opciones?.sedes, (x) => x.id, (x) => x.nombre) }] },
  { key: "ordenes", label: "Órdenes de servicio", icon: "headphones", dated: true, group: "operacion",
    desc: "Volumen de órdenes por estado, tipo y técnico asignado",
    // La sede sale del abonado de la orden (la orden no la lleva). Es el recorte que
    // más se pide de viva voz: "las órdenes de Villanueva en junio".
    filters: [{ param: "sede", label: "Sede", from: opciones((d) => d?.opciones?.sedes, (x) => x.id, (x) => x.nombre) }] },
  { key: "cortes-activaciones", label: "Cortes y activaciones", icon: "activity", dated: true, group: "operacion",
    desc: "Cuántos clientes se cortaron, activaron, suspendieron o retiraron",
    filters: [{ param: "sede", label: "Sede", from: opciones((d) => d?.opciones?.sedes, (x) => x.id, (x) => x.nombre) }] },
  { key: "estado-clientes", label: "Estado de clientes", icon: "users", dated: false, group: "operacion",
    desc: "Cómo está repartida la base de clientes por estado y por sede", endpoint: "/reports/estadisticas-servicios" },
  { key: "altas-retiros", label: "Altas y retiros", icon: "arrow-left-right", dated: true, group: "operacion",
    desc: "Clientes nuevos contra clientes que se fueron", endpoint: "/reports/movimientos",
    filters: [{ param: "sede", label: "Sede", from: opciones((d) => d?.opciones?.sedes, (x) => x.id, (x) => x.nombre) }] },

  // ── Personal: la gente ────────────────────────────────────────────────────
  { key: "tecnicos", label: "Rendimiento de técnicos", icon: "hard-hat", dated: true, group: "personal",
    desc: "Re-visita, cumplimiento y carga de cada técnico de campo",
    filters: [
      { param: "sede", label: "Sede", from: opciones((d) => d?.opciones?.sedes, (x) => x.id, (x) => x.nombre) },
      { param: "tipo", label: "Tipo de orden", from: opciones((d) => d?.opciones?.tipos, (x) => x, (x) => x) },
      { param: "prioridad", label: "Prioridad", from: opciones((d) => d?.opciones?.prioridades, (x) => x, (x) => x) },
    ] },
  { key: "recaudo-funcionario", label: "Recaudo por funcionario", icon: "hand-coins", dated: true, group: "personal",
    desc: "Cuánto recaudó cada persona, por caja y método",
    filters: [
      { param: "metodo", label: "Método", from: opciones((d) => d?.porMetodo, (x) => x.metodo, (x) => x.metodo) },
      { param: "caja", label: "Caja", from: opciones((d) => d?.porCaja, (x) => x.caja, (x) => x.caja) },
    ] },
  { key: "afiliados", label: "Afiliados por funcionario", icon: "user-plus", dated: true, group: "personal",
    desc: "Qué clientes quedaron a nombre de cada funcionario en el alta",
    filters: [
      { param: "funcionario", label: "Funcionario", from: opciones((d) => d?.opciones?.funcionarios, (x) => x.id, (x) => x.nombre) },
      { param: "sede", label: "Sede", from: opciones((d) => d?.opciones?.sedes, (x) => x.id, (x) => x.nombre) },
    ] },
  { key: "anulaciones", label: "Anulaciones (control)", icon: "ban", dated: true, group: "personal",
    desc: "Quién anuló qué, por cuánto y cuántos días después del cobro",
    filters: [
      { param: "quien", label: "Funcionario", from: opciones((d) => d?.porQuien, (x) => x.quien, (x) => x.quien) },
      { param: "sede", label: "Sede", from: opciones((d) => d?.opciones?.sedes, (x) => x.id, (x) => x.nombre) },
    ] },
  { key: "actividad", label: "Actividad en el sistema", icon: "history", dated: true, group: "personal",
    desc: "Qué se tocó en el sistema, por quién y en qué módulo",
    filters: [
      { param: "usuario", label: "Usuario", from: opciones((d) => d?.filtros?.usuarios, (x) => x.id, (x) => x.nombre) },
      { param: "modulo", label: "Módulo", from: opciones((d) => d?.filtros?.modulos, (x) => x, (x) => x) },
      { param: "accion", label: "Operación", from: opciones((d) => d?.filtros?.acciones, (x) => x, (x) => x) },
    ] },
];

export const REPORT_GROUPS: { key: ReportGroup; title: string; hint: string }[] = [
  { key: "gerencia", title: "Gerencia", hint: "La plata: facturación, recaudo, cartera e impuestos" },
  { key: "operacion", title: "Operación", hint: "El servicio: órdenes, cortes y estado de la base" },
  { key: "personal", title: "Personal", hint: "La gente: rendimiento, recaudo y control" },
];

/** Ruta de un reporte. Cada uno vive en su propia URL para poder enlazarlo. */
export const reportHref = (key: string) => `/reportes/${key}`;

export const findReport = (key: string) => REPORTS.find((r) => r.key === key);

/** Presets de rango de fecha típicos de gerencia. */
export function datePresets(): { label: string; from: string; to: string }[] {
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  return [
    { label: "Este mes", from: iso(new Date(y, m, 1)), to: iso(new Date(y, m + 1, 0)) },
    { label: "Mes anterior", from: iso(new Date(y, m - 1, 1)), to: iso(new Date(y, m, 0)) },
    { label: "Este año", from: iso(new Date(y, 0, 1)), to: iso(new Date(y, 11, 31)) },
  ];
}

/* ------------------------------------------------------------------ */
/*  Construcción del documento exportable (PDF / Excel) por reporte     */
/* ------------------------------------------------------------------ */
export function buildExportDoc(rep: string, label: string, data: any, from: string, to: string): ReportDoc | null {
  if (!data) return null;
  const periodo = from || to ? `Periodo: ${from || "inicio"} → ${to || "hoy"}` : "Histórico";
  const doc: ReportDoc = { title: `Reporte · ${label}`, subtitle: periodo, tables: [] };

  switch (rep) {
    case "facturacion":
      doc.tables.push({
        columns: [{ label: "Indicador" }, { label: "Valor", align: "right", money: false }],
        rows: [
          { cells: ["Facturas emitidas", data.total ?? 0] },
          { cells: ["Total facturado", data.facturadoTotal ?? 0], bold: true },
          { cells: ["Facturas pagadas", data.pagadas ?? 0] },
          { cells: ["Cartera pendiente", data.carteraTotal ?? 0] },
          { cells: ["Facturas en mora", data.carteraFacturas ?? 0] },
        ],
      });
      break;
    case "recaudo":
      doc.tables.push({
        heading: "Por caja",
        columns: [{ label: "Caja" }, { label: "Mov.", align: "right" }, { label: "Total", align: "right", money: true }],
        rows: (data.porCaja ?? []).map((r: any) => ({ cells: [r.caja, r.count, r.total] })),
      });
      doc.tables.push({
        heading: "Por método",
        columns: [{ label: "Método" }, { label: "Mov.", align: "right" }, { label: "Total", align: "right", money: true }],
        rows: (data.porMetodo ?? []).map((r: any) => ({ cells: [r.metodo, r.count, r.total] })),
      });
      break;
    case "ventas-sede":
      doc.tables.push({
        columns: [{ label: "Sede" }, { label: "Facturas", align: "right" }, { label: "Total facturado", align: "right", money: true }],
        rows: (data.items ?? []).map((r: any) => ({ cells: [r.sede, r.facturas, r.total] })),
      });
      break;
    case "ingresos-egresos":
      doc.tables.push({
        columns: [
          { label: "Mes" },
          { label: "Ingresos", align: "right", money: true },
          { label: "Egresos", align: "right", money: true },
          { label: "Balance", align: "right", money: true },
        ],
        rows: (data.items ?? []).map((r: any) => ({ cells: [monthLabel(r.month), r.income, r.expense, r.balance] })),
      });
      break;
    case "ordenes":
      doc.tables.push({
        heading: "Por estado",
        columns: [{ label: "Estado" }, { label: "Cantidad", align: "right" }],
        rows: (data.porEstado ?? []).map((r: any) => ({ cells: [r.estado, r.count] })),
      });
      doc.tables.push({
        heading: "Por tipo",
        columns: [{ label: "Tipo" }, { label: "Cantidad", align: "right" }],
        rows: (data.porTipo ?? []).map((r: any) => ({ cells: [r.tipo, r.count] })),
      });
      doc.tables.push({
        heading: "Por técnico",
        columns: [{ label: "Técnico" }, { label: "Cantidad", align: "right" }],
        rows: (data.porTecnico ?? []).map((r: any) => ({ cells: [r.tecnico, r.count] })),
      });
      break;
    case "tecnicos": {
      const eq = data.equipo;
      doc.subtitle = `${periodo} · solo trabajo de campo${eq ? ` · re-visita del equipo ${eq.revisitaPct ?? "—"}%` : ""}`;
      doc.tables.push({
        heading: "Rendimiento por técnico",
        columns: [
          { label: "Técnico" },
          { label: "Cerradas", align: "right" },
          { label: "Puntos", align: "right" },
          { label: "Puntaje medio", align: "right" },
          { label: "Sin cerrar", align: "right" },
          { label: "Antigüedad (días)", align: "right" },
          { label: "Re-visitas", align: "right" },
          { label: "Re-visita %", align: "right" },
          { label: "Con firma %", align: "right" },
          { label: "Con foto %", align: "right" },
          { label: "Ciclo (h)", align: "right" },
        ],
        rows: (data.tecnicos ?? []).map((r: any) => ({
          cells: [
            `${r.nombre}${r.muestraSuficiente ? "" : " (muestra baja)"}`,
            r.cerradas, r.puntos ?? 0, r.puntajePromedio ?? "—",
            r.abiertas, r.antiguedadDias ?? "—", r.revisitas,
            r.revisitaPct ?? "—", r.firmaPct ?? "—", r.evidenciaPct ?? "—", r.cicloHoras ?? "—",
          ],
        })),
      });
      if (eq) {
        doc.tables.push({
          heading: "Referencia del equipo",
          columns: [{ label: "Indicador" }, { label: "Valor", align: "right" }],
          rows: [
            { cells: ["Órdenes de campo cerradas", eq.cerradas] },
            { cells: ["Puntos repartidos", eq.puntos ?? 0] },
            { cells: ["Mediana de puntos por técnico", eq.medianaPuntos ?? "—"] },
            { cells: ["Clientes que volvieron a llamar", eq.revisitas] },
            { cells: ["Re-visita del equipo (%)", eq.revisitaPct ?? "—"], bold: true },
            { cells: ["Mediana por técnico (%)", eq.medianaRevisita ?? "—"] },
            { cells: ["Técnicos medidos", eq.tecnicos] },
            { cells: [`Con al menos ${eq.muestraMinima} órdenes cerradas`, eq.conMuestra] },
            { cells: ["Órdenes de campo sin técnico asignado", data.sinAtribuir ?? 0] },
          ],
        });
      }
      break;
    }
    case "recaudo-funcionario":
      doc.tables.push({
        heading: "Recaudo por funcionario",
        columns: [
          { label: "Funcionario" },
          { label: "Movimientos", align: "right" },
          { label: "Total recaudado", align: "right", money: true },
          { label: "Promedio", align: "right", money: true },
          { label: "Participación %", align: "right" },
        ],
        rows: [
          ...(data.funcionarios ?? []).map((r: any) => ({
            cells: [r.nombre, r.movimientos, r.total, r.promedio, r.participacion],
          })),
          { cells: ["TOTAL", data.movimientos ?? 0, data.total ?? 0, "", 100], bold: true },
        ],
      });
      doc.tables.push({
        heading: "Por caja",
        columns: [{ label: "Caja" }, { label: "Movimientos", align: "right" }, { label: "Total", align: "right", money: true }],
        rows: (data.porCaja ?? []).map((r: any) => ({ cells: [r.caja, r.movimientos, r.total] })),
      });
      break;
    case "afiliados":
      doc.subtitle = `${periodo} · ${data.total ?? 0} clientes afiliados`;
      doc.tables.push({
        heading: "Por funcionario",
        columns: [
          { label: "Funcionario" },
          { label: "Código" },
          { label: "Clientes", align: "right" },
          { label: "Activos hoy", align: "right" },
        ],
        rows: [
          ...(data.funcionarios ?? []).map((r: any) => ({ cells: [r.nombre, r.codigo ?? "—", r.clientes, r.activos] })),
          { cells: ["TOTAL", "", data.total ?? 0, data.activos ?? 0], bold: true },
        ],
      });
      doc.tables.push({
        heading: "Clientes",
        columns: [
          { label: "Fecha y hora del alta" },
          { label: "Abonado", align: "right" },
          { label: "Cliente" },
          { label: "Documento" },
          { label: "Sede" },
          { label: "Estado" },
          { label: "Funcionario" },
          { label: "Código" },
          { label: "Registró el alta" },
        ],
        rows: (data.clientes ?? []).map((r: any) => ({
          cells: [
            new Date(r.fecha).toLocaleString("es-CO", { timeZone: "America/Bogota", dateStyle: "short", timeStyle: "short" }),
            r.abonado, r.nombre ?? "—", r.documento ?? "—", r.sede ?? "—", r.estado ?? "—",
            r.funcionario ?? "—", r.codigo ?? "—", r.registradoPor ?? "—",
          ],
        })),
      });
      break;
    case "anulaciones":
      doc.subtitle = `${periodo} · ${data.total ?? 0} anulaciones (${data.tasaPct ?? 0}% de ${data.movimientosPeriodo ?? 0} movimientos)`;
      doc.tables.push({
        heading: "Por funcionario",
        columns: [
          { label: "Funcionario" },
          { label: "Anulaciones", align: "right" },
          { label: "Monto", align: "right", money: true },
          { label: "La más tardía (días)", align: "right" },
        ],
        rows: (data.porQuien ?? []).map((r: any) => ({ cells: [r.quien, r.n, r.monto, r.maxDias] })),
      });
      doc.tables.push({
        heading: "Detalle de anulaciones",
        columns: [
          { label: "Anulada el" },
          { label: "Quién" },
          { label: "Monto", align: "right", money: true },
          { label: "Días después", align: "right" },
          { label: "Cliente" },
          { label: "Caja" },
          { label: "Motivo" },
        ],
        rows: (data.casos ?? []).map((r: any) => ({
          cells: [
            new Date(r.fecha).toLocaleDateString("es-CO"),
            r.quien, r.monto, r.diasDespues ?? "—",
            r.cliente?.nombre ?? r.pagador ?? "—",
            r.caja ?? "—", r.motivo || r.detalle || "—",
          ],
        })),
      });
      break;
    case "actividad":
      doc.subtitle = `${periodo} · ${data.total ?? 0} eventos · la bitácora NO cubre todas las operaciones`;
      doc.tables.push({
        heading: "Por usuario",
        columns: [{ label: "Usuario" }, { label: "Eventos", align: "right" }],
        rows: (data.porUsuario ?? []).map((r: any) => ({ cells: [r.nombre, r.eventos] })),
      });
      doc.tables.push({
        heading: "Por módulo",
        columns: [{ label: "Módulo" }, { label: "Eventos", align: "right" }],
        rows: (data.porModulo ?? []).map((r: any) => ({ cells: [r.modulo, r.eventos] })),
      });
      doc.tables.push({
        heading: "Últimos eventos",
        columns: [{ label: "Cuándo" }, { label: "Quién" }, { label: "Módulo" }, { label: "Operación" }, { label: "IP" }],
        rows: (data.eventos ?? []).map((r: any) => ({
          cells: [new Date(r.fecha).toLocaleString("es-CO"), r.usuario, r.modulo, r.operacion, r.ip ?? "—"],
        })),
      });
      break;
    case "estado-clientes":
      doc.tables.push({
        heading: "Base por sede",
        columns: [
          { label: "Sede" },
          { label: "Total", align: "right" },
          { label: "Activos", align: "right" },
          { label: "Cortados", align: "right" },
          { label: "Cartera", align: "right" },
        ],
        rows: (data.porSede ?? []).map((r: any) => ({ cells: [r.sede, r.total, r.activos, r.cortados, r.cartera] })),
      });
      break;
    case "cortes-activaciones":
      doc.tables.push({
        columns: [{ label: "Evento" }, { label: "Cantidad", align: "right" }],
        rows: [
          { cells: ["Activaciones", data.activaciones ?? 0] },
          { cells: ["Cortes", data.cortes ?? 0] },
          { cells: ["Suspensiones", data.suspensiones ?? 0] },
          { cells: ["Retiros", data.retiros ?? 0] },
        ],
      });
      break;
    case "altas-retiros":
      doc.tables.push({
        columns: [{ label: "Movimiento" }, { label: "Cantidad", align: "right" }],
        rows: [
          { cells: ["Altas (nuevos)", data.altas ?? 0] },
          { cells: ["Retiros", data.retiros ?? 0] },
          { cells: ["Neto", data.neto ?? 0], bold: true },
        ],
      });
      break;
    case "cartera":
      doc.tables.push({
        columns: [
          { label: "Abonado" },
          { label: "Cliente" },
          { label: "Facturas", align: "right" },
          { label: "Deuda", align: "right", money: true },
        ],
        rows: (data.items ?? []).map((r: any) => ({ cells: [r.abonado, r.name, r.facturas, r.balance] })),
      });
      break;
    case "cartera-seguimiento": {
      const r = data.resumen;
      if (!r) break;
      const etiqueta: Record<string, string> = Object.fromEntries((data.categorias ?? []).map((c: any) => [c.key, c.label]));
      doc.subtitle = `${data.mesLabel}${data.sede ? ` · ${data.sede}` : ""}${data.abierto ? ` · en curso, cifras al ${data.corteAl}` : " · cerrado"}`;
      doc.tables.push({
        heading: "Balance del mes",
        columns: [{ label: "Concepto" }, { label: "Valor", align: "right", money: true }],
        rows: [
          { cells: ["Cartera inicial", r.carteraInicial] },
          { cells: ["− Pagaron y se reactivaron", -r.recuperadoActivados] },
          { cells: ["− Pagaron, pero siguen cortados", -r.recuperadoSinActivar] },
          { cells: ["− Pagaron y se retiraron", -r.recuperadoRetirados] },
          { cells: ["− Abonaron una parte", -r.recuperadoParciales] },
          { cells: ["Valor recuperado en el mes", r.recuperado], bold: true },
          { cells: ["= Deuda vieja que sigue sin pagar", r.deudaViejaPendiente] },
          { cells: ["+ Facturas nuevas del mes sin pagar (menos notas y depuraciones)", r.otrosMovimientos] },
          { cells: [data.abierto ? "= Cartera pendiente hoy" : "= Cartera pendiente al cierre", r.carteraFinal], bold: true },
          { cells: ["Diferencia (inicial − final)", r.diferencia], bold: true },
        ],
      });
      doc.tables.push({
        heading: "Usuarios",
        columns: [{ label: "Resultado" }, { label: "Usuarios", align: "right" }, { label: "Recuperado", align: "right", money: true }, { label: "Deuda vieja pendiente", align: "right", money: true }, { label: "Pendiente total", align: "right", money: true }],
        rows: [
          ...(data.categorias ?? []).map((c: any) => ({ cells: [c.label, c.usuarios, c.recuperado, c.deudaVieja, c.deudaFinal] })),
          { cells: ["Total (pagaron: " + r.usuariosPagaron + ")", r.usuariosInicial, r.recuperado, r.deudaViejaPendiente, r.carteraFinal], bold: true },
        ],
      });
      doc.tables.push({
        heading: "Detalle por usuario",
        columns: [
          { label: "Abonado" }, { label: "Cliente" }, { label: "Sede" }, { label: "Resultado" }, { label: "Estado" },
          { label: "Debía el día 1", align: "right", money: true }, { label: "Pagó en el mes", align: "right", money: true },
          { label: "Queda de lo viejo", align: "right", money: true }, { label: "Factura nueva", align: "right", money: true },
          { label: "Pendiente total", align: "right", money: true },
        ],
        rows: (data.items ?? []).map((x: any) => ({
          cells: [x.abonado, x.nombre, x.sede, etiqueta[x.categoria] ?? x.categoria, x.estadoFinal ?? "", x.deudaInicial, x.pagado, x.deudaVieja, x.deudaNueva, x.deudaFinal],
        })),
      });
      doc.tables.push({
        heading: "Mes a mes",
        columns: [
          { label: "Mes" }, { label: "Cartera inicial", align: "right", money: true }, { label: "Recuperado", align: "right", money: true },
          { label: "Pagaron", align: "right" }, { label: "Cartera final", align: "right", money: true }, { label: "Diferencia", align: "right", money: true },
        ],
        rows: (data.comparativo ?? []).map((m: any) => ({
          cells: [m.label + (m.abierto ? " (en curso)" : ""), m.carteraInicial, m.recuperado, m.usuariosPagaron, m.carteraFinal, m.diferencia],
        })),
      });
      break;
    }
    case "iva": {
      const t = data.totales ?? {};
      doc.subtitle = `${periodo} · ${data.tipo === "compras" ? "Compras" : "Ventas"}`;
      doc.tables.push({
        heading: "Resumen por tarifa",
        columns: [
          { label: "Tarifa" },
          { label: "Documentos", align: "right" },
          { label: "Base", align: "right", money: true },
          { label: "IVA", align: "right", money: true },
        ],
        rows: (data.porTarifa ?? []).map((r: any) => ({
          cells: [r.tarifa === 0 ? "Exento (0%)" : `${r.tarifa}%`, r.documentos, r.base, r.iva],
        })),
      });
      doc.tables.push({
        heading: "Detalle por documento",
        columns: [
          { label: "Fecha" },
          { label: "Documento" },
          { label: "Tercero" },
          { label: "NIT / Documento" },
          { label: "Base gravable", align: "right", money: true },
          { label: "Base exenta", align: "right", money: true },
          { label: "Notas/ajustes", align: "right", money: true },
          { label: "IVA", align: "right", money: true },
          { label: "Total", align: "right", money: true },
        ],
        rows: [
          ...(data.items ?? []).map((r: any) => ({
            cells: [
              new Date(r.fecha).toLocaleDateString("es-CO"), r.numero, r.tercero, r.documento ?? "—",
              r.baseGravable, r.baseExenta, r.ajustes, r.iva, r.total,
            ],
          })),
          {
            cells: ["", "", "TOTALES", "", t.baseGravable ?? 0, t.baseExenta ?? 0, t.ajustes ?? 0, t.iva ?? 0, t.total ?? 0],
            bold: true,
          },
        ],
      });
      break;
    }
    default:
      return null;
  }
  return doc;
}
