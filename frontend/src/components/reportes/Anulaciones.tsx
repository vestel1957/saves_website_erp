import Link from "next/link";
import { ChartCard, HBarList, TrendStat, compactCOP } from "@/components/charts";
import { DataTable } from "@/components/ui/DataTable";
import { Icon } from "@/components/Icon";
import { cop } from "@/lib/subscribers";
import { nfmt } from "@/lib/reportes";
import { Section } from "./Section";

/**
 * Días entre el cobro y su anulación. Es la columna que importa: anular algo del
 * mismo día es corregir un error de digitación; anular un recibo de hace dos
 * meses es otra conversación.
 */
function Dias({ n }: { n: number | null }) {
  if (n == null) return <span className="text-text-tertiary">—</span>;
  if (n <= 0) return <span className="text-text-secondary">mismo día</span>;
  const tono = n > 30 ? "text-error-text font-semibold" : n > 7 ? "text-warning-text font-semibold" : "text-text-secondary";
  return <span className={tono}>{n} {n === 1 ? "día" : "días"}</span>;
}

export function Anulaciones({ data }: { data: any }) {
  const casos = data.casos ?? [];
  const porQuien = data.porQuien ?? [];
  const tardias = data.tardias ?? { total: 0, monto: 0 };

  return (
    <>
      <Section>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <TrendStat label="Anulaciones" value={nfmt(data.total ?? 0)} icon="ban"
            hint={`${data.tasaPct ?? 0}% de ${nfmt(data.movimientosPeriodo ?? 0)} movimientos`}
            tone={(data.tasaPct ?? 0) > 3 ? "error" : (data.tasaPct ?? 0) > 1 ? "warning" : "default"} />
          <TrendStat label="Monto anulado" value={cop(data.monto ?? 0)} icon="banknote" tone="warning" />
          <TrendStat label="Anuladas tarde" value={nfmt(tardias.total)} icon="hourglass"
            tone={tardias.total > 0 ? "warning" : "success"}
            hint={tardias.total ? `${cop(tardias.monto)} · más de 7 días después del cobro` : "Ninguna pasó de 7 días"} />
          <TrendStat label="Funcionarios que anulan" value={nfmt(porQuien.length)} icon="contact" />
        </div>
      </Section>

      {/* Contexto antes que la tabla: sin la tasa, "62 anulaciones" no dice si
          está bien o mal. */}
      <div className="rounded-xl border border-border-subtle bg-surface-2 p-3 text-[12px] leading-relaxed text-text-secondary">
        <div className="mb-1 flex items-center gap-1.5 font-semibold text-text-primary">
          <Icon name="info" size={14} className="text-brand" /> Cómo leer esto
        </div>
        Anular es una operación normal: corrige un cobro mal registrado. Lo que se vigila no es la
        cantidad sino <strong>cuánto tiempo después</strong> se anula y <strong>por cuánta plata</strong>.
        Una anulación del mismo día es rutina; una de un recibo con semanas encima merece una mirada, y
        por eso salen marcadas en la tabla.
      </div>

      {porQuien.length > 0 && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <ChartCard title="Monto anulado por funcionario" icon="contact">
            <HBarList monochrome accent="var(--color-warning)" valueFormat={compactCOP}
              rows={porQuien.map((q: any) => ({ label: q.quien, value: q.monto, hint: `${nfmt(q.n)} anulaciones` }))} />
          </ChartCard>
          <ChartCard title="Detalle por funcionario" icon="list">
            <DataTable rows={porQuien} empty="Sin anulaciones." columns={[
              { key: "q", header: "Funcionario", render: (r: any) => <span className="font-medium text-text-primary">{r.quien}</span> },
              { key: "n", header: "Anulaciones", align: "right", render: (r: any) => nfmt(r.n) },
              { key: "m", header: "Monto", align: "right", render: (r: any) => cop(r.monto) },
              { key: "d", header: "La más tardía", align: "right", render: (r: any) => <Dias n={r.maxDias} /> },
            ]} />
          </ChartCard>
        </div>
      )}

      <ChartCard title="Anulaciones del periodo" subtitle="Ordenadas de la más reciente" icon="list-tree">
        <DataTable rows={casos} empty="No hubo anulaciones en este periodo." columns={[
          { key: "f", header: "Anulada el", render: (r: any) => new Date(r.fecha).toLocaleDateString("es-CO") },
          { key: "q", header: "Quién", render: (r: any) => <span className="font-medium text-text-primary">{r.quien}</span> },
          { key: "m", header: "Monto", align: "right", render: (r: any) => <span className="font-semibold text-warning-text">{cop(r.monto)}</span> },
          { key: "d", header: "Después de", align: "right", render: (r: any) => <Dias n={r.diasDespues} /> },
          { key: "c", header: "Cliente", render: (r: any) => r.cliente
            ? <Link href={`/clientes/${r.cliente.id}`} className="text-brand hover:underline">{r.cliente.nombre ?? `Abonado ${r.cliente.abonado}`}</Link>
            : <span className="text-text-tertiary">{r.pagador ?? "—"}</span> },
          { key: "caja", header: "Caja", render: (r: any) => r.caja ?? "—" },
          { key: "r", header: "Motivo", render: (r: any) => <span className="text-text-secondary">{r.motivo || r.detalle || "—"}</span> },
        ]} />
      </ChartCard>
    </>
  );
}
