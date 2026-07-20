"use client";

import { useRouter } from "next/navigation";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/Modal";
import { MOTIVO_GEO, PRECISION_DUDOSA_M, formatearDistancia, type Punto } from "@/lib/geo";
import { useCapturaGps } from "./useCapturaGps";

/**
 * Ubicación del abonado: **cómo llegar** y **actualizar la coordenada**, en el
 * mismo sitio y preguntando cuál de las dos. Son las dos únicas cosas que se
 * hacen con la ubicación de un cliente, así que comparten botón — el pin del
 * encabezado, la dirección de la tarjeta Contacto y el menú "Acciones" abren
 * todos esto.
 *
 * La ruta NO se dibuja aquí: navega a `/mapa/ruta`. Estuvo dentro del modal y no
 * servía — un trayecto en 288 px de alto no se lee, y de una ruta lo que se mira
 * es por dónde va, no el número de kilómetros. Un modal es el sitio de una
 * decisión corta; un mapa quiere la pantalla entera.
 */
export function UbicacionModal({
  open,
  onClose,
  subscriberId,
  subscriberName,
  actual,
  onGuardado,
}: {
  open: boolean;
  onClose: () => void;
  subscriberId: string;
  subscriberName?: string;
  actual?: Punto | null;
  onGuardado?: (p: Punto) => void;
}) {
  const router = useRouter();
  const { disponible, buscando, guardando, pendiente, capturar, guardar, descartar } =
    useCapturaGps(subscriberId, actual);

  const cerrar = () => {
    descartar();
    onClose();
  };

  const guardado = (p: Punto) => {
    onGuardado?.(p);
    onClose();
  };

  const irARuta = () => {
    const p = new URLSearchParams({ abonado: subscriberId });
    if (subscriberName) p.set("nombre", subscriberName);
    onClose();
    router.push(`/mapa/ruta?${p}`);
  };

  return (
    <Modal open={open} onClose={cerrar} title="Ubicación del cliente" maxWidth="max-w-md">
      {pendiente ? (
        /* ─── Confirmación de una captura sospechosa ─── */
        <div className="space-y-3">
          {pendiente.precisionMala && (
            <p className="rounded-lg border border-warning bg-warning-soft px-3 py-2 text-[12.5px] text-text-secondary">
              <strong>Precisión baja: ±{Math.round(pendiente.accuracy)} m.</strong> Con ese margen el
              punto viene de la red y no del GPS. Sal al exterior, espera unos segundos y repite
              antes de guardarlo.
            </p>
          )}
          {pendiente.saltoGrande && pendiente.movidoM != null && (
            <p className="rounded-lg border border-error bg-error-soft px-3 py-2 text-[12.5px] text-text-secondary">
              <strong>
                Está a {formatearDistancia(pendiente.movidoM)} de la ubicación que ya tenía
                {subscriberName ? ` ${subscriberName}` : " este cliente"}.
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
            <Button onClick={() => void guardar(pendiente, guardado)} disabled={guardando}>
              {guardando ? "Guardando…" : "Guardar de todos modos"}
            </Button>
          </div>
        </div>
      ) : (
        /* ─── Las dos únicas cosas que se hacen aquí ─── */
        <div className="space-y-3">
          <div className="rounded-lg border border-border-subtle bg-surface-2 px-3 py-2.5">
            {actual ? (
              <>
                <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-success-text">
                  <Icon name="map-pin" size={14} /> Este cliente aparece en el mapa
                </p>
                <p className="mt-0.5 font-mono text-[12px] text-text-secondary">
                  {actual.lat.toFixed(6)}, {actual.lng.toFixed(6)}
                </p>
              </>
            ) : (
              <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-text-secondary">
                <Icon name="alert-circle" size={14} className="text-warning-text" />
                Sin ubicación: este cliente no sale en el mapa
              </p>
            )}
          </div>

          <Opcion
            icon="navigation"
            titulo="Cómo llegar"
            detalle={
              actual
                ? "Abre el mapa a pantalla completa con la ruta desde donde estás."
                : "No disponible: primero hay que guardarle una ubicación."
            }
            onClick={irARuta}
            disabled={!actual}
          />

          <Opcion
            icon="map-pin"
            titulo={actual ? "Actualizar ubicación" : "Guardar ubicación"}
            detalle={
              disponible
                ? "Guarda el punto donde estás TÚ ahora. Úsalo solo en su domicilio: desde la oficina guardarías las coordenadas de la oficina."
                : MOTIVO_GEO[
                    typeof window !== "undefined" && !window.isSecureContext
                      ? "inseguro"
                      : "sin-soporte"
                  ]
            }
            onClick={() => void capturar(guardado)}
            disabled={!disponible || buscando || guardando}
            cargando={buscando}
          />

          <p className="text-right text-[11px] text-text-tertiary">
            Al guardar se avisa si la precisión es peor de ±{PRECISION_DUDOSA_M} m.
          </p>
        </div>
      )}
    </Modal>
  );
}

/** Fila grande y pulsable — pensada para el pulgar, no para el ratón. */
function Opcion({
  icon,
  titulo,
  detalle,
  onClick,
  disabled,
  cargando,
}: {
  icon: string;
  titulo: string;
  detalle: string;
  onClick: () => void;
  disabled?: boolean;
  cargando?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-start gap-3 rounded-lg border border-border-default bg-surface px-3 py-3 text-left transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:bg-surface"
    >
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-soft">
        <Icon
          name={cargando ? "loader" : icon}
          size={16}
          className={`text-brand ${cargando ? "animate-spin" : ""}`}
        />
      </span>
      <span className="min-w-0">
        <span className="block text-[13.5px] font-bold text-text-primary">
          {cargando ? "Ubicando…" : titulo}
        </span>
        <span className="mt-0.5 block text-[12px] leading-snug text-text-tertiary">{detalle}</span>
      </span>
    </button>
  );
}
