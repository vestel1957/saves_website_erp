"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { LoadError } from "@/components/ui/LoadError";
import { useAuth } from "@/context/AuthProvider";
import { cop } from "@/lib/subscribers";
import { esCajera } from "@/lib/treasury";
import { esTecnico } from "@/lib/support";
import { PanelCaja } from "@/components/treasury/PanelCaja";
import { PanelTecnico } from "@/components/support/PanelTecnico";

function compact(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return cop(n);
}
const nfmt = (n: number) => (n ?? 0).toLocaleString("es-CO");
// Monto preciso en millones de COP (ej. $10.030,7 M) — más exacto que el compacto.
const mill = (n: number) => `$${((n ?? 0) / 1e6).toLocaleString("es-CO", { maximumFractionDigits: 1 })} M`;
const MONTHS = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
const monthLabel = (m: string) => { const [y, mm] = (m || "-").split("-"); return `${MONTHS[Number(mm) - 1] ?? mm} ${(y || "").slice(2)}`; };

type Seg = { label: string; value: number; cls: string }; // cls = text-color class

/* Dona SVG (anillo) con total al centro */
function Donut({ segments, centerValue, centerLabel, size = 148 }: { segments: Seg[]; centerValue: string; centerLabel: string; size?: number }) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  let acc = 0;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg viewBox="0 0 42 42" className="h-full w-full -rotate-90">
        <circle cx="21" cy="21" r="15.915" fill="none" className="text-surface-2" stroke="currentColor" strokeWidth="4.5" />
        {segments.map((seg) => {
          const pct = (seg.value / total) * 100;
          const el = (
            <circle key={seg.label} cx="21" cy="21" r="15.915" fill="none" className={seg.cls} stroke="currentColor" strokeWidth="4.5"
              strokeDasharray={`${pct} ${100 - pct}`} strokeDashoffset={-acc} strokeLinecap="butt" />
          );
          acc += pct;
          return el;
        })}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-[19px] font-bold leading-none text-text-primary">{centerValue}</span>
        <span className="text-[10px] text-text-tertiary">{centerLabel}</span>
      </div>
    </div>
  );
}

function Legend({ segments, fmt }: { segments: Seg[]; fmt: (n: number) => string }) {
  return (
    <div className="flex flex-1 flex-col justify-center gap-1.5">
      {segments.map((s) => (
        <div key={s.label} className="flex items-center justify-between gap-3 text-[12px]">
          <span className="flex items-center gap-2"><span className={`h-2.5 w-2.5 rounded-sm ${s.cls.replace("text-", "bg-")}`} /><span className="text-text-secondary">{s.label}</span></span>
          <span className="font-semibold text-text-primary">{fmt(s.value)}</span>
        </div>
      ))}
    </div>
  );
}

/* Área grande de recaudo mensual */
function AreaChart({ serie }: { serie: { month: string; income: number; expense: number }[] }) {
  if (!serie.length) return <div className="flex h-56 items-center justify-center text-[12px] text-text-tertiary">Sin datos</div>;
  const max = Math.max(1, ...serie.map((s) => Math.max(s.income, s.expense)));
  const n = serie.length;
  const x = (i: number) => (n === 1 ? 50 : (i / (n - 1)) * 100);
  const y = (v: number) => 38 - (v / max) * 33;
  const line = (k: "income" | "expense") => serie.map((s, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(2)},${y(s[k]).toFixed(2)}`).join(" ");
  return (
    <div>
      <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="h-56 w-full">
        <defs>
          <linearGradient id="inc" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" className="text-brand" stopColor="currentColor" stopOpacity="0.28" />
            <stop offset="100%" className="text-brand" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((g) => <line key={g} x1="0" y1={38 * g + 1} x2="100" y2={38 * g + 1} className="text-border-subtle" stroke="currentColor" strokeWidth="0.18" />)}
        <path d={`${line("income")} L100,40 L0,40 Z`} fill="url(#inc)" />
        <path d={line("income")} fill="none" className="text-brand" stroke="currentColor" strokeWidth="1" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        <path d={line("expense")} fill="none" className="text-error-text" stroke="currentColor" strokeWidth="0.9" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeDasharray="2 1.5" />
      </svg>
      <div className="mt-1 flex justify-between text-[9px] text-text-tertiary">
        {serie.map((s) => <span key={s.month}>{monthLabel(s.month)}</span>)}
      </div>
    </div>
  );
}

/**
 * El dashboard no es uno solo: depende de a qué se dedique quien entra.
 *
 * · Cajera   → su caja: el informe del recaudo del día (ver `PanelCaja`).
 * · Técnico  → su rendimiento (`PanelTecnico`). Sus órdenes NO van aquí desde
 *              2026-07-31: se atienden en `/soporte`, que ya sólo le muestra las suyas.
 * · Los demás → el panel ejecutivo de siempre (abonados, cartera, recaudo, red).
 *
 * Se decide con los permisos que ya trae la sesión, así que no hay ni parpadeo ni una
 * llamada de más: ni la cajera ni el técnico piden `/dashboard` (que además les
 * respondería 403, porque ese endpoint sigue siendo de gerencia). Cada panel se sirve
 * de sus propios endpoints, ya acotados a quien pregunta.
 */
export default function DashboardPage() {
  const { loading: authLoading, user } = useAuth();
  if (authLoading) return <PageSkeleton />;
  if (esCajera(user)) return <PanelCaja />;
  if (esTecnico(user)) return <PanelTecnico />;
  return <PanelEjecutivo />;
}

function PanelEjecutivo() {
  const { loading: authLoading, authFetch } = useAuth();
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState(false);
  const load = useCallback(() => {
    setErr(false);
    void authFetch("/dashboard")
      .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
      .then(setD)
      .catch(() => setErr(true));
  }, [authFetch]);
  useEffect(() => { if (!authLoading) load(); }, [authLoading, load]);
  if (authLoading) return <PageSkeleton />;
  if (err && !d) return <div className="p-6"><LoadError message="No se pudo cargar el panel." onRetry={load} /></div>;
  if (!d) return <PageSkeleton />;

  const est = d.estadoClientes ?? {};
  const baseSeg: Seg[] = [
    { label: "Activos", value: est.ACTIVO ?? 0, cls: "text-success-text" },
    { label: "Cartera", value: est.CARTERA ?? 0, cls: "text-warning-text" },
    { label: "Cortados", value: est.CORTADO ?? 0, cls: "text-error-text" },
    { label: "Suspendidos", value: est.SUSPENDIDO ?? 0, cls: "text-info-text" },
    { label: "Otros", value: (est.COMPROMISO ?? 0) + (est.EXONERADO ?? 0) + (est.INSTALAR ?? 0) + (est.REPORTADO ?? 0), cls: "text-text-tertiary" },
  ].filter((s) => s.value > 0);
  const baseActiva = baseSeg.reduce((s, x) => s + x.value, 0);

  const ag = d.cartera.aging;
  const ageSeg: Seg[] = [
    { label: "Corriente (0-30)", value: ag.corriente, cls: "text-success-text" },
    { label: "31-60 días", value: ag.d31_60, cls: "text-warning-text" },
    { label: "61-90 días", value: ag.d61_90, cls: "text-brand" },
    { label: "+90 días (crítico)", value: ag.d90, cls: "text-error-text" },
  ].filter((s) => s.value > 0);

  const maxSede = Math.max(1, ...(d.ventasPorSede ?? []).map((s: any) => s.total));

  const Kpi = ({ label, value, icon, href, tone }: { label: string; value: string; icon: string; href: string; tone?: string }) => (
    <Link href={href} className="flex items-center gap-3 rounded-xl border border-border-subtle bg-surface px-4 py-3 shadow-sm transition-colors hover:border-border-strong">
      <span className={`flex h-9 w-9 items-center justify-center rounded-lg ${tone ?? "bg-brand-soft text-brand"}`}><Icon name={icon} size={17} /></span>
      <div><div className="text-[17px] font-bold leading-none text-text-primary">{value}</div><div className="text-[11px] text-text-tertiary">{label}</div></div>
    </Link>
  );

  return (
    <>
      <PageHeading icon="layout-dashboard" title="Panel ejecutivo" subtitle="Operación Vestel · abonados, recaudo, cartera y red" />

      {/* Franja de KPIs */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <Kpi label="Abonados" value={nfmt(d.clientes.total)} icon="users" href="/clientes" />
        <Kpi label="Activos" value={nfmt(d.clientes.activos)} icon="activity" href="/clientes" tone="bg-success-soft text-success-text" />
        <Kpi label="Cartera" value={compact(d.cartera.total)} icon="alert-triangle" href="/facturacion" tone="bg-error-soft text-error-text" />
        <Kpi label="Recaudo" value={compact(d.tesoreria.ingresos)} icon="banknote" href="/tesoreria" tone="bg-success-soft text-success-text" />
        <Kpi label="Órdenes abiertas" value={nfmt(d.soporte.pendientes)} icon="headphones" href="/soporte" tone="bg-info-soft text-info-text" />
        <Kpi label="Conexiones" value={nfmt(d.red.puertosUsados)} icon="wand-sparkles" href="/red" />
      </div>

      {/* Gráfica hero: recaudo mensual */}
      <div className="rounded-2xl border border-border-subtle bg-surface p-4 shadow-sm">
        <div className="mb-1 flex items-center justify-between">
          <div><div className="text-[14px] font-bold text-text-primary">Recaudo vs egresos por mes</div><div className="text-[11px] text-text-tertiary">Flujo de caja de los últimos meses</div></div>
          <span className="flex gap-3 text-[11px]">
            <span className="flex items-center gap-1"><span className="h-[3px] w-4 rounded-full bg-brand" /> Ingresos</span>
            <span className="flex items-center gap-1"><span className="h-[3px] w-4 rounded-full bg-error-text" /> Egresos</span>
          </span>
        </div>
        <AreaChart serie={d.serieMensual ?? []} />
      </div>

      {/* Dos donas: base de clientes + cartera por edad */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-border-subtle bg-surface p-4 shadow-sm">
          <div className="mb-3 text-[13px] font-bold text-text-primary">Distribución de la base activa</div>
          <div className="flex items-center gap-5">
            <Donut segments={baseSeg} centerValue={nfmt(baseActiva)} centerLabel="conectados" />
            <Legend segments={baseSeg} fmt={nfmt} />
          </div>
        </div>
        <div className="rounded-2xl border border-border-subtle bg-surface p-4 shadow-sm">
          <div className="text-[13px] font-bold text-text-primary">Cartera por antigüedad</div>
          <div className="mb-3 text-[11px] text-text-tertiary">Deuda según los días que lleva vencida</div>
          <div className="flex items-center gap-5">
            <Donut segments={ageSeg} centerValue={compact(d.cartera.total)} centerLabel="pendiente" />
            <Legend segments={ageSeg} fmt={compact} />
          </div>
        </div>
      </div>

      {/* Facturación por sede + Top deudores */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-border-subtle bg-surface p-4 shadow-sm">
          <div className="text-[13px] font-bold text-text-primary">Facturación por sede</div>
          <div className="mb-3 text-[11px] text-text-tertiary">Total facturado histórico y abonados por sede</div>
          <div className="flex flex-col gap-3">
            {(d.ventasPorSede ?? []).map((s: any) => (
              <div key={s.sede} className="flex items-center gap-3">
                <span className="w-24 shrink-0 truncate text-[12px] font-semibold text-text-primary">{s.sede}</span>
                <div className="h-3 flex-1 overflow-hidden rounded-full bg-surface-2"><div className="h-full rounded-full bg-brand" style={{ width: `${(s.total / maxSede) * 100}%` }} /></div>
                <div className="w-32 shrink-0 text-right">
                  <div className="text-[12px] font-bold text-text-primary" title={cop(s.total)}>{mill(s.total)}</div>
                  <div className="text-[10px] text-text-tertiary">{nfmt(s.abonados)} abonados</div>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-2xl border border-border-subtle bg-surface p-4 shadow-sm">
          <div className="mb-2 text-[13px] font-bold text-text-primary">Top clientes en mora</div>
          <div className="flex flex-col">
            {(d.topDeudores ?? []).slice(0, 7).map((r: any, i: number) => (
              <Link key={r.id} href={`/clientes/${r.id}`} className="flex items-center justify-between gap-2 border-b border-border-subtle py-1.5 text-[12px] last:border-0 hover:text-brand">
                <span className="truncate"><span className="mr-1.5 inline-flex h-4 w-4 items-center justify-center rounded-full bg-surface-2 text-[9px] font-bold text-text-tertiary">{i + 1}</span>{r.name}</span>
                <span className="shrink-0 font-semibold text-error-text">{compact(r.balance)}</span>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
