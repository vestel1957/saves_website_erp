import { ChartCard, TrendStat } from "@/components/charts";
import { DataTable } from "@/components/ui/DataTable";
import { cop } from "@/lib/subscribers";
import { nfmt } from "@/lib/reportes";
import { Section } from "./Section";

/**
 * Reporte de IVA. A diferencia del legacy, discrimina base gravable / exenta / IVA por
 * tarifa, aísla las notas y excluye los documentos anulados (el legacy los sumaba).
 */
export function ReporteIva({ data }: { data: any }) {
  const t = data.totales ?? {};
  return (
    <>
      <Section>
        <TrendStat icon="calculator" label="Base gravable" value={cop(t.baseGravable ?? 0)} />
        <TrendStat icon="receipt" label="IVA" value={cop(t.iva ?? 0)} />
        <TrendStat icon="file-text" label="Base exenta" value={cop(t.baseExenta ?? 0)} />
        <TrendStat icon="boxes" label="Documentos" value={nfmt(t.documentos ?? 0)} />
      </Section>

      <ChartCard title="Base e IVA por tarifa" subtitle="Los exentos (0%) se muestran aparte, no mezclados con los gravados">
        <DataTable
          rows={data.porTarifa ?? []}
          empty="Sin documentos en el periodo."
          columns={[
            { key: "tarifa", header: "Tarifa", render: (r: any) => (r.tarifa === 0 ? "Exento (0%)" : `${r.tarifa}%`) },
            { key: "documentos", header: "Documentos", render: (r: any) => nfmt(r.documentos) },
            { key: "base", header: "Base", render: (r: any) => cop(r.base) },
            { key: "iva", header: "IVA", render: (r: any) => cop(r.iva) },
          ]}
        />
      </ChartCard>

      <ChartCard title="Detalle por documento" subtitle="No incluye documentos anulados">
        <DataTable
          rows={data.items ?? []}
          empty="Sin documentos en el periodo."
          columns={[
            { key: "fecha", header: "Fecha", render: (r: any) => new Date(r.fecha).toLocaleDateString("es-CO") },
            { key: "numero", header: "Documento", render: (r: any) => `#${r.numero}` },
            { key: "tercero", header: "Tercero", render: (r: any) => r.tercero },
            { key: "documento", header: "NIT / Documento", render: (r: any) => r.documento ?? "—" },
            { key: "baseGravable", header: "Base gravable", render: (r: any) => cop(r.baseGravable) },
            { key: "baseExenta", header: "Base exenta", render: (r: any) => cop(r.baseExenta) },
            { key: "ajustes", header: "Notas/ajustes", render: (r: any) => (r.ajustes ? cop(r.ajustes) : "—") },
            { key: "iva", header: "IVA", render: (r: any) => cop(r.iva) },
            { key: "total", header: "Total", render: (r: any) => cop(r.total) },
            { key: "retencionTipo", header: "Retención", render: (r: any) => r.retencionTipo ?? "—" },
          ]}
        />
      </ChartCard>
    </>
  );
}
