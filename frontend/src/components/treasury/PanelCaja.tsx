"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Icon } from "@/components/Icon";
import { PageHeading } from "@/components/ui/PageHeading";
import { Field, Input } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { LoadError } from "@/components/ui/LoadError";
import { toast } from "@/components/ui/Toast";
import { mensajeDeError } from "@/lib/errores";
import { InformeCierre } from "@/components/treasury/InformeCierre";
import {
  AreaLineChart, ChartCard, ChartEmpty, DonutChart, HBarList, LegendItem, TrendStat, compactCOP,
} from "@/components/charts";
import { useAuth } from "@/context/AuthProvider";
import { cop } from "@/lib/subscribers";
import type { InformeCierreData, MiCaja } from "@/lib/treasury";
import { useFiltrosEnUrl, useFiltrosRecordados } from "@/lib/useFiltrosUrl";

/**
 * Colores de serie. Son los tokens `--chart-*` de `globals.css`: pasos validados
 * (contraste, daltonismo) con versión propia para claro y oscuro, así que aquí no se
 * escribe ningún hex — cambiarlos es cambiar el token, no esta pantalla.
 */
const C_AZUL = "var(--chart-1)";
const C_NARANJA = "var(--chart-2)";
const C_VERDE = "var(--chart-3)";
const C_ROJO = "var(--chart-4)";

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const nfmt = (n: number) => (n ?? 0).toLocaleString("es-CO");
/** Etiqueta corta de eje: "21 jul". Se lee de un vistazo y cabe en móvil. */
const diaCorto = (ymd: string) =>
  new Date(`${ymd}T12:00:00`).toLocaleDateString("es-CO", { day: "2-digit", month: "short" }).replace(".", "");
const fmtHora = (iso: string) =>
  new Date(iso).toLocaleTimeString("es-CO", { hour: "numeric", minute: "2-digit", hour12: true });
const diaLargo = (ymd: string) =>
  new Date(`${ymd}T12:00:00`).toLocaleDateString("es-CO", { weekday: "long", day: "2-digit", month: "long" });

type DiaSerie = { date: string; ingresos: number; egresos: number; pagos: number };
type Serie = { desde: string; hasta: string; items: DiaSerie[] };

/**
 * Estado de apertura del día. `existing` es la apertura registrada AQUÍ; `movimientos`
 * es lo que dice el libro — y el libro es lo que comparten los dos sistemas, así que una
 * caja que arrancó en el legacy se ve operando aquí aunque nadie haya pulsado nada.
 */
type Apertura = {
  fondoFijo: number;
  carryover: number;
  carryoverFrom: string | null;
  base: number;
  existing: { base: number; openedBy: string | null; openedAt: string | null } | null;
  movimientos: number;
  /** Hora del primer movimiento — sólo si se hizo en SAVES; el legacy no guarda hora. */
  desde: string | null;
  /** Quién registró el primer movimiento del día (del `eid` del legacy). */
  primero: string | null;
};

const DIAS = 14;

/**
 * Un reparto (parte-todo). Con dos categorías o más, dona; con UNA, barra: un anillo
 * al 100% no reparte nada — sólo dice "todo fue esto", que se lee mejor escrito.
 */
function Reparto({ data, centerLabel }: { data: { label: string; value: number; color: string }[]; centerLabel: string }) {
  const total = data.reduce((s, x) => s + x.value, 0);
  if (data.length >= 2) {
    return (
      <DonutChart data={data} centerValue={compactCOP(total)} centerLabel={centerLabel} valueFormat={cop} />
    );
  }
  return <HBarList rows={data} valueFormat={cop} />;
}

/**
 * El dashboard de la cajera.
 *
 * El panel ejecutivo (cartera, base de abonados, ventas por sede) es información de
 * gerencia: a quien está en la ventanilla no le dice nada y encima le enseña plata que
 * no es suya. Lo que ella necesita al abrir el sistema es lo de SU caja: cuánto lleva
 * recaudado hoy, cómo le pagaron, qué se cobró y cuánto efectivo debería haber en el
 * cajón — y si el día va flojo o normal, que es lo que responde la serie de 14 días.
 *
 * Las cifras son las mismas del cierre (mismo endpoint, mismos números del legacy); lo
 * que cambia es que aquí se ven en gráficas y ahí en tablas. Las tablas siguen estando,
 * a un clic, porque son las que el personal lee todos los días.
 */
export function PanelCaja() {
  const inicial = useFiltrosRecordados();
  if (!inicial) return <PageSkeleton />;
  return <PanelCajaCon inicial={inicial} />;
}

/**
 * El día se escribe en la dirección SÓLO si no es hoy, y NO se recupera de la última
 * visita: la cajera abre su panel para trabajar el día de hoy, y encontrárselo puesto
 * en un día viejo es justo lo que lleva a cerrar la caja equivocada. Un enlace con
 * fecha sí manda: sirve para pasarle a alguien el día exacto que se está mirando.
 */
function PanelCajaCon({ inicial }: { inicial: { valores: Record<string, string>; recordado: boolean } }) {
  const { authFetch } = useAuth();
  const [mi, setMi] = useState<MiCaja | null>(null);
  const [fecha, setFecha] = useState(
    () => (!inicial.recordado && inicial.valores.fecha) || iso(new Date()),
  );
  const [informe, setInforme] = useState<InformeCierreData | null>(null);
  const [serie, setSerie] = useState<Serie | null>(null);
  const [apertura, setApertura] = useState<Apertura | null>(null);
  const [abriendo, setAbriendo] = useState(false);
  const [cargando, setCargando] = useState(true);
  const [err, setErr] = useState("");
  const [verInforme, setVerInforme] = useState(inicial.valores.informe === "1");

  /**
   * El día y si las tablas están desplegadas, en la dirección: recargar no pierde el
   * sitio y el enlace lleva al otro a lo mismo que se está mirando. Un solo
   * `useFiltrosEnUrl` por pantalla — el hook reescribe la query entera.
   */
  useFiltrosEnUrl({
    fecha: fecha === iso(new Date()) ? "" : fecha,
    informe: verInforme ? "1" : "",
  });

  useEffect(() => {
    void authFetch("/treasury/mi-caja")
      .then((r) => (r.ok ? r.json() : null))
      .then((m: MiCaja | null) => {
        setMi(m);
        if (!m?.caja) setCargando(false);
      })
      .catch(() => { setErr("No se pudo saber cuál es tu caja."); setCargando(false); });
  }, [authFetch]);

  const cajaId = mi?.caja?.id ?? null;

  /**
   * `silencioso` = refresco de fondo: no enciende el esqueleto ni pinta error, y si
   * falla deja en pantalla lo último bueno. Un parpadeo cada minuto sería peor que el
   * dato viejo, y una caída de red pasajera no debe borrarle el panel a la cajera.
   */
  const cargar = useCallback(async (silencioso = false) => {
    if (cajaId == null) return;
    if (!silencioso) { setCargando(true); setErr(""); }
    try {
      const [rInf, rSerie, rAp] = await Promise.all([
        authFetch(`/treasury/cash-close/report?cashAccountId=${cajaId}&date=${fecha}`),
        authFetch(`/treasury/cash-daily?cashAccountId=${cajaId}&date=${fecha}&days=${DIAS}`),
        authFetch(`/treasury/cash-open-suggest?cashAccountId=${cajaId}&date=${fecha}`),
      ]);
      if (!rInf.ok) {
        if (silencioso) return;
        setInforme(null);
        setErr(rInf.status === 403 ? "No tienes acceso a esta caja." : "No se pudo cargar el panel.");
        return;
      }
      setInforme(await rInf.json());
      // La serie es el adorno, no el dato: si falla, el panel sigue en pie sin gráfica.
      setSerie(rSerie.ok ? await rSerie.json() : null);
      setApertura(rAp.ok ? await rAp.json() : null);
    } catch {
      if (!silencioso) setErr("No se pudo cargar el panel.");
    } finally {
      if (!silencioso) setCargando(false);
    }
  }, [authFetch, cajaId, fecha]);

  useEffect(() => { void cargar(); }, [cargar]);

  const esHoy = fecha === iso(new Date());
  const ultimoRefresco = useRef(0);

  /**
   * Refresco de fondo mientras se mira HOY.
   *
   * El primer cobro del día casi siempre se registra en el legacy y cruza por la
   * sincronización, y de ese movimiento es de donde sale el estado "caja abierta"
   * (aquí no hay apertura que copiar). Sin esto el panel se queda con la foto del
   * montaje: enseñaba SIN ABRIR con la cajera llevando rato cobrando, hasta que a
   * alguien se le ocurría recargar. Un día pasado no cambia, así que no se refresca.
   */
  useEffect(() => {
    if (cajaId == null || !esHoy) return;
    const refrescar = () => {
      if (document.visibilityState !== "visible") return; // pestaña de fondo: no se gasta
      // `focus` y `visibilitychange` llegan juntos al volver a la pestaña: una sola.
      const ahora = Date.now();
      if (ahora - ultimoRefresco.current < 5_000) return;
      ultimoRefresco.current = ahora;
      void cargar(true);
    };
    const t = setInterval(refrescar, 60_000);
    document.addEventListener("visibilitychange", refrescar);
    window.addEventListener("focus", refrescar);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", refrescar);
      window.removeEventListener("focus", refrescar);
    };
  }, [cargar, cajaId, esHoy]);

  /**
   * Abrir la caja: un clic, sin formulario. La base la pone el servidor (fondo fijo de
   * la caja + arrastre), así que aquí no se manda ninguna cifra — sólo el día.
   */
  async function abrirCaja() {
    setAbriendo(true);
    try {
      const r = await authFetch("/treasury/cash-open", {
        method: "POST",
        body: JSON.stringify({ date: fecha }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.message || "No se pudo abrir la caja.");
      toast(
        d.abierta
          ? `Caja abierta con base ${cop(d.base)}`
          : d.motivo === "ya-opera"
            ? "Esta caja ya estaba operando hoy: no hace falta abrirla."
            : `Esta caja ya estaba abierta (base ${cop(d.base)})`,
        "check",
      );
      await cargar();
    } catch (e) {
      toast(mensajeDeError(e), "alert-triangle");
    } finally {
      setAbriendo(false);
    }
  }

  const dias = useMemo(() => serie?.items ?? [], [serie]);
  const hoy = dias.length ? dias[dias.length - 1] : null;
  /** El día anterior CON movimiento: comparar contra un domingo en cero no dice nada. */
  const previo = useMemo(() => {
    for (let i = dias.length - 2; i >= 0; i--) if (dias[i].ingresos > 0) return dias[i];
    return null;
  }, [dias]);
  const delta = previo && previo.ingresos > 0 && hoy
    ? ((hoy.ingresos - previo.ingresos) / previo.ingresos) * 100
    : undefined;

  // Sin caja asignada no hay panel que pintar: es un asunto de administración, no un error.
  if (mi && !mi.caja) {
    return (
      <>
        <PageHeading icon="wallet" title="Mi caja" subtitle="Recaudo del día" />
        <div className="rounded-xl border border-dashed border-border-default bg-surface px-4 py-16 text-center">
          <Icon name="wallet" size={22} className="mx-auto mb-2 text-text-tertiary" />
          <p className="text-sm text-text-secondary">No tienes una caja asignada.</p>
          <p className="mt-1 text-[12px] text-text-tertiary">Pídele a administración que te asigne la tuya.</p>
        </div>
      </>
    );
  }

  const a = informe?.arqueo;

  /**
   * En qué estado está la caja ese día. El orden es el que manda:
   * cerrada > abierta (por apertura registrada o porque ya hay movimientos) > sin abrir.
   */
  const estado: "cerrada" | "abierta" | "sin-abrir" =
    a?.yaCerrado ? "cerrada"
    : apertura?.existing || (apertura?.movimientos ?? 0) > 0 ? "abierta"
    : "sin-abrir";

  /**
   * TODAS las gráficas se pintan con `soloCaja`: el informe sin los pagos de la pasarela
   * en línea. Ese dinero se consolida en la caja de la sede sólo porque la factura lleva
   * su nombre, pero el abonado lo paga desde el celular y nunca pasa por la ventanilla —
   * llegó a ser el 46% de lo que este panel llamaba "cobranza". Contárselo a la cajera
   * era enseñarle un recaudo que no puede arquear y que no cuadraba ni con la tarjeta de
   * al lado ("Recaudo del día", que siempre salió sólo de su caja).
   *
   * El informe en tablas de abajo sigue siendo el del legacy, con Wompi dentro: ése es
   * el documento que se concilia con el sistema viejo.
   */
  const sc = informe?.soloCaja;
  const enLinea = informe?.dineroEnCaja.wompi;

  /**
   * El arqueo del cajón, los cuatro pasos en orden: lo que había, lo que entró, lo que
   * salió y lo que queda por barrer.
   *
   * Antes esto era un donut "Cómo te pagaron" con Efectivo y Transferencia. Se cambió el
   * 2026-09-18: la transferencia bancaria no pasa por la ventanilla, así que salió del
   * bloque —sigue en el informe, bajo Bancos— y el donut se quedaba con una sola tajada,
   * que no es un reparto sino un número con un círculo alrededor.
   */
  const dc = sc?.dineroEnCaja;

  // ── Qué se cobró: planes, TV, reconexiones y afiliaciones, de mayor a menor. ──
  const servicios = sc
    ? [
        ...sc.servicios.planes.map((p) => ({
          label: `Internet ${p.megas}MG`, value: p.monto, hint: `${nfmt(p.cantidad)} cobros`,
        })),
        ...(sc.servicios.television.cantidad
          ? [{ label: "Televisión", value: sc.servicios.television.monto, hint: `${nfmt(sc.servicios.television.cantidad)} cobros` }]
          : []),
        ...(sc.servicios.reconexiones.cantidad
          ? [{ label: "Reconexiones", value: sc.servicios.reconexiones.monto, hint: `${nfmt(sc.servicios.reconexiones.cantidad)} cobros` }]
          : []),
        ...sc.servicios.afiliaciones.map((x) => ({
          label: x.producto, value: x.monto, hint: `${nfmt(x.cantidad)} cobros`,
        })),
      ].filter((r) => r.value > 0).sort((x, y) => y.value - x.value).slice(0, 7)
    : [];

  // ── De qué mes es lo que se cobró: corriente, mes pasado y cartera vieja. ──
  const m = sc?.meses;
  const mesLabel = (delta: number) => {
    const base = new Date(`${fecha}T12:00:00`);
    return new Date(base.getFullYear(), base.getMonth() + delta, 1)
      .toLocaleDateString("es-CO", { month: "long" });
  };
  const meses = m
    ? [
        { label: `Mes en curso (${mesLabel(0)})`, value: m.actual.monto, hint: `${nfmt(m.actual.cantidad)} cargos` },
        { label: `Mes pasado (${mesLabel(-1)})`, value: m.anterior.monto, hint: `${nfmt(m.anterior.cantidad)} cargos` },
        { label: "Meses anteriores", value: m.anteriores.monto, hint: `${nfmt(m.anteriores.cantidad)} cargos` },
      ].filter((r) => r.value > 0)
    : [];

  const ts = sc?.tipoServicio;
  const porServicio = ts
    ? [
        { label: "Internet", value: ts.Internet.monto, color: C_AZUL },
        { label: "Televisión", value: ts.Television.monto, color: C_NARANJA },
      ].filter((s) => s.value > 0)
    : [];

  return (
    <>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <PageHeading
          icon="wallet"
          title="Mi caja"
          subtitle={mi?.caja ? `${mi.caja.name} · ${esHoy ? "movimiento de hoy" : diaLargo(fecha)}` : "Recaudo del día"}
        />
        <div className="flex items-end gap-2">
          <Field label="Día">
            <Input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} />
          </Field>
          {!esHoy && (
            <button
              onClick={() => setFecha(iso(new Date()))}
              className="mb-[1px] rounded-md border border-border-default px-2.5 py-2 text-[12px] text-text-secondary hover:bg-surface-2"
            >
              Hoy
            </button>
          )}
        </div>
      </div>

      {err && !informe && <div className="p-2"><LoadError message={err} onRetry={() => void cargar()} /></div>}

      {cargando && !informe ? <PageSkeleton /> : informe && a ? (
        <div className="flex flex-col gap-4">
          {/* ── Estado de la caja: lo primero que se mira al entrar ── */}
          <EstadoCaja
            estado={estado}
            apertura={apertura}
            arqueo={a}
            esHoy={esHoy}
            abriendo={abriendo}
            onAbrir={() => void abrirCaja()}
          />

          {/* ── Las cuatro cifras del día ── */}
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <TrendStat
              label={a.yaCerrado ? "Efectivo barrido al cerrar" : "Efectivo en el cajón"}
              value={cop(a.excedente)}
              icon="banknote"
              tone="success"
              hint={a.yaCerrado ? "se arrastró al próximo día hábil" : "es lo que debería haber contado"}
            />
            {/* Los respaldos (cuando la serie de 14 días no carga) tienen que ser el MISMO
                número que la tarjeta de abajo. Antes caían en la cobranza —que suma los
                pagos en línea y se salta el efectivo sin factura— y en el bloque de egresos
                del legacy —que mete dentro el propio barrido del cierre—, así que al fallar
                la serie el panel se contradecía solo. */}
            <TrendStat
              label="Recaudo del día"
              value={cop(hoy?.ingresos ?? dc?.recaudo.monto ?? 0)}
              icon="trending-up"
              delta={delta}
              deltaLabel={previo ? `vs. ${diaCorto(previo.date)} (${compactCOP(previo.ingresos)})` : undefined}
              spark={dias.map((d) => d.ingresos)}
            />
            <TrendStat
              label="Egresos del día"
              value={cop(hoy?.egresos ?? dc?.egresos.monto ?? 0)}
              icon="trending-down"
              tone="error"
              spark={dias.map((d) => d.egresos)}
            />
            {/* Pagos, no cargos. `cobranza.total.cantidad` cuenta los renglones prorrateados
                de las facturas (93 el 16-09 en Villanueva) y se mostraba bajo el rótulo
                "Pagos recibidos" al lado de un recaudo que eran 52 pagos de verdad. */}
            <TrendStat
              label="Pagos recibidos"
              value={nfmt(dc?.recaudo.cantidad ?? 0)}
              icon="receipt"
              hint={
                dc && dc.recaudo.cantidad
                  ? `${cop(Math.round(dc.recaudo.monto / dc.recaudo.cantidad))} por pago`
                  : "sin pagos ese día"
              }
              spark={dias.map((d) => d.pagos)}
            />
          </div>

          {/* ── La tendencia: ¿hoy va flojo o normal? ── */}
          <ChartCard
            title={`Últimos ${DIAS} días`}
            subtitle="Ingresos y egresos de tu caja, día a día · sin el arrastre del cierre"
            icon="activity"
            action={
              <div className="flex gap-3">
                <LegendItem color={C_VERDE} label="Ingresos" />
                <LegendItem color={C_ROJO} label="Egresos" />
              </div>
            }
          >
            {dias.length ? (
              <AreaLineChart
                labels={dias.map((d) => diaCorto(d.date))}
                series={[
                  { name: "Ingresos", color: C_VERDE, points: dias.map((d) => d.ingresos) },
                  { name: "Egresos", color: C_ROJO, points: dias.map((d) => d.egresos) },
                ]}
                yFormat={compactCOP}
                height={210}
                smooth={false}
              />
            ) : (
              <ChartEmpty message="No se pudo cargar la serie de días." />
            )}
          </ChartCard>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {/* ── El cajón, paso a paso ── */}
            <ChartCard title="Dinero en caja" subtitle="Lo que hubo en tu cajón ese día" icon="wallet">
              {dc ? (
                <dl className="divide-y divide-border-subtle">
                  {[
                    { k: "Saldo anterior", h: "arrastre del día anterior", v: dc.saldoAnterior.monto },
                    { k: "Recaudo del día", h: `${nfmt(dc.recaudo.cantidad)} ${dc.recaudo.cantidad === 1 ? "pago" : "pagos"} por tu ventanilla`, v: dc.recaudo.monto },
                    { k: "Total en caja", h: null, v: dc.totalEnCaja, fuerte: true },
                    { k: "Egresos del día", h: `${nfmt(dc.egresos.cantidad)} ${dc.egresos.cantidad === 1 ? "salida" : "salidas"}`, v: -dc.egresos.monto },
                    { k: "Excedente barrido", h: null, v: dc.excedente, res: true },
                  ].map((f) => (
                    <div
                      key={f.k}
                      className={`flex items-baseline justify-between gap-3 py-2 ${f.res ? "bg-brand-soft -mx-2 mt-1 rounded-lg px-2" : ""}`}
                    >
                      <dt className="min-w-0">
                        <span className={`text-[13px] ${f.res ? "font-semibold text-brand" : f.fuerte ? "font-semibold text-text-primary" : "text-text-secondary"}`}>
                          {f.k}
                        </span>
                        {f.h && <span className="block text-[11px] text-text-tertiary">{f.h}</span>}
                      </dt>
                      <dd className={`shrink-0 tabular-nums ${
                        f.res ? "text-base font-bold text-brand"
                        : f.fuerte ? "text-base font-bold text-text-primary"
                        : "text-[13px] text-text-primary"
                      }`}>
                        {cop(f.v)}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <ChartEmpty message="Ese día no se movió tu caja." />
              )}
              {/* Los pagos en línea existen y se ven en el informe del legacy; decir aquí
                  que están fuera y cuánto son evita que parezca que se perdieron. */}
              {enLinea && enLinea.cantidad > 0 && (
                <p className="mt-1.5 text-[11px] text-text-tertiary">
                  Aparte entraron <strong className="text-text-secondary">{cop(enLinea.monto)}</strong> en{" "}
                  {nfmt(enLinea.cantidad)} {enLinea.cantidad === 1 ? "pago" : "pagos"} en línea de tu sede.
                  No entran en el arqueo porque no pasan por tu caja: los tienes en el informe en tablas.
                </p>
              )}
            </ChartCard>

            {/* ── Qué se cobró ── */}
            <ChartCard title="Qué se cobró" subtitle="Planes, televisión, reconexiones y afiliaciones" icon="list">
              <HBarList rows={servicios} valueFormat={cop} monochrome accent={C_AZUL} />
            </ChartCard>
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {/* ── Al día o cartera vieja ── */}
            <ChartCard
              title="De qué mes es lo cobrado"
              subtitle="Si pesa lo viejo, estás recogiendo cartera"
              icon="calendar"
            >
              <HBarList rows={meses} valueFormat={cop} monochrome accent={C_AZUL} />
            </ChartCard>

            {/* ── Internet vs TV ── */}
            <ChartCard title="Internet y televisión" subtitle="Reparto del recaudo por servicio" icon="tv">
              {porServicio.length ? (
                <Reparto data={porServicio} centerLabel="por servicio" />
              ) : (
                <ChartEmpty message="Ese día no se cobró ni internet ni TV." />
              )}
            </ChartCard>
          </div>

          {/* ── Puertas al detalle. El estado de la caja va arriba y no se repite aquí. ── */}
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border-subtle bg-surface px-4 py-2.5">
            <span className="flex items-center gap-1.5 text-[12px] text-text-secondary">
              <Icon name="search" size={13} className="text-text-tertiary" />
              ¿Necesitas el detalle?
            </span>
            <div className="flex gap-1">
              <button
                onClick={() => setVerInforme((v) => !v)}
                className="inline-flex items-center gap-1 rounded-md border border-border-default px-2 py-1 text-[12px] text-text-secondary hover:bg-surface-2"
              >
                <Icon name={verInforme ? "chevron-up" : "file-text"} size={13} />
                {verInforme ? "Ocultar el informe" : "Ver el informe en tablas"}
              </button>
              <Link
                href="/tesoreria/cierres"
                className="inline-flex items-center gap-1 rounded-md border border-border-default px-2 py-1 text-[12px] text-text-secondary hover:bg-surface-2"
              >
                <Icon name="search" size={13} /> Ver mis movimientos
              </Link>
            </div>
          </div>

          {/* Las tablas del legacy, cifra por cifra. Son la versión "tabla" de todo lo de
              arriba: quien necesite el número exacto (o no distinga los colores) lo tiene
              aquí, y es lo que el personal lleva años leyendo. */}
          {verInforme && <InformeCierre d={informe} />}
        </div>
      ) : null}
    </>
  );
}

/**
 * El estado de la caja, en una franja: abierta / cerrada / sin abrir, con quién la abrió
 * y desde cuándo.
 *
 * Lo del "a qué hora" tiene truco, y por eso se dice con cuidado: en el legacy
 * `transactions.date` es una fecha SIN hora, así que de un movimiento que venga de allá
 * la hora no existe en ninguna parte (el `createdAt` de aquí es la hora a la que corrió
 * la sincronización, no la del cobro). Se enseña la hora sólo cuando es de verdad —la de
 * la apertura registrada, o la del primer movimiento si se hizo en SAVES—; en los demás
 * casos se dice "con el primer movimiento" y se explica por qué, en vez de inventarla.
 */
function EstadoCaja({ estado, apertura, arqueo, esHoy, abriendo, onAbrir }: {
  estado: "cerrada" | "abierta" | "sin-abrir";
  apertura: Apertura | null;
  arqueo: InformeCierreData["arqueo"];
  esHoy: boolean;
  abriendo: boolean;
  onAbrir: () => void;
}) {
  const ap = apertura?.existing ?? null;
  const movs = apertura?.movimientos ?? 0;

  const tono =
    estado === "abierta"
      ? { punto: "bg-success", caja: "border-border-subtle bg-success-soft", icono: "text-success-text" }
      : estado === "cerrada"
        ? { punto: "bg-text-tertiary", caja: "border-border-subtle bg-surface", icono: "text-text-tertiary" }
        : { punto: "bg-warning", caja: "border-border-subtle bg-brand-soft", icono: "text-brand" };

  const titulo =
    estado === "abierta" ? "Caja abierta"
      : estado === "cerrada" ? "Caja cerrada"
        : esHoy ? "Caja sin abrir" : "Sin movimiento ese día";

  return (
    <div className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3 ${tono.caja}`}>
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface">
          <Icon name={estado === "cerrada" ? "lock" : "key-round"} size={16} className={tono.icono} />
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[13px] font-bold text-text-primary">
            <span className={`h-2 w-2 rounded-full ${tono.punto}`} />
            {titulo}
          </div>

          <div className="text-[12px] text-text-secondary">
            {estado === "cerrada" ? (
              <>
                Se barrieron <strong className="text-text-primary">{cop(arqueo.excedente)}</strong>
                {arqueo.horaCierre && <> a las {fmtHora(arqueo.horaCierre)}</>}
                {arqueo.cajero && <> · cerró {arqueo.cajero}</>}.
              </>
            ) : estado === "abierta" && ap ? (
              <>
                Abrió <strong className="text-text-primary">{ap.openedBy ?? "—"}</strong>
                {ap.openedAt && <> a las {fmtHora(ap.openedAt)}</>} con base{" "}
                <strong className="text-text-primary">{cop(ap.base)}</strong>.
              </>
            ) : estado === "abierta" ? (
              <>
                {apertura?.primero
                  ? <>La abrió <strong className="text-text-primary">{apertura.primero}</strong></>
                  : <>Arrancó</>}{" "}
                {apertura?.desde
                  ? <>a las <strong className="text-text-primary">{fmtHora(apertura.desde)}</strong></>
                  : <>con el primer movimiento del día</>}
                {" · "}{movs} {movs === 1 ? "movimiento" : "movimientos"} hasta ahora.
              </>
            ) : esHoy ? (
              <>
                Abrirá con <strong className="text-text-primary">{cop(apertura?.base ?? 0)}</strong>: base fija{" "}
                {cop(apertura?.fondoFijo ?? 0)}
                {(apertura?.carryover ?? 0) > 0 && (
                  <> + {cop(apertura!.carryover)} que arrastró el cierre anterior</>
                )}.
              </>
            ) : (
              <>Esa caja no registró movimientos ni apertura ese día.</>
            )}
          </div>

          {/* La hora falta por una razón concreta; decirla evita que parezca un fallo. */}
          {estado === "abierta" && !ap && !apertura?.desde && (
            <div className="mt-0.5 text-[11px] text-text-tertiary">
              El sistema anterior guarda los movimientos sin hora, así que de ese primer cobro
              sólo se sabe el día y quién lo hizo.
            </div>
          )}
        </div>
      </div>

      {/* Abrir sólo tiene sentido con el día en blanco: hoy, sin apertura y sin movimientos. */}
      {estado === "sin-abrir" && esHoy && (
        <Button onClick={onAbrir} disabled={abriendo}>{abriendo ? "Abriendo…" : "Abrir caja"}</Button>
      )}
    </div>
  );
}
