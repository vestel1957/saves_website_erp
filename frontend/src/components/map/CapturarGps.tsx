"use client";

import { useState } from "react";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/Modal";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { mensajeDeError } from "@/lib/errores";
import {
  MOTIVO_GEO,
  PRECISION_DUDOSA_M,
  distMetros,
  formatearDistancia,
  geoDisponible,
  pedirUbicacion,
  type Punto,
} from "@/lib/geo";

type Pendiente = { lat: number; lng: number; accuracy: number; movidoM: number | null };

/**
 * Botón "Capturar GPS aquí": guarda como coordenada del abonado el punto donde
 * está el técnico en ese momento.
 *
 * Es la vía por la que se va a georreferenciar el parque (hoy solo el 9% de los
 * abonados tiene coordenadas), así que asume que se pulsa desde un móvil, en la
 * calle y con prisa. De ahí las dos confirmaciones antes de escribir:
 *
 *  - **Precisión mala**: si el navegador reporta ±300 m, el punto viene del wifi
 *    o de la antena, no del GPS. Guardarlo es peor que no tener nada, porque
 *    parece un dato bueno.
 *  - **Salto grande**: si el abonado ya tenía coordenada y la nueva está a
 *    kilómetros, o el técnico no está donde cree, o está capturando en la ficha
 *    equivocada — que con un botón de un toque pasa constantemente.
 *
 * Un dato malo en el mapa cuesta más que un hueco: al hueco se le ve.
 */
export function CapturarGps({
  subscriberId,
  actual,
  onGuardado,
  size = "sm",
}: {
  subscriberId: string;
  /** Coordenada que ya tiene el abonado, si tiene. */
  actual?: Punto | null;
  onGuardado?: (p: Punto) => void;
  size?: "sm" | "md";
}) {
  const { authFetch } = useAuth();
  const [buscando, setBuscando] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [pendiente, setPendiente] = useState<Pendiente | null>(null);

  const disponible = geoDisponible();

  async function capturar() {
    setBuscando(true);
    try {
      const r = await pedirUbicacion();
      if (!r.ok) return toast(MOTIVO_GEO[r.motivo], "alert-circle");

      const movidoM = actual ? distMetros(actual, { lat: r.lat, lng: r.lng }) : null;
      const dudoso = r.accuracy > PRECISION_DUDOSA_M;
      const saltoGrande = movidoM != null && movidoM > 300;

      if (dudoso || saltoGrande) {
        setPendiente({ lat: r.lat, lng: r.lng, accuracy: r.accuracy, movidoM });
        return;
      }
      await guardar({ lat: r.lat, lng: r.lng, accuracy: r.accuracy, movidoM });
    } finally {
      setBuscando(false);
    }
  }

  async function guardar(p: Pendiente) {
    setGuardando(true);
    try {
      const res = await authFetch(`/geo/subscribers/${subscriberId}/location`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lat: p.lat, lng: p.lng, accuracy: p.accuracy, source: "campo" }),
      });
      if (!res.ok) {
        const cuerpo = await res.json().catch(() => null);
        throw new Error(cuerpo?.message ?? `Error ${res.status}`);
      }
      setPendiente(null);
      toast(`Ubicación guardada (±${Math.round(p.accuracy)} m)`, "map-pin");
      onGuardado?.({ lat: p.lat, lng: p.lng });
    } catch (e) {
      toast(mensajeDeError(e, "No se pudo guardar la ubicación"), "alert-circle");
    } finally {
      setGuardando(false);
    }
  }

  if (!disponible) {
    return (
      <span
        className="inline-flex items-center gap-1.5 text-[12px] text-text-tertiary"
        title={MOTIVO_GEO[typeof window !== "undefined" && !window.isSecureContext ? "inseguro" : "sin-soporte"]}
      >
        <Icon name="alert-circle" size={13} />
        GPS no disponible (requiere HTTPS)
      </span>
    );
  }

  return (
    <>
      <Button variant="secondary" size={size} onClick={capturar} disabled={buscando || guardando}>
        <Icon name={buscando ? "loader" : "map-pin"} size={14} className={buscando ? "animate-spin" : ""} />
        {buscando ? "Ubicando…" : actual ? "Actualizar GPS aquí" : "Capturar GPS aquí"}
      </Button>

      <Modal
        open={!!pendiente}
        onClose={() => setPendiente(null)}
        title="Confirma la ubicación"
        maxWidth="max-w-md"
      >
        {pendiente && (
          <div className="space-y-3">
            {pendiente.accuracy > PRECISION_DUDOSA_M && (
              <p className="rounded-lg border border-warning bg-warning-soft px-3 py-2 text-[12.5px] text-text-secondary">
                <strong>Precisión baja: ±{Math.round(pendiente.accuracy)} m.</strong> El punto
                probablemente viene de la red y no del GPS. Sal al exterior, espera unos segundos y
                vuelve a intentarlo antes de guardarlo.
              </p>
            )}
            {pendiente.movidoM != null && pendiente.movidoM > 300 && (
              <p className="rounded-lg border border-error bg-error-soft px-3 py-2 text-[12.5px] text-text-secondary">
                <strong>
                  La nueva ubicación está a {formatearDistancia(pendiente.movidoM)} de la que ya
                  tenía este abonado.
                </strong>{" "}
                Comprueba que estás en el domicilio correcto y en la ficha correcta.
              </p>
            )}
            <p className="text-[12px] text-text-tertiary">
              {pendiente.lat.toFixed(6)}, {pendiente.lng.toFixed(6)}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setPendiente(null)} disabled={guardando}>
                Cancelar
              </Button>
              <Button onClick={() => void guardar(pendiente)} disabled={guardando}>
                {guardando ? "Guardando…" : "Guardar de todos modos"}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
