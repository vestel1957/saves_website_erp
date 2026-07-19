import type { ReportDoc } from "./report-export";

export const nfmt = (n: number) => (n ?? 0).toLocaleString("es-CO");

export const MONTHS = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];

export const monthLabel = (m: string) => {
  const [y, mm] = (m || "-").split("-");
  return `${MONTHS[Number(mm) - 1] ?? mm} ${(y || "").slice(2)}`;
};

export const REPORTS: { key: string; label: string; icon: string; dated: boolean; endpoint?: string }[] = [
  { key: "facturacion", label: "Resumen de facturación", icon: "receipt", dated: false, endpoint: "/billing/stats" },
  { key: "recaudo", label: "Recaudo", icon: "banknote", dated: true },
  { key: "ventas-sede", label: "Ventas por sede", icon: "receipt", dated: true },
  { key: "ingresos-egresos", label: "Ingresos y egresos", icon: "trending-up", dated: false },
  { key: "ordenes", label: "Órdenes de servicio", icon: "headphones", dated: true },
  { key: "top-deudores", label: "Cartera / deudores", icon: "alert-triangle", dated: false },
  { key: "estadisticas-servicios", label: "Estado de clientes", icon: "users", dated: false },
  { key: "cortes-activaciones", label: "Cortes y activaciones", icon: "activity", dated: true },
  { key: "movimientos", label: "Altas y retiros", icon: "trending-up", dated: true },
  { key: "iva", label: "Reporte de IVA", icon: "calculator", dated: true },
];

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
    case "estadisticas-servicios":
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
    case "movimientos":
      doc.tables.push({
        columns: [{ label: "Movimiento" }, { label: "Cantidad", align: "right" }],
        rows: [
          { cells: ["Altas (nuevos)", data.altas ?? 0] },
          { cells: ["Retiros", data.retiros ?? 0] },
          { cells: ["Neto", data.neto ?? 0], bold: true },
        ],
      });
      break;
    case "top-deudores":
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
