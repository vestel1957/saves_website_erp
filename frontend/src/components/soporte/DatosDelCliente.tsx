"use client";

import { useCallback, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { toast } from "@/components/ui/Toast";
import { CapturarGps } from "@/components/map/CapturarGps";
import { useAuth } from "@/context/AuthProvider";
import { mensajeDeError } from "@/lib/errores";
import type { Punto } from "@/lib/geo";

const MAX_BYTES = 20 * 1024 * 1024;

/**
 * Los dos datos del cliente que hay que dejar ANTES de empezar la visita
 * (2026-09-18): su ubicación y la foto de la vivienda. Ver
 * `backend/src/support/datos-cliente.policy.ts`.
 *
 * Vive en un componente propio porque se pinta en DOS sitios de la misma pantalla y
 * tienen que decir exactamente lo mismo: el aviso «Para empezar esta visita», que se
 * lee al llegar, y el modal del 422, que sale si aun así se pulsó «Empezar». Dos
 * copias acabarían pidiendo cosas distintas.
 *
 * Cada renglón trae SU arreglo al lado —capturar el GPS, tomar la foto—, que es la
 * diferencia entre un candado y una cadena: el técnico está en la puerta, con el
 * cliente delante, y lo que necesita es el botón, no la explicación.
 */
export function DatosDelCliente({
  subscriberId,
  falta,
  gps,
  onHecho,
}: {
  subscriberId: string;
  /** `true` = falta. Lo calcula el servidor con la misma función que frena el arranque. */
  falta: { ubicacion?: boolean; foto?: boolean };
  /** Coordenada que ya tiene el abonado, para avisar del salto si se recaptura. */
  gps?: Punto | null;
  /** Tras capturar o subir: recargar la orden para que el aviso se apague solo. */
  onHecho: () => void;
}) {
  const { authFetch } = useAuth();
  const [subiendo, setSubiendo] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const subir = useCallback(
    async (file: File) => {
      if (file.size > MAX_BYTES) {
        toast("La foto supera el máximo de 20 MB", "alert-circle");
        return;
      }
      setSubiendo(true);
      try {
        const fd = new FormData();
        fd.append("file", file);
        const res = await authFetch(`/subscribers/${subscriberId}/house-photo`, { method: "POST", body: fd });
        if (!res.ok) {
          const m = await res.json().catch(() => null);
          throw new Error(m?.message ?? "No se pudo subir la foto");
        }
        toast("Foto de la vivienda guardada");
        onHecho();
      } catch (e) {
        toast(mensajeDeError(e) ?? "No se pudo subir la foto", "alert-circle");
      } finally {
        setSubiendo(false);
      }
    },
    [authFetch, subscriberId, onHecho],
  );

  return (
    <ul className="flex flex-col gap-2">
      {falta.ubicacion && (
        <li className="flex flex-wrap items-start gap-2 text-[12.5px] text-text-secondary">
          <Icon name="map-pin" size={14} className="mt-0.5 shrink-0 text-warning-text" />
          <span className="min-w-[180px] flex-1">
            El cliente no tiene ubicación guardada. Captúrala <strong>desde la puerta</strong>: es
            contra ese punto que se comprueba el cierre.
          </span>
          <CapturarGps subscriberId={subscriberId} actual={gps ?? null} onGuardado={() => onHecho()} />
        </li>
      )}
      {falta.foto && (
        <li className="flex flex-wrap items-start gap-2 text-[12.5px] text-text-secondary">
          <Icon name="camera" size={14} className="mt-0.5 shrink-0 text-warning-text" />
          <span className="min-w-[180px] flex-1">
            Falta la foto de la vivienda. Tómala de la fachada, con el número visible si lo hay:
            queda en el campo <strong>Foto de la vivienda</strong> de su ficha, no en el seguimiento.
          </span>
          {/* `capture="environment"` abre la cámara trasera del teléfono en vez del
              carrete: la foto es de la casa que tiene delante, no de la galería. */}
          <input
            ref={input}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            capture="environment"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void subir(f);
            }}
          />
          <Button variant="secondary" size="sm" disabled={subiendo} onClick={() => input.current?.click()}>
            <Icon name={subiendo ? "loader" : "camera"} size={14} className={subiendo ? "animate-spin" : ""} />
            {subiendo ? "Subiendo…" : "Tomar foto de la vivienda"}
          </Button>
        </li>
      )}
    </ul>
  );
}
