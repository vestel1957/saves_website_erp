"use client";

import { useCallback, useState } from "react";
import { Icon } from "@/components/Icon";
import { useAuth } from "@/context/AuthProvider";
import { TICKET_PRIORITY_TONE } from "@/lib/support";

type Visita = {
  id: string; code: number | null; type: string; priority: string | null;
  cliente: string | null; abonado: number | null; barrio: string | null; direccion: string | null;
  puesto: number | null;
};
type Proximas = {
  resolved: boolean; desde: string; hasta: string; total: number;
  dias: { fecha: string; ordenes: Visita[] }[];
};

const TONO: Record<string, string> = {
  error: "bg-error-soft text-error-text",
  warning: "bg-warning-soft text-warning-text",
  info: "bg-info-soft text-info-text",
  success: "bg-success-soft text-success-text",
  default: "bg-surface-2 text-text-secondary",
};

const diaLargo = (ymd: string) =>
  new Date(`${ymd}T12:00:00`).toLocaleDateString("es-CO", { weekday: "long", day: "2-digit", month: "long" });

/**
 * "Lo que viene": las visitas que el técnico ya tiene agendadas para los próximos
 * días (2026-08-26, junto con el calendario de agendamiento).
 *
 * Es SOLO LECTURA a propósito: aquí no hay enlaces ni forma de adelantar visitas
 * porque lo que se decide en esta pantalla no es qué hacer ahora, sino cómo
 * organizarse —llevar material, saber que mañana le toca al otro lado del pueblo— sin
 * llamar a la oficina a preguntar. Con el turno de vuelta (2026-09-02) el backend
 * además se lo negaría: lo de hoy va por orden, y lo de mañana todavía no es suyo.
 *
 * Va plegado y carga al abrirlo: el contador ya viene con la agenda, y el técnico
 * está en la calle con sus datos.
 */
export function LoQueViene({ cuantas }: { cuantas: number }) {
  const { authFetch } = useAuth();
  const [abierto, setAbierto] = useState(false);
  const [d, setD] = useState<Proximas | null>(null);
  const [err, setErr] = useState(false);
  const [cargando, setCargando] = useState(false);

  const abrir = useCallback(async () => {
    const siguiente = !abierto;
    setAbierto(siguiente);
    if (!siguiente || d || cargando) return;
    setCargando(true);
    setErr(false);
    try {
      const r = await authFetch("/support/mis-proximas?dias=14");
      if (!r.ok) throw new Error(String(r.status));
      setD(await r.json());
    } catch { setErr(true); } finally { setCargando(false); }
  }, [abierto, authFetch, cargando, d]);

  if (cuantas <= 0) return null;

  return (
    <div className="rounded-xl border border-border-subtle bg-surface">
      <button
        type="button"
        onClick={() => void abrir()}
        aria-expanded={abierto}
        className="tap flex w-full items-center gap-2 px-3.5 py-3 text-left"
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-text-secondary">
          <Icon name="calendar-days" size={15} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-bold text-text-primary">Lo que viene</span>
          <span className="block text-[11.5px] text-text-secondary">
            {cuantas} {cuantas === 1 ? "visita agendada" : "visitas agendadas"} para los próximos días
          </span>
        </span>
        <Icon name={abierto ? "chevron-up" : "chevron-down"} size={16} className="shrink-0 text-text-tertiary" />
      </button>

      {abierto && (
        <div className="border-t border-border-subtle px-3.5 py-3">
          {cargando && (
            <div className="flex items-center gap-2 text-[12px] text-text-tertiary">
              <Icon name="loader" size={14} className="animate-spin" /> Cargando…
            </div>
          )}
          {err && !cargando && (
            <p className="text-[12px] text-text-tertiary">
              No se pudo cargar. Vuelve a intentarlo cuando tengas señal.
            </p>
          )}
          {d && !cargando && (
            d.dias.length === 0 ? (
              <p className="text-[12px] text-text-tertiary">No tienes nada agendado para los próximos días.</p>
            ) : (
              <div className="flex flex-col gap-3">
                {d.dias.map((dia) => (
                  <div key={dia.fecha}>
                    <div className="mb-1.5 flex items-center gap-2">
                      <span className="text-[12px] font-bold text-text-primary first-letter:uppercase">
                        {diaLargo(dia.fecha)}
                      </span>
                      <span className="text-[11px] text-text-tertiary">
                        {dia.ordenes.length} {dia.ordenes.length === 1 ? "visita" : "visitas"}
                      </span>
                    </div>
                    <div className="flex flex-col gap-1">
                      {/* Sin enlace y sin botones: hoy no se pueden abrir. Enseñar un
                          camino que el backend va a negar es peor que no enseñarlo. */}
                      {dia.ordenes.map((o) => (
                        <div key={o.id} className="flex items-start gap-2 rounded-lg border border-border-subtle px-2 py-1.5">
                          <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface-2 text-[10px] font-bold text-text-secondary">
                            {o.puesto ?? "·"}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-1.5">
                              <span className="truncate text-[12.5px] font-semibold text-text-primary">{o.type}</span>
                              <span className={`ml-auto shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase ${TONO[TICKET_PRIORITY_TONE[o.priority ?? ""] ?? "default"]}`}>
                                {o.priority ?? "—"}
                              </span>
                            </span>
                            <span className="block truncate text-[11px] text-text-secondary">
                              {o.cliente ?? "—"}{o.abonado ? ` · ${o.abonado}` : ""}
                            </span>
                            {(o.barrio || o.direccion) && (
                              <span className="flex items-start gap-1 text-[10.5px] text-text-tertiary">
                                <Icon name="map-pin" size={10} className="mt-0.5 shrink-0" />
                                <span className="truncate">{o.barrio ?? o.direccion}</span>
                              </span>
                            )}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
                <p className="text-[11px] text-text-tertiary">
                  Es para que te organices. Cada visita se abre el día que toca, en el orden que
                  ponga la persona de caja.
                </p>
              </div>
            )
          )}
        </div>
      )}
    </div>
  );
}
