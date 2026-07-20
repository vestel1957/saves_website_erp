"use client";

import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/Modal";
import { MOTIVO_GEO, formatearDistancia, type Punto } from "@/lib/geo";
import { useCapturaGps } from "./useCapturaGps";

/**
 * Botón en línea "Capturar GPS aquí", para la orden de soporte.
 *
 * Aquí sí va suelto y a la vista, al revés que en la ficha del cliente (donde
 * vive detrás del menú "Acciones", en `UbicacionModal`): en una orden abierta el
 * técnico está por definición en el domicilio del abonado, así que capturar es
 * lo correcto por defecto y esconderlo solo añadiría toques. Es el momento en
 * que se georreferencia el parque sin trabajo extra.
 *
 * Las guardas contra datos falsos (precisión de red, salto sospechoso) son las
 * mismas: viven en `useCapturaGps`, no en cada botón.
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
  const { disponible, buscando, guardando, pendiente, capturar, guardar, descartar } =
    useCapturaGps(subscriberId, actual);

  if (!disponible) {
    return (
      <span
        className="inline-flex items-center gap-1.5 text-[12px] text-text-tertiary"
        title={
          MOTIVO_GEO[
            typeof window !== "undefined" && !window.isSecureContext ? "inseguro" : "sin-soporte"
          ]
        }
      >
        <Icon name="alert-circle" size={13} />
        GPS no disponible (requiere HTTPS)
      </span>
    );
  }

  return (
    <>
      <Button
        variant="secondary"
        size={size}
        onClick={() => void capturar(onGuardado)}
        disabled={buscando || guardando}
      >
        <Icon
          name={buscando ? "loader" : "map-pin"}
          size={14}
          className={buscando ? "animate-spin" : ""}
        />
        {buscando ? "Ubicando…" : actual ? "Actualizar GPS aquí" : "Capturar GPS aquí"}
      </Button>

      <Modal
        open={!!pendiente}
        onClose={descartar}
        title="Confirma la ubicación"
        maxWidth="max-w-md"
      >
        {pendiente && (
          <div className="space-y-3">
            {pendiente.precisionMala && (
              <p className="rounded-lg border border-warning bg-warning-soft px-3 py-2 text-[12.5px] text-text-secondary">
                <strong>Precisión baja: ±{Math.round(pendiente.accuracy)} m.</strong> El punto
                probablemente viene de la red y no del GPS. Sal al exterior, espera unos segundos y
                vuelve a intentarlo antes de guardarlo.
              </p>
            )}
            {pendiente.saltoGrande && pendiente.movidoM != null && (
              <p className="rounded-lg border border-error bg-error-soft px-3 py-2 text-[12.5px] text-text-secondary">
                <strong>
                  La nueva ubicación está a {formatearDistancia(pendiente.movidoM)} de la que ya
                  tenía este abonado.
                </strong>{" "}
                Comprueba que estás en el domicilio correcto y en la ficha correcta.
              </p>
            )}
            <p className="font-mono text-[12px] text-text-tertiary">
              {pendiente.lat.toFixed(6)}, {pendiente.lng.toFixed(6)}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={descartar} disabled={guardando}>
                Cancelar
              </Button>
              <Button onClick={() => void guardar(pendiente, onGuardado)} disabled={guardando}>
                {guardando ? "Guardando…" : "Guardar de todos modos"}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
