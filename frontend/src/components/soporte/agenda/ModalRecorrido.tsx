"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { Modal } from "@/components/Modal";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { mensajeDeError, objetoJson } from "@/lib/errores";
import { diaLargo } from "./comun";

type Visita = {
  id: string;
  code: string | null;
  tipo: string | null;
  estado: string;
  cliente: string | null;
  abonado: number | null;
  direccion: string | null;
  barrio: string | null;
  puestoActual: number | null;
  puestoPropuesto: number;
  fija: boolean;
  /** `exacto` = GPS de la casa · `barrio` = centroide del barrio · `null` = sin ubicar. */
  ubicacion: "exacto" | "barrio" | null;
};

type Propuesta = {
  tecnico: string;
  fecha: string;
  sinCambios: boolean;
  motivo?: string;
  metrosAntes?: number;
  metrosDespues?: number;
  ahorroM?: number;
  porCarretera?: boolean;
  aproximado?: boolean;
  visitas: Visita[];
};

const km = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);

/**
 * La propuesta de recorrido de una jornada: en qué orden conviene hacer las
 * visitas para no cruzar la ciudad dos veces.
 *
 * **Propone; aplica la persona.** El botón de abajo es el único que escribe, y
 * escribe el orden que el técnico está obligado a seguir (el turno reparte las
 * visitas de una en una y en este orden). Reordenarle el día a alguien que ya
 * salió a la calle sin que nadie lo mire sería otra cosa muy distinta.
 *
 * Los dos avisos de abajo no son letra pequeña:
 *  · **Ubicación aproximada** — la visita se colocó en el CENTROIDE DE SU BARRIO
 *    porque el abonado no tiene GPS (hoy, 3 de cada 4). Ordena bien a escala de
 *    ciudad y no dice nada de la calle. Callarlo sería enseñar como dato lo que
 *    es una estimación.
 *  · **Línea recta** — OSRM no respondió y los metros son en recta, no por
 *    carretera. El orden sigue siendo razonable; la cifra, no discutible.
 */
export function ModalRecorrido({
  open, onClose, staffId, fecha, onAplicado,
}: {
  open: boolean;
  onClose: () => void;
  staffId: string;
  fecha: string;
  onAplicado: () => void;
}) {
  const { authFetch } = useAuth();
  const [p, setP] = useState<Propuesta | null>(null);
  // Arranca en `true`: el modal sólo se monta cuando ya se pulsó el botón, así que
  // "cargando" es su primer estado real. Ponerlo desde el efecto era un setState
  // síncrono dentro del efecto —cascada de renders— y además pintaba un parpadeo
  // de "sin visitas" antes del primer render de carga.
  const [cargando, setCargando] = useState(true);
  const [aplicando, setAplicando] = useState(false);
  const [err, setErr] = useState("");

  const calcular = useCallback(async () => {
    // Nada de setState antes del primer `await`: hacerlo dentro del efecto que
    // llama a esto encadena renders (regla `set-state-in-effect`).
    try {
      const r = await authFetch(`/support/agenda/recorrido?staffId=${encodeURIComponent(staffId)}&fecha=${encodeURIComponent(fecha)}`);
      if (!r.ok) throw new Error((await objetoJson<{ message?: string }>(r))?.message || "No se pudo calcular el recorrido");
      setErr("");
      setP(await objetoJson<Propuesta>(r));
    } catch (e) {
      setErr(mensajeDeError(e));
      setP(null);
    } finally { setCargando(false); }
  }, [authFetch, staffId, fecha]);

  // La carga sale del efecto por un `setTimeout(0)`, igual que en `VistaRepartir` y
  // `VistaPorTecnico`: `calcular` acaba llamando a setState y hacerlo dentro del
  // cuerpo del efecto encadena renders (regla `react-hooks/set-state-in-effect`).
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => { void calcular(); }, 0);
    return () => window.clearTimeout(t);
  }, [open, calcular]);

  const aplicar = async () => {
    if (!p) return;
    setAplicando(true);
    try {
      const r = await authFetch("/support/agenda/recorrido", {
        method: "POST",
        body: JSON.stringify({ staffId, fecha, ticketIds: p.visitas.map((v) => v.id) }),
      });
      if (!r.ok) throw new Error((await objetoJson<{ message?: string }>(r))?.message || "No se pudo aplicar el recorrido");
      toast("Recorrido aplicado", "check");
      onAplicado();
      onClose();
    } catch (e) {
      toast(mensajeDeError(e), "alert-triangle");
    } finally { setAplicando(false); }
  };

  const cambia = (v: Visita) => v.puestoActual !== v.puestoPropuesto;

  return (
    <Modal open={open} onClose={onClose} title="Recorrido sugerido" maxWidth="max-w-2xl">
      <div className="flex flex-col gap-3">
        <p className="text-[12px] text-text-secondary">
          {p ? <><b className="text-text-primary">{p.tecnico}</b> · <span className="first-letter:uppercase">{diaLargo(fecha)}</span></> : "Calculando…"}
        </p>

        {cargando && (
          <div className="flex items-center gap-2 py-6 text-[12px] text-text-tertiary">
            <Icon name="loader" size={14} className="animate-spin" />
            Ordenando las visitas por cercanía…
          </div>
        )}

        {err && !cargando && (
          <div className="rounded-lg border border-border-default bg-surface-2 px-3 py-2 text-[12px] text-text-secondary">{err}</div>
        )}

        {p && !cargando && !p.visitas.length && (
          <div className="rounded-lg border border-border-default bg-surface-2 px-3 py-2 text-[12px] text-text-secondary">
            {p.motivo ?? "Ese día no tiene visitas agendadas."}
          </div>
        )}

        {p && !cargando && p.visitas.length > 0 && (
          <>
            <div className="rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-[12px]">
              {p.sinCambios ? (
                <span className="text-text-secondary">
                  Ya estaban en el mejor orden que se sabe calcular. No hay nada que cambiar.
                </span>
              ) : (
                <span className="text-text-secondary">
                  Recorrido actual <b className="text-text-primary">{km(p.metrosAntes ?? 0)}</b> ·
                  propuesto <b className="text-text-primary">{km(p.metrosDespues ?? 0)}</b> ·
                  se ahorra <b className="text-brand">{km(p.ahorroM ?? 0)}</b>
                </span>
              )}
            </div>

            <ol className="flex flex-col gap-1">
              {p.visitas.map((v) => (
                <li
                  key={v.id}
                  className={`flex items-start gap-2 rounded-lg border px-2.5 py-1.5 ${
                    cambia(v) ? "border-brand/40 bg-brand/5" : "border-border-subtle bg-surface"
                  }`}
                >
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-surface-2 text-[11px] font-bold text-text-secondary">
                    {v.puestoPropuesto}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="truncate text-[12px] font-semibold text-text-primary">{v.cliente ?? "Sin cliente"}</span>
                      {v.code && <span className="text-[11px] text-text-tertiary">#{v.code}</span>}
                      {v.fija && (
                        <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[10.5px] text-text-tertiary" title="Ya está en marcha o cerrada: no se mueve.">
                          no se mueve
                        </span>
                      )}
                      {v.ubicacion === null && (
                        <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[10.5px] text-text-tertiary" title="Ni el abonado tiene GPS ni su barrio tiene punto: no se pudo ordenar, va al final.">
                          sin ubicar
                        </span>
                      )}
                      {v.ubicacion === "barrio" && (
                        <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[10.5px] text-text-tertiary" title="Ubicada por el centro de su barrio, no por su casa.">
                          por barrio
                        </span>
                      )}
                    </div>
                    <div className="truncate text-[11px] text-text-tertiary">
                      {[v.tipo, v.barrio, v.direccion].filter(Boolean).join(" · ") || "Sin dirección"}
                    </div>
                  </div>
                  {cambia(v) && v.puestoActual != null && (
                    <span className="mt-0.5 shrink-0 text-[10.5px] text-text-tertiary" title="Puesto que tenía">
                      antes {v.puestoActual}
                    </span>
                  )}
                </li>
              ))}
            </ol>

            <div className="flex flex-col gap-1 text-[11px] text-text-tertiary">
              {p.aproximado && (
                <span className="flex items-start gap-1.5">
                  <Icon name="map-pin" size={12} className="mt-0.5 shrink-0" />
                  Alguna visita se ubicó por el centro de su barrio porque el abonado no tiene GPS. Sirve para
                  decidir qué queda de camino; no dice en qué calle está.
                </span>
              )}
              {p.porCarretera === false && (
                <span className="flex items-start gap-1.5">
                  <Icon name="navigation" size={12} className="mt-0.5 shrink-0" />
                  Distancias en línea recta: el servicio de rutas no respondió. El orden sigue siendo válido; los metros son aproximados.
                </span>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={onClose} className="tap rounded-lg border border-border-default px-3 py-1.5 text-[12px] font-semibold text-text-secondary hover:bg-surface-2">
                Cerrar
              </button>
              <button
                type="button"
                onClick={() => void aplicar()}
                disabled={aplicando || p.sinCambios}
                className="tap rounded-lg bg-brand px-3 py-1.5 text-[12px] font-semibold text-on-brand disabled:opacity-50"
              >
                {aplicando ? "Aplicando…" : "Aplicar este orden"}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
