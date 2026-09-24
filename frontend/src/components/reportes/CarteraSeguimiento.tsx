"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ChartCard } from "@/components/charts";
import { DataTable } from "@/components/ui/DataTable";
import { Icon } from "@/components/Icon";
import { cop, SUB_STATUS_LABEL } from "@/lib/subscribers";
import { fmtDate } from "@/lib/format";
import { nfmt } from "@/lib/reportes";

/** Color de cada categoría: el mismo en las cuentas, las tarjetas, las pastillas y la tabla. */
const TONO: Record<string, { chip: string; texto: string; punto: string }> = {
  ACTIVADO: { chip: "bg-success-soft text-success-text", texto: "text-success-text", punto: "bg-success" },
  RETIRADO: { chip: "bg-surface-2 text-text-secondary", texto: "text-text-secondary", punto: "bg-text-tertiary" },
  PARCIAL: { chip: "bg-warning-soft text-warning-text", texto: "text-warning-text", punto: "bg-warning" },
  PAGO_SIN_ACTIVAR: { chip: "bg-info-soft text-info-text", texto: "text-info-text", punto: "bg-info" },
  SIN_PAGO: { chip: "bg-error-soft text-error-text", texto: "text-error-text", punto: "bg-error" },
};

/** Cómo se nombra cada grupo en las cuentas del mes («− Pagaron y …»). */
const PASO: Record<string, string> = {
  ACTIVADO: "Pagaron y se reactivaron",
  PAGO_SIN_ACTIVAR: "Pagaron, pero siguen cortados",
  RETIRADO: "Pagaron y se retiraron",
  PARCIAL: "Abonaron una parte",
};

const PAGINA = 200;
const pct = (a: number, b: number) => (b > 0 ? (a / b) * 100 : 0);
const pctTxt = (n: number) => `${n.toLocaleString("es-CO", { maximumFractionDigits: 1 })} %`;
const usuarios = (n: number) => `${nfmt(n)} usuario${n === 1 ? "" : "s"}`;

/** Una línea de las cuentas del mes: signo, concepto, usuarios, barra y valor. */
function Linea({ signo, label, nota, gente, barra, valor, tono, fuerte, fondo }: {
  signo?: string; label: React.ReactNode; nota?: string; gente?: string; barra?: React.ReactNode;
  valor: string; tono?: string; fuerte?: boolean; fondo?: boolean;
}) {
  return (
    <div className={`grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-b border-border-subtle px-2 py-3 last:border-b-0 md:grid-cols-[28px_minmax(0,1fr)_120px_minmax(0,240px)_160px] ${fondo ? "bg-surface-2" : ""}`}>
      <div className={`text-center text-[18px] font-extrabold ${tono ?? "text-text-tertiary"}`}>{signo}</div>
      <div className="flex flex-col">
        <div className={`flex items-center gap-2 ${fuerte ? "text-[15px] font-bold" : "text-[14px]"}`}>{label}</div>
        {nota && <div className="text-[12px] text-text-tertiary">{nota}</div>}
      </div>
      <div className="hidden text-right text-[13px] text-text-secondary md:block">{gente}</div>
      <div className="hidden md:block">{barra}</div>
      <div className={`text-right tabular-nums ${fuerte ? "text-[18px] font-extrabold" : "text-[15px] font-bold"} ${tono ?? ""}`}>{valor}</div>
    </div>
  );
}

/**
 * Seguimiento mensual de la cartera: la cohorte que estaba en CARTERA el día 1 y qué
 * pasó con cada abonado. Se lee de arriba abajo: la respuesta en una frase, las
 * cuentas que la explican, los grupos de usuarios, el detalle y el mes a mes. La
 * deuda de hoy se muestra partida en VIEJA (lo del día 1 sin pagar) y NUEVA (las
 * facturas del mes), que es lo que confundía: quien saldó su cartera y debe el mes en
 * curso no es un abono parcial (ver backend reports/cartera-seguimiento.ts).
 */
export function CarteraSeguimiento({ data }: { data: any }) {
  const [cat, setCat] = useState<string>("");
  const [limite, setLimite] = useState(PAGINA);

  const items: any[] = data.items ?? [];
  const filas = useMemo(() => (cat ? items.filter((r) => r.categoria === cat) : items), [items, cat]);

  if (data.vacio || !data.resumen) {
    return (
      <div className="rounded-xl border border-border-subtle bg-surface p-6 text-[13px] text-text-secondary">
        Todavía no hay ningún mes fotografiado. La foto de la cartera se toma el día 1 de cada mes a las 00:40.
      </div>
    );
  }

  const r = data.resumen;
  const cats: any[] = data.categorias ?? [];
  const etiqueta: Record<string, string> = Object.fromEntries(cats.map((c) => [c.key, c.label]));
  const bajo = r.diferencia > 0;
  const igual = r.diferencia === 0;
  const mesCorto = (data.mesLabel ?? "").split(" ")[0]?.toLowerCase();
  const pagados = cats.filter((c) => c.key !== "SIN_PAGO");
  const maxRec = Math.max(...pagados.map((c) => c.recuperado), 1);
  const noPagaron = r.usuariosInicial - r.usuariosPagaron;
  const elegir = (k: string) => { setCat(cat === k ? "" : k); setLimite(PAGINA); };

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 text-[12px] text-text-secondary">
        <span className="font-semibold text-text-primary">{data.mesLabel}</span>
        {data.sede && <span>· {data.sede}</span>}
        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium ${data.abierto ? "bg-warning-soft text-warning-text" : "bg-success-soft text-success-text"}`}>
          <Icon name={data.abierto ? "clock" : "lock"} size={12} />
          {data.abierto ? `Mes en curso · cifras al ${fmtDate(data.corteAl)}` : "Mes cerrado"}
        </span>
        {data.reconstruido && (
          <span className="rounded-full bg-surface-2 px-2 py-0.5" title="Este mes no se fotografió el día 1: la lista de abonados sale del respaldo del 9 de septiembre y la deuda inicial se reconstruyó con facturas y pagos.">
            Cartera inicial reconstruida
          </span>
        )}
      </div>

      {/* 1 · La respuesta */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-4 rounded-2xl border border-border-subtle bg-surface p-6">
          <div className="text-[12px] font-bold uppercase tracking-wide text-brand">El mes en una frase</div>
          <p className="text-[20px] font-medium leading-snug md:text-[24px]">
            De los <b className="font-extrabold">{cop(r.carteraInicial)}</b> que había en cartera el 1 de {mesCorto},
            se recuperaron <b className="font-extrabold text-success-text">{cop(r.recuperado)}</b>.
          </p>
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-[13px] text-text-secondary">
            <span><b className="text-[17px] text-text-primary">{pctTxt(r.porcentajeRecuperado)}</b> de la cartera</span>
            <span><b className="text-[17px] text-text-primary">{nfmt(r.usuariosPagaron)}</b> de {nfmt(r.usuariosInicial)} usuarios pagaron</span>
            <span><b className="text-[17px] text-text-primary">{cop(r.deudaViejaPendiente)}</b> de deuda vieja sigue sin pagar</span>
          </div>
        </div>
        <div className={`flex flex-col gap-2 rounded-2xl border p-6 ${igual ? "border-border-subtle bg-surface-2" : bajo ? "border-success/30 bg-success-soft" : "border-error/30 bg-error-soft"}`}>
          <div className={`flex items-center gap-2 text-[12px] font-bold uppercase tracking-wide ${igual ? "text-text-secondary" : bajo ? "text-success-text" : "text-error-text"}`}>
            <Icon name={igual ? "arrow-left-right" : bajo ? "trending-down" : "trending-up"} size={16} />
            {igual ? "La cartera se mantuvo igual" : bajo ? "La cartera bajó" : "La cartera subió"}
          </div>
          <div className={`text-[32px] font-extrabold tracking-tight ${igual ? "" : bajo ? "text-success-text" : "text-error-text"}`}>{cop(Math.abs(r.diferencia))}</div>
          {r.otrosMovimientos > 0 && (
            <p className="text-[13px] leading-relaxed text-text-secondary">
              {bajo ? "Bajó menos de lo recuperado porque" : "Subió porque"} a estos mismos usuarios se les facturaron <b>{cop(r.otrosMovimientos)}</b> nuevos este mes que todavía no han pagado.
            </p>
          )}
          {r.otrosMovimientos < 0 && (
            <p className="text-[13px] leading-relaxed text-text-secondary">
              Además de lo recuperado, la deuda bajó <b>{cop(-r.otrosMovimientos)}</b> por notas crédito o depuraciones.
            </p>
          )}
        </div>
      </div>

      {/* 2 · Las cuentas */}
      <ChartCard title="Cómo pasó de la cartera inicial a la final" subtitle="Se lee de arriba abajo: cada línea suma o resta" icon="banknote">
        <div className="flex flex-col">
          <Linea label={`Cartera al 1 de ${mesCorto}`} gente={usuarios(r.usuariosInicial)} valor={cop(r.carteraInicial)} fuerte />
          {pagados.map((c) => (
            <Linea key={c.key} signo="−" tono="text-success-text"
              label={<><span className={`h-2.5 w-2.5 shrink-0 rounded-sm ${TONO[c.key].punto}`} />{PASO[c.key]}</>}
              gente={usuarios(c.usuarios)}
              barra={<div className="h-2.5 overflow-hidden rounded-full bg-surface-2"><div className={`h-full rounded-full ${TONO[c.key].punto}`} style={{ width: `${pct(c.recuperado, maxRec)}%` }} /></div>}
              valor={`−${cop(c.recuperado)}`} />
          ))}
          <Linea signo="=" label="Deuda vieja que sigue sin pagar" fondo
            gente={`${nfmt(noPagaron)} sin pago`}
            barra={<span className="text-[12px] text-text-tertiary">El {pctTxt(pct(r.deudaViejaPendiente, r.carteraInicial))} de lo que se debía el día 1</span>}
            valor={cop(r.deudaViejaPendiente)} />
          <Linea signo={r.otrosMovimientos < 0 ? "−" : "+"} tono={r.otrosMovimientos < 0 ? "text-success-text" : "text-error-text"}
            label="Facturas nuevas del mes, aún sin pagar"
            nota="No es cartera vieja: es el mes en curso de estos usuarios, menos notas crédito o depuraciones"
            valor={`${r.otrosMovimientos < 0 ? "−" : "+"}${cop(Math.abs(r.otrosMovimientos))}`} />
          <Linea signo="=" label={data.abierto ? "Cartera pendiente hoy" : "Cartera al cierre del mes"} valor={cop(r.carteraFinal)} tono="text-error-text" fuerte />
        </div>
        <p className="text-[12px] text-text-tertiary">
          <b>Recuperado</b> es lo que pagaron hasta cubrir lo que debían el día 1. Lo que pagaron de más (reconexión, mes en curso) no es cartera: en total recaudaron {cop(r.recaudado)}.
        </p>
      </ChartCard>

      {/* 3 · Los grupos */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[16px] font-bold">Qué pasó con los {nfmt(r.usuariosInicial)} usuarios</h2>
          <span className="text-[12px] text-text-tertiary">Toca un grupo para ver solo esos usuarios abajo</span>
        </div>
        <div className="flex flex-col gap-2 rounded-xl border border-border-subtle bg-surface px-4 py-3">
          <div className="flex justify-between text-[12px] text-text-secondary">
            <span><b className="text-text-primary">{nfmt(r.usuariosPagaron)} pagaron</b> ({pctTxt(pct(r.usuariosPagaron, r.usuariosInicial))})</span>
            <span><b className="text-text-primary">{nfmt(noPagaron)} no pagaron nada</b> ({pctTxt(pct(noPagaron, r.usuariosInicial))})</span>
          </div>
          <div className="flex h-3 overflow-hidden rounded-full bg-error-soft">
            {pagados.filter((c) => c.usuarios > 0).map((c) => (
              <div key={c.key} className={TONO[c.key].punto} style={{ width: `${pct(c.usuarios, r.usuariosInicial)}%`, minWidth: 4 }} title={`${c.label}: ${nfmt(c.usuarios)}`} />
            ))}
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {cats.map((c) => {
            const t = TONO[c.key];
            const activo = cat === c.key;
            return (
              <button key={c.key} type="button" onClick={() => elegir(c.key)} aria-pressed={activo}
                className={`flex flex-col gap-2 rounded-xl border-2 bg-surface p-4 text-left transition-colors hover:bg-surface-2 ${activo ? "border-brand" : "border-border-subtle"}`}>
                <div className={`flex items-center gap-2 text-[13px] font-bold ${t.texto}`}>
                  <span className={`h-2.5 w-2.5 rounded-full ${t.punto}`} /> {c.label}
                </div>
                <div className="text-[28px] font-extrabold leading-none">{nfmt(c.usuarios)}</div>
                <div className="min-h-[34px] text-[12px] text-text-tertiary">{c.desc}</div>
                <div className="mt-auto flex flex-col gap-1 border-t border-border-subtle pt-2 text-[12px]">
                  <div className="flex justify-between gap-2"><span className="text-text-secondary">Recuperado</span><b className="tabular-nums">{cop(c.recuperado)}</b></div>
                  <div className="flex justify-between gap-2"><span className="text-text-secondary">Deuda vieja pendiente</span><b className="tabular-nums">{cop(c.deudaVieja)}</b></div>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* 4 · El detalle */}
      <ChartCard title={cat ? `Usuario por usuario · ${etiqueta[cat]}` : "Usuario por usuario"} icon="list-tree"
        subtitle={`${usuarios(filas.length)}${cat ? "" : " · de mayor a menor pago"}`}
        action={
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filtrar por resultado">
            {[{ key: "", label: "Todos", usuarios: r.usuariosInicial }, ...cats].map((c: any) => (
              <button key={c.key} type="button" onClick={() => { setCat(c.key); setLimite(PAGINA); }} aria-pressed={cat === c.key}
                className={`rounded-full border px-3 py-1.5 text-[12px] font-semibold ${cat === c.key ? "border-brand bg-brand text-on-brand" : "border-border-default text-text-secondary hover:bg-surface-2"}`}>
                {c.label} · {nfmt(c.usuarios)}
              </button>
            ))}
          </div>
        }>
        <DataTable rows={filas.slice(0, limite)} empty="Nadie en este grupo." columns={[
          { key: "abonado", header: "Abonado", render: (x: any) => <span className="font-mono text-text-secondary">{x.abonado ?? "—"}</span> },
          { key: "nombre", header: "Cliente", render: (x: any) => <Link href={`/clientes/${x.id}`} className="font-medium text-brand hover:underline">{x.nombre}</Link> },
          { key: "sede", header: "Sede", render: (x: any) => x.sede },
          { key: "categoria", header: "Resultado", sortValue: (x: any) => etiqueta[x.categoria],
            render: (x: any) => <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${TONO[x.categoria]?.chip}`}>{etiqueta[x.categoria]}</span> },
          { key: "deudaInicial", header: "Debía el día 1", align: "right", render: (x: any) => cop(x.deudaInicial) },
          { key: "pagado", header: "Pagó en el mes", align: "right",
            render: (x: any) => x.pagado > 0 ? <span className="font-semibold text-success-text" title={`${x.pagos} pago(s)`}>{cop(x.pagado)}</span> : <span className="text-text-tertiary">—</span> },
          { key: "deudaVieja", header: "Queda de lo viejo", align: "right",
            render: (x: any) => x.deudaVieja > 0 ? <span className="font-semibold text-error-text">{cop(x.deudaVieja)}</span> : <span className="font-semibold text-success-text">Saldada</span> },
          { key: "deudaNueva", header: "Factura nueva", align: "right",
            render: (x: any) => x.deudaNueva > 0 ? cop(x.deudaNueva) : x.deudaNueva < 0 ? <span title="Notas crédito o depuraciones">−{cop(-x.deudaNueva)}</span> : <span className="text-text-tertiary">—</span> },
          { key: "estadoFinal", header: data.abierto ? "Estado hoy" : "Estado al cierre", render: (x: any) => SUB_STATUS_LABEL[x.estadoFinal] ?? x.estadoFinal ?? "—" },
        ]} />
        {filas.length > limite && (
          <button onClick={() => setLimite((l) => l + PAGINA)} className="self-center rounded-lg border border-border-default px-3 py-1.5 text-[12px] text-text-secondary hover:bg-surface-2">
            Mostrar {nfmt(Math.min(PAGINA, filas.length - limite))} más (de {nfmt(filas.length - limite)} restantes)
          </button>
        )}
      </ChartCard>

      {/* 5 · Mes a mes */}
      <ChartCard title="Mes a mes: ¿la cartera baja, sube o se queda igual?" subtitle="Cada mes se congela el día 1 del siguiente" icon="calendar">
        <DataTable rows={data.comparativo ?? []} empty="Sin meses." sortableByDefault={false} columns={[
          { key: "label", header: "Mes", render: (m: any) => <span className="font-semibold">{m.label}{m.abierto ? <span className="font-normal text-warning-text"> (en curso)</span> : ""}</span> },
          { key: "ini", header: "Cartera inicial", align: "right", render: (m: any) => cop(m.carteraInicial) },
          { key: "rec", header: "Recuperado", align: "right", render: (m: any) => <span className="font-semibold text-success-text">{cop(m.recuperado)}</span> },
          { key: "por", header: "% recup.", align: "right", render: (m: any) => pctTxt(m.porcentajeRecuperado) },
          { key: "pag", header: "Pagaron", align: "right", render: (m: any) => `${nfmt(m.usuariosPagaron)} de ${nfmt(m.usuariosInicial)}` },
          { key: "ret", header: "De retirados", align: "right", render: (m: any) => cop(m.recuperadoRetirados) },
          { key: "act", header: "De reactivados", align: "right", render: (m: any) => cop(m.recuperadoActivados) },
          { key: "fin", header: "Cartera final", align: "right", render: (m: any) => <span className="font-semibold text-error-text">{cop(m.carteraFinal)}</span> },
          { key: "dif", header: "Resultado", align: "right",
            render: (m: any) => m.diferencia === 0 ? <span className="text-text-secondary">Igual</span> : (
              <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${m.diferencia > 0 ? "bg-success-soft text-success-text" : "bg-error-soft text-error-text"}`}>
                {m.diferencia > 0 ? "Bajó" : "Subió"} {cop(Math.abs(m.diferencia))}
              </span>
            ) },
        ]} />
        {data.abierto && (
          <p className="text-[12px] text-text-tertiary">El mes siguiente se abre el día 1 con la foto de quienes estén en cartera ese día.</p>
        )}
      </ChartCard>
    </>
  );
}
