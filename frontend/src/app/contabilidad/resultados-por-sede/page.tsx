"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { PageHeading } from "@/components/ui/PageHeading";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { RangoFechas, rangoDePreset, etiquetaRango, type RangoFechasValor } from "@/components/ui/RangoFechas";
import { ExportMenu } from "@/components/reportes/ExportMenu";
import { Icon } from "@/components/Icon";
import { useAuth } from "@/context/AuthProvider";
import { accountingApi } from "@/lib/accounting";
import type { IncomeByCenterRow, IncomeStatementByCenter, IncomeStatementTotals } from "@/lib/accounting-types";
import type { ReportDoc, ReportRow } from "@/lib/report-export";
import { fullCurrency } from "@/lib/format";

/**
 * Estado de resultados POR SEDE (contabilidad de gestión, docs/centros-de-costo/PLAN.md).
 *
 * Filas: las cuentas de ingreso, costo y gasto. Columnas: cada sede, «Administración
 * general» (lo compartido, que todavía no se reparte), los demás centros con movimiento,
 * «Sin asignar» (lo que no se pudo atribuir a una sede sin adivinar) y el total.
 *
 * El backend comprueba que las columnas sumen el estado de resultados total; si algún día
 * no cuadra, se avisa arriba en rojo en vez de enseñar cifras que no suman.
 */

type Seccion = { key: "income" | "costs" | "expenses"; titulo: string; total: keyof IncomeStatementTotals };

const SECCIONES: Seccion[] = [
  { key: "income", titulo: "Ingresos", total: "totalIncome" },
  { key: "costs", titulo: "Costos", total: "totalCosts" },
  { key: "expenses", titulo: "Gastos", total: "totalExpenses" },
];

/** Totales que se pintan después de cada sección (la utilidad bruta tras los costos). */
const TRAS: Partial<Record<Seccion["key"], { campo: keyof IncomeStatementTotals; label: string }>> = {
  costs: { campo: "grossProfit", label: "Utilidad bruta" },
  expenses: { campo: "netIncome", label: "Utilidad neta" },
};

const cifra = (n: number | undefined) => (n ? fullCurrency(n) : "—");

export default function ResultadosPorSedePage() {
  const { authFetch } = useAuth();
  const api = useMemo(() => accountingApi(authFetch), [authFetch]);
  const [rango, setRango] = useState<RangoFechasValor>(() => rangoDePreset("mes"));
  const [data, setData] = useState<IncomeStatementByCenter | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    api
      .getIncomeStatementByCenter({ from: rango.desde, to: rango.hasta })
      .then((d) => { if (alive) setData(d); })
      .catch((e: Error) => { if (alive) { setData(null); setError(e.message); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [api, rango.desde, rango.hasta]);

  const doc = useMemo<ReportDoc | null>(() => (data ? documento(data, etiquetaRango(rango)) : null), [data, rango]);

  const columnas = data?.columns ?? [];
  const sinAsignar = data?.totalsByColumn.SIN_ASIGNAR;
  const haySinAsignar = !!sinAsignar && (sinAsignar.totalIncome !== 0 || sinAsignar.totalCosts !== 0 || sinAsignar.totalExpenses !== 0);

  return (
    <div className="flex flex-col gap-4">
      <PageHeading
        icon="bar-chart-3"
        title="Resultados por sede"
        subtitle="Estado de resultados repartido por centro de costo: cada sede, Administración general y lo sin asignar"
      />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <RangoFechas value={rango} onChange={setRango} />
        <ExportMenu doc={doc} />
      </div>

      {loading && !data ? (
        <PageSkeleton />
      ) : error ? (
        <div className="rounded-xl border border-error-subtle bg-error-soft p-3 text-[13px] text-error-text">{error}</div>
      ) : data ? (
        <>
          {!data.cuadre.ok && (
            <div className="flex items-start gap-2 rounded-xl border border-error-subtle bg-error-soft p-3 text-[12.5px] text-error-text">
              <Icon name="alert-triangle" size={15} className="mt-0.5 shrink-0" />
              <div>
                Las columnas NO suman el estado de resultados total. No use estas cifras y avise a sistemas.
                <ul className="mt-1 font-mono text-[11.5px]">
                  {data.cuadre.detalle.filter((d) => !d.ok).map((d) => (
                    <li key={d.campo}>
                      {d.campo}: columnas {fullCurrency(d.columnas)} · total {fullCurrency(d.total)} · estado de resultados {fullCurrency(d.estadoDeResultados)}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          {haySinAsignar && (
            <div className="flex items-start gap-2 rounded-xl border border-warning-subtle bg-warning-soft p-3 text-[12.5px] text-warning-text">
              <Icon name="info" size={15} className="mt-0.5 shrink-0" />
              «Sin asignar» son asientos cuya sede no se pudo saber sin adivinar (p. ej. facturas que ya no
              existen o cajas sin sede). No se reparten: se enseñan aparte para que el total cuadre.
            </div>
          )}

          <div className={`shrink-0 overflow-x-auto rounded-xl border border-border-subtle bg-surface ${loading ? "opacity-60" : ""}`}>
            <table className="w-full min-w-max text-[12.5px]">
              <thead>
                <tr className="border-b border-border-subtle bg-surface-2 text-[11px] font-bold uppercase tracking-wider text-text-secondary">
                  <th className="sticky left-0 z-10 bg-surface-2 px-3 py-2.5 text-left">Cuenta</th>
                  {columnas.map((c) => (
                    <th
                      key={c.key}
                      className={`px-3 py-2.5 text-right ${c.kind === "SIN_ASIGNAR" ? "text-warning-text" : ""}`}
                      title={c.code ? `${c.code}${c.isActive ? "" : " (inactivo)"}` : undefined}
                    >
                      {c.name}
                    </th>
                  ))}
                  <th className="px-3 py-2.5 text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {SECCIONES.map((s) => (
                  <Fragment key={s.key}>
                    <tr className="border-b border-border-subtle">
                      <td colSpan={columnas.length + 2} className="sticky left-0 bg-surface px-3 pb-1 pt-3 text-[11px] font-bold uppercase tracking-wider text-text-tertiary">
                        {s.titulo}
                      </td>
                    </tr>
                    {data[s.key].length === 0 && (
                      <tr className="border-b border-border-subtle">
                        <td colSpan={columnas.length + 2} className="px-3 py-2 text-text-tertiary">Sin movimientos</td>
                      </tr>
                    )}
                    {data[s.key].map((f) => (
                      <FilaCuenta key={f.accountId} fila={f} columnas={columnas.map((c) => c.key)} />
                    ))}
                    <FilaTotal
                      label={`Total ${s.titulo.toLowerCase()}`}
                      columnas={columnas.map((c) => c.key)}
                      valores={data.totalsByColumn}
                      campo={s.total}
                      total={data.totals[s.total]}
                    />
                    {TRAS[s.key] && (
                      <FilaTotal
                        label={TRAS[s.key]!.label}
                        columnas={columnas.map((c) => c.key)}
                        valores={data.totalsByColumn}
                        campo={TRAS[s.key]!.campo}
                        total={data.totals[TRAS[s.key]!.campo]}
                        fuerte
                      />
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[11.5px] text-text-tertiary">
            Sin asientos de cierre de mes. Un centro que agrupa a otros suma lo de sus hijos en la columna de su sede.
            {data.cuadre.ok && " Las columnas suman el estado de resultados total."}
          </p>
        </>
      ) : null}
    </div>
  );
}

function FilaCuenta({ fila, columnas }: { fila: IncomeByCenterRow; columnas: string[] }) {
  return (
    <tr className="border-b border-border-subtle hover:bg-surface-2">
      <td className="sticky left-0 bg-surface px-3 py-2 text-text-secondary">
        <span className="mr-2 font-mono text-[11px] text-text-tertiary">{fila.code}</span>
        {fila.name}
      </td>
      {columnas.map((k) => (
        <td key={k} className="px-3 py-2 text-right font-mono text-text-primary">{cifra(fila.amounts[k])}</td>
      ))}
      <td className="px-3 py-2 text-right font-mono font-semibold text-text-primary">{cifra(fila.total)}</td>
    </tr>
  );
}

function FilaTotal({ label, columnas, valores, campo, total, fuerte = false }: {
  label: string;
  columnas: string[];
  valores: Record<string, IncomeStatementTotals>;
  campo: keyof IncomeStatementTotals;
  total: number;
  fuerte?: boolean;
}) {
  const color = (n: number) => (fuerte && n < 0 ? "text-error-text" : "text-text-primary");
  return (
    <tr className={`border-b border-border-subtle ${fuerte ? "bg-surface-2" : ""}`}>
      <td className={`sticky left-0 px-3 py-2 font-semibold text-text-primary ${fuerte ? "bg-surface-2" : "bg-surface"}`}>{label}</td>
      {columnas.map((k) => (
        <td key={k} className={`px-3 py-2 text-right font-mono font-semibold ${color(valores[k]?.[campo] ?? 0)}`}>
          {cifra(valores[k]?.[campo])}
        </td>
      ))}
      <td className={`px-3 py-2 text-right font-mono font-bold ${color(total)}`}>{cifra(total)}</td>
    </tr>
  );
}

/** El mismo cuadro, para Excel / PDF. */
function documento(d: IncomeStatementByCenter, periodo: string): ReportDoc {
  const keys = d.columns.map((c) => c.key);
  const columns = [
    { label: "Cuenta" },
    ...d.columns.map((c) => ({ label: c.name, align: "right" as const, money: true })),
    { label: "Total", align: "right" as const, money: true },
  ];
  const rows: ReportRow[] = [];
  const total = (label: string, campo: keyof IncomeStatementTotals) =>
    rows.push({ bold: true, cells: [label, ...keys.map((k) => d.totalsByColumn[k]?.[campo] ?? 0), d.totals[campo]] });
  for (const s of SECCIONES) {
    rows.push({ bold: true, cells: [s.titulo.toUpperCase(), ...keys.map(() => ""), ""] });
    for (const f of d[s.key]) rows.push({ cells: [`${f.code} ${f.name}`, ...keys.map((k) => f.amounts[k] ?? 0), f.total] });
    total(`Total ${s.titulo.toLowerCase()}`, s.total);
    const tras = TRAS[s.key];
    if (tras) total(tras.label, tras.campo);
  }
  return { title: "Resultados por sede", subtitle: periodo, tables: [{ columns, rows }] };
}
