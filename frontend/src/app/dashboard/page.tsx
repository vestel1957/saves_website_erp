"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { LoadError } from "@/components/ui/LoadError";
import { useAuth } from "@/context/AuthProvider";
import { cop } from "@/lib/subscribers";
import { esCajera, tieneCaja } from "@/lib/treasury";
import { esTecnico } from "@/lib/support";
import { PanelCaja } from "@/components/treasury/PanelCaja";
import { PanelTecnico } from "@/components/support/PanelTecnico";
import { RangoFechas, RangoFechasValor, etiquetaRango, rangoDePreset } from "@/components/ui/RangoFechas";
import { Select } from "@/components/ui/Field";
import { MovimientoAbonadosModal, TipoMovimiento } from "@/components/subscribers/MovimientoAbonadosModal";

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
// La serie viene por mes ('YYYY-MM') o por día ('YYYY-MM-DD') según el rango elegido.
const puntoLabel = (m: string) => {
  const [y, mm, dd] = (m || "-").split("-");
  const mes = MONTHS[Number(mm) - 1] ?? mm;
  return dd ? `${Number(dd)} ${mes}` : `${mes} ${(y || "").slice(2)}`;
};

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
      {/*
        Con rango por días son hasta 92 puntos: se rotulan como mucho 8, repartidos, o
        las etiquetas se pisan hasta ser ilegibles (y en móvil desbordan la tarjeta).
      */}
      <div className="mt-1 flex justify-between text-[9px] text-text-tertiary">
        {serie.map((s, i) => {
          const paso = Math.ceil(serie.length / 8);
          const visible = i % paso === 0 || i === serie.length - 1;
          return <span key={s.month} className={visible ? "" : "invisible"}>{puntoLabel(s.month)}</span>;
        })}
      </div>
    </div>
  );
}

/**
 * El dashboard no es uno solo: depende de a qué se dedique quien entra.
 *
 * · CON caja asignada → su caja, y nada más (`PanelCaja`): el informe del recaudo del
 *                       día de ESA caja, con el botón de abrirla.
 * · Técnico  → su rendimiento (`PanelTecnico`). Sus órdenes NO van aquí desde
 *              2026-07-31: se atienden en `/soporte`, que ya sólo le muestra las suyas.
 * · Los demás → el panel ejecutivo de siempre (abonados, cartera, recaudo, red).
 *
 * Se decide con los permisos que ya trae la sesión, así que no hay ni parpadeo ni una
 * llamada de más: ni la cajera ni el técnico piden `/dashboard` (que además les
 * respondería 403, porque ese endpoint sigue siendo de gerencia). Cada panel se sirve
 * de sus propios endpoints, ya acotados a quien pregunta.
 *
 * LA CAJA MANDA SOBRE EL CARGO (2026-08-28, decisión del usuario). Quien tiene una caja
 * asignada (`User.cajaLegacyId`, en la sesión como `user.caja`) ve el tablero de esa
 * caja aunque además sea superusuario: son tres superusuarias que atienden ventanilla
 * (Paula Unas y Windy Muñoz en Yopal, Margarita Reyes en Villanueva 2) y su día es la
 * ventanilla, no la gerencia. Sustituye a las pestañas `Panel ejecutivo | Mi caja` que
 * estuvieron vivas un día: el ejecutivo ya no se les pinta, y las cifras de empresa se
 * miran desde una cuenta sin caja.
 *
 * OJO con el orden de las tres preguntas: la caja va PRIMERO, antes que `esCajera()` y
 * que `esTecnico()`, porque es justamente el caso del mando con caja el que hay que
 * atrapar antes de que gane su área. Y `GET /dashboard` (el endpoint del ejecutivo)
 * sigue abierto para un superusuario: esto es lo que ve, no un candado sobre el dato.
 */
export default function DashboardPage() {
  const { loading: authLoading, user } = useAuth();

  if (authLoading) return <PageSkeleton />;
  // `PanelCaja` guarda su día en la dirección y para eso lee `useSearchParams`, que en
  // el App Router exige una frontera de Suspense.
  if (tieneCaja(user) || esCajera(user)) {
    return (
      <Suspense fallback={<PageSkeleton />}>
        <PanelCaja />
      </Suspense>
    );
  }
  if (esTecnico(user)) return <PanelTecnico />;
  return <PanelEjecutivo />;
}

/** Dónde se recuerdan el último periodo y la última sede mirados, para no reelegirlos en cada visita. */
const CLAVE_RANGO = "dashboard:rango";
const CLAVE_SEDE = "dashboard:sede";

function PanelEjecutivo() {
  const { loading: authLoading, authFetch } = useAuth();
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState(false);
  const [cargando, setCargando] = useState(false);
  const [rango, setRango] = useState<RangoFechasValor>(() => rangoDePreset("mes"));
  // Sede mirada: "" = todas las que alcance el usuario. Viaja a la API como el
  // `legacyId` de la sede, que es lo que entienden el resto de filtros del sistema.
  const [sede, setSede] = useState("");
  // Card de abonados cuyo listado está abierto (null = ninguno).
  const [movimiento, setMovimiento] = useState<TipoMovimiento | null>(null);

  // El periodo elegido se recuerda entre visitas, pero las FECHAS se recalculan a
  // partir del atajo: guardado "este mes" en julio, al volver en agosto tiene que
  // enseñar agosto, no seguir clavado en julio.
  useEffect(() => {
    try {
      const guardado = JSON.parse(localStorage.getItem(CLAVE_RANGO) ?? "null") as RangoFechasValor | null;
      if (guardado?.preset === "personalizado") setRango(guardado);
      else if (guardado?.preset) setRango(rangoDePreset(guardado.preset));
    } catch { /* nada guardado o ilegible: se queda el mes en curso */ }
    try { setSede(localStorage.getItem(CLAVE_SEDE) ?? ""); } catch { /* modo privado */ }
  }, []);

  const cambiarRango = useCallback((next: RangoFechasValor) => {
    setRango(next);
    try { localStorage.setItem(CLAVE_RANGO, JSON.stringify(next)); } catch { /* modo privado */ }
  }, []);

  const cambiarSede = useCallback((next: string) => {
    setSede(next);
    try { localStorage.setItem(CLAVE_SEDE, next); } catch { /* modo privado */ }
  }, []);

  const { desde, hasta } = rango;
  
  const load = useCallback(() => {
    setErr(false);
    setCargando(true);
    void authFetch(`/dashboard?from=${desde}&to=${hasta}${sede ? `&sede=${sede}` : ""}`)
      .then((r) => {
        // 403 = la sede recordada ya no es suya (le cambiaron el alcance). Se olvida y
        // se vuelve a "todas" en vez de dejarlo con un panel roto que no sabe arreglar.
        if (r.status === 403 && sede) { cambiarSede(""); return null; }
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((json) => { if (json) setD(json); })
      .catch(() => setErr(true))
      .finally(() => setCargando(false));
  }, [authFetch, desde, hasta, sede, cambiarSede]);

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

  // Con `onClick` en vez de `href` la card abre un detalle en el sitio (el listado de
  // abonados nuevos o de retiros) en lugar de navegar a otra pantalla.
  const Kpi = ({ label, value, icon, href, onClick, tone }: { label: string; value: string; icon: string; href?: string; onClick?: () => void; tone?: string }) => {
    const cls = "flex items-center gap-3 rounded-xl border border-border-subtle bg-surface px-4 py-3 text-left shadow-sm transition-colors hover:border-border-strong";
    const cuerpo = (
      <>
        <span className={`flex h-9 w-9 items-center justify-center rounded-lg ${tone ?? "bg-brand-soft text-brand"}`}><Icon name={icon} size={17} /></span>
        <div><div className="text-[17px] font-bold leading-none text-text-primary">{value}</div><div className="text-[11px] text-text-tertiary">{label}</div></div>
      </>
    );
    return onClick
      ? <button type="button" onClick={onClick} className={cls}>{cuerpo}</button>
      : <Link href={href ?? "#"} className={cls}>{cuerpo}</Link>;
  };
  const Rotulo = ({ children }: { children: React.ReactNode }) => (
    <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">{children}</div>
  );

  const periodo = etiquetaRango(rango);
  // El clic en Recaudo/Egresos abre Movimientos con el MISMO periodo y la misma sede,
  // para que la cifra de arriba sea la misma que se acaba de ver aquí.
  const hrefTesoreria = `/tesoreria?${new URLSearchParams({
    periodo: "personalizado", desde: rango.desde, hasta: rango.hasta, ...(sede ? { sede } : {}),
  })}`;
  // El catálogo lo trae la propia respuesta ya acotado a las sedes del usuario: no hay
  // llamada aparte, y quien sólo alcanza una sede no ve un desplegable que no le sirve.
  const sedes: { id: number; nombre: string }[] = d.sedes ?? [];
  // La sede que trae los datos que se están pintando (`d.sede`), no la del selector:
  // mientras vuelve la petición siguiente, los rótulos tienen que describir lo que hay
  // en pantalla. Y a quien sólo alcanza una sede se la nombra igual, aunque no filtre.
  const sedeActual = d.sede != null ? sedes.find((x) => x.id === d.sede) ?? null : null;
  const ambito = sedeActual ? sedeActual.nombre : "Todas las sedes";

  return (
    <>
      {/*
        El panel se lee SIEMPRE contra un periodo (por defecto el mes en curso). Lo que
        es una foto de hoy y no depende del rango —la base de abonados y la cartera—
        queda sólo en las donas, que lo dicen en su propio subtítulo: la franja "A hoy"
        se quitó a pedido del usuario (2026-08-08) por repetir esos mismos números.
      */}
      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 [&>div]:mb-0">
          <PageHeading icon="layout-dashboard" title="Panel ejecutivo" subtitle={`${ambito} · ${periodo}`} />
        </div>
        <div className="flex flex-wrap items-center gap-2 lg:pt-1">
          {cargando && <Icon name="loader" size={14} className="animate-spin text-text-tertiary" />}
          {sedes.length > 1 && (
            <Select value={sede} onChange={(e) => cambiarSede(e.target.value)} className="w-auto" aria-label="Sede">
              <option value="">Todas las sedes</option>
              {sedes.map((x) => <option key={x.id} value={x.id}>{x.nombre}</option>)}
            </Select>
          )}
          <RangoFechas value={rango} onChange={cambiarRango} />
        </div>
      </div>

      {/* Franja de KPIs del periodo elegido */}
      <div className="shrink-0">
        <Rotulo>En el periodo</Rotulo>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
          <Kpi label="Facturado" value={compact(d.facturacion.total)} icon="file-text" href="/facturacion" />
          <Kpi label="Recaudo" value={compact(d.tesoreria.ingresos)} icon="banknote" href={hrefTesoreria} tone="bg-success-soft text-success-text" />
          <Kpi label="Egresos" value={compact(d.tesoreria.egresos)} icon="arrow-down" href={hrefTesoreria} tone="bg-error-soft text-error-text" />
          <Kpi label="Órdenes creadas" value={nfmt(d.soporte.total)} icon="headphones" href="/soporte" tone="bg-info-soft text-info-text" />
          <Kpi label="Abonados nuevos" value={nfmt(d.nuevosAbonados ?? 0)} icon="user-plus" onClick={() => setMovimiento("nuevos")} tone="bg-success-soft text-success-text" />
          <Kpi label="Retiros" value={nfmt(d.retirosAbonados ?? 0)} icon="user-minus" onClick={() => setMovimiento("retiros")} tone="bg-error-soft text-error-text" />
        </div>
      </div>

      {/* Gráfica hero: recaudo del periodo */}
      <div className="rounded-2xl border border-border-subtle bg-surface p-4 shadow-sm">
        <div className="mb-1 flex items-center justify-between">
          <div>
            <div className="text-[14px] font-bold text-text-primary">Recaudo vs egresos</div>
            {/*
              Al filtrar por sede el movimiento se ata a SU CAJA, que es donde vive la
              sede del dinero. Los bancos (Wompi, consignaciones) no son de ninguna
              sede, así que quedan fuera: se avisa aquí para que nadie lea el recaudo de
              una sede como "todo lo que entró por esos clientes".
            */}
            <div className="text-[11px] text-text-tertiary">
              Flujo de caja {d.rango?.granularidad === "dia" ? "por día" : "por mes"} · {periodo}
              {sedeActual && " · sólo las cajas de la sede (los bancos no se reparten)"}
            </div>
          </div>
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
          <div className="text-[13px] font-bold text-text-primary">Distribución de la base activa</div>
          <div className="mb-3 text-[11px] text-text-tertiary">Cómo está la base hoy (no depende del periodo)</div>
          <div className="flex items-center gap-5">
            <Donut segments={baseSeg} centerValue={nfmt(baseActiva)} centerLabel="conectados" />
            <Legend segments={baseSeg} fmt={nfmt} />
          </div>
        </div>
        <div className="rounded-2xl border border-border-subtle bg-surface p-4 shadow-sm">
          <div className="text-[13px] font-bold text-text-primary">Cartera por antigüedad</div>
          <div className="mb-3 text-[11px] text-text-tertiary">Deuda a hoy según los días que lleva vencida</div>
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
          {/*
            Esta tarjeta NO se filtra a propósito: es la comparativa entre sedes, y
            filtrada sería una sola barra al 100%, que no compara nada. Al elegir una
            sede se resalta la suya y se atenúan las demás.
          */}
          <div className="mb-3 text-[11px] text-text-tertiary">
            Facturado y abonados facturados en el periodo · {periodo}
            {sedeActual && sedes.length > 1 && " · todas las sedes, para comparar"}
          </div>
          <div className="flex flex-col gap-3">
            {!(d.ventasPorSede ?? []).length && <div className="py-6 text-center text-[12px] text-text-tertiary">Sin facturación en el periodo</div>}
            {(d.ventasPorSede ?? []).map((s: any) => {
              const elegida = !!sedeActual && s.id === d.sede;
              const atenuada = !!sedeActual && !elegida;
              return (
                <button
                  key={s.sede}
                  type="button"
                  // La barra es también el filtro: es donde uno mira cuando piensa "¿y
                  // qué pasa en Monterrey?". Volver a pulsarla quita el filtro.
                  onClick={() => cambiarSede(elegida || s.id == null ? "" : String(s.id))}
                  className={`tap flex items-center gap-3 rounded-lg px-1 py-0.5 text-left transition-opacity hover:bg-surface-2 ${atenuada ? "opacity-45" : ""}`}
                  aria-pressed={elegida}
                >
                  <span className={`w-24 shrink-0 truncate text-[12px] font-semibold ${elegida ? "text-brand" : "text-text-primary"}`}>{s.sede}</span>
                  <div className="h-3 flex-1 overflow-hidden rounded-full bg-surface-2"><div className="h-full rounded-full bg-brand" style={{ width: `${(s.total / maxSede) * 100}%` }} /></div>
                  <div className="w-32 shrink-0 text-right">
                    <div className="text-[12px] font-bold text-text-primary" title={cop(s.total)}>{mill(s.total)}</div>
                    <div className="text-[10px] text-text-tertiary">{nfmt(s.abonados)} abonados</div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
        <div className="rounded-2xl border border-border-subtle bg-surface p-4 shadow-sm">
          <div className="text-[13px] font-bold text-text-primary">Top clientes en mora</div>
          <div className="mb-2 text-[11px] text-text-tertiary">Deuda acumulada a hoy</div>
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
      <MovimientoAbonadosModal tipo={movimiento} desde={desde} hasta={hasta} sede={sede} periodo={`${ambito} · ${periodo}`} onClose={() => setMovimiento(null)} />
    </>
  );
}
