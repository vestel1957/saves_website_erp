"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { LoadError } from "@/components/ui/LoadError";
import { Modal } from "@/components/Modal";
import { Input } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { useAuth } from "@/context/AuthProvider";
import { VisitaHecha, type MiHistorial } from "@/components/soporte/VisitaHecha";

/** "miércoles, 03 de septiembre" — el día como lo nombra quien lo trabajó. */
const diaLargo = (ymd: string) =>
  new Date(`${ymd}T12:00:00`).toLocaleDateString("es-CO", { weekday: "long", day: "2-digit", month: "long" });

/** El día `n` días antes de un 'YYYY-MM-DD', en la misma escala (sin zona horaria). */
const menosDias = (ymd: string, n: number) =>
  new Date(new Date(`${ymd}T12:00:00Z`).getTime() - n * 86_400_000).toISOString().slice(0, 10);

const PERIODOS = [7, 15, 30] as const;

/**
 * **Mi historial: lo que el técnico ya hizo** (2026-09-04, a pedido del usuario:
 * «que el técnico pueda ver a detalle una orden que hizo hace tres días, con su
 * documentación»).
 *
 * El detalle de una orden cerrada siempre estuvo abierto para él —el turno lo deja
 * pasar a propósito y se comprobó contra la base: fotos, firma, material y
 * seguimiento le salen enteros—. Lo que no había era CAMINO: `/mi-agenda` enseña
 * sólo hoy y para llegar a la del martes tenía que rebuscar en la lista general.
 *
 * Por eso esta pantalla se organiza por DÍA DE TRABAJO y no por fecha de creación
 * (que es como ordena la lista general): el técnico busca "lo del martes", no "las
 * órdenes que abrieron el martes". Y cada visita dice de un vistazo qué quedó
 * guardado —3 fotos, firmada, 4 materiales—, para no tener que abrirlas todas
 * buscando la que traía la foto.
 *
 * Es SOLO LECTURA: desde aquí no se cierra, ni se aparta, ni se agenda nada. El
 * trabajo del día sigue estando —entero y con sus botones— en `/mi-agenda`.
 */
export default function MiHistorialPage() {
  const { loading: authLoading, authFetch } = useAuth();
  const [d, setD] = useState<MiHistorial | null>(null);
  const [err, setErr] = useState(false);
  const [cargando, setCargando] = useState(true);
  /** Periodo elegido, en días hacia atrás. `null` = rango a mano. */
  const [dias, setDias] = useState<number | null>(7);
  const [rango, setRango] = useState<{ desde: string; hasta: string } | null>(null);
  const [verFechas, setVerFechas] = useState(false);
  const [borrador, setBorrador] = useState({ desde: "", hasta: "" });

  const cargar = useCallback(async () => {
    setErr(false);
    setCargando(true);
    try {
      const qs = new URLSearchParams();
      if (rango) {
        qs.set("desde", rango.desde);
        qs.set("hasta", rango.hasta);
      } else if (dias && dias !== 7 && d?.hoy) {
        // El día de hoy lo pone el servidor (Colombia), no el reloj del celular: el
        // técnico que abre esto a las 11 de la noche seguiría viendo su jornada.
        qs.set("desde", menosDias(d.hoy, dias - 1));
        qs.set("hasta", d.hoy);
      }
      const r = await authFetch(`/support/mi-historial${qs.toString() ? `?${qs.toString()}` : ""}`);
      if (!r.ok) throw new Error(String(r.status));
      setD((await r.json()) as MiHistorial);
    } catch {
      setErr(true);
    } finally {
      setCargando(false);
    }
    // `d.hoy` se lee para calcular el rango, pero NO va en las dependencias: cada
    // respuesta lo trae otra vez y volvería a disparar la carga en bucle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authFetch, dias, rango]);

  useEffect(() => {
    if (!authLoading) void cargar();
  }, [authLoading, cargar]);

  if (authLoading || (!d && cargando)) return <PageSkeleton />;
  if (err && !d) return <LoadError message="No se pudo cargar tu historial." onRetry={() => void cargar()} />;
  if (!d) return null;

  const etiquetaPeriodo = rango
    ? `${diaLargo(rango.desde)} → ${diaLargo(rango.hasta)}`
    : `Últimos ${dias} días`;

  return (
    <div className="flex flex-col gap-3">
      <PageHeading
        icon="history"
        title="Lo que ya hice"
        subtitle="Tus visitas terminadas, día por día. Toca una para ver su documentación."
      />

      {/* Periodo. Tres atajos y, detrás, las fechas a mano: en el celular dos campos
          de fecha en la barra la parten en cuatro renglones (mismo criterio que
          «Mis órdenes»). */}
      <div className="flex flex-wrap items-center gap-1.5">
        {PERIODOS.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => { setRango(null); setDias(p); }}
            className={`tap rounded-lg border px-3 py-1.5 text-[12px] font-semibold transition-colors ${
              !rango && dias === p
                ? "border-brand bg-brand-soft text-brand"
                : "border-border-default bg-surface text-text-secondary hover:bg-surface-2"
            }`}
          >
            {p} días
          </button>
        ))}
        <button
          type="button"
          onClick={() => { setBorrador({ desde: rango?.desde ?? d.desde, hasta: rango?.hasta ?? d.hasta }); setVerFechas(true); }}
          className={`tap inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12px] font-semibold transition-colors ${
            rango ? "border-brand bg-brand-soft text-brand" : "border-border-default bg-surface text-text-secondary hover:bg-surface-2"
          }`}
        >
          <Icon name="calendar-days" size={14} /> Otras fechas
        </button>
      </div>

      <Modal open={verFechas} onClose={() => setVerFechas(false)} title="Elegir periodo" maxWidth="max-w-lg">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Input type="date" value={borrador.desde} max={d.hoy} onChange={(e) => setBorrador({ ...borrador, desde: e.target.value })} className="w-auto" />
            <span className="text-text-tertiary">→</span>
            <Input type="date" value={borrador.hasta} max={d.hoy} onChange={(e) => setBorrador({ ...borrador, hasta: e.target.value })} className="w-auto" />
          </div>
          <p className="text-[12px] text-text-tertiary">Se puede consultar de a 92 días como mucho.</p>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" size="sm" onClick={() => { setRango(null); setDias(7); setVerFechas(false); }}>Volver a 7 días</Button>
            <Button
              variant="primary"
              size="sm"
              disabled={!borrador.desde || !borrador.hasta || borrador.desde > borrador.hasta}
              onClick={() => { setRango({ ...borrador }); setDias(null); setVerFechas(false); }}
            >
              Ver
            </Button>
          </div>
        </div>
      </Modal>

      {/* Sin ficha de empleado no hay forma de saber qué visitas son suyas. Se dice
          qué pasa y a quién pedírselo, igual que en «Mi agenda». */}
      {!d.resolved ? (
        <div className="rounded-xl border border-warning-border bg-warning-soft p-4">
          <div className="flex items-start gap-2.5">
            <Icon name="alert-triangle" size={18} className="mt-0.5 shrink-0 text-warning-text" />
            <div className="text-[13px] text-text-primary">
              <div className="font-bold">Tu usuario no está ligado a una ficha de empleado</div>
              <p className="mt-1 text-text-secondary">
                Por eso no podemos saber qué visitas son tuyas. Pídele a administración que revise
                que tu correo sea el mismo en <span className="font-semibold">Empleados</span>.
              </p>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border-subtle bg-surface px-3.5 py-2.5">
            <p className="text-[13px] text-text-secondary">
              <b className="text-text-primary">{d.total} {d.total === 1 ? "visita" : "visitas"}</b>
              {d.dias.length > 0 ? ` en ${d.dias.length} ${d.dias.length === 1 ? "día" : "días"}` : ""}
            </p>
            <p className="text-[11.5px] text-text-tertiary">{etiquetaPeriodo}</p>
          </div>

          {/* Un historial que calla que le faltan órdenes es peor que uno corto. */}
          {d.truncado && (
            <p className="flex items-start gap-1.5 rounded-lg bg-warning-soft px-3 py-2 text-[12px] text-warning-text">
              <Icon name="alert-triangle" size={14} className="mt-0.5 shrink-0" />
              Hay más visitas de las que caben en una consulta. Acorta el periodo para verlas todas.
            </p>
          )}

          {cargando && <p className="text-[12px] text-text-tertiary">Cargando…</p>}

          {d.dias.length === 0 && !cargando ? (
            <div className="rounded-xl border border-border-subtle bg-surface p-6 text-center">
              <span className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-surface-2 text-text-tertiary">
                <Icon name="history" size={20} />
              </span>
              <h2 className="text-[14px] font-bold text-text-primary">No hay visitas terminadas en este periodo</h2>
              <p className="mx-auto mt-1 max-w-md text-[12.5px] text-text-secondary">
                Prueba con un periodo más largo, o busca la orden por su número en «Mis órdenes».
              </p>
            </div>
          ) : (
            d.dias.map((dia) => (
              <section key={dia.fecha} className="flex flex-col gap-2">
                <h2 className="flex items-baseline justify-between gap-2 pt-1 text-[12.5px] font-bold text-text-primary">
                  <span>
                    {diaLargo(dia.fecha).replace(/^./, (c) => c.toUpperCase())}
                    {dia.fecha === d.hoy && <span className="ml-1.5 text-[11px] font-semibold text-brand">hoy</span>}
                  </span>
                  <span className="text-[11.5px] font-medium text-text-tertiary">
                    {dia.cuantas} {dia.cuantas === 1 ? "visita" : "visitas"}
                  </span>
                </h2>
                {dia.ordenes.map((o) => (
                  <VisitaHecha key={`${o.id}-${o.resultado}`} o={o} />
                ))}
              </section>
            ))
          )}
        </>
      )}

      <div className="flex flex-wrap gap-2 pt-1">
        <Link
          href="/mi-agenda"
          className="tap inline-flex items-center gap-1.5 rounded-lg border border-border-default px-3.5 py-2 text-[12.5px] font-semibold text-text-secondary hover:bg-surface-2"
        >
          <Icon name="calendar-clock" size={14} /> Mi trabajo de hoy
        </Link>
        <Link
          href="/soporte"
          className="tap inline-flex items-center gap-1.5 rounded-lg border border-border-default px-3.5 py-2 text-[12.5px] font-semibold text-text-secondary hover:bg-surface-2"
        >
          <Icon name="clipboard-check" size={14} /> Buscar entre todas mis órdenes
        </Link>
      </div>
    </div>
  );
}
