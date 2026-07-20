"use client";

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/Modal";
import { useAuth } from "@/context/AuthProvider";
import { mensajeDeError } from "@/lib/errores";
import {
  MOTIVO_GEO,
  PRECISION_DUDOSA_M,
  formatearDistancia,
  pedirUbicacion,
  type Punto,
} from "@/lib/geo";
import { formatearDuracion, type Ruta } from "@/lib/mapa";
import { COLOR_ESTADO, type PuntoMapa } from "./Mapa";
import { useCapturaGps } from "./useCapturaGps";

const Mapa = dynamic(() => import("./Mapa").then((m) => m.Mapa), {
  ssr: false,
  loading: () => <div className="h-full w-full animate-pulse rounded-lg bg-surface-2" />,
});

type Vista = "menu" | "ruta";

/**
 * Ubicación del abonado: **cómo llegar** y **actualizar la coordenada**, en el
 * mismo sitio y preguntando cuál de las dos.
 *
 * Antes eran dos cosas sueltas y ninguna estaba bien: el pin del encabezado
 * lanzaba Google Maps en una pestaña nueva —sacando al usuario del sistema para
 * algo que el sistema ya sabe dibujar— y la captura vivía enterrada aparte. Son
 * las dos únicas cosas que se hacen con la ubicación de un cliente, así que
 * comparten botón.
 *
 * La ruta se traza DENTRO de la aplicación. El botón de navegación por voz sigue
 * existiendo, porque para conducir la app nativa es mejor que cualquier mapa
 * embebido, pero se abre solo si el técnico lo pide — no de golpe.
 */
export function UbicacionModal({
  open,
  onClose,
  subscriberId,
  subscriberName,
  actual,
  onGuardado,
  irA = "menu",
}: {
  open: boolean;
  onClose: () => void;
  subscriberId: string;
  subscriberName?: string;
  actual?: Punto | null;
  onGuardado?: (p: Punto) => void;
  /** `ruta` entra directo a trazar el camino, sin pasar por el menú: lo usa el
   *  botón "Cómo llegar" de la orden, donde ya se sabe lo que se quiere. */
  irA?: Vista;
}) {
  const { authFetch } = useAuth();
  const [vista, setVista] = useState<Vista>(irA);
  const [ruta, setRuta] = useState<Ruta | null>(null);
  const [calculando, setCalculando] = useState(false);
  const [errorRuta, setErrorRuta] = useState<string | null>(null);

  const { disponible, buscando, guardando, pendiente, capturar, guardar, descartar } =
    useCapturaGps(subscriberId, actual);

  const cerrar = () => {
    descartar();
    setVista(irA);
    setRuta(null);
    setErrorRuta(null);
    onClose();
  };

  const guardado = (p: Punto) => {
    onGuardado?.(p);
    onClose();
  };

  /** Pide MI posición y la ruta desde ahí hasta el cliente. */
  const trazarRuta = useCallback(async () => {
    setVista("ruta");
    setErrorRuta(null);
    setCalculando(true);
    try {
      const yo = await pedirUbicacion();
      if (!yo.ok) {
        setErrorRuta(`No se puede calcular la ruta sin saber dónde estás. ${MOTIVO_GEO[yo.motivo]}`);
        return;
      }
      const res = await authFetch("/geo/route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromLat: yo.lat, fromLng: yo.lng, subscriberId }),
      });
      if (!res.ok) {
        const cuerpo = await res.json().catch(() => null);
        throw new Error(cuerpo?.message ?? `Error ${res.status}`);
      }
      setRuta((await res.json()) as Ruta);
    } catch (e) {
      setErrorRuta(mensajeDeError(e, "No se pudo calcular la ruta"));
    } finally {
      setCalculando(false);
    }
  }, [authFetch, subscriberId]);

  // Abierto ya en modo ruta: se traza en cuanto se monta, sin un clic de más.
  useEffect(() => {
    if (open && irA === "ruta" && !ruta && !calculando && !errorRuta) void trazarRuta();
  }, [open, irA, ruta, calculando, errorRuta, trazarRuta]);

  const puntos: PuntoMapa[] = ruta
    ? [
        { id: "yo", tipo: "yo", lat: ruta.origen.lat, lng: ruta.origen.lng, titulo: "Estás aquí" },
        {
          id: "destino",
          tipo: "abonado",
          lat: ruta.destino.lat,
          lng: ruta.destino.lng,
          titulo: ruta.nombre ?? subscriberName ?? "Destino",
          color: COLOR_ESTADO.CORTADO,
        },
      ]
    : [];

  const navExterna = ruta
    ? `https://www.google.com/maps/dir/?api=1&origin=${ruta.origen.lat},${ruta.origen.lng}&destination=${ruta.destino.lat},${ruta.destino.lng}&travelmode=driving`
    : actual
      ? `https://www.google.com/maps/dir/?api=1&destination=${actual.lat},${actual.lng}&travelmode=driving`
      : null;

  return (
    <Modal
      open={open}
      onClose={cerrar}
      title={vista === "ruta" ? "Cómo llegar" : "Ubicación del cliente"}
      maxWidth={vista === "ruta" ? "max-w-2xl" : "max-w-md"}
    >
      {/* ─────────── Confirmación de una captura sospechosa ─────────── */}
      {pendiente ? (
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
      ) : vista === "ruta" ? (
        /* ─────────── Ruta ─────────── */
        <div className="space-y-3">
          {calculando && (
            <div className="flex items-center gap-2 text-[13px] text-text-secondary">
              <Icon name="loader" size={15} className="animate-spin" />
              Buscando tu ubicación y trazando la ruta…
            </div>
          )}

          {errorRuta && (
            <p className="rounded-lg border border-error bg-error-soft px-3 py-2 text-[12.5px] text-text-secondary">
              {errorRuta}
            </p>
          )}

          {ruta && (
            <>
              <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
                <span className="text-[20px] font-bold text-text-primary">
                  {formatearDistancia(ruta.distanceM)}
                </span>
                {ruta.durationS != null && (
                  <span className="text-[13px] text-text-secondary">
                    ≈ {formatearDuracion(ruta.durationS)} en carro
                  </span>
                )}
                {ruta.nombre && (
                  <span className="text-[12.5px] text-text-tertiary">hasta {ruta.nombre}</span>
                )}
              </div>

              {ruta.aproximada && (
                <p className="rounded-lg border border-warning bg-warning-soft px-3 py-2 text-[12.5px] text-text-secondary">
                  No se pudo calcular el camino por carretera, así que la línea punteada es la
                  distancia <strong>en línea recta</strong>. El recorrido real será mayor.
                </p>
              )}

              <div className="h-72 overflow-hidden rounded-lg border border-border-subtle">
                <Mapa puntos={puntos} ruta={ruta.geometry} rutaAproximada={ruta.aproximada} />
              </div>
            </>
          )}

          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={() => (irA === "ruta" ? cerrar() : setVista("menu"))}>
              {irA === "ruta" ? "Cerrar" : "Volver"}
            </Button>
            {navExterna && (
              // Explícito, nunca automático: para conducir, la app del móvil da
              // voz y tráfico en vivo; un mapa embebido no.
              <a
                href={navExterna}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-brand px-3.5 py-2 text-[13px] font-semibold text-on-brand transition-colors hover:bg-brand-hover"
              >
                <Icon name="navigation" size={14} /> Navegar por voz
              </a>
            )}
          </div>
        </div>
      ) : (
        /* ─────────── Menú: las dos únicas cosas que se hacen aquí ─────────── */
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
                ? "Traza la ruta desde donde estás hasta su domicilio, aquí mismo."
                : "No disponible: primero hay que guardarle una ubicación."
            }
            onClick={() => void trazarRuta()}
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
