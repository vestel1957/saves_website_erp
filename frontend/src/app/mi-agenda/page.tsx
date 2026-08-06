"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { LoadError } from "@/components/ui/LoadError";
import { useAuth } from "@/context/AuthProvider";
import { VisitaEnTurno, type MiTurno } from "@/components/soporte/VisitaEnTurno";

const diaLargo = (ymd: string) =>
  new Date(`${ymd}T12:00:00`).toLocaleDateString("es-CO", { weekday: "long", day: "2-digit", month: "long" });

/**
 * Mi agenda: UNA visita, la que toca ahora.
 *
 * Hasta el 2026-08-04 esta pantalla listaba el día entero numerado y el técnico
 * abría la que quisiera; el número era una sugerencia. Por decisión del usuario ahora
 * es obligatorio: ve una sola visita y hasta que no la cierre —o la aparte diciendo
 * por qué no se pudo— no aparece la siguiente.
 *
 * Dos cosas que se quitaron a conciencia, y conviene no devolverlas sin pensarlo:
 *
 *  · **La lista del día.** Enseñar las seis visitas y dejar abrir solo una es peor que
 *    no enseñarlas: invita a discutir el orden en vez de seguirlo. Lo que sí se dice
 *    es cuántas van y cuántas faltan, que es lo que necesita para organizarse.
 *  · **Las flechas de otros días.** Servían para revisar días pasados, pero eran
 *    también la puerta para mirar (y abrir) el trabajo de mañana. El resumen de lo que
 *    viene se conserva como una línea de texto al pie.
 *
 * El candado de verdad está en el backend (`support/turno.ts`): aunque alguien llegue
 * por URL a otra orden pendiente, se la niega con el mismo criterio que usa esta
 * pantalla para decidir qué enseñar.
 */
export default function MiAgendaPage() {
  const { loading: authLoading, authFetch } = useAuth();
  const [d, setD] = useState<MiTurno | null>(null);
  const [err, setErr] = useState(false);

  const cargar = useCallback(async () => {
    setErr(false);
    try {
      const r = await authFetch("/support/mi-turno");
      if (!r.ok) throw new Error(String(r.status));
      setD((await r.json()) as MiTurno);
    } catch {
      setErr(true);
    }
  }, [authFetch]);

  useEffect(() => {
    if (!authLoading) void cargar();
  }, [authLoading, cargar]);

  /** Aparta la visita en turno. Devuelve el mensaje de error, o `null` si salió bien. */
  const apartar = useCallback(
    async (motivo: string): Promise<string | null> => {
      if (!d?.visita) return "No hay ninguna visita en turno.";
      try {
        const r = await authFetch("/support/mi-turno/no-atendida", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ticketId: d.visita.id, motivo }),
        });
        if (!r.ok) {
          const cuerpo = await r.json().catch(() => null);
          return cuerpo?.message ?? "No se pudo guardar. Inténtalo de nuevo.";
        }
        await cargar();
        return null;
      } catch {
        return "No hay conexión. Inténtalo de nuevo cuando tengas señal.";
      }
    },
    [authFetch, cargar, d],
  );

  if (authLoading || (!d && !err)) return <PageSkeleton />;
  if (err && !d)
    return (
      <div className="p-6">
        <LoadError message="No se pudo cargar tu visita." onRetry={() => void cargar()} />
      </div>
    );
  if (!d) return <PageSkeleton />;

  return (
    <div className="flex flex-col gap-3">
      <PageHeading
        icon="calendar-clock"
        title="Mi trabajo de hoy"
        subtitle={diaLargo(d.fecha).replace(/^./, (c) => c.toUpperCase())}
      />

      {/* Sin ficha de empleado no hay forma de saber qué visitas son suyas. Se dice
          qué pasa y a quién pedírselo, en vez de una pantalla vacía que parece un día
          libre. Mismo criterio que el panel de rendimiento. */}
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
      ) : d.visita ? (
        <>
          <VisitaEnTurno d={d} onApartada={apartar} />
          {d.restantes > 1 && (
            <p className="text-center text-[12px] text-text-tertiary">
              Cuando cierres esta te aparece la siguiente. Te quedan {d.restantes} de {d.total}.
            </p>
          )}
        </>
      ) : d.total > 0 ? (
        // Terminó el día. Es la única pantalla del sistema que da una felicitación, y
        // se la ha ganado: cerró todo lo que le pusieron.
        <div className="rounded-xl border border-success-border bg-success-soft p-6 text-center">
          <span className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-surface text-success-text">
            <Icon name="check" size={22} />
          </span>
          <h2 className="text-[15px] font-bold text-text-primary">Terminaste tus visitas de hoy</h2>
          <p className="mx-auto mt-1 max-w-md text-[12.5px] text-text-secondary">
            Cerraste las {d.total} que tenías agendadas. Si aparece algo nuevo, te lo verás aquí.
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-border-subtle bg-surface p-6 text-center">
          <span className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-surface-2 text-text-tertiary">
            <Icon name="calendar-clock" size={20} />
          </span>
          <h2 className="text-[14px] font-bold text-text-primary">No tienes visitas agendadas para hoy</h2>
          <p className="mx-auto mt-1 max-w-md text-[12.5px] text-text-secondary">
            Quien reparte el día es la persona de caja. Si crees que es un error, háblale antes de
            salir.
          </p>
          <Link
            href="/soporte"
            className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-border-default px-3.5 py-2 text-[12.5px] font-semibold text-text-secondary hover:bg-surface-2"
          >
            <Icon name="clipboard-check" size={14} /> Ver mis órdenes
          </Link>
        </div>
      )}

      {d.proximas > 0 && (
        <p className="text-center text-[11.5px] text-text-tertiary">
          Tienes {d.proximas} {d.proximas === 1 ? "visita agendada" : "visitas agendadas"} para los
          próximos días.
        </p>
      )}
    </div>
  );
}
