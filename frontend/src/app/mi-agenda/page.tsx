"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { LoadError } from "@/components/ui/LoadError";
import { useAuth } from "@/context/AuthProvider";
import { VisitaAgendada, visitaLista, type MiAgenda } from "@/components/soporte/VisitaAgendada";

/** Suma días a un 'YYYY-MM-DD' sin pasar por la zona horaria del navegador. */
function sumarDias(ymd: string, dias: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + dias)).toISOString().slice(0, 10);
}
const diaLargo = (ymd: string) =>
  new Date(`${ymd}T12:00:00`).toLocaleDateString("es-CO", { weekday: "long", day: "2-digit", month: "long" });

/**
 * Mi agenda: las visitas del técnico EN EL ORDEN que le puso la cajera.
 *
 * Es la primera pantalla de PRINCIPAL y por tanto donde aterriza al entrar
 * (`firstAccessibleHref`). Antes vivía embebida arriba de "Mis órdenes de trabajo",
 * pero lo primero que necesita quien va a salir a la calle es "qué me toca y en qué
 * orden", no una tabla de 966 filas — y compartir pantalla con esa tabla la dejaba
 * como un adorno encima de otra cosa.
 *
 * Se puede mirar otro día (◀ ▶). No se puede reordenar: quien agenda es la cajera
 * (`/soporte/agenda`), y el backend se lo niega aunque llegue por API.
 */
export default function MiAgendaPage() {
  const { loading: authLoading, authFetch } = useAuth();
  const [fecha, setFecha] = useState<string | null>(null);
  const [d, setD] = useState<MiAgenda | null>(null);
  const [err, setErr] = useState(false);

  const cargar = useCallback(async (f?: string | null) => {
    setErr(false);
    try {
      const r = await authFetch(`/support/mi-agenda${f ? `?fecha=${f}` : ""}`);
      if (!r.ok) throw new Error(String(r.status));
      const j: MiAgenda = await r.json();
      setD(j);
      setFecha(j.fecha);
    } catch { setErr(true); }
  }, [authFetch]);

  useEffect(() => { if (!authLoading) void cargar(null); }, [authLoading, cargar]);

  if (authLoading || (!d && !err)) return <PageSkeleton />;
  if (err && !d) return <div className="p-6"><LoadError message="No se pudo cargar tu agenda." onRetry={() => void cargar(fecha)} /></div>;
  if (!d) return <PageSkeleton />;

  const esHoy = d.fecha === d.hoy;
  const irA = (f: string) => { setFecha(f); void cargar(f); };
  const hechas = d.ordenes.filter(visitaLista).length;
  const siguiente = d.ordenes.find((o) => !visitaLista(o));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <PageHeading
          icon="calendar-clock"
          title={esHoy ? "Mi agenda de hoy" : "Mi agenda"}
          subtitle="Tus visitas en el orden en que hay que atenderlas"
        />
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={() => irA(sumarDias(d.fecha, -1))} aria-label="Día anterior"
            className="tap rounded-lg border border-border-default px-2 py-1.5 text-text-secondary hover:bg-surface-2">
            <Icon name="chevron-left" size={15} />
          </button>
          <span className="min-w-[170px] rounded-lg border border-border-default bg-surface px-3 py-1.5 text-center text-[12.5px] font-semibold text-text-primary first-letter:uppercase">
            {diaLargo(d.fecha)}
          </span>
          <button type="button" onClick={() => irA(sumarDias(d.fecha, 1))} aria-label="Día siguiente"
            className="tap rounded-lg border border-border-default px-2 py-1.5 text-text-secondary hover:bg-surface-2">
            <Icon name="chevron-right" size={15} />
          </button>
          {!esHoy && (
            <button type="button" onClick={() => irA(d.hoy)}
              className="rounded-lg border border-border-default px-2.5 py-1.5 text-[12px] font-semibold text-text-secondary hover:bg-surface-2">
              Hoy
            </button>
          )}
        </div>
      </div>

      {/* Sin ficha de empleado no hay forma de saber qué visitas son suyas. Se dice
          qué pasa y a quién pedírselo, en vez de una agenda vacía que parece un día
          libre. Mismo criterio que el panel de rendimiento. */}
      {!d.resolved ? (
        <div className="rounded-xl border border-warning-border bg-warning-soft p-4">
          <div className="flex items-start gap-2.5">
            <Icon name="alert-triangle" size={18} className="mt-0.5 shrink-0 text-warning-text" />
            <div className="text-[13px] text-text-primary">
              <div className="font-bold">Tu usuario no está ligado a una ficha de empleado</div>
              <p className="mt-1 text-text-secondary">
                Por eso no podemos saber qué visitas son tuyas. Pídele a administración que revise que tu
                correo sea el mismo en <span className="font-semibold">Empleados</span>.
              </p>
              <Link href="/soporte" className="mt-2 inline-flex items-center gap-1.5 text-[12px] font-semibold text-brand hover:underline">
                Ver mis órdenes de trabajo <Icon name="chevron-right" size={13} />
              </Link>
            </div>
          </div>
        </div>
      ) : d.ordenes.length === 0 ? (
        // Una agenda vacía no es un error, pero tampoco es el final del camino: se le
        // manda a su lista de órdenes, que es donde está el resto de su trabajo.
        <div className="rounded-xl border border-border-subtle bg-surface p-6 text-center">
          <span className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-surface-2 text-text-tertiary">
            <Icon name="calendar-clock" size={20} />
          </span>
          <h2 className="text-[14px] font-bold text-text-primary">
            {esHoy ? "No tienes visitas agendadas para hoy" : "No hay visitas agendadas para este día"}
          </h2>
          <p className="mx-auto mt-1 max-w-md text-[12.5px] text-text-secondary">
            Quien reparte el día es la persona de caja. Mientras tanto, tus órdenes abiertas siguen en tu lista.
          </p>
          <Link
            href="/soporte"
            className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-brand px-3.5 py-2 text-[12.5px] font-semibold text-on-brand transition-opacity hover:opacity-90"
          >
            <Icon name="clipboard-check" size={14} /> Ver mis órdenes de trabajo
          </Link>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-brand/40 bg-brand-soft/30 px-3.5 py-2.5">
            <div className="text-[12.5px] text-text-secondary">
              <b className="text-text-primary">{d.ordenes.length}</b> {d.ordenes.length === 1 ? "visita" : "visitas"}
              {hechas > 0 ? ` · ${hechas} lista${hechas === 1 ? "" : "s"}` : ""}
              {d.ordenes[0]?.agendadaPor ? ` · la agendó ${d.ordenes[0].agendadaPor}` : ""}
            </div>
            {siguiente && (
              <Link
                href={`/soporte/${siguiente.id}`}
                className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg bg-brand px-3.5 text-[12px] font-semibold text-on-brand transition-opacity hover:opacity-90"
              >
                <Icon name="arrow-right" size={14} /> Ir a la #{siguiente.seq ?? 1}
              </Link>
            )}
          </div>

          <ol className="flex flex-col gap-2">
            {d.ordenes.map((o) => <li key={o.id}><VisitaAgendada o={o} /></li>)}
          </ol>
        </>
      )}

      {d.proximas > 0 && (
        <p className="text-[11.5px] text-text-tertiary">
          Tienes {d.proximas} {d.proximas === 1 ? "visita agendada" : "visitas agendadas"} para los próximos días.
        </p>
      )}
    </div>
  );
}
