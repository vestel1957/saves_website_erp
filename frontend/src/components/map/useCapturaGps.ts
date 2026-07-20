"use client";

import { useCallback, useState } from "react";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { mensajeDeError } from "@/lib/errores";
import {
  MOTIVO_GEO,
  PRECISION_DUDOSA_M,
  distMetros,
  geoDisponible,
  pedirUbicacion,
  type Punto,
} from "@/lib/geo";

/** Captura pendiente de confirmar, con el motivo por el que se frenó. */
export type CapturaPendiente = {
  lat: number;
  lng: number;
  accuracy: number;
  /** Distancia a la coordenada que ya tenía el abonado, si la tenía. */
  movidoM: number | null;
  precisionMala: boolean;
  saltoGrande: boolean;
};

/** Un salto mayor que esto sugiere que se está capturando en la ficha equivocada. */
const SALTO_SOSPECHOSO_M = 300;

/**
 * Lógica de "capturar el GPS y guardarlo como ubicación del abonado", compartida
 * por el botón en línea de la orden de soporte y por el modal de la ficha del
 * cliente. La misma operación se ofrece desde dos sitios muy distintos, y el que
 * duplicaba era el riesgo: son precisamente las guardas contra datos falsos las
 * que no se pueden quedar en una sola de las dos copias.
 */
export function useCapturaGps(subscriberId: string, actual?: Punto | null) {
  const { authFetch } = useAuth();
  const [buscando, setBuscando] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [pendiente, setPendiente] = useState<CapturaPendiente | null>(null);

  const guardar = useCallback(
    async (p: { lat: number; lng: number; accuracy: number }, onGuardado?: (p: Punto) => void) => {
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
        return true;
      } catch (e) {
        toast(mensajeDeError(e, "No se pudo guardar la ubicación"), "alert-circle");
        return false;
      } finally {
        setGuardando(false);
      }
    },
    [authFetch, subscriberId],
  );

  /**
   * Pide el GPS y guarda. Se detiene a preguntar en los dos casos en que el dato
   * probablemente sería basura: precisión de red en vez de GPS, o un salto que
   * delata que no se está donde se cree.
   */
  const capturar = useCallback(
    async (onGuardado?: (p: Punto) => void) => {
      setBuscando(true);
      try {
        const r = await pedirUbicacion();
        if (!r.ok) {
          toast(MOTIVO_GEO[r.motivo], "alert-circle");
          return;
        }
        const movidoM = actual ? distMetros(actual, { lat: r.lat, lng: r.lng }) : null;
        const precisionMala = r.accuracy > PRECISION_DUDOSA_M;
        const saltoGrande = movidoM != null && movidoM > SALTO_SOSPECHOSO_M;

        if (precisionMala || saltoGrande) {
          setPendiente({ lat: r.lat, lng: r.lng, accuracy: r.accuracy, movidoM, precisionMala, saltoGrande });
          return;
        }
        await guardar(r, onGuardado);
      } finally {
        setBuscando(false);
      }
    },
    [actual, guardar],
  );

  return {
    /** ¿El navegador permite siquiera pedir la ubicación? (exige HTTPS) */
    disponible: geoDisponible(),
    buscando,
    guardando,
    pendiente,
    capturar,
    guardar,
    descartar: useCallback(() => setPendiente(null), []),
  };
}
